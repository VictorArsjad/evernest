// Auth state.
//
// - access token  → in memory only; doesn't survive a hard reload (we
//   re-hydrate by calling /v1/auth/refresh on app boot).
// - user object   → in memory only; same story.
// - refresh token → NOT persisted by JS. The FE and API share an origin
//   (the API binary embeds the SPA — see apps/api/internal/spa), so the
//   BE keeps the refresh token in a first-party httpOnly cookie. On a
//   reload / PWA cold start, bootstrapAuth() POSTs /v1/auth/refresh with
//   `credentials: 'include'` and the browser supplies the cookie. We keep
//   the token value in memory only (from the response body) so
//   ensureFreshToken() can tell a logged-in session from an anonymous one.
//
// Why the cookie and not localStorage: a first-party cookie survives iOS
// WebKit's ITP eviction of script-writable storage, which used to silently
// log users out. httpOnly also keeps the token out of reach of XSS. The
// token is opaque + rotated on every use (apps/api/internal/auth/
// sessions.go); re-using a rotated token returns 401.
import { create } from "zustand";
import type { User } from "./types";

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
  refreshToken: null,
  user: null,
  status: "initializing",
  setSession: ({ access_token, expires_at, refresh_token, user }) => {
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
    set({
      accessToken: null,
      expiresAt: null,
      refreshToken: null,
      user: null,
      status: "anonymous",
    });
  },
  setAnonymous: () => {
    set({
      status: "anonymous",
      accessToken: null,
      expiresAt: null,
      refreshToken: null,
      user: null,
    });
  },
}));
