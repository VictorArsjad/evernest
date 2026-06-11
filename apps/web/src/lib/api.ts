// Typed fetch wrapper.
//
// Behavior:
// - Attaches the in-memory access token as `Authorization: Bearer ...`.
// - On a 401 from a non-/auth request, attempts a single refresh and retries
//   the original request once. If refresh fails, clears auth state.
// - Throws `ApiError` (with the server's error envelope when present) on
//   non-2xx responses so TanStack Query treats them as errors.
//
// Refresh-token transport: the token is persisted in localStorage by
// authStore (see authStore.ts header comment) and sent in the body of
// /v1/auth/refresh + /v1/auth/logout. iOS Safari ITP blocks cross-site
// cookies between github.io and our ts.net API, which used to log users
// out every ~15min. For migration safety, if localStorage is empty we
// fall through to a single `credentials: 'include'` refresh call so a
// user with the legacy cookie still gets a clean upgrade on first page
// load post-deploy. Once the cookie path is removed BE-side we can drop
// the fallback here too.
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

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  // Skip the access-token attachment + 401-refresh dance. Used for /auth/*.
  skipAuth?: boolean;
  signal?: AbortSignal;
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

async function ensureFreshToken(): Promise<void> {
  const { accessToken, expiresAt, refreshToken } = useAuthStore.getState();
  if (!accessToken || !refreshToken || !expiresAt) return;
  const msUntil = new Date(expiresAt).getTime() - Date.now();
  if (msUntil > EXPIRY_BUFFER_MS) return;
  await tryRefresh();
}

async function tryRefresh(): Promise<TokenResponse | null> {
  if (!refreshInflight) {
    refreshInflight = (async () => {
      try {
        const stored = useAuthStore.getState().refreshToken;
        // Prefer the body-based call. If localStorage is empty (first
        // boot post-deploy with only the legacy cookie), fall back to
        // credentials:'include' with an empty body so the BE picks the
        // cookie up and we get migrated to localStorage on success.
        const init: RequestInit = stored
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refresh_token: stored }),
            }
          : {
              method: "POST",
              credentials: "include",
            };
        const res = await fetch(`${BASE}/auth/refresh`, init);
        if (!res.ok) return null;
        const data = (await res.json()) as TokenResponse;
        useAuthStore.getState().setSession(data);
        return data;
      } catch {
        return null;
      } finally {
        // Allow the next refresh attempt to proceed.
        queueMicrotask(() => {
          refreshInflight = null;
        });
      }
    })();
  }
  return refreshInflight;
}

export async function api<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = "GET", body, skipAuth = false, signal } = opts;

  const doFetch = async (token: string | null) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token && !skipAuth) headers.Authorization = `Bearer ${token}`;

    return fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
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
    return fetch(`${BASE}${path}`, { method: "GET", headers, signal: opts.signal });
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

// Convenience: bootstrap the auth store by attempting a silent refresh.
// Returns true if we ended up authenticated, false otherwise.
export async function bootstrapAuth(): Promise<boolean> {
  const refreshed = await tryRefresh();
  if (!refreshed) {
    useAuthStore.getState().setAnonymous();
    return false;
  }
  return true;
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
