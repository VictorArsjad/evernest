import { describe, expect, it } from "vitest";

import {
  DEFAULT_PALETTE,
  PRESETS,
  type ChartPalette,
  resolve,
} from "./palette";

describe("resolve", () => {
  it("returns the chosen preset's colors when there are no overrides", () => {
    const colors = resolve({ preset: "warm", overrides: {} });
    expect(colors).toEqual(PRESETS.warm);
  });

  it("falls back to the default preset for null/undefined input", () => {
    expect(resolve(null)).toEqual(PRESETS.default);
    expect(resolve(undefined)).toEqual(PRESETS.default);
  });

  it("lets a single override win over the preset for that key only", () => {
    const p: ChartPalette = {
      preset: "default",
      overrides: { nursing: "#123456" },
    };
    const colors = resolve(p);
    expect(colors.nursing).toBe("#123456");
    // Every other key still matches the preset.
    expect(colors.bottle_breast).toBe(PRESETS.default.bottle_breast);
    expect(colors.bottle_formula).toBe(PRESETS.default.bottle_formula);
    expect(colors.pumping).toBe(PRESETS.default.pumping);
    expect(colors.diaper_wet).toBe(PRESETS.default.diaper_wet);
    expect(colors.diaper_soiled).toBe(PRESETS.default.diaper_soiled);
    expect(colors.diaper_mixed).toBe(PRESETS.default.diaper_mixed);
    expect(colors.weight).toBe(PRESETS.default.weight);
  });

  it("returns the default palette for the explicit DEFAULT_PALETTE constant", () => {
    expect(resolve(DEFAULT_PALETTE)).toEqual(PRESETS.default);
  });

  it("ignores unknown override keys without crashing or leaking them into the output", () => {
    const p = {
      preset: "default",
      // Cast through unknown so we can simulate a stale FE bundle reading a
      // row written by a newer/looser client.
      overrides: { foo: "#abcdef", nursing: "#112233" },
    } as unknown as ChartPalette;
    const colors = resolve(p);
    expect(colors.nursing).toBe("#112233");
    expect(Object.keys(colors).sort()).toEqual(
      [
        "bottle_breast",
        "bottle_formula",
        "diaper_mixed",
        "diaper_soiled",
        "diaper_wet",
        "nursing",
        "pumping",
        "weight",
      ].sort(),
    );
    // No 'foo' should have leaked in.
    expect(Object.keys(colors)).not.toContain("foo");
  });

  it("drops override values that are not #rrggbb hex strings", () => {
    const p = {
      preset: "default",
      overrides: {
        nursing: "red",
        pumping: "#abc",
        weight: "#ZZZZZZ",
        diaper_wet: 42,
        diaper_soiled: null,
        diaper_mixed: "#aaBBcc", // valid mixed-case hex
      },
    } as unknown as ChartPalette;
    const colors = resolve(p);
    // All malformed entries fall back to preset:
    expect(colors.nursing).toBe(PRESETS.default.nursing);
    expect(colors.pumping).toBe(PRESETS.default.pumping);
    expect(colors.weight).toBe(PRESETS.default.weight);
    expect(colors.diaper_wet).toBe(PRESETS.default.diaper_wet);
    expect(colors.diaper_soiled).toBe(PRESETS.default.diaper_soiled);
    // The one well-formed value still wins:
    expect(colors.diaper_mixed).toBe("#aaBBcc");
  });

  it("falls back to the default preset when the preset name is unknown", () => {
    const p = {
      preset: "neon" as unknown as ChartPalette["preset"],
      overrides: {},
    };
    const colors = resolve(p as ChartPalette);
    expect(colors).toEqual(PRESETS.default);
  });
});
