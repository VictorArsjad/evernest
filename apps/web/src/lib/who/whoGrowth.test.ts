import { describe, expect, it } from "vitest";

import {
  ageInMonths,
  classify,
  lmsAt,
  measurePercentile,
  ordinal,
  percentileFromZ,
  rowsFor,
  valueAtPercentile,
  valueAtZ,
  zFromPercentile,
  zScore,
} from "./whoGrowth";

// Ground-truth LMS values transcribed independently from WHO's published
// tables (via the pygrowup mirror, cross-checked against WHO SD0/SD2
// columns). These are the anchor points that make the tests a real
// correctness gate rather than a tautology over whatever we happened to
// bundle.
const GIRLS_WFA_12 = { l: -0.2024, m: 8.9481, s: 0.12268 }; // median 8.9481 kg
const GIRLS_WFA_12_PLUS2SD = 11.5087; // WHO +2 SD weight at 12 mo

describe("zScore / percentile", () => {
  it("returns z≈0 and the 50th percentile at the median", () => {
    const z = zScore(GIRLS_WFA_12, GIRLS_WFA_12.m);
    expect(z).toBeCloseTo(0, 6);
    expect(percentileFromZ(z)).toBeCloseTo(50, 4);
  });

  it("returns z≈2 (~97.7th) at WHO's published +2 SD value", () => {
    const z = zScore(GIRLS_WFA_12, GIRLS_WFA_12_PLUS2SD);
    expect(z).toBeCloseTo(2, 2);
    expect(percentileFromZ(z)).toBeCloseTo(97.72, 1);
  });

  it("is monotic: heavier reads as a higher percentile", () => {
    const light = measurePercentile("weight", "female", 12, 7.5)!;
    const heavy = measurePercentile("weight", "female", 12, 10.5)!;
    expect(light.percentile).toBeLessThan(heavy.percentile);
  });

  it("applies the extreme-tail correction beyond ±3 SD (stays finite)", () => {
    const huge = zScore(GIRLS_WFA_12, 30); // absurd 30 kg at 12 mo
    expect(Number.isFinite(huge)).toBe(true);
    expect(huge).toBeGreaterThan(3);
    const tiny = zScore(GIRLS_WFA_12, 1); // absurd 1 kg at 12 mo
    expect(Number.isFinite(tiny)).toBe(true);
    expect(tiny).toBeLessThan(-3);
  });
});

describe("valueAtPercentile / valueAtZ round-trips", () => {
  it("valueAtPercentile(50) equals the median", () => {
    expect(valueAtPercentile(GIRLS_WFA_12, 50)).toBeCloseTo(GIRLS_WFA_12.m, 6);
  });

  it("round-trips a value → z → value", () => {
    const v = valueAtZ(GIRLS_WFA_12, 1.3);
    expect(zScore(GIRLS_WFA_12, v)).toBeCloseTo(1.3, 6);
  });

  it("round-trips a percentile → value → percentile", () => {
    const v = valueAtPercentile(GIRLS_WFA_12, 90);
    expect(percentileFromZ(zScore(GIRLS_WFA_12, v))).toBeCloseTo(90, 3);
  });
});

describe("zFromPercentile", () => {
  it("maps the standard percentiles to known z-scores", () => {
    expect(zFromPercentile(50)).toBeCloseTo(0, 6);
    expect(zFromPercentile(97.72)).toBeCloseTo(2, 2);
    expect(zFromPercentile(2.28)).toBeCloseTo(-2, 2);
  });
});

describe("lmsAt interpolation", () => {
  const rows = rowsFor("weight", "female")!;

  it("returns the exact row on an integer month", () => {
    const lms = lmsAt(rows, 12)!;
    expect(lms.m).toBeCloseTo(GIRLS_WFA_12.m, 6);
    expect(lms.l).toBeCloseTo(GIRLS_WFA_12.l, 6);
  });

  it("linearly interpolates between two months", () => {
    const a = lmsAt(rows, 12)!;
    const b = lmsAt(rows, 13)!;
    const mid = lmsAt(rows, 12.5)!;
    expect(mid.m).toBeCloseTo((a.m + b.m) / 2, 6);
  });

  it("returns null outside the 0–60 month range", () => {
    expect(lmsAt(rows, -1)).toBeNull();
    expect(lmsAt(rows, 61)).toBeNull();
  });
});

describe("rowsFor / measurePercentile sex handling", () => {
  it("resolves male→boys and female→girls", () => {
    expect(rowsFor("weight", "male")).not.toBeNull();
    expect(rowsFor("length", "female")).not.toBeNull();
  });

  it("returns null for unspecified / missing sex", () => {
    expect(rowsFor("weight", "unspecified")).toBeNull();
    expect(rowsFor("weight", null)).toBeNull();
    expect(rowsFor("weight", undefined)).toBeNull();
    expect(measurePercentile("weight", "unspecified", 12, 8.9)).toBeNull();
  });

  it("returns null when the age is out of range", () => {
    expect(measurePercentile("weight", "female", 72, 12)).toBeNull();
  });

  it("places WHO medians at the 50th percentile across metrics", () => {
    // boys length-for-age at birth: median 49.8842 cm
    expect(measurePercentile("length", "male", 0, 49.8842)!.percentile).toBeCloseTo(50, 2);
    // girls head-circumference at birth: median 33.8787 cm
    expect(measurePercentile("head", "female", 0, 33.8787)!.percentile).toBeCloseTo(50, 2);
  });
});

describe("ageInMonths", () => {
  it("is ~0 at birth and ~12 a year later", () => {
    const dob = new Date("2025-01-01T00:00:00Z");
    expect(ageInMonths(dob, dob)).toBeCloseTo(0, 6);
    expect(ageInMonths(dob, new Date("2026-01-01T00:00:00Z"))).toBeCloseTo(12, 1);
  });
});

describe("classify", () => {
  it("labels the typical band, edges, and outer range with escalating tone", () => {
    expect(classify(50).tone).toBe("typical");
    expect(classify(10).tone).toBe("edge");
    expect(classify(90).tone).toBe("edge");
    expect(classify(1).tone).toBe("outer");
    expect(classify(99).tone).toBe("outer");
  });
});

describe("ordinal", () => {
  it("renders English ordinals", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(48)).toBe("48th");
    expect(ordinal(22)).toBe("22nd");
  });
});
