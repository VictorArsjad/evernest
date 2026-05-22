// Auth state lives in memory (so it doesn't survive a hard reload, which is
// fine — we re-hydrate by calling /v1/auth/refresh on app boot using the
// httpOnly refresh cookie).
//
// The token is intentionally NOT persisted to localStorage: that would defeat
// the point of httpOnly cookies for the refresh token and would expose the
// access token to any XSS we ship.
import { create } from "zustand";
import type { User } from "./types";

interface AuthState {
  accessToken: string | null;
  expiresAt: string | null;
  user: User | null;
  status: "initializing" | "anonymous" | "authenticated";
  setSession: (t: { access_token: string; expires_at: string; user: User }) => void;
  setUser: (user: User) => void;
  clear: () => void;
  setAnonymous: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  expiresAt: null,
  user: null,
  status: "initializing",
  setSession: ({ access_token, expires_at, user }) =>
    set({ accessToken: access_token, expiresAt: expires_at, user, status: "authenticated" }),
  setUser: (user) => set({ user }),
  clear: () => set({ accessToken: null, expiresAt: null, user: null, status: "anonymous" }),
  setAnonymous: () => set({ status: "anonymous", accessToken: null, expiresAt: null, user: null }),
}));
