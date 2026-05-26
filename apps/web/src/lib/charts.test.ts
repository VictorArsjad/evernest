import { describe, expect, it } from "vitest";

import {
  barLayout,
  dailyWindowEndingToday,
  formatDayShort,
  formatLocalYMD,
  linePoints,
  stackedDiaperLayout,
  summarize,
} from "./charts";
import type { ChartDaily } from "./types";

function emptyDay(date: string): ChartDaily {
  return {
    date,
    bottle_ml: 0,
    nursing_minutes: 0,
    pumping_ml: 0,
    diaper_total: 0,
    diaper_wet: 0,
    diaper_soiled: 0,
    diaper_mixed: 0,
    growth: { weight_g: null, height_cm: null, head_cm: null },
  };
}

describe("formatLocalYMD", () => {
  it("zero-pads month/day in local time", () => {
    // Constructed in local time so the assertion isn't tz-dependent.
    const d = new Date(2026, 0, 5, 12, 0, 0); // 2026-01-05 12:00 local
    expect(formatLocalYMD(d)).toBe("2026-01-05");
  });
});

describe("dailyWindowEndingToday", () => {
  it("ends on `today` and spans the requested number of days inclusively", () => {
    const today = new Date(2026, 4, 14, 9, 0, 0); // May 14, 2026
    const w = dailyWindowEndingToday(today, 7);
    // 7 days ending today: 2026-05-08 .. 2026-05-14
    expect(w.to).toBe("2026-05-14");
    expect(w.from).toBe("2026-05-08");
  });

  it("supports the 14- and 30-day presets", () => {
    const today = new Date(2026, 4, 14, 9, 0, 0);
    expect(dailyWindowEndingToday(today, 14).from).toBe("2026-05-01");
    expect(dailyWindowEndingToday(today, 30).from).toBe("2026-04-15");
  });

  it("treats 0/negative days as a single-day window", () => {
    const today = new Date(2026, 4, 14, 9, 0, 0);
    expect(dailyWindowEndingToday(today, 0)).toEqual({ from: "2026-05-14", to: "2026-05-14" });
    expect(dailyWindowEndingToday(today, -5)).toEqual({ from: "2026-05-14", to: "2026-05-14" });
  });
});

describe("barLayout", () => {
  it("scales the tallest bar to yTop=1 and others proportionally", () => {
    const { bars, max } = barLayout([10, 20, 0, 40]);
    expect(max).toBe(40);
    expect(bars[3].yTop).toBe(1);
    expect(bars[2].yTop).toBe(0);
    expect(bars[1].yTop).toBeCloseTo(0.5);
    expect(bars.map((b) => b.width)).toEqual(new Array(4).fill(bars[0].width));
  });

  it("treats all-zero input as zero-height bars (no NaNs)", () => {
    const { bars, max } = barLayout([0, 0, 0]);
    expect(max).toBe(0);
    for (const b of bars) {
      expect(b.yTop).toBe(0);
      expect(Number.isFinite(b.x)).toBe(true);
    }
  });

  it("clamps negative values to zero (belt-and-suspenders)", () => {
    const { bars } = barLayout([-5, 10]);
    expect(bars[0].yTop).toBe(0);
    expect(bars[1].yTop).toBe(1);
  });

  it("returns an empty array for empty input", () => {
    expect(barLayout([])).toEqual({ bars: [], max: 0 });
  });
});

describe("stackedDiaperLayout", () => {
  it("stacks wet/soiled/mixed against a shared total max", () => {
    const rows = [
      { wet: 3, soiled: 1, mixed: 0 },
      { wet: 2, soiled: 2, mixed: 2 }, // tallest, total 6
      { wet: 0, soiled: 0, mixed: 0 }, // empty
    ];
    const { wet, soiled, mixed, max } = stackedDiaperLayout(rows);
    expect(max).toBe(6);
    // Tallest day fills to 1.0 at its mixed top.
    expect(mixed[1].yTop).toBeCloseTo(1);
    // First day has no mixed, so its mixed yTop should equal its soiled yTop.
    expect(mixed[0].yTop).toBeCloseTo(soiled[0].yTop);
    // Empty day stays at zero.
    expect(wet[2].yTop).toBe(0);
    expect(mixed[2].yTop).toBe(0);
    // Stack order is wet (bottom) -> soiled -> mixed.
    expect(soiled[1].yBottom).toBeCloseTo(wet[1].yTop);
    expect(mixed[1].yBottom).toBeCloseTo(soiled[1].yTop);
  });

  it("handles all-zero input without crashing", () => {
    const { wet, soiled, mixed, max } = stackedDiaperLayout([
      { wet: 0, soiled: 0, mixed: 0 },
      { wet: 0, soiled: 0, mixed: 0 },
    ]);
    expect(max).toBe(0);
    expect(wet.every((b) => b.yTop === 0)).toBe(true);
    expect(soiled.every((b) => b.yTop === 0)).toBe(true);
    expect(mixed.every((b) => b.yTop === 0)).toBe(true);
  });

  it("returns empty arrays for empty rows", () => {
    expect(stackedDiaperLayout([])).toEqual({ wet: [], soiled: [], mixed: [], max: 0 });
  });
});

describe("linePoints", () => {
  it("marks null values as undefined so the renderer can break the line", () => {
    const { points, hasData, min, max } = linePoints([4200, null, 4350]);
    expect(hasData).toBe(true);
    expect(min).toBe(4200);
    expect(max).toBe(4350);
    expect(points[0].defined).toBe(true);
    expect(points[1].defined).toBe(false);
    expect(points[2].defined).toBe(true);
    // Defined points normalize to [0..1] vertical.
    expect(points[0].y).toBeCloseTo(0); // min
    expect(points[2].y).toBeCloseTo(1); // max
  });

  it("an all-null series has hasData=false (renderer shows empty state)", () => {
    const { hasData } = linePoints([null, null, null]);
    expect(hasData).toBe(false);
  });

  it("a single-non-null series stays flat at the midline", () => {
    // span=0 path: avoids div-by-zero, returns y=0.5 for the lone point.
    const { points, hasData } = linePoints([null, 4200, null]);
    expect(hasData).toBe(true);
    expect(points[1].y).toBe(0.5);
  });
});

describe("formatDayShort", () => {
  it("returns Mon D for YYYY-MM-DD", () => {
    expect(formatDayShort("2026-05-25")).toBe("May 25");
    expect(formatDayShort("2026-01-01")).toBe("Jan 1");
    expect(formatDayShort("2026-12-31")).toBe("Dec 31");
  });
});

describe("summarize", () => {
  it("averages over the requested window length, not over non-zero days", () => {
    // 7 days, but only days 0 and 4 have bottle data. Average = total / 7.
    const days: ChartDaily[] = [
      { ...emptyDay("d1"), bottle_ml: 200 },
      emptyDay("d2"),
      emptyDay("d3"),
      emptyDay("d4"),
      { ...emptyDay("d5"), bottle_ml: 500 },
      emptyDay("d6"),
      emptyDay("d7"),
    ];
    const s = summarize(days);
    expect(s.bottleTotalMl).toBe(700);
    expect(s.bottleAvgMl).toBeCloseTo(100); // 700 / 7
  });

  it("returns the latest weight reading in the window (last assignment wins)", () => {
    const days: ChartDaily[] = [
      {
        ...emptyDay("d1"),
        growth: { weight_g: 4200, height_cm: null, head_cm: null },
      },
      emptyDay("d2"),
      {
        ...emptyDay("d3"),
        growth: { weight_g: 4350, height_cm: null, head_cm: null },
      },
      emptyDay("d4"),
    ];
    expect(summarize(days).latestWeightG).toBe(4350);
  });

  it("empty input returns zeros and null weight", () => {
    const s = summarize([]);
    expect(s.bottleTotalMl).toBe(0);
    expect(s.bottleAvgMl).toBe(0);
    expect(s.latestWeightG).toBeNull();
  });
});
