// Pathless layout for authenticated screens. Redirects to /login if the
// auth bootstrap landed anonymous; lets initializing pass through so we don't
// flash a redirect during the first paint.
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useAuthStore } from "../lib/authStore";

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
  return <Outlet />;
}
