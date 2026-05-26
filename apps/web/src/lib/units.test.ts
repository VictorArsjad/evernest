import { describe, expect, it } from "vitest";

import {
  CM_PER_INCH,
  LB_PER_KG,
  ML_PER_FL_OZ,
  cmToDisplayLength,
  displayLengthToCm,
  displayVolumeToMl,
  displayWeightToG,
  formatLength,
  formatTime,
  formatVolume,
  formatWeight,
  gToDisplayWeight,
  lengthUnitLabel,
  mlToDisplayVolume,
  volumeUnitLabel,
  weightUnitLabel,
} from "./units";

describe("formatVolume", () => {
  it("renders ml as a whole number", () => {
    expect(formatVolume(60, "ml")).toBe("60 ml");
    expect(formatVolume(120.7, "ml")).toBe("121 ml");
    expect(formatVolume(0, "ml")).toBe("0 ml");
  });

  it("renders oz with 1 decimal", () => {
    expect(formatVolume(ML_PER_FL_OZ, "oz")).toBe("1.0 oz");
    expect(formatVolume(ML_PER_FL_OZ * 4, "oz")).toBe("4.0 oz");
    expect(formatVolume(60, "oz")).toBe("2.0 oz");
    expect(formatVolume(0, "oz")).toBe("0.0 oz");
  });

  it("guards against NaN/Infinity", () => {
    expect(formatVolume(NaN, "ml")).toBe("—");
    expect(formatVolume(NaN, "oz")).toBe("—");
    expect(formatVolume(Infinity, "ml")).toBe("—");
  });

  it("handles very large values without exponent notation", () => {
    expect(formatVolume(99999, "ml")).toBe("99999 ml");
    expect(formatVolume(1_000_000, "oz")).toMatch(/^\d+(\.\d+)? oz$/);
  });
});

describe("displayVolumeToMl + mlToDisplayVolume", () => {
  it("round-trips ml without loss", () => {
    expect(displayVolumeToMl(60, "ml")).toBe(60);
    expect(mlToDisplayVolume(60, "ml")).toBe(60);
  });

  it("converts oz <-> ml using the documented factor", () => {
    expect(displayVolumeToMl(2, "oz")).toBeCloseTo(2 * ML_PER_FL_OZ, 1);
    expect(mlToDisplayVolume(2 * ML_PER_FL_OZ, "oz")).toBe(2);
  });

  it("rounds oz display to 1 decimal", () => {
    // 60ml = 2.028 oz; display rounds to 2.0
    expect(mlToDisplayVolume(60, "oz")).toBe(2);
  });

  it("guards against NaN at the conversion boundary", () => {
    expect(displayVolumeToMl(NaN, "oz")).toBeNaN();
    expect(displayVolumeToMl(NaN, "ml")).toBeNaN();
  });
});

describe("formatLength", () => {
  it("renders cm without trailing zeros", () => {
    expect(formatLength(62, "cm")).toBe("62 cm");
    expect(formatLength(62.5, "cm")).toBe("62.5 cm");
  });

  it("renders in with 1 decimal", () => {
    expect(formatLength(62, "in")).toBe(`${(62 / CM_PER_INCH).toFixed(1)} in`);
    expect(formatLength(0, "in")).toBe("0.0 in");
  });

  it("guards against NaN/Infinity", () => {
    expect(formatLength(NaN, "cm")).toBe("—");
    expect(formatLength(Infinity, "in")).toBe("—");
  });
});

describe("displayLengthToCm + cmToDisplayLength", () => {
  it("round-trips cm without loss", () => {
    expect(displayLengthToCm(62, "cm")).toBe(62);
    expect(cmToDisplayLength(62, "cm")).toBe(62);
  });

  it("converts in <-> cm using the documented factor", () => {
    expect(displayLengthToCm(24, "in")).toBeCloseTo(24 * CM_PER_INCH, 2);
    expect(cmToDisplayLength(24 * CM_PER_INCH, "in")).toBe(24);
  });
});

describe("formatWeight", () => {
  it("renders kg with 2 decimals below 10kg", () => {
    expect(formatWeight(6500, "kg")).toBe("6.50 kg");
    expect(formatWeight(500, "kg")).toBe("0.50 kg");
    expect(formatWeight(0, "kg")).toBe("0.00 kg");
  });

  it("renders kg with 1 decimal at or above 10kg", () => {
    expect(formatWeight(10000, "kg")).toBe("10.0 kg");
    expect(formatWeight(14200, "kg")).toBe("14.2 kg");
  });

  it("renders lb with 1 decimal", () => {
    expect(formatWeight(1000, "lb")).toBe(`${LB_PER_KG.toFixed(1)} lb`);
    expect(formatWeight(6500, "lb")).toBe(`${(6.5 * LB_PER_KG).toFixed(1)} lb`);
  });

  it("renders g as an integer", () => {
    expect(formatWeight(500, "g")).toBe("500 g");
    expect(formatWeight(500.7, "g")).toBe("501 g");
  });

  it("guards against NaN/Infinity", () => {
    expect(formatWeight(NaN, "kg")).toBe("—");
    expect(formatWeight(Infinity, "lb")).toBe("—");
  });

  it("handles a very large value (toddler edge)", () => {
    expect(formatWeight(20000, "kg")).toBe("20.0 kg");
  });
});

describe("displayWeightToG + gToDisplayWeight", () => {
  it("round-trips kg without loss", () => {
    expect(displayWeightToG(6.5, "kg")).toBe(6500);
    expect(gToDisplayWeight(6500, "kg")).toBe(6.5);
  });

  it("converts lb <-> g using the documented factor", () => {
    const fourteenLbInG = (14 / LB_PER_KG) * 1000;
    expect(displayWeightToG(14, "lb")).toBeCloseTo(fourteenLbInG, 0);
    expect(gToDisplayWeight(fourteenLbInG, "lb")).toBeCloseTo(14, 1);
  });

  it("supports g (canonical) round-trip", () => {
    expect(displayWeightToG(6500, "g")).toBe(6500);
    expect(gToDisplayWeight(6500, "g")).toBe(6500);
  });
});

describe("formatTime", () => {
  it("renders 24h HH:mm with leading zeros", () => {
    // Pin to a fixed local instant via the constructor; HH:mm is
    // tz-stable since it reads the same local fields the test runner
    // uses.
    const d = new Date(2026, 4, 22, 8, 5);
    expect(formatTime(d.toISOString(), "24h")).toBe("08:05");
    const d2 = new Date(2026, 4, 22, 14, 30);
    expect(formatTime(d2.toISOString(), "24h")).toBe("14:30");
  });

  it("renders 12h with AM/PM and 12h-clock midnight/noon", () => {
    const morning = new Date(2026, 4, 22, 8, 5);
    expect(formatTime(morning.toISOString(), "12h")).toBe("8:05 AM");
    const evening = new Date(2026, 4, 22, 14, 30);
    expect(formatTime(evening.toISOString(), "12h")).toBe("2:30 PM");
    const midnight = new Date(2026, 4, 22, 0, 0);
    expect(formatTime(midnight.toISOString(), "12h")).toBe("12:00 AM");
    const noon = new Date(2026, 4, 22, 12, 0);
    expect(formatTime(noon.toISOString(), "12h")).toBe("12:00 PM");
  });

  it("guards against bad input", () => {
    expect(formatTime("", "24h")).toBe("—");
    expect(formatTime("nope", "24h")).toBe("—");
  });
});

describe("unit labels", () => {
  it("returns expected suffix strings", () => {
    expect(volumeUnitLabel("ml")).toBe("ml");
    expect(volumeUnitLabel("oz")).toBe("oz");
    expect(lengthUnitLabel("cm")).toBe("cm");
    expect(lengthUnitLabel("in")).toBe("in");
    expect(weightUnitLabel("kg")).toBe("kg");
    expect(weightUnitLabel("lb")).toBe("lb");
    expect(weightUnitLabel("g")).toBe("g");
  });
});
