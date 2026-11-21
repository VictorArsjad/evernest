// Characterization ("freeze") tests for mergeRecent in recentEvents.ts. These
// pin the output shape (kind discriminant, the `at` instant each kind sorts
// by, and the untouched `data` reference) for all eight event kinds, ahead of
// a refactor that replaces the three per-kind unions with one EVENT_KINDS
// catalog. Kind strings and instant fields are literals from the source.
import { describe, expect, it } from "vitest";

import { mergeRecent, type RecentEventSources } from "./recentEvents";
import type {
  BottleFeed,
  Diaper,
  Growth,
  Note,
  Nursing,
  Pumping,
  Sleep,
  SolidMeal,
} from "./types";

const CREATED = "2026-11-22T00:00:00Z";

function bottle(over: Partial<BottleFeed> = {}): BottleFeed {
  return {
    id: "bottle-1",
    baby_id: "baby-1",
    occurred_at: "2026-11-22T10:00:00Z",
    milk_source: "formula",
    amount_ml: 120,
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
}

function diaper(over: Partial<Diaper> = {}): Diaper {
  return {
    id: "diaper-1",
    baby_id: "baby-1",
    occurred_at: "2026-11-22T11:00:00Z",
    type: "wet",
    notes: null,
    has_photo: false,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
}

function pumping(over: Partial<Pumping> = {}): Pumping {
  return {
    id: "pump-1",
    baby_id: "baby-1",
    occurred_at: "2026-11-22T09:00:00Z",
    amount_ml: 90,
    duration_seconds: 900,
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
}

function nursing(over: Partial<Nursing> = {}): Nursing {
  return {
    id: "nurse-1",
    baby_id: "baby-1",
    started_at: "2026-11-22T12:00:00Z",
    ended_at: "2026-11-22T12:20:00Z",
    starting_breast: "left",
    nursing_side: "both",
    left_duration_s: 300,
    right_duration_s: 180,
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
}

function growth(over: Partial<Growth> = {}): Growth {
  return {
    id: "growth-1",
    baby_id: "baby-1",
    measured_at: "2026-11-22T08:00:00Z",
    weight_g: 5200,
    height_cm: null,
    head_circumference_cm: null,
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
}

function sleep(over: Partial<Sleep> = {}): Sleep {
  return {
    id: "sleep-1",
    baby_id: "baby-1",
    started_at: "2026-11-22T07:00:00Z",
    ended_at: "2026-11-22T08:30:00Z",
    sleep_type: "nap",
    location: "crib",
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
}

function note(over: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    baby_id: "baby-1",
    occurred_at: "2026-11-22T13:00:00Z",
    body: "small rash on hand",
    has_photo: false,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
}

function solids(over: Partial<SolidMeal> = {}): SolidMeal {
  return {
    id: "solids-1",
    baby_id: "baby-1",
    occurred_at: "2026-11-22T06:00:00Z",
    foods: ["banana"],
    reaction: "liked",
    amount_g: 30,
    notes: null,
    has_photo: false,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
}

function allKinds(): RecentEventSources {
  return {
    bottleFeeds: [bottle()],
    diapers: [diaper()],
    pumpings: [pumping()],
    nursings: [nursing()],
    growths: [growth()],
    sleeps: [sleep()],
    notes: [note()],
    solidMeals: [solids()],
  };
}

describe("mergeRecent (freeze)", () => {
  it("merges all eight kinds into one newest-first list with literal kind order", () => {
    const out = mergeRecent(allKinds());
    expect(out.map((e) => e.kind)).toEqual([
      "note", // 13:00 occurred_at
      "nursing", // 12:00 started_at (ended_at 12:20 is not the sort key)
      "diaper", // 11:00
      "bottle", // 10:00
      "pumping", // 09:00
      "growth", // 08:00 measured_at
      "sleep", // 07:00 started_at
      "solids", // 06:00
    ]);
  });

  it("uses the per-kind instant field for `at`", () => {
    const out = mergeRecent(allKinds());
    expect(out.map((e) => [e.kind, e.at])).toEqual([
      ["note", "2026-11-22T13:00:00Z"],
      ["nursing", "2026-11-22T12:00:00Z"],
      ["diaper", "2026-11-22T11:00:00Z"],
      ["bottle", "2026-11-22T10:00:00Z"],
      ["pumping", "2026-11-22T09:00:00Z"],
      ["growth", "2026-11-22T08:00:00Z"],
      ["sleep", "2026-11-22T07:00:00Z"],
      ["solids", "2026-11-22T06:00:00Z"],
    ]);
  });

  it("keeps the source row as `data` by reference and sets `data` to the matching kind", () => {
    const b = bottle();
    const n = nursing();
    const out = mergeRecent({ bottleFeeds: [b], nursings: [n] });
    expect(out).toHaveLength(2);
    const [first, second] = out;
    expect(first.kind).toBe("nursing");
    expect(first.data).toBe(n);
    expect(second.kind).toBe("bottle");
    expect(second.data).toBe(b);
  });

  it("orders nursing by started_at even when ended_at is later than another row", () => {
    const out = mergeRecent({
      nursings: [nursing({ started_at: "2026-11-22T05:00:00Z", ended_at: "2026-11-22T15:00:00Z" })],
      bottleFeeds: [bottle({ occurred_at: "2026-11-22T06:00:00Z" })],
    });
    expect(out.map((e) => e.kind)).toEqual(["bottle", "nursing"]);
    expect(out[1].at).toBe("2026-11-22T05:00:00Z");
  });

  it("orders sleep by started_at, not ended_at", () => {
    const out = mergeRecent({
      sleeps: [sleep({ started_at: "2026-11-22T04:00:00Z", ended_at: "2026-11-22T09:00:00Z" })],
      diapers: [diaper({ occurred_at: "2026-11-22T05:00:00Z" })],
    });
    expect(out.map((e) => [e.kind, e.at])).toEqual([
      ["diaper", "2026-11-22T05:00:00Z"],
      ["sleep", "2026-11-22T04:00:00Z"],
    ]);
  });

  it("orders growth by measured_at, not created_at", () => {
    const out = mergeRecent({
      growths: [growth({ measured_at: "2026-11-22T02:00:00Z", created_at: "2026-11-22T20:00:00Z" })],
      solidMeals: [solids({ occurred_at: "2026-11-22T03:00:00Z" })],
    });
    expect(out.map((e) => e.kind)).toEqual(["solids", "growth"]);
  });

  it("breaks an identical `at` across different kinds by created_at descending", () => {
    const out = mergeRecent({
      bottleFeeds: [bottle({ occurred_at: "2026-11-22T10:00:00Z", created_at: "2026-11-22T10:00:05Z" })],
      diapers: [diaper({ occurred_at: "2026-11-22T10:00:00Z", created_at: "2026-11-22T10:00:09Z" })],
    });
    expect(out.map((e) => e.kind)).toEqual(["diaper", "bottle"]);
  });

  it("returns an empty list for no sources and for all-undefined sources", () => {
    expect(mergeRecent({})).toEqual([]);
    expect(
      mergeRecent({
        bottleFeeds: undefined,
        diapers: undefined,
        pumpings: undefined,
        nursings: undefined,
        growths: undefined,
        sleeps: undefined,
        notes: undefined,
        solidMeals: undefined,
      }),
    ).toEqual([]);
  });

  it("emits exactly the eight literal kind strings and no others", () => {
    const kinds = new Set(mergeRecent(allKinds()).map((e) => e.kind));
    expect([...kinds].sort()).toEqual([
      "bottle",
      "diaper",
      "growth",
      "note",
      "nursing",
      "pumping",
      "sleep",
      "solids",
    ]);
  });

  it("produces a single-kind list for each source alone, with that kind's literal tag", () => {
    const cases: Array<[keyof RecentEventSources, () => RecentEventSources, string]> = [
      ["bottleFeeds", () => ({ bottleFeeds: [bottle()] }), "bottle"],
      ["diapers", () => ({ diapers: [diaper()] }), "diaper"],
      ["pumpings", () => ({ pumpings: [pumping()] }), "pumping"],
      ["nursings", () => ({ nursings: [nursing()] }), "nursing"],
      ["growths", () => ({ growths: [growth()] }), "growth"],
      ["sleeps", () => ({ sleeps: [sleep()] }), "sleep"],
      ["notes", () => ({ notes: [note()] }), "note"],
      ["solidMeals", () => ({ solidMeals: [solids()] }), "solids"],
    ];
    for (const [, build, kind] of cases) {
      const out = mergeRecent(build());
      expect(out).toHaveLength(1);
      expect(out[0].kind).toBe(kind);
    }
  });
});
