// Pure helpers for the sleep charts on /charts. Two different day rules
// coexist on purpose:
//
//   - clipSleepToDays (rhythm chart): intervals are CLIPPED at the
//     sleep-day cutover for display, so a 22:00→06:30 night with a
//     midnight cutover paints the bottom of one column and the top of
//     the next — that's what makes the pattern readable. With a 6am
//     cutover the same night sits wholly in one column.
//   - dailySleepTotals (totals band): an interval counts WHOLLY toward
//     the sleep-day it started, matching the Today banner total and the
//     History roll-up so the three surfaces never disagree about "how
//     much sleep happened on Tuesday".
//
// The cutover hour (dayStartHour, 0–23) comes from baby_settings.day_start_hour.
// 0 = local midnight (legacy). Both take YMD strings (the /charts window)
// and work in local time via the same setDate arithmetic as charts.ts so
// DST transitions stay on wall-clock day boundaries.
import { formatLocalYMD } from "./charts";
import type { Sleep, SleepType } from "./types";

export interface SleepSegment {
  // Minutes from the sleep-day cutover, [0, 1440]. endMin > startMin always.
  startMin: number;
  endMin: number;
  type: SleepType;
  // True when this segment comes from a still-open session (clipped at
  // `now`); renderers draw it dimmed.
  open: boolean;
  // Source row, for tooltips.
  sleep: Sleep;
}

export interface SleepDay {
  date: string; // YYYY-MM-DD (sleep-day key)
  segments: SleepSegment[];
}

// classify returns the row's explicit type, falling back to a heuristic
// for untyped rows: anything overlapping the deep-night hours
// (00:00–06:00 local) reads as night sleep, everything else as a nap.
// Independent of dayStartHour — nap vs night, not day cutover.
export function classifySleep(s: Pick<Sleep, "sleep_type" | "started_at" | "ended_at">, end: Date): SleepType {
  if (s.sleep_type === "nap" || s.sleep_type === "night") return s.sleep_type;
  const start = new Date(s.started_at);
  // Overlaps 00:00–06:00 if it starts before 06:00, or crosses midnight.
  if (start.getHours() < 6 || end.getHours() < 6) return "night";
  if (formatLocalYMD(start) !== formatLocalYMD(end)) return "night";
  return "nap";
}

function localMidnight(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map((n) => Number.parseInt(n, 10));
  return new Date(y, m - 1, d);
}

function clampHour(hour: number): number {
  if (!Number.isFinite(hour)) return 0;
  return Math.min(23, Math.max(0, Math.trunc(hour)));
}

// sleepDayKey returns the YYYY-MM-DD label of the sleep-day containing
// `instant`. A sleep-day labeled D runs [D @ hour, D+1 @ hour). Shifting
// back by `hour` hours makes hour=0 identical to formatLocalYMD.
export function sleepDayKey(instant: Date, hour: number): string {
  const h = clampHour(hour);
  const shifted = new Date(instant.getTime());
  shifted.setHours(shifted.getHours() - h);
  return formatLocalYMD(shifted);
}

// sleepDayBounds returns the half-open [start, end) window for sleep-day
// `ymd` at the given cutover hour.
export function sleepDayBounds(ymd: string, hour: number): { start: Date; end: Date } {
  const h = clampHour(hour);
  const start = localMidnight(ymd);
  start.setHours(h, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

// currentSleepDayBounds returns the in-progress sleep-day containing `now`
// (at 5am with cutover 6, that is still yesterday's sleep-day).
export function currentSleepDayBounds(
  now: Date,
  hour: number,
): { start: Date; end: Date; ymd: string } {
  const ymd = sleepDayKey(now, hour);
  const { start, end } = sleepDayBounds(ymd, hour);
  return { start, end, ymd };
}

function minutesIntoDay(d: Date, dayStart: Date): number {
  return Math.round((d.getTime() - dayStart.getTime()) / 60_000);
}

// clipSleepToDays projects sleeps onto the [fromYMD, toYMD] window (both
// inclusive sleep-day keys), splitting intervals at the cutover. Open
// sessions are clipped at `now`. Rows entirely outside the window are
// dropped; zero-length clips are dropped too. Callers should fetch the
// sleeps list with `from` one day EARLIER than the window so an
// overnight sleep that started the day before still paints the window's
// first morning.
export function clipSleepToDays(
  sleeps: readonly Sleep[],
  fromYMD: string,
  toYMD: string,
  now: Date,
  dayStartHour = 0,
): SleepDay[] {
  const hour = clampHour(dayStartHour);
  // Materialize the day list first so every day renders a column even
  // when empty.
  const days: SleepDay[] = [];
  const byDate = new Map<string, SleepDay>();
  for (let d = localMidnight(fromYMD); ; d.setDate(d.getDate() + 1)) {
    const ymd = formatLocalYMD(d);
    const day: SleepDay = { date: ymd, segments: [] };
    days.push(day);
    byDate.set(ymd, day);
    if (ymd === toYMD) break;
    // Defensive bound: never loop past ~1 year even on a malformed range.
    if (days.length > 400) break;
  }

  for (const s of sleeps) {
    const start = new Date(s.started_at);
    if (Number.isNaN(start.getTime())) continue;
    const open = s.ended_at == null;
    const end = open ? now : new Date(s.ended_at as string);
    if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) continue;
    const type = classifySleep(s, end);

    // Walk sleep-days the interval touches, clipping to each.
    const firstKey = sleepDayKey(start, hour);
    for (
      let dayStart = sleepDayBounds(firstKey, hour).start;
      dayStart.getTime() < end.getTime();
      dayStart.setDate(dayStart.getDate() + 1)
    ) {
      const ymd = sleepDayKey(dayStart, hour);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const day = byDate.get(ymd);
      if (day) {
        const segStart = Math.max(
          0,
          minutesIntoDay(new Date(Math.max(start.getTime(), dayStart.getTime())), dayStart),
        );
        const segEnd = Math.min(
          1440,
          minutesIntoDay(new Date(Math.min(end.getTime(), dayEnd.getTime())), dayStart),
        );
        if (segEnd > segStart) {
          day.segments.push({ startMin: segStart, endMin: segEnd, type, open, sleep: s });
        }
      }
    }
  }
  for (const day of days) day.segments.sort((a, b) => a.startMin - b.startMin);
  return days;
}

// dailySleepTotals sums CLOSED sleep minutes per sleep-day, attributing
// each interval wholly to the sleep-day it started (see module comment).
// Returns one entry per day in the window, zeros included, in ascending
// date order.
export function dailySleepTotals(
  sleeps: readonly Sleep[],
  fromYMD: string,
  toYMD: string,
  dayStartHour = 0,
): { date: string; minutes: number }[] {
  const hour = clampHour(dayStartHour);
  const totals = new Map<string, number>();
  const order: string[] = [];
  for (let d = localMidnight(fromYMD); ; d.setDate(d.getDate() + 1)) {
    const ymd = formatLocalYMD(d);
    totals.set(ymd, 0);
    order.push(ymd);
    if (ymd === toYMD) break;
    if (order.length > 400) break;
  }
  for (const s of sleeps) {
    if (s.ended_at == null) continue;
    const start = new Date(s.started_at);
    const end = new Date(s.ended_at);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const min = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
    const ymd = sleepDayKey(start, hour);
    if (totals.has(ymd)) totals.set(ymd, (totals.get(ymd) ?? 0) + min);
  }
  return order.map((date) => ({ date, minutes: totals.get(date) ?? 0 }));
}
