// Decides where a route layout should redirect a user based on the
// auth store's current status.
//
// Why this exists: route guards in `_app.tsx` / `_auth.tsx` were using
// TanStack Router's `beforeLoad` to gate access. `beforeLoad` only runs
// once at navigation time, so a hard refresh of `/` (which boots the
// store at `status: "initializing"`) would slip past the `_app` guard
// — the guard saw "not anonymous" and waved the user through. Then
// when `bootstrapAuth()` resolved with no valid refresh token and
// flipped status to `"anonymous"`, nothing re-evaluated the route, the
// Today page sat firing queries with no access token, every query
// 401'd, and the user got stranded on the "Setting up…" fallback
// forever. iPad first-visit and Chrome incognito both tripped this
// deterministically because they have empty localStorage; devices with
// a stored refresh token hid the bug because bootstrap completed
// before the page tried to render data.
//
// The fix is to add a reactive `useEffect` inside each layout that
// subscribes to the store and navigates on status changes. This module
// is the pure decision helper that effect calls so we can unit-test
// the redirect contract without dragging jsdom into the suite (vitest
// is intentionally configured node-only — see vitest.config.ts).

import type { AuthStatus } from "./authStore";

// Where a user inside the authenticated surface (`/_app/*`) should go
// based on auth status. `"initializing"` returns null — the AuthGate
// splash covers that window and we don't want to bounce off the route
// during the boot race we're fixing.
export function authedSurfaceRedirect(status: AuthStatus): "/login" | null {
  return status === "anonymous" ? "/login" : null;
}

// Symmetric helper for the anonymous-only surface (`/_auth/*`). A user
// who logs in mid-paint (e.g. a fast bootstrap on a warm cache) gets
// bounced into the app instead of being left sitting on /login.
export function anonSurfaceRedirect(status: AuthStatus): "/" | null {
  return status === "authenticated" ? "/" : null;
}
