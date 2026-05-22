import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";

import { bootstrapAuth } from "./lib/api";
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
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: { retry: 0 },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
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
});
