import { describe, expect, it } from "vitest";

import { EVENT_KIND_ROWS, EVENT_KINDS, eventKindMeta } from "./eventKinds";

describe("event kind catalog", () => {
  it("lists kinds in Today-grid order", () => {
    expect(EVENT_KINDS).toEqual([
      "bottle", "nursing", "pumping", "diaper", "solids", "growth", "sleep", "note",
    ]);
  });

  it("flags photo kinds and open-session kinds", () => {
    expect(EVENT_KINDS.filter((k) => EVENT_KIND_ROWS[k].photoAlt)).toEqual([
      "diaper", "solids", "note",
    ]);
    expect(EVENT_KINDS.filter((k) => EVENT_KIND_ROWS[k].openSession)).toEqual([
      "nursing", "sleep",
    ]);
  });

  it("owns each series key exactly once", () => {
    const all = EVENT_KINDS.flatMap((k) => eventKindMeta(k).series);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(10);
  });
});
