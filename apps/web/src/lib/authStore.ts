// Auth state.
//
// - access token  → in memory only; doesn't survive a hard reload (we
//   re-hydrate by calling /v1/auth/refresh on app boot).
// - user object   → in memory only; same story.
// - refresh token → persisted to localStorage so we can hit
//   /v1/auth/refresh after a reload (or PWA cold start) without depending
//   on a cookie. iOS Safari ITP blocks cross-site cookies between
//   github.io and our ts.net API, which used to silently log users out
//   every ~15min when the access token expired. See package doc in
//   apps/api/internal/auth/handlers.go for the full reasoning.
//
// Trade-off vs. the old httpOnly-cookie design: an XSS now also reads the
// refresh token, not just the access token. The token is opaque + rotated
// on every use (apps/api/internal/auth/sessions.go), and re-using a
// rotated token returns 401 — so a stolen refresh token is bounded to the
// next legitimate refresh by the legitimate client.
import { create } from "zustand";
import type { User } from "./types";

const REFRESH_TOKEN_STORAGE_KEY = "evernest_refresh_token";

// safeStorage wraps localStorage in a try/catch because Safari throws on
// access in private mode (and IndexedDB-backed shims do the same). We
// fall through to "no persistence" rather than crashing the app — the
// user just gets logged out on reload, which matches the old behavior.
const safeStorage = {
  get(key: string): string | null {
    try {
      return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
    } catch {
      /* private mode / quota — give up silently */
    }
  },
  remove(key: string): void {
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(key);
    } catch {
      /* same as set() */
    }
  },
};

export function readStoredRefreshToken(): string | null {
  return safeStorage.get(REFRESH_TOKEN_STORAGE_KEY);
}

// "initializing" is the boot-time placeholder before bootstrapAuth()
// resolves. The AuthGate splash covers this state; route layouts use
// the authRedirect helpers (lib/authRedirect.ts) to react when this
// transitions to "anonymous" / "authenticated" post-mount.
export type AuthStatus = "initializing" | "anonymous" | "authenticated";

interface AuthState {
  accessToken: string | null;
  expiresAt: string | null;
  refreshToken: string | null;
  user: User | null;
  status: AuthStatus;
  setSession: (t: {
    access_token: string;
    expires_at: string;
    refresh_token: string;
    refresh_expires_at: string;
    user: User;
  }) => void;
  setUser: (user: User) => void;
  clear: () => void;
  setAnonymous: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  expiresAt: null,
  refreshToken: readStoredRefreshToken(),
  user: null,
  status: "initializing",
  setSession: ({ access_token, expires_at, refresh_token, user }) => {
    safeStorage.set(REFRESH_TOKEN_STORAGE_KEY, refresh_token);
    set({
      accessToken: access_token,
      expiresAt: expires_at,
      refreshToken: refresh_token,
      user,
      status: "authenticated",
    });
  },
  setUser: (user) => set({ user }),
  clear: () => {
    safeStorage.remove(REFRESH_TOKEN_STORAGE_KEY);
    set({
      accessToken: null,
      expiresAt: null,
      refreshToken: null,
      user: null,
      status: "anonymous",
    });
  },
  setAnonymous: () => {
    safeStorage.remove(REFRESH_TOKEN_STORAGE_KEY);
    set({
      status: "anonymous",
      accessToken: null,
      expiresAt: null,
      refreshToken: null,
      user: null,
    });
  },
}));
