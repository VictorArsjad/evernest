import { describe, expect, it } from "vitest";

import {
  PERCENTILE_LINES,
  niceAgeMax,
  niceTicks,
  sampleReferenceCurves,
  valueBounds,
} from "./curves";
import { rowsFor, valueAtPercentile, lmsAt } from "./whoGrowth";

const rows = rowsFor("weight", "female")!;

describe("sampleReferenceCurves", () => {
  it("returns one curve per drawn percentile", () => {
    const curves = sampleReferenceCurves(rows, 12, 1);
    expect(curves.map((c) => c.pct)).toEqual([...PERCENTILE_LINES]);
  });

  it("samples the 50th curve through the LMS median", () => {
    const curves = sampleReferenceCurves(rows, 12, 1);
    const p50 = curves.find((c) => c.pct === 50)!;
    const at6 = p50.samples.find((s) => s.age === 6)!;
    expect(at6.value).toBeCloseTo(valueAtPercentile(lmsAt(rows, 6)!, 50), 6);
  });

  it("does not sample past the requested age", () => {
    const curves = sampleReferenceCurves(rows, 9, 0.5);
    for (const c of curves) {
      expect(Math.max(...c.samples.map((s) => s.age))).toBeLessThanOrEqual(9 + 1e-9);
    }
  });
});

describe("valueBounds", () => {
  it("spans the curves plus any extra values, padded", () => {
    const curves = sampleReferenceCurves(rows, 12, 1);
    const { min, max } = valueBounds(curves, [20]); // 20 kg outlier
    expect(max).toBeGreaterThan(20); // padding pushes past the outlier
    expect(min).toBeLessThan(curves[0].samples[0].value);
  });

  it("falls back to a unit span when empty", () => {
    expect(valueBounds([], [])).toEqual({ min: 0, max: 1 });
  });
});

describe("niceAgeMax", () => {
  it("snaps a bit past the current age to a friendly boundary", () => {
    expect(niceAgeMax(0)).toBe(3);
    expect(niceAgeMax(4)).toBe(6);
    expect(niceAgeMax(11)).toBe(12);
    expect(niceAgeMax(20)).toBe(24);
  });

  it("caps at 60 months", () => {
    expect(niceAgeMax(200)).toBe(60);
  });
});

describe("niceTicks", () => {
  it("produces round ticks within range", () => {
    const ticks = niceTicks(2, 16, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(2);
      expect(t).toBeLessThanOrEqual(16);
    }
    // No float artifacts.
    for (const t of ticks) expect(t).toBe(Number(t.toFixed(4)));
  });
});
