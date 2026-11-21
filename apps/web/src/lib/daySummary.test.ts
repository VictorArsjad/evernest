import { describe, expect, it } from "vitest";

import {
  latestWeightGrams,
  todaySleepWindow,
  todayTotals,
  todayWindows,
} from "./daySummary";
import type { BottleFeed, Growth, Nursing, Pumping, Sleep } from "./types";

// Local-time builder so the tests are timezone-independent (the module
// works in local time).
function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s, ms);
}

function feed(ml: number | string): BottleFeed {
  return { amount_ml: ml } as unknown as BottleFeed;
}
function pump(ml: number | string): Pumping {
  return { amount_ml: ml } as unknown as Pumping;
}
function nurse(left: number, right: number): Nursing {
  return { left_duration_s: left, right_duration_s: right } as unknown as Nursing;
}
function sleepRow(start: Date, end: Date | null): Sleep {
  return {
    started_at: start.toISOString(),
    ended_at: end ? end.toISOString() : null,
  } as unknown as Sleep;
}

describe("todayWindows", () => {
  const now = local(2026, 11, 22, 15, 30);

  it("spans local midnight to the last millisecond of the day", () => {
    const w = todayWindows(now);
    expect(w.from).toBe(local(2026, 11, 22).toISOString());
    expect(w.to).toBe(local(2026, 11, 22, 23, 59, 59, 999).toISOString());
  });

  it("looks back 30 local days from midnight for `since`", () => {
    expect(todayWindows(now).since).toBe(local(2026, 10, 23).toISOString());
  });

  it("does not mutate its input", () => {
    const copy = new Date(now);
    todayWindows(now);
    expect(now.getTime()).toBe(copy.getTime());
  });
});

describe("todaySleepWindow", () => {
  it("is the calendar day when the cutover is midnight", () => {
    const w = todaySleepWindow(local(2026, 11, 22, 15), 0);
    expect(w.from).toBe(local(2026, 11, 22).toISOString());
    expect(w.to).toBe(local(2026, 11, 23).toISOString());
  });

  it("stays on yesterday's sleep-day before the cutover hour", () => {
    const w = todaySleepWindow(local(2026, 11, 22, 5), 6);
    expect(w.from).toBe(local(2026, 11, 21, 6).toISOString());
    expect(w.to).toBe(local(2026, 11, 22, 6).toISOString());
  });
});

describe("todayTotals", () => {
  it("is all zeros with no data", () => {
    expect(todayTotals({})).toEqual({ totalMl: 0, pumpedMl: 0, nursingMin: 0, sleepMin: 0 });
  });

  it("sums bottle and pumped ml, coercing numeric strings", () => {
    const t = todayTotals({ feeds: [feed(60), feed("90")], pumpings: [pump(30), pump("20")] });
    expect(t.totalMl).toBe(150);
    expect(t.pumpedMl).toBe(50);
  });

  it("rounds nursing minutes per row, not over the total", () => {
    // 100s → 1.67 → 2 and 100s → 2; a single round of 200s/60 would give 3.
    const t = todayTotals({ nursings: [nurse(50, 50), nurse(60, 40)] });
    expect(t.nursingMin).toBe(4);
    // 0.5 rounds up per row: 30s → 1 each.
    expect(todayTotals({ nursings: [nurse(30, 0), nurse(0, 30)] }).nursingMin).toBe(2);
  });

  it("counts closed sleeps only", () => {
    const t = todayTotals({
      sleeps: [
        sleepRow(local(2026, 11, 22, 1), local(2026, 11, 22, 2, 30)),
        sleepRow(local(2026, 11, 22, 14), null),
      ],
    });
    expect(t.sleepMin).toBe(90);
  });

  it("rounds sleep minutes per row", () => {
    const t = todayTotals({
      sleeps: [
        sleepRow(local(2026, 11, 22, 1, 0, 0), local(2026, 11, 22, 1, 10, 40)),
        sleepRow(local(2026, 11, 22, 3, 0, 0), local(2026, 11, 22, 3, 10, 40)),
      ],
    });
    expect(t.sleepMin).toBe(22);
  });
});

describe("latestWeightGrams", () => {
  const g = (weight: number | null): Growth => ({ weight_g: weight }) as unknown as Growth;

  it("is null without rows", () => {
    expect(latestWeightGrams(undefined)).toBeNull();
    expect(latestWeightGrams([])).toBeNull();
  });

  it("takes the first row that has a weight (newest-first input)", () => {
    expect(latestWeightGrams([g(null), g(5200), g(4900)])).toBe(5200);
  });

  it("is null when no row has a weight", () => {
    expect(latestWeightGrams([g(null)])).toBeNull();
  });
});
