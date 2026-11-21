// Characterization ("freeze") tests for palette.ts. Pins the SeriesKey set,
// labels, every preset's full color map, and the resolve() override rules
// ahead of a refactor that derives series keys from a shared EVENT_KINDS
// catalog. Expected values are literals copied from the current source.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PALETTE,
  PRESET_LABELS,
  PRESET_NAMES,
  PRESETS,
  resolve,
  SERIES_LABELS,
  type SeriesKey,
} from "./palette";

const SERIES_KEYS_IN_ORDER: SeriesKey[] = [
  "bottle_breast",
  "bottle_formula",
  "nursing",
  "pumping",
  "diaper_wet",
  "diaper_soiled",
  "diaper_mixed",
  "sleep_night",
  "sleep_nap",
  "weight",
];

describe("SERIES_LABELS (freeze)", () => {
  it("has the exact label for every series key", () => {
    expect(SERIES_LABELS).toEqual({
      bottle_breast: "Bottle (breast)",
      bottle_formula: "Bottle (formula)",
      nursing: "Nursing",
      pumping: "Pumping",
      diaper_wet: "Diapers — wet",
      diaper_soiled: "Diapers — soiled",
      diaper_mixed: "Diapers — mixed",
      sleep_night: "Sleep — night",
      sleep_nap: "Sleep — nap",
      weight: "Weight",
    });
  });

  it("iterates in grouped insertion order (drives the Advanced disclosure)", () => {
    expect(Object.keys(SERIES_LABELS)).toEqual(SERIES_KEYS_IN_ORDER);
  });
});

describe("PRESET_NAMES / PRESET_LABELS (freeze)", () => {
  it("lists presets in picker order", () => {
    expect(PRESET_NAMES).toEqual([
      "default",
      "warm",
      "pastel",
      "high_contrast",
      "colorblind",
    ]);
  });

  it("has the exact picker label for every preset", () => {
    expect(PRESET_LABELS).toEqual({
      default: "Default",
      warm: "Warm",
      pastel: "Pastel",
      high_contrast: "High contrast",
      colorblind: "Colorblind safe",
    });
  });
});

describe("DEFAULT_PALETTE (freeze)", () => {
  it("is the default preset with no overrides", () => {
    expect(DEFAULT_PALETTE).toEqual({ preset: "default", overrides: {} });
  });
});

describe("PRESETS (freeze)", () => {
  it("every preset defines exactly the ten series keys", () => {
    for (const name of PRESET_NAMES) {
      expect(Object.keys(PRESETS[name])).toEqual(SERIES_KEYS_IN_ORDER);
    }
  });

  it("default preset matches the hard-coded chart colors verbatim", () => {
    expect(PRESETS.default).toEqual({
      bottle_breast: "#f472b6",
      bottle_formula: "#fdba74",
      nursing: "#6ee7b7",
      pumping: "#7dd3fc",
      diaper_wet: "#fde047",
      diaper_soiled: "#d97706",
      diaper_mixed: "#b45309",
      sleep_night: "#6366f1",
      sleep_nap: "#a5b4fc",
      weight: "#c4b5fd",
    });
  });

  it("warm preset", () => {
    expect(PRESETS.warm).toEqual({
      bottle_breast: "#fb7185",
      bottle_formula: "#fbbf24",
      nursing: "#f97316",
      pumping: "#f43f5e",
      diaper_wet: "#fde68a",
      diaper_soiled: "#b45309",
      diaper_mixed: "#7c2d12",
      sleep_night: "#9f1239",
      sleep_nap: "#fda4af",
      weight: "#fb923c",
    });
  });

  it("pastel preset", () => {
    expect(PRESETS.pastel).toEqual({
      bottle_breast: "#fbcfe8",
      bottle_formula: "#fed7aa",
      nursing: "#bbf7d0",
      pumping: "#bae6fd",
      diaper_wet: "#fef08a",
      diaper_soiled: "#fdba74",
      diaper_mixed: "#fcd34d",
      sleep_night: "#c7d2fe",
      sleep_nap: "#e0e7ff",
      weight: "#ddd6fe",
    });
  });

  it("high_contrast preset", () => {
    expect(PRESETS.high_contrast).toEqual({
      bottle_breast: "#ff00aa",
      bottle_formula: "#ffaa00",
      nursing: "#00ff88",
      pumping: "#00aaff",
      diaper_wet: "#ffff00",
      diaper_soiled: "#ff5500",
      diaper_mixed: "#aa00ff",
      sleep_night: "#5533ff",
      sleep_nap: "#00ffee",
      weight: "#ffffff",
    });
  });

  it("colorblind preset", () => {
    expect(PRESETS.colorblind).toEqual({
      bottle_breast: "#cc79a7",
      bottle_formula: "#e69f00",
      nursing: "#009e73",
      pumping: "#56b4e9",
      diaper_wet: "#f0e442",
      diaper_soiled: "#d55e00",
      diaper_mixed: "#b06000",
      sleep_night: "#004488",
      sleep_nap: "#88ccee",
      weight: "#0072b2",
    });
  });
});

describe("resolve (freeze)", () => {
  it("null and undefined resolve to the default preset map", () => {
    expect(resolve(null)).toEqual(PRESETS.default);
    expect(resolve(undefined)).toEqual(PRESETS.default);
  });

  it("returns a fresh object, never the PRESETS table itself", () => {
    const out = resolve({ preset: "warm", overrides: {} });
    expect(out).not.toBe(PRESETS.warm);
    out.nursing = "#000000";
    expect(PRESETS.warm.nursing).toBe("#f97316");
  });

  it("accepts an override on every one of the ten series keys", () => {
    for (const key of SERIES_KEYS_IN_ORDER) {
      const out = resolve({ preset: "default", overrides: { [key]: "#abcdef" } });
      expect(out[key]).toBe("#abcdef");
      expect(Object.keys(out)).toEqual(SERIES_KEYS_IN_ORDER);
    }
  });

  it("accepts uppercase hex (regex is case-insensitive)", () => {
    expect(
      resolve({ preset: "default", overrides: { weight: "#ABCDEF" } }).weight,
    ).toBe("#ABCDEF");
  });

  it("drops malformed override values and keeps the preset color", () => {
    const bad: Record<string, unknown> = {
      nursing: "red",
      pumping: "#abc",
      diaper_wet: "#GGGGGG",
      diaper_soiled: "#aabbcc00",
      diaper_mixed: "aabbcc",
      sleep_night: 5,
      sleep_nap: null,
    };
    const out = resolve({
      preset: "default",
      overrides: bad as ChartOverrides,
    });
    expect(out).toEqual(PRESETS.default);
  });

  it("drops unknown override keys (including the old 'bottle' umbrella name)", () => {
    const out = resolve({
      preset: "default",
      overrides: { bottle: "#123456", bogus: "#123456" } as ChartOverrides,
    });
    expect(out).toEqual(PRESETS.default);
    expect(Object.keys(out)).toEqual(SERIES_KEYS_IN_ORDER);
  });

  it("applies overrides on top of a non-default preset, touching only that key", () => {
    const out = resolve({
      preset: "pastel",
      overrides: { nursing: "#000000", bogus: "#111111" } as ChartOverrides,
    });
    expect(out).toEqual({ ...PRESETS.pastel, nursing: "#000000" });
  });

  it("falls back to the default preset when the preset name is unknown", () => {
    const out = resolve({
      preset: "neon" as unknown as ChartPresetName,
      overrides: {},
    });
    expect(out).toEqual(PRESETS.default);
  });
});

// Local aliases so the casts above read as intent, not as import noise.
type ChartOverrides = Partial<Record<SeriesKey, string>>;
type ChartPresetName = (typeof PRESET_NAMES)[number];
