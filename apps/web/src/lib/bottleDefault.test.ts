import { describe, expect, it } from "vitest";

import { suggestBottleAmountMl, type FeedSample } from "./bottleDefault";

// Fixed "now" so the relative window math is deterministic.
const NOW = new Date("2026-06-10T12:00:00.000Z");

function daysAgo(n: number, hour = 9): string {
  const d = new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function feed(amount_ml: number, occurred_at: string): FeedSample {
  return { amount_ml, occurred_at };
}

describe("suggestBottleAmountMl", () => {
  it("returns null when there is no history", () => {
    expect(suggestBottleAmountMl([], NOW)).toBeNull();
  });

  it("returns the only logged amount", () => {
    expect(suggestBottleAmountMl([feed(120, daysAgo(1))], NOW)).toBe(120);
  });

  it("picks the most common amount, ignoring a one-off outlier", () => {
    const feeds = [
      feed(120, daysAgo(1)),
      feed(120, daysAgo(2)),
      feed(120, daysAgo(3)),
      feed(45, daysAgo(1, 13)), // a single small top-up should not win
    ];
    expect(suggestBottleAmountMl(feeds, NOW)).toBe(120);
  });

  it("breaks ties toward the most recently logged amount", () => {
    // 90 and 120 each appear twice; 120 was logged most recently, so the
    // new steady-state wins as soon as it ties the old one.
    const feeds = [
      feed(90, daysAgo(5)),
      feed(90, daysAgo(4)),
      feed(120, daysAgo(2)),
      feed(120, daysAgo(1)),
    ];
    expect(suggestBottleAmountMl(feeds, NOW)).toBe(120);
  });

  it("ignores feeds outside the lookback window", () => {
    const feeds = [
      feed(200, daysAgo(40)), // old routine, way outside 14d
      feed(200, daysAgo(30)),
      feed(110, daysAgo(2)),
    ];
    expect(suggestBottleAmountMl(feeds, NOW)).toBe(110);
  });

  it("respects a custom window", () => {
    const feeds = [feed(150, daysAgo(10))];
    expect(suggestBottleAmountMl(feeds, NOW, 7)).toBeNull();
    expect(suggestBottleAmountMl(feeds, NOW, 14)).toBe(150);
  });

  it("skips invalid amounts and timestamps", () => {
    const feeds = [
      feed(0, daysAgo(1)),
      feed(-50, daysAgo(1)),
      feed(Number.NaN, daysAgo(1)),
      feed(130, "not-a-date"),
      feed(95, daysAgo(2)),
    ];
    expect(suggestBottleAmountMl(feeds, NOW)).toBe(95);
  });

  it("ignores feeds in the future", () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    const feeds = [feed(300, future), feed(125, daysAgo(1))];
    expect(suggestBottleAmountMl(feeds, NOW)).toBe(125);
  });
});
