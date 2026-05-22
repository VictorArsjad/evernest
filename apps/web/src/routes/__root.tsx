import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  // App is mobile-first; cap at max-w-md and center on larger screens.
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-bg-base">
      <Outlet />
    </div>
  );
}
