// Pathless layout for anonymous-only screens (login/register). If the user is
// already authenticated, bounce to the app root.
import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useAuthStore } from "../lib/authStore";

export const Route = createFileRoute("/_auth")({
  beforeLoad: () => {
    if (useAuthStore.getState().status === "authenticated") {
      throw redirect({ to: "/" });
    }
  },
  component: AuthLayout,
});

function AuthLayout() {
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
