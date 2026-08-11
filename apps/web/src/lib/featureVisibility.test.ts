import { describe, expect, it } from "vitest";

import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  isFeatureVisible,
  setFeatureVisibility,
} from "./featureVisibility";

describe("FEATURE_KEYS", () => {
  // The array order drives the Settings toggle list, which mirrors the
  // Today tile grid left-to-right. Sleep sits between Growth and Note by
  // design — a reorder here is a UI change, not a refactor.
  it("keeps the Today-grid order with sleep between growth and note", () => {
    expect(FEATURE_KEYS).toEqual([
      "bottle",
      "nursing",
      "pumping",
      "diaper",
      "growth",
      "sleep",
      "note",
    ]);
  });

  it("has a label for every key", () => {
    for (const k of FEATURE_KEYS) {
      expect(FEATURE_LABELS[k]).toBeTruthy();
    }
  });
});

describe("isFeatureVisible", () => {
  it("treats missing keys as visible", () => {
    expect(isFeatureVisible({}, "bottle")).toBe(true);
    expect(isFeatureVisible(undefined, "nursing")).toBe(true);
  });

  it("treats explicit true as visible", () => {
    expect(isFeatureVisible({ bottle: true }, "bottle")).toBe(true);
  });

  it("treats explicit false as hidden", () => {
    expect(isFeatureVisible({ bottle: false }, "bottle")).toBe(false);
  });

  it("does not leak hidden state across keys", () => {
    const map = { bottle: false };
    for (const k of FEATURE_KEYS) {
      if (k === "bottle") continue;
      expect(isFeatureVisible(map, k)).toBe(true);
    }
  });
});

describe("setFeatureVisibility", () => {
  it("returns a new map (immutable)", () => {
    const before = { bottle: false } as const;
    const after = setFeatureVisibility(before, "nursing", false);
    expect(after).not.toBe(before);
    expect(before).toEqual({ bottle: false });
  });

  it("strips visible keys (sparse storage — missing == visible)", () => {
    const after = setFeatureVisibility({ bottle: false }, "bottle", true);
    expect(after).toEqual({});
  });

  it("writes false for explicitly hidden keys", () => {
    const after = setFeatureVisibility({}, "diaper", false);
    expect(after).toEqual({ diaper: false });
  });

  it("preserves unrelated entries when toggling one key", () => {
    const after = setFeatureVisibility(
      { bottle: false, nursing: false },
      "bottle",
      true,
    );
    expect(after).toEqual({ nursing: false });
  });

  it("handles undefined input as an empty starting map", () => {
    const after = setFeatureVisibility(undefined, "growth", false);
    expect(after).toEqual({ growth: false });
  });
});
