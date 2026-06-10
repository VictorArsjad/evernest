import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";

import { AuthGate } from "../components/AuthGate";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  // App is mobile-first; cap at max-w-md and center on larger screens.
  // The env(safe-area-inset-*) padding pushes in-flow content out from
  // under the iOS Dynamic Island / status bar / home indicator and the
  // Android gesture-nav handle. Padding lives on the same element as
  // bg-bg-base so the dark background still bleeds to the screen edges
  // (matching apple-mobile-web-app-status-bar-style="black-translucent");
  // only the inner content is inset.
  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col bg-bg-base pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <AuthGate>
        <Outlet />
      </AuthGate>
    </div>
  );
}
