// Characterization ("freeze") tests for featureVisibility.ts. These pin the
// current public surface (key order, labels, visibility helpers) ahead of a
// refactor that folds FeatureKey into a shared EVENT_KINDS catalog. Every
// expected value is a literal; nothing is derived from the module under test.
import { describe, expect, it } from "vitest";

import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  type FeatureKey,
  type FeatureVisibilityMap,
  isFeatureVisible,
  setFeatureVisibility,
} from "./featureVisibility";

const ALL_KEYS_IN_ORDER: FeatureKey[] = [
  "bottle",
  "nursing",
  "pumping",
  "diaper",
  "solids",
  "growth",
  "sleep",
  "note",
];

describe("FEATURE_KEYS (freeze)", () => {
  it("is exactly the eight kinds in Today-grid order", () => {
    expect(FEATURE_KEYS).toEqual(ALL_KEYS_IN_ORDER);
  });

  it("has no duplicates", () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
  });
});

describe("FEATURE_LABELS (freeze)", () => {
  it("maps every key to its exact Settings label", () => {
    expect(FEATURE_LABELS).toEqual({
      bottle: "Bottle",
      nursing: "Nursing",
      pumping: "Pumping",
      diaper: "Diaper",
      solids: "Solids",
      growth: "Growth",
      sleep: "Sleep",
      note: "Note",
    });
  });

  it("has exactly the same key set as FEATURE_KEYS", () => {
    expect(Object.keys(FEATURE_LABELS).sort()).toEqual(
      [...ALL_KEYS_IN_ORDER].sort(),
    );
  });
});

describe("isFeatureVisible (freeze)", () => {
  it("treats undefined and empty maps as visible for every key", () => {
    for (const key of ALL_KEYS_IN_ORDER) {
      expect(isFeatureVisible(undefined, key)).toBe(true);
      expect(isFeatureVisible({}, key)).toBe(true);
    }
  });

  it("hides only the key explicitly set to false", () => {
    const map: FeatureVisibilityMap = { sleep: false };
    const visible = ALL_KEYS_IN_ORDER.map((k) => [k, isFeatureVisible(map, k)]);
    expect(visible).toEqual([
      ["bottle", true],
      ["nursing", true],
      ["pumping", true],
      ["diaper", true],
      ["solids", true],
      ["growth", true],
      ["sleep", false],
      ["note", true],
    ]);
  });

  it("treats an explicit true as visible", () => {
    expect(isFeatureVisible({ growth: true }, "growth")).toBe(true);
  });
});

describe("setFeatureVisibility (freeze)", () => {
  it("hiding a key on an undefined map yields a sparse map with false", () => {
    expect(setFeatureVisibility(undefined, "solids", false)).toEqual({
      solids: false,
    });
  });

  it("showing a key strips it from the map entirely (sparse storage)", () => {
    expect(setFeatureVisibility({ solids: false }, "solids", true)).toEqual({});
  });

  it("showing a key that was never hidden on undefined returns an empty object", () => {
    expect(setFeatureVisibility(undefined, "note", true)).toEqual({});
  });

  it("keeps other hidden keys untouched", () => {
    expect(
      setFeatureVisibility({ bottle: false, note: false }, "diaper", false),
    ).toEqual({ bottle: false, note: false, diaper: false });
  });

  it("does not mutate the input map", () => {
    const input: FeatureVisibilityMap = { bottle: false };
    const out = setFeatureVisibility(input, "bottle", true);
    expect(input).toEqual({ bottle: false });
    expect(out).toEqual({});
    expect(out).not.toBe(input);
  });

  it("hiding all eight keys one at a time serializes to a full false map", () => {
    let map: FeatureVisibilityMap | undefined = undefined;
    for (const key of ALL_KEYS_IN_ORDER) {
      map = setFeatureVisibility(map, key, false);
    }
    expect(map).toEqual({
      bottle: false,
      nursing: false,
      pumping: false,
      diaper: false,
      solids: false,
      growth: false,
      sleep: false,
      note: false,
    });
  });
});
