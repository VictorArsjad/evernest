import { describe, expect, it } from "vitest";

import { groupByLocalDay } from "./groupByDay";
import type { RecentEvent } from "./recentEvents";
import type { BottleFeed } from "./types";

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

function ev(id: string, at: string): RecentEvent {
  return { kind: "bottle", at, data: bottle(id, at) };
}

// Helper to build a local-tz ISO timestamp at a specific wall-clock
// year/month/day/hour/minute. Avoids hard-coding a runtime tz so the
// test is deterministic regardless of the dev/CI tz.
function localIso(y: number, mo: number, d: number, h: number, mi: number): string {
  return new Date(y, mo - 1, d, h, mi, 0, 0).toISOString();
}

function localDayKey(y: number, mo: number, d: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}`;
}

describe("groupByLocalDay", () => {
  it("returns an empty array for empty input", () => {
    expect(groupByLocalDay([])).toEqual([]);
  });

  it("returns a single bucket for a single event", () => {
    const groups = groupByLocalDay([ev("e1", localIso(2026, 5, 22, 10, 0))]);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayKey).toBe(localDayKey(2026, 5, 22));
    expect(groups[0].events.map((e) => e.data.id)).toEqual(["e1"]);
    expect(groups[0].date.getHours()).toBe(0);
    expect(groups[0].date.getMinutes()).toBe(0);
    expect(groups[0].date.getSeconds()).toBe(0);
    expect(groups[0].date.getFullYear()).toBe(2026);
    expect(groups[0].date.getMonth()).toBe(4);
    expect(groups[0].date.getDate()).toBe(22);
  });

  it("buckets two same-local-day events together and preserves order", () => {
    const events = [
      ev("late", localIso(2026, 5, 22, 22, 0)),
      ev("early", localIso(2026, 5, 22, 7, 30)),
    ];
    const groups = groupByLocalDay(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].events.map((e) => e.data.id)).toEqual(["late", "early"]);
  });

  it("splits across local midnight into two buckets, newer day first", () => {
    const events = [
      ev("today-am", localIso(2026, 5, 22, 1, 5)),
      ev("yesterday-pm", localIso(2026, 5, 21, 23, 50)),
    ];
    const groups = groupByLocalDay(events);
    expect(groups).toHaveLength(2);
    expect(groups[0].dayKey).toBe(localDayKey(2026, 5, 22));
    expect(groups[1].dayKey).toBe(localDayKey(2026, 5, 21));
    expect(groups[0].events.map((e) => e.data.id)).toEqual(["today-am"]);
    expect(groups[1].events.map((e) => e.data.id)).toEqual(["yesterday-pm"]);
  });

  // Boundary regression: an event right at local midnight belongs to
  // the day that *starts* at that midnight, not the day before. We
  // build the timestamp via `new Date(y, mo, d, 0, 0)` so the runtime
  // tz is honored; if the implementation accidentally sliced the UTC
  // ISO string, this would show up as the dayKey being the previous
  // UTC day for callers east of UTC.
  it("treats local midnight as the start of the new day, not the end of the old", () => {
    const events = [
      ev("midnight", localIso(2026, 5, 22, 0, 0)),
      ev("just-before", localIso(2026, 5, 21, 23, 59)),
    ];
    const groups = groupByLocalDay(events);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.dayKey)).toEqual([
      localDayKey(2026, 5, 22),
      localDayKey(2026, 5, 21),
    ]);
    expect(groups[0].events.map((e) => e.data.id)).toEqual(["midnight"]);
    expect(groups[1].events.map((e) => e.data.id)).toEqual(["just-before"]);
  });

  // Property test: regardless of tz, an event must bucket under the
  // local-tz date of its instant — NOT the UTC date that a naive
  // `iso.slice(0, 10)` would yield. We construct a UTC instant late
  // in UTC's day so a non-UTC tz can shift the local date by ±1;
  // even when the runtime is UTC (CI default), the assertion still
  // holds (local and UTC days happen to coincide). The expectation is
  // computed via the same Date#get* APIs the implementation uses, so
  // any deviation would mean a slice-based shortcut snuck back in.
  it("buckets by local date, not the UTC date implied by the ISO string", () => {
    const iso = new Date(Date.UTC(2026, 4, 22, 23, 30)).toISOString();
    const at = new Date(iso);
    const expectedDayKey = localDayKey(
      at.getFullYear(),
      at.getMonth() + 1,
      at.getDate(),
    );
    const utcDayKey = iso.slice(0, 10);
    const groups = groupByLocalDay([ev("u1", iso)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayKey).toBe(expectedDayKey);
    // If local and UTC days differ in this runtime tz, also assert
    // explicitly that the bucket is NOT the UTC date. (When they're
    // equal — runtime is UTC — this branch is a no-op.)
    if (expectedDayKey !== utcDayKey) {
      expect(groups[0].dayKey).not.toBe(utcDayKey);
    }
    expect(groups[0].date.getFullYear()).toBe(at.getFullYear());
    expect(groups[0].date.getMonth()).toBe(at.getMonth());
    expect(groups[0].date.getDate()).toBe(at.getDate());
    expect(groups[0].date.getHours()).toBe(0);
  });
});
