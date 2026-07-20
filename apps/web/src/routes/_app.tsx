// Pathless layout for authenticated screens. Two-layer auth gate:
//
//   1. `beforeLoad` (synchronous, runs once at navigation time): if the
//      store is already known anonymous, redirect to /login immediately
//      so we never even mount the route.
//
//   2. `useEffect` (reactive, runs whenever auth status changes): if
//      the store flips to anonymous *after* mount — the most common
//      case being a hard refresh of `/` where the store starts at
//      "initializing", the guard waves the user through, and then
//      bootstrapAuth() resolves with no valid refresh token — bounce
//      to /login. Without this second layer, queries on the mounted
//      page silently 401 and the user gets stranded on the Today
//      page's "Setting up…" fallback forever. iPad first-visit and
//      Chrome incognito both tripped this before; devices with a
//      stored refresh token hid the bug because bootstrap completed
//      before the page tried to render data.
import {
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { AppNav } from "../components/AppNav";
import { useAuthStore } from "../lib/authStore";
import { authedSurfaceRedirect } from "../lib/authRedirect";

// The bottom tab bar only belongs on the primary destinations. The
// /log/* forms and /onboarding are focused sub-flows with their own
// Cancel/Save chrome, so the bar stays hidden there.
const NAV_PATHS = new Set(["/", "/growth", "/charts", "/settings"]);

export const Route = createFileRoute("/_app")({
  beforeLoad: () => {
    const status = useAuthStore.getState().status;
    if (status === "anonymous") {
      throw redirect({ to: "/login" });
    }
  },
  component: AppLayout,
});

function AppLayout() {
  const nav = useNavigate();
  const status = useAuthStore((s) => s.status);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    const target = authedSurfaceRedirect(status);
    if (target) void nav({ to: target, replace: true });
  }, [status, nav]);
  return (
    <>
      <Outlet />
      {NAV_PATHS.has(pathname) && <AppNav />}
    </>
  );
}
