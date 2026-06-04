import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";

import { bootstrapAuth } from "./lib/api";
import { sync as syncOutbox } from "./lib/outbox";
import { routeTree } from "./routeTree.gen";
import "./styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => {
        // Don't retry auth errors; let the route guards handle them.
        const status = (err as { status?: number } | undefined)?.status;
        if (status === 401 || status === 403) return false;
        return count < 1;
      },
      // Multi-device sync: when the user comes back to the PWA on
      // device B after logging on device A, refetch so the list shows
      // the new entry without manual reload. The schema is idempotent
      // (client-generated UUIDs + ON CONFLICT DO NOTHING) so a refetch
      // racing an in-flight write is safe.
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // Per-query `refetchInterval`s (see queries.ts) only fire while
      // the tab is visible — no battery/network spend on hidden tabs.
      refetchIntervalInBackground: false,
      staleTime: 30_000,
    },
    mutations: { retry: 0 },
  },
});

// Vite injects BASE_URL from the `base` config (e.g. "/evernest/" on GH
// Pages, "/" on local dev). TanStack Router needs this as `basepath` or it
// tries to match "/evernest/..." against route entries defined as "/..."
// and renders a 404. Strip the trailing slash — router expects no trailing.
const ROUTER_BASEPATH = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  basepath: ROUTER_BASEPATH,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

// Try to silently refresh the session before first render. Falls through to
// the anonymous state if the refresh cookie is missing/expired. We don't
// gate rendering on this — the route guards read the auth store and handle
// the redirect when state lands.
bootstrapAuth().finally(() => {
  createRoot(rootEl).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
  // CP6b: kick a single drain attempt of the offline mutation outbox
  // once the auth bootstrap settled. Records pending from a previous
  // session (the user closed the tab while offline; refresh just now)
  // get re-sent here. Failure (still offline) is silent — useOutbox
  // will retry on `window.online` and on subsequent mutations.
  void syncOutbox();
});
