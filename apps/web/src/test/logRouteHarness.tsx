/* eslint-disable react-refresh/only-export-components -- test-only module; it exports helpers, not components */
// Shared scaffolding for the characterization ("freeze") tests of the eight
// /log/* form routes (apps/web/src/routes/_app.log.*.tsx).
//
// Seam: each route module is loaded as-is and mounted under a REAL TanStack
// memory router (createMemoryHistory + RouterProvider) with a "/" route, so
// `useNavigate`, `Route.useSearch` and search validation run for real. Above
// the router sit a real QueryClient and the real api.ts / outbox.ts /
// eventKind.ts stack (IndexedDB via fake-indexeddb, through queryHarness). Only
// the platform edges are stubbed: global fetch (queryHarness.stubFetch), the
// clock (Date only), crypto.randomUUID, and the photo pipeline's browser APIs
// (createImageBitmap, canvas 2d context + toBlob, URL object URLs).
//
// Time zone: the tests pin TZ to Asia/Jakarta (UTC+7, no DST) at import time.
// Node re-reads process.env.TZ on assignment, so this works without a global
// setup file. Every local-datetime literal in the freeze tests assumes it.
//
// Usage: each test file calls installLogRouteHarness() once at module level and
// mounts a route with renderLogRoute().
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRoute,
  type AnyRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, vi } from "vitest";

import {
  EXISTING_ID,
  type FetchCall,
  installQueryHarness,
  json,
  noContent,
  ROW_ID,
  stubFetch,
} from "./queryHarness";

process.env.TZ = "Asia/Jakarta";

export const HOUSEHOLD_ID = "h1";
export const BABY_ID = "55555555-5555-4555-8555-555555555555";
export const OTHER_BABY_ID = "66666666-6666-4666-8666-666666666666";
// Fixed clock from queryHarness.NOW (2026-11-22T10:00:00Z) = 17:00 in Jakarta.
export const NOW_LOCAL_INPUT = "2026-11-22T17:00";
export const NOW_ISO = "2026-11-22T10:00:00.000Z";

// Bytes the stubbed canvas.toBlob returns. Base64 of "JPEGBYTES" is the
// photo payload the route is expected to send.
export const STUB_JPEG_BYTES = "JPEGBYTES";
export const STUB_JPEG_BASE64 = "SlBFR0JZVEVT";

export const DEFAULT_PREFS = {
  time_format: "24h",
  show_recommended_targets: true,
  chart_palette: { preset: "default", overrides: {} },
  feature_visibility: {},
  autofill_bottle_amount: false,
};

export const DEFAULT_SETTINGS = {
  unit_volume: "ml",
  unit_length: "cm",
  unit_weight: "kg",
  day_start_hour: 0,
};

// Path segment → route kind, used to pick the list / item / photo URLs.
export type Segment =
  | "bottle-feeds"
  | "diapers"
  | "solid-meals"
  | "notes"
  | "pumpings"
  | "nursing-sessions"
  | "sleeps"
  | "growths";

export interface Backend {
  // Rows served by GET /v1/babies/<BABY_ID>/<segment>... (any query string).
  lists?: Partial<Record<Segment, unknown[]>>;
  prefs?: Partial<typeof DEFAULT_PREFS>;
  settings?: Partial<typeof DEFAULT_SETTINGS>;
  // Bytes served by GET /v1/<segment>/<id>/photo.
  // A string body, not a Blob: Node's Response rejects jsdom Blobs as bodies.
  photo?: string;
  // Lets a test answer a specific call itself. Return undefined to fall through.
  respond?: (call: FetchCall) => Response | undefined;
}

export type LogRouteName =
  | "bottle"
  | "diaper"
  | "solids"
  | "note"
  | "pumping"
  | "nursing"
  | "sleep"
  | "growth";

const LOADERS: Record<LogRouteName, () => Promise<RouteModule>> = {
  bottle: () => import("../routes/_app.log.bottle") as Promise<RouteModule>,
  diaper: () => import("../routes/_app.log.diaper") as Promise<RouteModule>,
  solids: () => import("../routes/_app.log.solids") as Promise<RouteModule>,
  note: () => import("../routes/_app.log.note") as Promise<RouteModule>,
  pumping: () => import("../routes/_app.log.pumping") as Promise<RouteModule>,
  nursing: () => import("../routes/_app.log.nursing") as Promise<RouteModule>,
  sleep: () => import("../routes/_app.log.sleep") as Promise<RouteModule>,
  growth: () => import("../routes/_app.log.growth") as Promise<RouteModule>,
};

// The route modules export `Route`; only the options we re-mount with are typed.
interface RouteModule {
  Route: {
    id: string;
    options: {
      validateSearch?: unknown;
      component?: () => React.ReactElement;
    };
  };
}

export interface RenderedRoute {
  qc: QueryClient;
  calls: FetchCall[];
  router: AnyRouter;
  // Current location as "pathname?search", e.g. "/" after a successful save.
  location: () => string;
}

// Installs the query harness plus the photo/clock stubs. Call once at module
// level in each freeze test file.
export function installLogRouteHarness(): void {
  installQueryHarness();

  let restore: Array<() => void> = [];
  beforeEach(() => {
    // jsdom has no layout; the router's scroll-restore call only logs noise.
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (file: Blob) => {
        // Chrome/Firefox/Android cannot decode HEIC; the browser throws this.
        if (file.type === "image/heic" || file.type === "image/heif") {
          throw new DOMException("The source image could not be decoded.", "InvalidStateError");
        }
        return { width: 4000, height: 3000, close() {} };
      }),
    );
    const proto = HTMLCanvasElement.prototype;
    const origCtx = proto.getContext;
    const origToBlob = proto.toBlob;
    proto.getContext = (() => ({ drawImage() {} })) as unknown as typeof origCtx;
    proto.toBlob = function (cb: BlobCallback) {
      cb(new Blob([STUB_JPEG_BYTES], { type: "image/jpeg" }));
    } as typeof origToBlob;
    restore = [
      () => {
        proto.getContext = origCtx;
        proto.toBlob = origToBlob;
      },
    ];
    URL.createObjectURL = vi.fn(() => "blob:fake-preview");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    cleanup();
    for (const fn of restore) fn();
    restore = [];
    vi.unstubAllGlobals();
  });
}

function backendResponder(backend: Backend) {
  return (call: FetchCall): Response => {
    const custom = backend.respond?.(call);
    if (custom) return custom;
    const url = new URL(call.url, "http://x");
    const path = url.pathname.replace(/^\/v1/, "");

    if (call.method === "GET") {
      if (path === "/households") return json([{ id: HOUSEHOLD_ID, name: "Home" }]);
      if (path === `/households/${HOUSEHOLD_ID}/babies`) {
        return json([{ id: BABY_ID, household_id: HOUSEHOLD_ID, name: "Ada" }]);
      }
      if (path === "/me/preferences") return json({ ...DEFAULT_PREFS, ...backend.prefs });
      if (path === `/babies/${BABY_ID}/settings`) {
        return json({ ...DEFAULT_SETTINGS, ...backend.settings });
      }
      const photo = path.match(/^\/([a-z-]+)\/([^/]+)\/photo$/);
      if (photo) {
        return backend.photo
          ? new Response(backend.photo, {
              status: 200,
              headers: { "content-type": "image/jpeg" },
            })
          : new Response(null, { status: 204 });
      }
      const list = path.match(new RegExp(`^/babies/${BABY_ID}/([a-z-]+)$`));
      if (list) {
        const seg = list[1] as Segment;
        return json(backend.lists?.[seg] ?? []);
      }
    }

    if (call.method === "POST") {
      const seg = path.match(new RegExp(`^/babies/${BABY_ID}/([a-z-]+)$`))?.[1];
      if (seg) {
        const body = (call.body ?? {}) as Record<string, unknown>;
        return json({ ...body, id: body.id ?? ROW_ID, baby_id: BABY_ID, source: "manual" }, 201);
      }
    }

    if (call.method === "PATCH") {
      const m = path.match(/^\/([a-z-]+)\/([^/]+)$/);
      if (m) return json({ ...(call.body as object), id: m[2] }, 200);
    }

    if (call.method === "DELETE") return noContent();

    return json({ error: { code: "not_found", message: `no fake for ${call.method} ${path}` } }, 404);
  };
}

// Mounts one /log/* route at `url` under the real memory router.
export async function renderLogRoute(
  name: LogRouteName,
  url: string,
  opts: { backend?: Backend; seed?: (qc: QueryClient) => void } = {},
): Promise<RenderedRoute> {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const calls = stubFetch(backendResponder(opts.backend ?? {}));
  opts.seed?.(qc);

  const mod = await LOADERS[name]();
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <p>home</p>,
  });
  // Re-mount the module's own options under a path the test router can match.
  // The module's `Route.useSearch()` binds to `Route.id`, so keep that id.
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: mod.Route.id,
    path: "/log/" + name,
    validateSearch: mod.Route.options.validateSearch as never,
    component: mod.Route.options.component,
  });
  // The route tree is assembled from per-test createRoute calls, so its generic
  // types cannot be inferred against the app's registered router; cast here only.
  const options = {
    routeTree: rootRoute.addChildren([homeRoute, pageRoute] as unknown as AnyRoute[]),
    history: createMemoryHistory({ initialEntries: [url] }),
  };
  const router = createRouter(options as never) as unknown as AnyRouter;

  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await waitFor(() => {
    if (!router.state.location.pathname.startsWith("/log/")) throw new Error("not on route");
    // Every log route renders a <main> once it has a babyId. Waiting for it
    // lets the mount effects (prefill, focus listeners) run before a test acts.
    if (!document.querySelector("main")) throw new Error("route not rendered yet");
  });
  await flush();

  return {
    qc,
    calls,
    router,
    location: () => {
      const { pathname, searchStr } = router.state.location;
      return `${pathname}${searchStr}`;
    },
  };
}

// Non-GET calls only: the mutations a freeze test asserts on.
export function mutations(calls: FetchCall[]): FetchCall[] {
  return calls.filter((c) => c.method !== "GET");
}

// Local datetime input value → what the browser sends as ISO (Jakarta UTC+7).
export function fillDatetime(el: HTMLElement, value: string): void {
  fireEvent.change(el, { target: { value } });
}

export async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

export { EXISTING_ID, ROW_ID, screen, waitFor, fireEvent, act };
