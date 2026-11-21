import { describe, expect, it } from "vitest";

import {
  chartEndDate,
  chartTotals,
  entryDayKeys,
  formatDaySummary,
  historyWindows,
  lastEvents,
  lastWokeAtOf,
  latestWeightGrams,
  sleepWindowTotals,
  todaySleepWindow,
  todayTotals,
  todayWindows,
} from "./daySummary";
import type { DayGroup } from "./groupByDay";
import type { RecentEvent } from "./recentEvents";
import type { BottleFeed, Growth, Nursing, Pumping, Sleep } from "./types";

// Local-time builder so the tests are timezone-independent (the module
// works in local time).
function local(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s, ms);
}

function feed(ml: number | string): BottleFeed {
  return { amount_ml: ml } as unknown as BottleFeed;
}
function pump(ml: number | string): Pumping {
  return { amount_ml: ml } as unknown as Pumping;
}
function nurse(left: number, right: number): Nursing {
  return { left_duration_s: left, right_duration_s: right } as unknown as Nursing;
}
function sleepRow(start: Date, end: Date | null): Sleep {
  return {
    started_at: start.toISOString(),
    ended_at: end ? end.toISOString() : null,
  } as unknown as Sleep;
}

describe("todayWindows", () => {
  const now = local(2026, 11, 22, 15, 30);

  it("spans local midnight to the last millisecond of the day", () => {
    const w = todayWindows(now);
    expect(w.from).toBe(local(2026, 11, 22).toISOString());
    expect(w.to).toBe(local(2026, 11, 22, 23, 59, 59, 999).toISOString());
  });

  it("looks back 30 local days from midnight for `since`", () => {
    expect(todayWindows(now).since).toBe(local(2026, 10, 23).toISOString());
  });

  it("does not mutate its input", () => {
    const copy = new Date(now);
    todayWindows(now);
    expect(now.getTime()).toBe(copy.getTime());
  });
});

describe("todaySleepWindow", () => {
  it("is the calendar day when the cutover is midnight", () => {
    const w = todaySleepWindow(local(2026, 11, 22, 15), 0);
    expect(w.from).toBe(local(2026, 11, 22).toISOString());
    expect(w.to).toBe(local(2026, 11, 23).toISOString());
  });

  it("stays on yesterday's sleep-day before the cutover hour", () => {
    const w = todaySleepWindow(local(2026, 11, 22, 5), 6);
    expect(w.from).toBe(local(2026, 11, 21, 6).toISOString());
    expect(w.to).toBe(local(2026, 11, 22, 6).toISOString());
  });
});

describe("todayTotals", () => {
  it("is all zeros with no data", () => {
    expect(todayTotals({})).toEqual({ totalMl: 0, pumpedMl: 0, nursingMin: 0, sleepMin: 0 });
  });

  it("sums bottle and pumped ml, coercing numeric strings", () => {
    const t = todayTotals({ feeds: [feed(60), feed("90")], pumpings: [pump(30), pump("20")] });
    expect(t.totalMl).toBe(150);
    expect(t.pumpedMl).toBe(50);
  });

  it("rounds nursing minutes per row, not over the total", () => {
    // 100s → 1.67 → 2 and 100s → 2; a single round of 200s/60 would give 3.
    const t = todayTotals({ nursings: [nurse(50, 50), nurse(60, 40)] });
    expect(t.nursingMin).toBe(4);
    // 0.5 rounds up per row: 30s → 1 each.
    expect(todayTotals({ nursings: [nurse(30, 0), nurse(0, 30)] }).nursingMin).toBe(2);
  });

  it("counts closed sleeps only", () => {
    const t = todayTotals({
      sleeps: [
        sleepRow(local(2026, 11, 22, 1), local(2026, 11, 22, 2, 30)),
        sleepRow(local(2026, 11, 22, 14), null),
      ],
    });
    expect(t.sleepMin).toBe(90);
  });

  it("rounds sleep minutes per row", () => {
    const t = todayTotals({
      sleeps: [
        sleepRow(local(2026, 11, 22, 1, 0, 0), local(2026, 11, 22, 1, 10, 40)),
        sleepRow(local(2026, 11, 22, 3, 0, 0), local(2026, 11, 22, 3, 10, 40)),
      ],
    });
    expect(t.sleepMin).toBe(22);
  });
});

describe("latestWeightGrams", () => {
  const g = (weight: number | null): Growth => ({ weight_g: weight }) as unknown as Growth;

  it("is null without rows", () => {
    expect(latestWeightGrams(undefined)).toBeNull();
    expect(latestWeightGrams([])).toBeNull();
  });

  it("takes the first row that has a weight (newest-first input)", () => {
    expect(latestWeightGrams([g(null), g(5200), g(4900)])).toBe(5200);
  });

  it("is null when no row has a weight", () => {
    expect(latestWeightGrams([g(null)])).toBeNull();
  });
});

describe("lastEvents", () => {
  const f = (at: string) => ({ occurred_at: at }) as unknown as BottleFeed;
  const n = (at: string, ended: string | null) =>
    ({ started_at: at, ended_at: ended }) as unknown as Nursing;

  it("is all null without data", () => {
    expect(lastEvents({})).toEqual({ lastFedAt: null, lastDiaperAt: null, lastSolidsAt: null });
  });

  it("picks the newest of bottle feeds and closed nursing sessions", () => {
    const r = lastEvents({
      latestFeeds: [f("2026-11-22T01:00:00Z")],
      latestNursings: [n("2026-11-22T03:00:00Z", "2026-11-22T03:20:00Z")],
    });
    expect(r.lastFedAt).toBe("2026-11-22T03:00:00Z");
  });

  it("ignores an open nursing session", () => {
    const r = lastEvents({
      latestFeeds: [f("2026-11-22T01:00:00Z")],
      latestNursings: [n("2026-11-22T05:00:00Z", null)],
    });
    expect(r.lastFedAt).toBe("2026-11-22T01:00:00Z");
  });

  it("derives diaper and solids labels independently", () => {
    const r = lastEvents({
      latestDiapers: [{ occurred_at: "2026-11-22T02:00:00Z" }],
      latestSolids: [{ occurred_at: "2026-11-21T02:00:00Z" }],
    });
    expect(r.lastDiaperAt).toBe("2026-11-22T02:00:00Z");
    expect(r.lastSolidsAt).toBe("2026-11-21T02:00:00Z");
    expect(r.lastFedAt).toBeNull();
  });
});

describe("lastWokeAtOf", () => {
  const s = (ended: string | null) => ({ ended_at: ended }) as unknown as Sleep;

  it("is null without closed sleeps", () => {
    expect(lastWokeAtOf(undefined)).toBeNull();
    expect(lastWokeAtOf([])).toBeNull();
    expect(lastWokeAtOf([s(null)])).toBeNull();
  });

  it("compares instants, not ISO strings", () => {
    // 13:45+07:00 is 06:45Z: earlier than 06:50Z though lexically larger.
    expect(lastWokeAtOf([s("2026-11-22T06:50:00Z"), s("2026-11-22T13:45:00+07:00")])).toBe(
      "2026-11-22T06:50:00Z",
    );
  });

  it("ignores unparseable end times", () => {
    expect(lastWokeAtOf([s("not-a-date"), s("2026-11-22T06:50:00Z")])).toBe("2026-11-22T06:50:00Z");
  });

  it("returns the latest end among closed sleeps, ignoring open ones", () => {
    expect(
      lastWokeAtOf([s("2026-11-22T01:00:00Z"), s(null), s("2026-11-22T04:00:00Z")]),
    ).toBe("2026-11-22T04:00:00Z");
  });
});

describe("chartEndDate", () => {
  const now = local(2026, 11, 22, 15, 30);

  it("is local midnight today at offset 0", () => {
    expect(chartEndDate(now, 14, 0).getTime()).toBe(local(2026, 11, 22).getTime());
  });

  it("steps back offset * range wall-clock days", () => {
    expect(chartEndDate(now, 7, 2).getTime()).toBe(local(2026, 11, 8).getTime());
  });

  it("does not mutate its input", () => {
    const copy = new Date(now);
    chartEndDate(now, 7, 1);
    expect(now.getTime()).toBe(copy.getTime());
  });
});

describe("historyWindows", () => {
  const end = local(2026, 11, 22);

  it("history covers `range` days ending at the last ms of endDate", () => {
    const { history } = historyWindows(end, 7);
    expect(history.from).toBe(local(2026, 11, 16).toISOString());
    expect(history.to).toBe(local(2026, 11, 22, 23, 59, 59, 999).toISOString());
  });

  it("rhythm reaches one extra lookback day and shares the end", () => {
    const { history, rhythm } = historyWindows(end, 7);
    expect(rhythm.from).toBe(local(2026, 11, 15).toISOString());
    expect(rhythm.to).toBe(history.to);
  });

  it("does not mutate endDate", () => {
    const copy = new Date(end);
    historyWindows(end, 30);
    expect(end.getTime()).toBe(copy.getTime());
  });
});

describe("entryDayKeys", () => {
  it("collects the day keys of the groups", () => {
    const groups = [{ dayKey: "2026-11-22" }, { dayKey: "2026-11-20" }] as unknown as DayGroup[];
    expect([...entryDayKeys(groups)].sort()).toEqual(["2026-11-20", "2026-11-22"]);
    expect(entryDayKeys([]).size).toBe(0);
  });
});

describe("formatDaySummary", () => {
  const prefs = { unit_volume: "ml", day_start_hour: 0 } as const;
  const ev = (kind: RecentEvent["kind"], data: object, at = "2026-11-22T05:00:00Z") =>
    ({ kind, at, data }) as unknown as RecentEvent;
  const sleepEv = (start: Date, end: Date | null) =>
    ev("sleep", { started_at: start.toISOString(), ended_at: end?.toISOString() ?? null });

  it("is empty for a day with nothing summarizable", () => {
    expect(formatDaySummary([], prefs, "2026-11-22", [])).toBe("");
  });

  it("joins non-zero parts in fixed order", () => {
    const events = [
      ev("bottle", { amount_ml: 60 }),
      ev("bottle", { amount_ml: "40" }),
      ev("nursing", { left_duration_s: 600, right_duration_s: 620 }),
      ev("pumping", { amount_ml: 30 }),
      ev("diaper", {}),
      ev("diaper", {}),
      ev("growth", {}),
      ev("note", {}),
    ];
    expect(formatDaySummary(events, prefs, "2026-11-22", events)).toBe(
      "100 ml · 20 min nursing · 30 ml pumped · 2 diapers · 1 growth · 1 note",
    );
  });

  it("singularizes diaper and note, pluralizes otherwise", () => {
    const events = [ev("diaper", {}), ev("note", {}), ev("note", {})];
    expect(formatDaySummary(events, prefs, "2026-11-22", events)).toBe("1 diaper · 2 notes");
  });

  it("rounds nursing minutes per row", () => {
    const events = [
      ev("nursing", { left_duration_s: 50, right_duration_s: 50 }),
      ev("nursing", { left_duration_s: 60, right_duration_s: 40 }),
    ];
    expect(formatDaySummary(events, prefs, "2026-11-22", events)).toBe("4 min nursing");
  });

  it("formats volumes in the preferred unit", () => {
    const events = [ev("bottle", { amount_ml: 59.147 })];
    expect(
      formatDaySummary(events, { unit_volume: "oz", day_start_hour: 0 }, "2026-11-22", events),
    ).toBe("2.0 oz");
  });

  it("attributes closed sleep to its sleep-day from the whole event list", () => {
    // 22:00→06:30 night starts on the 21st. With a midnight cutover it
    // belongs to the 21st even though it ends on the 22nd.
    const night = sleepEv(local(2026, 11, 21, 22), local(2026, 11, 22, 6, 30));
    expect(formatDaySummary([], prefs, "2026-11-21", [night])).toBe("8h 30m sleep");
    expect(formatDaySummary([], prefs, "2026-11-22", [night])).toBe("");
  });

  it("uses the cutover hour for attribution", () => {
    // Started 03:00 on the 22nd: with a 6am cutover that is still the 21st.
    const nap = sleepEv(local(2026, 11, 22, 3), local(2026, 11, 22, 4));
    const p6 = { unit_volume: "ml", day_start_hour: 6 } as const;
    expect(formatDaySummary([], p6, "2026-11-21", [nap])).toBe("1h 0m sleep");
    expect(formatDaySummary([], p6, "2026-11-22", [nap])).toBe("");
  });

  it("skips open sleeps and never reads group events for sleep", () => {
    const open = sleepEv(local(2026, 11, 22, 3), null);
    const closed = sleepEv(local(2026, 11, 22, 8), local(2026, 11, 22, 9));
    expect(formatDaySummary([closed], prefs, "2026-11-22", [open])).toBe("");
    expect(formatDaySummary([], prefs, "2026-11-22", [open, closed])).toBe("1h 0m sleep");
  });
});

describe("sleepWindowTotals", () => {
  const day = (date: string, minutes: number) => ({ date, minutes });

  it("totals the whole window but averages past days only", () => {
    const r = sleepWindowTotals(
      [day("2026-11-20", 600), day("2026-11-21", 660), day("2026-11-22", 120)],
      "2026-11-22",
    );
    expect(r.totalMin).toBe(1380);
    expect(r.avgMin).toBe(630);
  });

  it("divides by all past window days, zero-sleep days included", () => {
    // Pending product question: the other cards divide by past days WITH
    // data; sleep divides by every past day. This pins the difference.
    const r = sleepWindowTotals(
      [day("2026-11-19", 0), day("2026-11-20", 0), day("2026-11-21", 600), day("2026-11-22", 50)],
      "2026-11-22",
    );
    expect(r.avgMin).toBe(200);
  });

  it("includes today when it is the only day", () => {
    expect(sleepWindowTotals([day("2026-11-22", 90)], "2026-11-22")).toEqual({
      totalMin: 90,
      avgMin: 90,
    });
  });

  it("is zero for an empty window", () => {
    expect(sleepWindowTotals([], "2026-11-22")).toEqual({ totalMin: 0, avgMin: 0 });
  });
});

describe("chartTotals", () => {
  const d = (date: string, bottle: number, diapers: number) =>
    ({
      date,
      bottle_ml: bottle,
      pumping_ml: 0,
      nursing_minutes: 0,
      diaper_total: diapers,
    }) as unknown as import("./types").ChartDaily;

  it("excludes today from averages but not from totals", () => {
    const r = chartTotals([d("2026-11-21", 300, 4), d("2026-11-22", 100, 1)], "2026-11-22");
    expect(r.bottleTotalMl).toBe(400);
    expect(r.bottleAvgMl).toBe(300);
    expect(r.diaperAvg).toBe(4);
  });
});
