// @vitest-environment jsdom
// Characterization ("freeze") tests for the Charts & History route's derived
// values: window summaries, per-day averages, sleep-day attribution, window
// navigation and jump-to-day.
//
// Expected strings are literals worked out by hand from the fixture below.
//
// Clock: NOW = 2026-11-22T10:00:00Z = Sunday 17:00 Asia/Jakarta. Default
// window = 14 days ending today: Nov 9 – Nov 22. Local times in comments are
// Asia/Jakarta (UTC+7). day_start_hour = 6 (sleep-day cutover).
import "./pinTz";

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  baseFixture,
  BASE_SETTINGS,
  installRouteHarness,
  mouseUp,
  renderAt,
  row,
  type RouteFixture,
} from "./routeHarness";

installRouteHarness();

const DAY_START_6 = { ...BASE_SETTINGS, day_start_hour: 6 };

const CHARTS: RouteFixture["charts"] = [
  // Literal per-day rows, independent of the event lists below. They feed
  // only the chart primaries and averages. The day-group summaries come from
  // events.
  {
    date: "2026-11-20",
    bottle_ml: 600,
    bottle_ml_breast: 400,
    bottle_ml_formula: 200,
    nursing_minutes: 120,
    pumping_ml: 60,
    diaper_total: 6,
    diaper_wet: 6,
    diaper_soiled: 0,
    diaper_mixed: 0,
    growth: { weight_g: 8150, height_cm: null, head_cm: null },
  },
  {
    date: "2026-11-21",
    bottle_ml: 720,
    bottle_ml_breast: 500,
    bottle_ml_formula: 220,
    nursing_minutes: 100,
    pumping_ml: 90,
    diaper_total: 5,
    diaper_wet: 5,
    diaper_soiled: 0,
    diaper_mixed: 0,
    growth: { weight_g: null, height_cm: null, head_cm: null },
  },
  {
    date: "2026-11-22",
    bottle_ml: 180,
    bottle_ml_breast: 0,
    bottle_ml_formula: 180,
    nursing_minutes: 11,
    pumping_ml: 90,
    diaper_total: 3,
    diaper_wet: 3,
    diaper_soiled: 0,
    diaper_mixed: 0,
    growth: { weight_g: null, height_cm: 72, head_cm: null },
  },
];

// Sleep-day key = start minus 6 h (day_start_hour 6).
//   P: 11-20 20:00–23:00 local (180 min) -> key 11-20
//   T: 11-21 02:00–03:00 local ( 60 min) -> key 11-20 (calendar group 11-21)
//   Q: 11-21 07:00–11:00 local (240 min) -> key 11-21
//   R: 11-22 13:00–13:45 local ( 45 min) -> key 11-22
// Totals by key: 11-20 = 240 min, 11-21 = 240 min, 11-22 = 45 min.
const SLEEPS = [
  row("P", "started_at", "2026-11-20T13:00:00Z", { ended_at: "2026-11-20T16:00:00Z" }),
  row("T", "started_at", "2026-11-20T19:00:00Z", { ended_at: "2026-11-20T20:00:00Z" }),
  row("Q", "started_at", "2026-11-21T00:00:00Z", { ended_at: "2026-11-21T04:00:00Z" }),
  row("R", "started_at", "2026-11-22T06:00:00Z", { ended_at: "2026-11-22T06:45:00Z" }),
];

const WORKED: RouteFixture = baseFixture({
  settings: DAY_START_6,
  charts: CHARTS,
  lists: {
    "bottle-feeds": [
      row("bf1", "occurred_at", "2026-11-22T02:00:00Z", { amount_ml: 120 }),
      row("bf2", "occurred_at", "2026-11-22T06:00:00Z", { amount_ml: 60 }),
    ],
    pumpings: [row("pu1", "occurred_at", "2026-11-22T03:00:00Z", { amount_ml: 90 })],
    "nursing-sessions": [
      row("ns1", "started_at", "2026-11-22T01:00:00Z", {
        ended_at: "2026-11-22T01:10:00Z",
        left_duration_s: 450,
        right_duration_s: 0,
      }),
      row("ns2", "started_at", "2026-11-22T06:30:00Z", {
        ended_at: "2026-11-22T06:40:00Z",
        left_duration_s: 100,
        right_duration_s: 50,
      }),
    ],
    diapers: [
      row("d1", "occurred_at", "2026-11-22T02:30:00Z"),
      row("d2", "occurred_at", "2026-11-22T04:00:00Z"),
      row("d3", "occurred_at", "2026-11-22T07:00:00Z"),
    ],
    "solid-meals": [row("m1", "occurred_at", "2026-11-22T05:00:00Z", { foods: ["Banana"] })],
    growths: [
      row("g1", "measured_at", "2026-11-22T01:00:00Z", { height_cm: 72 }),
      row("g2", "measured_at", "2026-11-20T03:00:00Z", { weight_g: 8150 }),
    ],
    sleeps: SLEEPS,
  },
});

describe("Charts window header and fetch", () => {
  it("shows the 14-day window in Asia/Jakarta and asks the API for it", async () => {
    const { calls } = renderAt("/charts", WORKED);
    await screen.findByText("Nov 9 – Nov 22 · Asia/Jakarta");

    expect(
      calls.some(
        (c) =>
          c.url.includes("charts/daily") &&
          c.url.includes("from=2026-11-09") &&
          c.url.includes("to=2026-11-22"),
      ),
    ).toBe(true);
  });
});

describe("Charts summary primaries", () => {
  it("sums the window and averages the past days only", async () => {
    renderAt("/charts", WORKED);
    await screen.findByText("1500 ml total");

    // Bottle: 600 + 720 + 180 = 1500. Avg over the two past days with data
    // (today excluded): (600 + 720) / 2 = 660.
    expect(screen.getByText("660 ml/day avg")).toBeTruthy();
    // Nursing: 120 + 100 + 11 = 231. Avg (120 + 100) / 2 = 110.
    expect(screen.getByText("231 min total")).toBeTruthy();
    expect(screen.getByText("110 min/day avg")).toBeTruthy();
    // Pumping: 60 + 90 + 90 = 240. Avg (60 + 90) / 2 = 75.
    expect(screen.getByText("240 ml total")).toBeTruthy();
    expect(screen.getByText("75 ml/day avg")).toBeTruthy();
    // Diapers: 6 + 5 + 3 = 14. Avg (6 + 5) / 2 = 5.5.
    expect(screen.getByText("14 total")).toBeTruthy();
    expect(screen.getByText("5.5 /day avg")).toBeTruthy();
  });
});

describe("Charts sleep totals", () => {
  it("sums sleep by sleep-day key and averages over all 13 past window days", async () => {
    renderAt("/charts", WORKED);
    await screen.findByText("8h 45m total");

    // 240 + 240 + 45 = 525 min = 8h 45m.
    // Average: (240 + 240) / 13 past days = 36.9, shown as 37m. The 11 empty
    // past days count as zeros. This is a frozen quirk, not a target.
    expect(screen.getByText("37m /day avg")).toBeTruthy();
    expect(screen.getByText(/typical 12–16h for age/)).toBeTruthy();
  });
});

describe("Charts History day summaries", () => {
  it("attributes sleep by sleep-day key, not by calendar group", async () => {
    renderAt("/charts", WORKED);
    await screen.findByText("Fri, Nov 20");

    // 11-20 group: growth g2, plus P and T by sleep-day key (180 + 60 = 240).
    expect(screen.getByText("1 growth · 4h 0m sleep")).toBeTruthy();
    // 11-21 group: Q only (240). T's calendar group is 11-21 but its key is 11-20.
    expect(screen.getByText("4h 0m sleep")).toBeTruthy();
  });

  it("builds today's summary with zero parts dropped", async () => {
    renderAt("/charts", WORKED);
    const summary = await screen.findByText(/ml · \d+ min nursing/);

    // ml, nursing minutes (7.5 -> 8, 2.5 -> 3, total 11), pumped, diapers,
    // growth, sleep (R, 45 min). The solid meal has no part in the summary.
    expect(summary.textContent).toBe(
      "180 ml · 11 min nursing · 90 ml pumped · 3 diapers · 1 growth · 45m sleep",
    );
  });

  it("labels yesterday's group as Yesterday", async () => {
    renderAt("/charts", WORKED);
    await screen.findByText("Yesterday");
    expect(screen.getByRole("button", { name: /Yesterday/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });
});

describe("Charts previous-window navigation", () => {
  it("steps back 14 days, shows the empty state, and resets with Today", async () => {
    const { calls } = renderAt("/charts", WORKED);
    await screen.findByText("Nov 9 – Nov 22 · Asia/Jakarta");

    fireEvent.click(screen.getByLabelText("Previous period"));

    await screen.findByText("Oct 26 – Nov 8 · Asia/Jakarta");
    expect(calls.some((c) => c.url.includes("from=2026-10-26") && c.url.includes("to=2026-11-08"))).toBe(
      true,
    );
    expect(screen.getAllByText("No data in this window yet.").length).toBeGreaterThan(0);
    expect(screen.getByText("0m total")).toBeTruthy();

    // The Today reset button shows only when the window is not the current one.
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await screen.findByText("Nov 9 – Nov 22 · Asia/Jakarta");
  });
});

describe("Charts jump-to-day", () => {
  it("opens the History day when its bottle bar is clicked", async () => {
    renderAt("/charts", WORKED);
    await screen.findByText("Yesterday");

    // The hit overlay for the 11-21 bottle bar. aria-label is
    // "{Mon D}: {ariaValue}".
    mouseUp(screen.getByLabelText("Nov 21: 500 ml breast, 220 ml formula, 720 ml total"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Yesterday/ }).getAttribute("aria-expanded")).toBe(
        "true",
      ),
    );
  });
});
