import { describe, expect, it } from "vitest";

import { classifySleep, clipSleepToDays, dailySleepTotals } from "./sleepDays";
import type { Sleep } from "./types";

const NOW = new Date(2026, 7, 11, 12, 0); // local Aug 11 2026, noon

// Local-time ISO builder so the tests are timezone-independent: the
// helpers work in local time, so we must construct instants in local
// time too.
function local(y: number, mo: number, d: number, h: number, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

function sleep(overrides: Partial<Sleep>): Sleep {
  return {
    id: "s1",
    baby_id: "b1",
    started_at: local(2026, 8, 10, 13),
    ended_at: local(2026, 8, 10, 14),
    sleep_type: null,
    location: null,
    notes: null,
    source: "manual",
    created_at: local(2026, 8, 10, 13),
    ...overrides,
  };
}

describe("classifySleep", () => {
  it("respects an explicit type", () => {
    const s = sleep({ sleep_type: "night", started_at: local(2026, 8, 10, 13) });
    expect(classifySleep(s, new Date(2026, 7, 10, 14))).toBe("night");
  });

  it("infers night for intervals crossing midnight or in the small hours", () => {
    const overnight = sleep({ started_at: local(2026, 8, 10, 22), ended_at: local(2026, 8, 11, 6, 30) });
    expect(classifySleep(overnight, new Date(2026, 7, 11, 6, 30))).toBe("night");
    const earlyMorning = sleep({ started_at: local(2026, 8, 10, 4), ended_at: local(2026, 8, 10, 5) });
    expect(classifySleep(earlyMorning, new Date(2026, 7, 10, 5))).toBe("night");
  });

  it("infers nap for daytime intervals", () => {
    const s = sleep({ started_at: local(2026, 8, 10, 13), ended_at: local(2026, 8, 10, 14, 30) });
    expect(classifySleep(s, new Date(2026, 7, 10, 14, 30))).toBe("nap");
  });
});

describe("clipSleepToDays", () => {
  it("renders every window day even when empty", () => {
    const days = clipSleepToDays([], "2026-08-09", "2026-08-11", NOW);
    expect(days.map((d) => d.date)).toEqual(["2026-08-09", "2026-08-10", "2026-08-11"]);
    expect(days.every((d) => d.segments.length === 0)).toBe(true);
  });

  it("splits an overnight sleep at local midnight", () => {
    const overnight = sleep({
      id: "n1",
      sleep_type: "night",
      started_at: local(2026, 8, 10, 22),
      ended_at: local(2026, 8, 11, 6, 30),
    });
    const days = clipSleepToDays([overnight], "2026-08-10", "2026-08-11", NOW);
    expect(days[0].segments).toEqual([
      expect.objectContaining({ startMin: 22 * 60, endMin: 1440, type: "night", open: false }),
    ]);
    expect(days[1].segments).toEqual([
      expect.objectContaining({ startMin: 0, endMin: 6 * 60 + 30, type: "night", open: false }),
    ]);
  });

  it("paints the window's first morning from a sleep that started before the window", () => {
    const overnight = sleep({
      started_at: local(2026, 8, 9, 23),
      ended_at: local(2026, 8, 10, 5),
    });
    const days = clipSleepToDays([overnight], "2026-08-10", "2026-08-11", NOW);
    expect(days[0].segments).toEqual([
      expect.objectContaining({ startMin: 0, endMin: 5 * 60 }),
    ]);
  });

  it("clips an open session at now and flags it", () => {
    const open = sleep({ started_at: local(2026, 8, 11, 11), ended_at: null });
    const days = clipSleepToDays([open], "2026-08-11", "2026-08-11", NOW);
    expect(days[0].segments).toEqual([
      expect.objectContaining({ startMin: 11 * 60, endMin: 12 * 60, open: true }),
    ]);
  });

  it("drops malformed and zero-length rows", () => {
    const bad = sleep({ started_at: "nope" });
    const inverted = sleep({ started_at: local(2026, 8, 10, 14), ended_at: local(2026, 8, 10, 14) });
    const days = clipSleepToDays([bad, inverted], "2026-08-10", "2026-08-10", NOW);
    expect(days[0].segments).toEqual([]);
  });
});

describe("dailySleepTotals", () => {
  it("attributes an overnight sleep wholly to its start day", () => {
    const overnight = sleep({
      started_at: local(2026, 8, 10, 22),
      ended_at: local(2026, 8, 11, 6, 30),
    });
    const totals = dailySleepTotals([overnight], "2026-08-10", "2026-08-11");
    expect(totals).toEqual([
      { date: "2026-08-10", minutes: 8.5 * 60 },
      { date: "2026-08-11", minutes: 0 },
    ]);
  });

  it("excludes open sessions and sums multiple naps", () => {
    const nap1 = sleep({ id: "a", started_at: local(2026, 8, 10, 9), ended_at: local(2026, 8, 10, 10) });
    const nap2 = sleep({ id: "b", started_at: local(2026, 8, 10, 13), ended_at: local(2026, 8, 10, 14, 30) });
    const open = sleep({ id: "c", started_at: local(2026, 8, 10, 20), ended_at: null });
    const totals = dailySleepTotals([nap1, nap2, open], "2026-08-10", "2026-08-10");
    expect(totals).toEqual([{ date: "2026-08-10", minutes: 150 }]);
  });

  it("ignores rows outside the window", () => {
    const before = sleep({ started_at: local(2026, 8, 1, 9), ended_at: local(2026, 8, 1, 10) });
    const totals = dailySleepTotals([before], "2026-08-10", "2026-08-10");
    expect(totals).toEqual([{ date: "2026-08-10", minutes: 0 }]);
  });
});
