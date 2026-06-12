// Pathless layout for anonymous-only screens (login/register). Same
// two-layer guard as `_app.tsx` but in the opposite direction:
//
//   1. `beforeLoad` redirects already-authenticated users to / on
//      navigation so we never even mount the login form for someone
//      who has a valid session.
//
//   2. `useEffect` reacts to status changes after mount — e.g. a fast
//      bootstrap that resolves to "authenticated" right after the
//      login form paints — so the user gets dropped into the app
//      instead of being left staring at the login screen with no
//      session needed.
import { Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuthStore } from "../lib/authStore";
import { anonSurfaceRedirect } from "../lib/authRedirect";

export const Route = createFileRoute("/_auth")({
  beforeLoad: () => {
    if (useAuthStore.getState().status === "authenticated") {
      throw redirect({ to: "/" });
    }
  },
  component: AuthLayout,
});

function AuthLayout() {
  const nav = useNavigate();
  const status = useAuthStore((s) => s.status);
  useEffect(() => {
    const target = anonSurfaceRedirect(status);
    if (target) void nav({ to: target, replace: true });
  }, [status, nav]);
  return (
    <main className="flex flex-1 flex-col items-stretch justify-center p-6">
      <div className="mb-8 text-center">
        <h1 className="text-4xl font-semibold tracking-tight">Evernest</h1>
        <p className="mt-1 text-sm text-white/60">Track feedings, diapers, growth.</p>
      </div>
      <Outlet />
    </main>
  );
}
