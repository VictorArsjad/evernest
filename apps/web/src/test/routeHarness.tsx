import "./pinTz";
// Route-level harness for the Today and Charts freeze tests.
//
// Mounts the REAL routeTree in a memory-history router, so the real route
// guards, AuthGate, AppNav and the real query hooks (api.ts, queries.ts,
// outbox) all run. Only the network edge is replaced: fetch answers each
// endpoint from a fixture. List endpoints apply from/to/limit the way the API
// does (inclusive window, newest first, then limit), so the derived values
// are computed from real windows rather than from a pre-filtered fixture.
//
// Times in fixtures are literal ISO instants. Local readings in comments are
// Asia/Jakarta (UTC+7). "Now" is NOW from queryHarness: 2026-11-22T10:00:00Z,
// which is 17:00 local on Sunday 2026-11-22.
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { beforeEach, vi } from "vitest";

import { useAuthStore } from "../lib/authStore";
import { routeTree } from "../routeTree.gen";
import {
  BABY,
  NOW,
  installQueryHarness,
  json,
  noContent,
  setup,
  stubFetch,
  type FetchCall,
} from "./queryHarness";

export type Row = Record<string, unknown>;

export type Segment =
  | "bottle-feeds"
  | "diapers"
  | "pumpings"
  | "nursing-sessions"
  | "sleeps"
  | "growths"
  | "solid-meals"
  | "notes";

export interface RouteFixture {
  baby: Row;
  preferences: Row;
  settings: Row;
  lists: Partial<Record<Segment, Row[]>>;
  // The /open endpoints: a row, or absent for 204 (nothing running).
  open: Partial<Record<"nursing-sessions" | "sleeps", Row>>;
  // ChartDaily rows, one per local date. The endpoint filters them by window.
  charts: Row[];
}

export const HOUSEHOLD_ID = "h1";

// Preferences the app falls back to when nothing is stored, except the
// fields a test needs to vary. feature_visibility {} means every feature shows.
export const BASE_PREFERENCES: Row = {
  user_id: "u1",
  time_format: "24h",
  timezone: "Asia/Jakarta",
  locale: "en-US",
  show_recommended_targets: true,
  chart_palette: { preset: "default", overrides: {} },
  feature_visibility: {},
  autofill_bottle_amount: true,
  updated_at: NOW,
};

export const BASE_SETTINGS: Row = {
  baby_id: BABY,
  unit_volume: "ml",
  unit_length: "cm",
  unit_weight: "kg",
  day_start_hour: 0,
};

// Baby born 2026-05-22: six months old on NOW, so the age brackets are the
// 6-month row (daily targets: bottle 900 ml, nursing 120 min, pumping 720 ml,
// diapers 6; wake window 90–150 min).
export const BASE_BABY: Row = {
  id: BABY,
  household_id: HOUSEHOLD_ID,
  name: "Ada",
  date_of_birth: "2026-05-22",
  sex: null,
  created_at: "2026-05-22T00:00:00Z",
};

export function baseFixture(over: Partial<RouteFixture> = {}): RouteFixture {
  return {
    baby: BASE_BABY,
    preferences: BASE_PREFERENCES,
    settings: BASE_SETTINGS,
    lists: {},
    open: {},
    charts: [],
    ...over,
  };
}

// One event row. `field` is the instant the list endpoint filters and sorts on.
export function row(id: string, field: string, at: string, extra: Row = {}): Row {
  return { id, baby_id: BABY, [field]: at, created_at: at, source: "app", ...extra };
}

const TIME_FIELD: Record<Segment, string> = {
  "bottle-feeds": "occurred_at",
  diapers: "occurred_at",
  pumpings: "occurred_at",
  "solid-meals": "occurred_at",
  notes: "occurred_at",
  "nursing-sessions": "started_at",
  sleeps: "started_at",
  growths: "measured_at",
};

function filterList(rows: Row[], segment: Segment, sp: URLSearchParams): Row[] {
  const field = TIME_FIELD[segment];
  const from = sp.get("from");
  const to = sp.get("to");
  const limit = sp.get("limit");
  let out = rows.filter((r) => {
    const t = Date.parse(String(r[field]));
    if (from && t < Date.parse(from)) return false;
    if (to && t > Date.parse(to)) return false;
    return true;
  });
  out = out.sort((a, b) => Date.parse(String(b[field])) - Date.parse(String(a[field])));
  if (limit) out = out.slice(0, Number(limit));
  return out;
}

function respond(f: RouteFixture) {
  return (call: FetchCall): Response => {
    const url = new URL(call.url, "http://localhost");
    const p = url.pathname;
    if (p === "/v1/households") {
      return json([{ id: HOUSEHOLD_ID, name: "Home", role: "owner", created_at: "2026-05-01T00:00:00Z" }]);
    }
    if (p === `/v1/households/${HOUSEHOLD_ID}/babies`) return json([f.baby]);
    if (p === "/v1/me/preferences") return json(f.preferences);
    const m = /^\/v1\/babies\/([^/]+)\/(.+)$/.exec(p);
    if (!m) return json({ error: "not_found" }, 404);
    const rest = m[2];
    if (rest === "settings") return json(f.settings);
    if (rest === "charts/daily") {
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      return json({ days: f.charts.filter((d) => String(d.date) >= from && String(d.date) <= to) });
    }
    const open = /^(nursing-sessions|sleeps)\/open$/.exec(rest);
    if (open) {
      const r = f.open[open[1] as "nursing-sessions" | "sleeps"];
      return r ? json(r) : noContent();
    }
    const segment = rest as Segment;
    const rows = f.lists[segment];
    if (!rows || !(segment in TIME_FIELD)) return json({ error: "not_found" }, 404);
    return json(filterList(rows, segment, url.searchParams));
  };
}

// Mounts the real router at `path`. Returns the live fetch log.
export function renderAt(path: string, fixture: RouteFixture) {
  const calls = stubFetch(respond(fixture));
  const { qc } = setup();
  const router = createRouter({
    routeTree,
    context: { queryClient: qc },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { calls };
}

// The banner stat cell for an icon: its textContent is icon + head + tail
// with no separators, e.g. "🍼180ml". The Tile grid also uses icons, but
// those sit in a different wrapper, so only banner cells match here.
export function statCell(icon: string): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>("div.items-baseline")).find(
      (el) => el.firstElementChild?.textContent === icon,
    ) ?? null
  );
}

export function cellText(icon: string): string | null {
  return statCell(icon)?.textContent ?? null;
}

// Width of a banner cell's progress bar, or null when the cell has no bar.
export function cellBar(icon: string): string | null {
  return (
    statCell(icon)?.parentElement?.querySelector<HTMLElement>(".h-1 > div")?.style.width ?? null
  );
}

// Dispatches a mouse pointerup the way a desktop click arrives. jsdom has no
// PointerEvent, so pointerType is attached by hand; React reads it from the
// native event.
export function mouseUp(el: Element): void {
  const ev = new Event("pointerup", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "pointerType", { value: "mouse" });
  el.dispatchEvent(ev);
}

export function installRouteHarness(): void {
  installQueryHarness();
  beforeEach(() => {
    useAuthStore.setState({
      status: "authenticated",
      user: {
        id: "u1",
        email: "test@example.test",
        display_name: "Test Parent",
        created_at: "2026-05-01T00:00:00Z",
      },
    });
    // useInstallPrompt reads matchMedia without a guard; jsdom has none.
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }));
    // Jump-to-day scrolls the target section into view; jsdom has no layout.
    Element.prototype.scrollIntoView = vi.fn();
    // Swipe and window changes call scrollTo; jsdom logs "not implemented".
    window.scrollTo = vi.fn();
  });
}
