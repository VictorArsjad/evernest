// Typed fetch wrapper.
//
// Behavior:
// - Includes `credentials: 'include'` so the refresh cookie is sent.
// - Attaches the in-memory access token as `Authorization: Bearer ...`.
// - On a 401 from a non-/auth request, attempts a single refresh and retries
//   the original request once. If refresh fails, clears auth state.
// - Throws `ApiError` (with the server's error envelope when present) on
//   non-2xx responses so TanStack Query treats them as errors.
import { useAuthStore } from "./authStore";
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

async function tryRefresh(): Promise<TokenResponse | null> {
  if (!refreshInflight) {
    refreshInflight = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: "POST",
          credentials: "include",
        });
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
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  };

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
