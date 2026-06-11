import { describe, expect, it } from "vitest";

import { compareRecentDesc, mergeRecent, type RecentEvent } from "./recentEvents";
import type { BottleFeed, Diaper, Growth, Nursing, Pumping } from "./types";

// Convenience factories — each returns a minimally-populated record; tests
// only depend on `id`, `occurred_at`, `created_at`.
function bottle(id: string, occurredAt: string, createdAt = occurredAt): BottleFeed {
  return {
    id,
    baby_id: "b1",
    occurred_at: occurredAt,
    milk_source: "formula",
    amount_ml: 60,
    notes: null,
    source: "manual",
    created_at: createdAt,
  };
}

function diaper(id: string, occurredAt: string, createdAt = occurredAt): Diaper {
  return {
    id,
    baby_id: "b1",
    occurred_at: occurredAt,
    type: "wet",
    notes: null,
    has_photo: false,
    source: "manual",
    created_at: createdAt,
  };
}

function pumping(id: string, occurredAt: string, createdAt = occurredAt): Pumping {
  return {
    id,
    baby_id: "b1",
    occurred_at: occurredAt,
    amount_ml: 80,
    duration_seconds: null,
    notes: null,
    source: "manual",
    created_at: createdAt,
  };
}

function nursing(id: string, startedAt: string, createdAt = startedAt): Nursing {
  return {
    id,
    baby_id: "b1",
    started_at: startedAt,
    ended_at: null,
    starting_breast: null,
    nursing_side: "both",
    left_duration_s: 300,
    right_duration_s: 300,
    notes: null,
    source: "manual",
    created_at: createdAt,
  };
}

function growth(id: string, measuredAt: string, createdAt = measuredAt): Growth {
  return {
    id,
    baby_id: "b1",
    measured_at: measuredAt,
    weight_g: 6500,
    height_cm: null,
    head_circumference_cm: null,
    notes: null,
    source: "manual",
    created_at: createdAt,
  };
}

describe("compareRecentDesc", () => {
  it("sorts by occurred_at instant, newest first", () => {
    const events: RecentEvent[] = [
      { kind: "bottle", at: "2026-05-22T07:00:00Z", data: bottle("b-old", "2026-05-22T07:00:00Z") },
      { kind: "bottle", at: "2026-05-22T09:00:00Z", data: bottle("b-new", "2026-05-22T09:00:00Z") },
      { kind: "bottle", at: "2026-05-22T08:00:00Z", data: bottle("b-mid", "2026-05-22T08:00:00Z") },
    ];
    expect(events.slice().sort(compareRecentDesc).map((e) => e.data.id)).toEqual([
      "b-new",
      "b-mid",
      "b-old",
    ]);
  });

  // Regression for the bug fixed in cursor/fix-recent-list-sort: when two
  // events share `occurred_at`, the old `(a.at > b.at ? -1 : 1)` comparator
  // returned 1 for equal values, telling V8's sort to swap and shuffling
  // ties pairwise on every render.
  it("breaks occurred_at ties stably by created_at desc", () => {
    const sameMinute = "2026-05-22T07:41:00Z";
    const events: RecentEvent[] = [
      { kind: "diaper", at: sameMinute, data: diaper("d-first", sameMinute, "2026-05-22T07:41:01Z") },
      { kind: "diaper", at: sameMinute, data: diaper("d-second", sameMinute, "2026-05-22T07:41:02Z") },
      { kind: "pumping", at: sameMinute, data: pumping("p-third", sameMinute, "2026-05-22T07:41:03Z") },
    ];
    const ids = events.slice().sort(compareRecentDesc).map((e) => e.data.id);
    expect(ids).toEqual(["p-third", "d-second", "d-first"]);
  });

  // Regression for the second half of the same bug: Go's `time.RFC3339Nano`
  // omits trailing zeros, so the API can serialize the same column as
  // `…00:00Z` for one row and `…00:00.123Z` for another. Lexicographic
  // compare would place `…00Z` before `…00.123Z`, even though the latter
  // is a strictly later instant.
  it("orders mixed sub-second precision by true instant, not lexicographically", () => {
    const events: RecentEvent[] = [
      { kind: "bottle", at: "2026-05-22T08:00:00Z", data: bottle("whole", "2026-05-22T08:00:00Z") },
      { kind: "bottle", at: "2026-05-22T08:00:00.999Z", data: bottle("nanos", "2026-05-22T08:00:00.999Z") },
    ];
    const ids = events.slice().sort(compareRecentDesc).map((e) => e.data.id);
    expect(ids).toEqual(["nanos", "whole"]);
  });

  // Regression for the third arm of the same bug: a mobile client that
  // submitted `occurred_at` with a local offset would round-trip out of
  // the API as either UTC or its original offset depending on driver/
  // serializer settings. Lexicographic compare can disagree with instant
  // compare for offset strings.
  it("orders mixed timezone offsets by true instant", () => {
    const events: RecentEvent[] = [
      // 2026-05-22T08:00:00+07:00 = 2026-05-22T01:00:00Z (earlier)
      { kind: "bottle", at: "2026-05-22T08:00:00+07:00", data: bottle("jakarta", "2026-05-22T08:00:00+07:00") },
      // 2026-05-22T02:00:00Z (later)
      { kind: "bottle", at: "2026-05-22T02:00:00Z", data: bottle("utc", "2026-05-22T02:00:00Z") },
    ];
    const ids = events.slice().sort(compareRecentDesc).map((e) => e.data.id);
    expect(ids).toEqual(["utc", "jakarta"]);
  });
});

describe("mergeRecent", () => {
  it("merges across all five kinds in single newest-first order", () => {
    const merged = mergeRecent({
      bottleFeeds: [bottle("b1", "2026-05-22T08:00:00Z"), bottle("b2", "2026-05-22T10:00:00Z")],
      diapers: [diaper("d1", "2026-05-22T09:00:00Z")],
      pumpings: [pumping("p1", "2026-05-22T11:00:00Z")],
      nursings: [nursing("n1", "2026-05-22T12:00:00Z")],
      growths: [growth("g1", "2026-05-22T13:00:00Z")],
    });
    expect(merged.map((e) => `${e.kind}:${e.data.id}`)).toEqual([
      "growth:g1",
      "nursing:n1",
      "pumping:p1",
      "bottle:b2",
      "diaper:d1",
      "bottle:b1",
    ]);
  });

  // Nursing rows don't carry `occurred_at` — the schema models them as
  // an interval. Ordering must therefore key off `started_at`, otherwise
  // a recent nursing would either go missing or sort to the bottom.
  it("orders nursing rows by started_at, not occurred_at", () => {
    const merged = mergeRecent({
      bottleFeeds: [bottle("b-mid", "2026-05-22T09:00:00Z")],
      nursings: [
        nursing("n-early", "2026-05-22T08:00:00Z"),
        nursing("n-late", "2026-05-22T10:00:00Z"),
      ],
    });
    expect(merged.map((e) => e.data.id)).toEqual(["n-late", "b-mid", "n-early"]);
  });

  // Growth rows don't carry `occurred_at` either — the schema names the
  // column `measured_at`. Same regression rationale as nursing's
  // `started_at` test: keying off the wrong field would either drop a
  // recent measurement from the list or sort it to the bottom.
  it("orders growth rows by measured_at, not occurred_at", () => {
    const merged = mergeRecent({
      bottleFeeds: [bottle("b-mid", "2026-05-22T09:00:00Z")],
      growths: [
        growth("g-early", "2026-05-22T08:00:00Z"),
        growth("g-late", "2026-05-22T10:00:00Z"),
      ],
    });
    expect(merged.map((e) => e.data.id)).toEqual(["g-late", "b-mid", "g-early"]);
  });

  it("treats missing sources as empty without throwing", () => {
    expect(mergeRecent({})).toEqual([]);
    expect(mergeRecent({ bottleFeeds: [bottle("only", "2026-05-22T08:00:00Z")] })).toHaveLength(1);
    expect(mergeRecent({ nursings: [nursing("nx", "2026-05-22T08:00:00Z")] })).toHaveLength(1);
    expect(mergeRecent({ growths: [growth("gx", "2026-05-22T08:00:00Z")] })).toHaveLength(1);
  });
});
