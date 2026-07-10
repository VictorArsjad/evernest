// Typed fetch wrapper.
//
// Behavior:
// - Attaches the in-memory access token as `Authorization: Bearer ...`.
// - On a 401 from a non-/auth request, attempts a single refresh and retries
//   the original request once. If refresh fails, clears auth state.
// - Throws `ApiError` (with the server's error envelope when present) on
//   non-2xx responses so TanStack Query treats them as errors.
//
// Refresh-token transport: the FE and API are served from the same origin
// (the API binary embeds the SPA — see apps/api/internal/spa), so the
// refresh token rides a first-party httpOnly cookie set by the BE on
// /v1/auth/{register,login,refresh}. /auth/refresh + /auth/logout send
// `credentials: 'include'` and carry no token in the body — the cookie is
// the source of truth. This is what makes iOS durable: a first-party
// cookie survives WebKit's ITP eviction, unlike the localStorage token the
// old cross-site (github.io -> ts.net) deploy was forced to use.
//
// CP6b adds `apiQueued()` as the mutation seam: on network failure / 5xx
// it enqueues the mutation into the offline outbox and resolves with a
// caller-supplied synthetic response so TanStack Query's onSuccess paths
// run optimistically. Reads (GET) still use `api()` directly — they
// don't get queued because there's nothing to replay.
import { useAuthStore } from "./authStore";
import {
  type DispatchResult,
  enqueueMutation,
  setDispatcher,
} from "./outbox";
import type { TokenResponse } from "./types";

export class ApiError extends Error {
  code: string;
  status: number;
  details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// TimeoutError is thrown when a request exceeds its client-side deadline.
// iOS WebKit hangs (rather than fails) fetches that are in flight across a
// background→foreground transition or issued before the tailnet is ready,
// so without this the request never settles and the UI stays stuck on
// "loading" / "Saving…" forever. We use a dedicated named class — rather
// than relying on the fetch abort *reason* (only Safari 15.4+ propagates
// it) — so downstream `instanceof` checks work on every engine and can
// tell a timeout apart from a caller-initiated abort (query cancellation).
export class TimeoutError extends Error {
  constructor(message = "request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  // Skip the access-token attachment + 401-refresh dance. Used for /auth/*.
  skipAuth?: boolean;
  signal?: AbortSignal;
  // Forwarded to fetch so cookie-carrying auth calls (logout) can opt into
  // sending the first-party refresh cookie explicitly.
  credentials?: RequestCredentials;
}

// In dev (Vite) and in same-origin prod (legacy Caddy reverse-proxy) the FE
// and API share an origin, so a relative `/v1` path Just Works. On GH Pages
// the FE is on `*.github.io` and the API is on `*.ts.net`, so we need an
// absolute base. Set VITE_API_BASE_URL=https://evernest.<tail>.ts.net at build
// time to switch modes; leave unset for same-origin.
const API_ROOT = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const BASE = `${API_ROOT}/v1`;

let refreshInflight: Promise<TokenResponse | null> | null = null;

// ensureFreshToken refreshes the access token preemptively when it's
// within EXPIRY_BUFFER_MS of expiring. Eliminates the 401 burst when
// the warm PWA is refocused after >15 min idle and refetchOnWindowFocus
// fires the whole query set at once with a stale JWT. Uses the same
// single-flight as tryRefresh() so N concurrent callers cause exactly
// one refresh round-trip.
const EXPIRY_BUFFER_MS = 60_000;

// Client-side request deadlines. Without them an iOS-suspended fetch never
// settles (see TimeoutError). Data reads/mutations get a tolerant window so
// a slow tailnet cold-load isn't cut short; the auth refresh gets a tighter
// bound because it blocks boot and, via the single-flight below, every
// subsequent authed request — it must fail fast so recovery can kick in.
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_TIMEOUT_MS = 8_000;

// makeTimeout builds an AbortSignal that fires after `ms`, optionally
// chained to a caller-supplied signal (query cancellation). We use a manual
// AbortController + setTimeout rather than AbortSignal.timeout()/any() on
// purpose: AbortSignal.any() is iOS Safari 17.4+ only, and this PWA targets
// older iOS. `timedOut()` lets the caller distinguish our deadline from a
// caller-initiated abort so the two are classified differently downstream.
function makeTimeout(ms: number, caller?: AbortSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ms);
  const onAbort = () => controller.abort();
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

async function ensureFreshToken(): Promise<void> {
  const { accessToken, expiresAt, refreshToken } = useAuthStore.getState();
  if (!accessToken || !refreshToken || !expiresAt) return;
  const msUntil = new Date(expiresAt).getTime() - Date.now();
  if (msUntil > EXPIRY_BUFFER_MS) return;
  await tryRefresh();
}

// RefreshOutcome distinguishes the three cases the callers actually need to
// act on differently:
//   - "ok"          → we have a fresh session.
//   - "unauth"      → the cookie is definitively invalid (401/403); the
//                     session is really gone, so it's safe to sign out.
//   - "unreachable" → timeout / network / 5xx: we DON'T know whether the
//                     session is valid, so bootstrap must retry rather than
//                     dump a possibly-valid session to /login.
type RefreshOutcome =
  | { status: "ok"; data: TokenResponse }
  | { status: "unauth" }
  | { status: "unreachable" };

// refreshOnce performs a single timed refresh round-trip and classifies the
// result. It always settles within REFRESH_TIMEOUT_MS (the timeout guarantees
// the fetch promise rejects), which is what makes the single-flight below
// impossible to wedge.
async function refreshOnce(): Promise<RefreshOutcome> {
  const t = makeTimeout(REFRESH_TIMEOUT_MS);
  try {
    // Same-origin first-party cookie carries the refresh token; send no body
    // so a stale value can never shadow the cookie. On success the BE rotates
    // the cookie and returns a fresh access token.
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      signal: t.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as TokenResponse;
      useAuthStore.getState().setSession(data);
      return { status: "ok", data };
    }
    if (res.status === 401 || res.status === 403) return { status: "unauth" };
    return { status: "unreachable" }; // 5xx and other non-2xx
  } catch {
    // TimeoutError / caller abort / network TypeError — all "we couldn't
    // reach the server", not "the session is invalid".
    return { status: "unreachable" };
  } finally {
    t.cleanup();
  }
}

async function tryRefresh(): Promise<TokenResponse | null> {
  if (!refreshInflight) {
    refreshInflight = refreshOnce()
      .then((o) => (o.status === "ok" ? o.data : null))
      .finally(() => {
        // Allow the next refresh attempt to proceed. Deferred a microtask so
        // all concurrent awaiters observe the same settled promise before it
        // is cleared (preserves the single-flight coalescing).
        queueMicrotask(() => {
          refreshInflight = null;
        });
      });
  }
  return refreshInflight;
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = "GET", body, skipAuth = false, signal, credentials } = opts;

  const doFetch = async (token: string | null) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token && !skipAuth) headers.Authorization = `Bearer ${token}`;

    const t = makeTimeout(REQUEST_TIMEOUT_MS, signal);
    try {
      return await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: t.signal,
        credentials,
      });
    } catch (err) {
      // Our deadline fired → TimeoutError (a transient, enqueue-worthy
      // failure). Anything else — a caller-initiated AbortError or a real
      // network TypeError — is preserved so its own classification holds.
      if (t.timedOut()) throw new TimeoutError();
      throw err;
    } finally {
      t.cleanup();
    }
  };

  if (!skipAuth && !path.startsWith("/auth/")) {
    await ensureFreshToken();
  }

  let res = await doFetch(skipAuth ? null : useAuthStore.getState().accessToken);

  if (res.status === 401 && !skipAuth && !path.startsWith("/auth/")) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await doFetch(refreshed.access_token);
    } else {
      useAuthStore.getState().clear();
    }
  }

  if (!res.ok) {
    let code = "unknown";
    let message = res.statusText || `request failed (${res.status})`;
    let details: unknown;
    try {
      const errBody = (await res.json()) as {
        error?: { code: string; message: string };
      } & Record<string, unknown>;
      if (errBody.error) {
        code = errBody.error.code;
        message = errBody.error.message;
      }
      details = errBody;
    } catch {
      // body was empty or non-JSON; keep defaults
    }
    throw new ApiError(res.status, code, message, details);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// apiBlob is the read-only sibling of api() for endpoints that stream
// raw bytes (e.g. GET /v1/diapers/{id}/photo). Mirrors the same
// access-token + 401→refresh→retry dance so callers don't have to
// re-invent it for media routes. Always uses GET; non-2xx still throws
// ApiError, but a 204 resolves to `null` so the caller can distinguish
// "no photo attached" from "no row".
export async function apiBlob(
  path: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Blob | null> {
  const doFetch = async (token: string | null) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const t = makeTimeout(REQUEST_TIMEOUT_MS, opts.signal);
    try {
      return await fetch(`${BASE}${path}`, { method: "GET", headers, signal: t.signal });
    } catch (err) {
      if (t.timedOut()) throw new TimeoutError();
      throw err;
    } finally {
      t.cleanup();
    }
  };

  let res = await doFetch(useAuthStore.getState().accessToken);
  if (res.status === 401 && !path.startsWith("/auth/")) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await doFetch(refreshed.access_token);
    } else {
      useAuthStore.getState().clear();
    }
  }

  if (res.status === 204) return null;
  if (!res.ok) {
    let code = "unknown";
    let message = res.statusText || `request failed (${res.status})`;
    try {
      const errBody = (await res.json()) as {
        error?: { code: string; message: string };
      };
      if (errBody.error) {
        code = errBody.error.code;
        message = errBody.error.message;
      }
    } catch {
      // body was empty or non-JSON; keep defaults
    }
    throw new ApiError(res.status, code, message);
  }
  return await res.blob();
}

// Bootstrap the auth store by attempting a silent refresh on cold start.
// Returns true if we ended up authenticated, false otherwise.
//
// A definitive 401/403 ("unauth") means the session is really gone → sign
// out and let the route guard send the user to /login. But a timeout /
// network failure ("unreachable") is ambiguous — the refresh cookie may be
// perfectly valid and the tailnet just wasn't up yet. Dumping such a user to
// /login is the wrong call, so we retry with backoff and, if every attempt
// is unreachable, flip to the "error" status the AuthGate turns into a
// Retry screen (rather than an endless splash or a bogus logout).
//
// Calls refreshOnce() directly instead of the single-flight tryRefresh():
// at cold start the routed query burst is gated behind the AuthGate splash,
// so there is no concurrent refresh to coalesce with.
const MAX_BOOT_ATTEMPTS = 3;
const BOOT_BACKOFF_MS = [500, 1500]; // waits between attempts 1→2 and 2→3

export async function bootstrapAuth(): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_BOOT_ATTEMPTS; attempt++) {
    const outcome = await refreshOnce();
    if (outcome.status === "ok") return true;
    if (outcome.status === "unauth") {
      useAuthStore.getState().setAnonymous();
      return false;
    }
    // "unreachable" — back off and retry (unless this was the last attempt).
    if (attempt < MAX_BOOT_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, BOOT_BACKOFF_MS[attempt]));
    }
  }
  useAuthStore.getState().setBootError();
  return false;
}

// --- mutation seam: apiQueued ---
//
// apiQueued tries the real request first (so when online, latency is
// unchanged) and on a network failure or 5xx falls through to the
// outbox. It returns the caller-supplied synthetic response in that
// case so TanStack Query's onSuccess paths still run — the optimistic
// row appears in the cache, the form clears, the user is told the save
// succeeded even though it'll actually flush later.
//
// Decisions:
//   - 4xx (excluding 401) → throw. Caller error / validation; retrying
//     won't help, surface it.
//   - 401 → the underlying api() already tried one refresh and a retry.
//     If we still ended up 401 the session is fully gone — enqueue
//     pending so that once the user re-auths and triggers sync(), it
//     drains. Caller still sees the synthetic "success" so the form
//     doesn't sit on an error state for what they perceive as a
//     transient hiccup.
//   - 5xx / network → enqueue + return synthetic.

export interface QueuedOpts<T> extends RequestOpts {
  // Required for non-GET requests so the outbox can dedupe a
  // double-tap of "Save" before the first send completes.
  idempotencyKey: string;
  // Synthetic response returned to the caller when the request is
  // queued. For creates this is typically the full new row shape so
  // optimistic cache updates have something to write.
  synthesize: () => T;
}

export async function apiQueued<T>(path: string, opts: QueuedOpts<T>): Promise<T> {
  try {
    return await api<T>(path, opts);
  } catch (err) {
    if (!shouldEnqueue(err)) throw err;
    await enqueueMutation({
      method: opts.method as "POST" | "PUT" | "PATCH" | "DELETE",
      path,
      body: opts.body,
      idempotencyKey: opts.idempotencyKey,
    });
    return opts.synthesize();
  }
}

function shouldEnqueue(err: unknown): boolean {
  // A client-side timeout (iOS hung the request) is transient — the write
  // never reached the server, so queue it and hand the caller a synthetic
  // success rather than leaving the form stuck on "Saving…". A caller-
  // initiated abort (query cancellation) surfaces as a DOMException named
  // "AbortError", which is NOT a TimeoutError, so it falls through to the
  // final `return false` and is rethrown as a cancellation (never queued).
  if (err instanceof TimeoutError) return true;
  // TypeError from fetch == network failure. The classic "navigator
  // didn't even reach the server" case; obvious queue candidate.
  if (err instanceof TypeError) return true;
  if (err instanceof ApiError) {
    // 5xx is transient — server might recover; queue + retry.
    if (err.status >= 500) return true;
    // 401 here means the refresh + retry dance in api() already failed.
    // Session is fully expired; queue and let post-login sync drain.
    if (err.status === 401) return true;
    // 4xx → caller error (validation / missing baby / etc.). Don't
    // queue; surface to the user immediately.
    return false;
  }
  // Unknown error type — be conservative and surface, don't queue.
  return false;
}

// Outbox dispatcher: drives replay attempts. Returns a tagged result
// the outbox uses to decide drop / dead / pending / retry.
async function outboxDispatch(record: {
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}): Promise<DispatchResult> {
  try {
    const data = await api<unknown>(record.path, {
      method: record.method,
      body: record.body,
    });
    return { kind: "ok", status: 200, data };
  } catch (err) {
    if (err instanceof TimeoutError) {
      // Hung replay send — retry with backoff, don't misclassify as dead.
      return { kind: "transient", status: 0, message: err.message };
    }
    if (err instanceof TypeError) {
      return {
        kind: "transient",
        status: 0,
        message: err.message || "network error",
      };
    }
    if (err instanceof ApiError) {
      if (err.status === 401) {
        return { kind: "auth_error", status: 401, message: err.message };
      }
      if (err.status >= 500) {
        return { kind: "transient", status: err.status, message: err.message };
      }
      return { kind: "client_error", status: err.status, message: err.message };
    }
    return {
      kind: "transient",
      status: 0,
      message: (err as Error)?.message ?? "dispatch failed",
    };
  }
}

// Wire the dispatcher at module load. Tests that want to swap it can
// call setDispatcher(...) themselves.
setDispatcher(outboxDispatch);
