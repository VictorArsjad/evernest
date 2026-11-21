// @vitest-environment jsdom
// Characterization ("freeze") tests for the Today route's derived values.
//
// Pins: banner totals, latest weight, last-fed/diaper/solids labels, the wake
// window card, the yesterday fallback, open sessions, and feature gating. The
// expected strings are literals worked out by hand from the fixture below, not
// recomputed the way the route computes them.
//
// Clock: NOW = 2026-11-22T10:00:00Z = Sunday 17:00 Asia/Jakarta. Local midnight
// today = 2026-11-21T17:00:00Z. Comments give Asia/Jakarta local times.
import "./pinTz";

import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  BASE_PREFERENCES,
  baseFixture,
  cellBar,
  cellText,
  installRouteHarness,
  renderAt,
  row,
  statCell,
  type RouteFixture,
} from "./routeHarness";

installRouteHarness();

// Worked fixture for Today (all instants are Z; local times in comments).
const WORKED: RouteFixture = baseFixture({
  lists: {
    // 09:00 local, 120 ml; 13:00 local, 60 ml. Bottle total today = 180 ml.
    "bottle-feeds": [
      row("bf1", "occurred_at", "2026-11-22T02:00:00Z", { amount_ml: 120 }),
      row("bf2", "occurred_at", "2026-11-22T06:00:00Z", { amount_ml: 60 }),
    ],
    // 10:00 local, 90 ml pumped.
    pumpings: [row("pu1", "occurred_at", "2026-11-22T03:00:00Z", { amount_ml: 90 })],
    // ns1: 450 s left + 0 s right = 7.5 min -> Math.round -> 8.
    // ns2: 100 s left + 50 s right = 2.5 min -> Math.round -> 3.
    // Per-row rounding gives 11. Summing first and rounding once would give 10.
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
    // Diapers at 09:30, 11:00, 14:00 local. Last one 3 h before NOW.
    diapers: [
      row("d1", "occurred_at", "2026-11-22T02:30:00Z"),
      row("d2", "occurred_at", "2026-11-22T04:00:00Z"),
      row("d3", "occurred_at", "2026-11-22T07:00:00Z"),
    ],
    // 12:00 local solid meal. 5 h before NOW.
    "solid-meals": [row("m1", "occurred_at", "2026-11-22T05:00:00Z", { foods: ["Banana"] })],
    // Sleep sl1: 01:00–02:30 local (90 min). sl2: 13:00–13:45 local (45 min).
    // Closed total = 135 min = 2h 15m. sl2 ends 06:45Z, the last wake.
    sleeps: [
      row("sl1", "started_at", "2026-11-21T18:00:00Z", { ended_at: "2026-11-21T19:30:00Z" }),
      row("sl2", "started_at", "2026-11-22T06:00:00Z", { ended_at: "2026-11-22T06:45:00Z" }),
    ],
    // g1: height only, no weight, so it is skipped for latest weight.
    // g2: weight 8150 g = 8.15 kg, two days before NOW.
    growths: [
      row("g1", "measured_at", "2026-11-22T01:00:00Z", { height_cm: 72 }),
      row("g2", "measured_at", "2026-11-20T03:00:00Z", { weight_g: 8150 }),
    ],
  },
});

describe("Today banner totals and stat cells", () => {
  it("renders the day totals from the worked fixture", async () => {
    renderAt("/", WORKED);
    await screen.findByText("Fed 3h 30m ago");

    expect(cellText("🍼")).toBe("🍼180ml");
    expect(cellText("👶")).toBe("👶11min");
    expect(cellText("💧")).toBe("💧90ml");
    expect(cellText("🧷")).toBe("🧷3");
    expect(cellText("📏")).toBe("📏8.15kg");
    expect(cellText("😴")).toBe("😴2h 15m");
  });

  it("sizes the progress bars from the targets (6-month bracket)", async () => {
    renderAt("/", WORKED);
    await screen.findByText("Fed 3h 30m ago");

    // 180 / 900 bottle target, 90 / 720 pumping target, 3 / 6 diapers.
    expect(cellBar("🍼")).toBe("20%");
    expect(cellBar("💧")).toBe("12.5%");
    expect(cellBar("🧷")).toBe("50%");
  });

  it("gives the growth cell no progress bar", async () => {
    renderAt("/", WORKED);
    await screen.findByText("Fed 3h 30m ago");

    expect(statCell("📏")).not.toBeNull();
    expect(cellBar("📏")).toBeNull();
  });
});

describe("Today last-event labels", () => {
  it("uses the nursing start instant for last fed and adds today's bottle ml", async () => {
    renderAt("/", WORKED);
    // Nursing ns2 started 06:30Z, which is later than bottle bf2 at 06:00Z.
    // 10:00Z − 06:30Z = 3h 30m.
    await screen.findByText("Fed 3h 30m ago");
    expect(screen.getByText("· 180 ml")).toBeTruthy();
  });

  it("shows the last diaper, last solids and the sleep wake time", async () => {
    renderAt("/", WORKED);
    await screen.findByText("Fed 3h 30m ago");

    // Last diaper 07:00Z = 3h ago. Last solids 05:00Z = 5h ago.
    expect(screen.getByText("Last diaper 3h ago")).toBeTruthy();
    expect(screen.getByText("Last solids 5h ago")).toBeTruthy();
    expect(screen.getByText("Awake 3h 15m")).toBeTruthy();
  });
});

describe("Today wake-window card", () => {
  it("shows awake time, the age bracket and the past-window status", async () => {
    renderAt("/", WORKED);
    await screen.findByText("Awake 3h 15m");

    // 195 min awake is past the 150 min window max for the 6-month bracket.
    // Window 90–150 min renders as 1.5–2.5h.
    expect(screen.getByText("typical window 1.5–2.5h")).toBeTruthy();
    expect(screen.getByText("Past the typical window — watch for overtired cues.")).toBeTruthy();
  });
});

describe("Today yesterday fallback", () => {
  // Only one bottle feed, at 22:30 local yesterday (15:30Z on 11-21).
  const YESTERDAY: RouteFixture = baseFixture({
    lists: {
      "bottle-feeds": [row("y1", "occurred_at", "2026-11-21T15:30:00Z", { amount_ml: 150 })],
    },
  });

  it("shows the last feed from yesterday with no volume suffix and empty today totals", async () => {
    renderAt("/", YESTERDAY);
    // 10:00Z − 15:30Z(11-21) = 18h 30m. The bottle total is today-only, so it
    // reads 0 and the volume suffix is dropped.
    await screen.findByText("Fed 18h 30m ago");
    expect(screen.queryByText(/· \d+ ml/)).toBeNull();
    expect(cellText("🍼")).toBe("🍼0ml");
    expect(screen.getByText("Nothing logged today yet. Tap a tile above to add one.")).toBeTruthy();
  });
});

describe("Today open sessions", () => {
  it("shows an open nursing session as Nursing now and leaves it out of last fed", async () => {
    // ns3 started 09:00Z, one hour before NOW. Its start is later than ns2,
    // so it must not count as the last fed.
    const fixture = baseFixture({
      lists: WORKED.lists,
      open: {
        "nursing-sessions": row("ns3", "started_at", "2026-11-22T09:00:00Z", {
          ended_at: null,
          left_duration_s: 0,
          right_duration_s: 0,
        }),
      },
    });
    renderAt("/", fixture);

    const now = await screen.findByText("Nursing now");
    expect(now.parentElement?.textContent).toMatch(/Nursing now\s*·\s*1:00/);
    expect(screen.queryByText(/^Fed /)).toBeNull();
  });

  it("hides the wake card and shows the open sleep, counting only closed sleep", async () => {
    // Open sleep started 08:00Z, two hours before NOW.
    // The closed sleep total is sl2 alone: 45 min.
    const fixture = baseFixture({
      lists: { ...WORKED.lists, sleeps: [WORKED.lists.sleeps![1]] },
      open: {
        sleeps: row("sl3", "started_at", "2026-11-22T08:00:00Z", { ended_at: null }),
      },
    });
    renderAt("/", fixture);

    const asleep = await screen.findByText("asleep");
    expect(asleep.parentElement?.textContent).toMatch(/2:00\s*asleep/);
    expect(cellText("😴")).toBe("😴45m");
    expect(screen.queryByText(/^Awake /)).toBeNull();
  });
});

describe("Today feature-visibility gating", () => {
  it("hides the sleep, nursing and solids cells and labels when those kinds are hidden", async () => {
    const fixture = baseFixture({
      ...WORKED,
      preferences: {
        ...BASE_PREFERENCES,
        feature_visibility: { nursing: false, sleep: false, solids: false },
      },
    });
    renderAt("/", fixture);

    // Bottle still shows, so the page has rendered before the checks.
    await waitFor(() => expect(cellText("🍼")).toBe("🍼180ml"));
    expect(statCell("👶")).toBeNull();
    expect(statCell("😴")).toBeNull();
    expect(screen.queryByText(/^Last solids/)).toBeNull();
    expect(screen.queryByText(/^Awake /)).toBeNull();
    expect(screen.queryAllByRole("link", { name: /nursing/i })).toHaveLength(0);
  });
});

describe("Today wake card: compare-instants change (approved)", () => {
  // Two closed sleeps end at the same wall-clock region but in different
  // zones. Instants: 06:50Z (sleepA) and 06:45Z (sleepB, 13:45 at +07:00).
  // The route sorts the ISO strings lexically, so it picks "13:45:00+07:00"
  // (the earlier instant) as the last wake. The true latest instant is
  // 06:50Z, which would read 3h 10m. This test freezes the current string
  // result: 3h 15m.
  it("APPROVED CHANGE (compare instants): lastWokeAt picks the lexically largest ISO string", async () => {
    const fixture = baseFixture({
      lists: {
        sleeps: [
          row("sA", "started_at", "2026-11-22T05:00:00Z", { ended_at: "2026-11-22T06:50:00Z" }),
          row("sB", "started_at", "2026-11-22T06:00:00Z", {
            ended_at: "2026-11-22T13:45:00+07:00",
          }),
        ],
      },
    });
    renderAt("/", fixture);

    await screen.findByText("Awake 3h 15m");
  });
});
