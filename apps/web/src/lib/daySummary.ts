// Day summary: the pure derivations behind the Today banner and the
// Charts & History screen — query windows, daily totals, "last X" labels,
// per-day history rollups and the /day averages. No React; the routes
// fetch, call these, and render.
import { currentSleepDayBounds } from "./sleepDays";
import { lastEventAt, type EventLike } from "./timeSince";
import type { BottleFeed, Growth, Nursing, Pumping, Sleep } from "./types";

// --- Today windows ---

// Lookback for "last fed / last diaper": the banner surfaces the most
// recent event regardless of day, so 30 days matches formatTimeSince's
// ceiling (older than that renders "—" anyway).
const SINCE_DAYS = 30;

// todayWindows returns ISO instants for the local-calendar "today" and
// the 30-day lookback start, all anchored at local midnight.
export function todayWindows(now: Date): { from: string; to: string; since: string } {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  const since = new Date(now);
  since.setDate(since.getDate() - SINCE_DAYS);
  since.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString(), since: since.toISOString() };
}

// todaySleepWindow follows the baby's sleep-day cutover (e.g. 6am→6am),
// independent of the calendar-midnight window used for other metrics.
export function todaySleepWindow(now: Date, dayStartHour: number): { from: string; to: string } {
  const { start, end } = currentSleepDayBounds(now, dayStartHour);
  return { from: start.toISOString(), to: end.toISOString() };
}

// --- Today totals ---

export interface TodayTotalsInput {
  feeds?: readonly BottleFeed[];
  pumpings?: readonly Pumping[];
  nursings?: readonly Nursing[];
  // Sleeps fetched with the sleep-day window.
  sleeps?: readonly Sleep[];
}

export interface TodayTotals {
  totalMl: number;
  pumpedMl: number;
  nursingMin: number;
  sleepMin: number;
}

// Nursing minutes are rounded per row, then summed (not rounded once
// over the total). Sleep counts closed intervals only, attributed to the
// sleep-day they started in — the caller's window already selects that.
export function todayTotals(input: TodayTotalsInput): TodayTotals {
  const totalMl = input.feeds?.reduce((s, f) => s + Number(f.amount_ml), 0) ?? 0;
  const pumpedMl = input.pumpings?.reduce((s, p) => s + Number(p.amount_ml), 0) ?? 0;
  const nursingMin =
    input.nursings?.reduce(
      (s, n) => s + Math.round((Number(n.left_duration_s) + Number(n.right_duration_s)) / 60),
      0,
    ) ?? 0;
  const sleepMin =
    input.sleeps?.reduce((sum, s) => {
      if (s.ended_at == null) return sum;
      return (
        sum +
        Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60_000)
      );
    }, 0) ?? 0;
  return { totalMl, pumpedMl, nursingMin, sleepMin };
}

// latestWeightG returns the weight of the first row carrying one; the
// growths list arrives newest-first.
export function latestWeightGrams(growths: readonly Growth[] | undefined): number | null {
  const row = growths?.find((g) => g.weight_g != null);
  return row?.weight_g != null ? Number(row.weight_g) : null;
}

// --- Last-event labels ---

export interface LastEventsInput {
  latestFeeds?: readonly BottleFeed[];
  latestNursings?: readonly Nursing[];
  latestDiapers?: readonly EventLike[];
  latestSolids?: readonly EventLike[];
}

// "Last fed" combines bottle feeds and COMPLETED nursing sessions: an open
// session is shown as "Nursing now" with higher priority in the banner, so
// it is excluded here to avoid double-counting.
export function lastEvents(input: LastEventsInput): {
  lastFedAt: string | null;
  lastDiaperAt: string | null;
  lastSolidsAt: string | null;
} {
  return {
    lastFedAt: lastEventAt([
      ...(input.latestFeeds ?? []),
      ...(input.latestNursings ?? []).filter((n) => n.ended_at != null),
    ]),
    lastDiaperAt: lastEventAt(input.latestDiapers ?? []),
    lastSolidsAt: lastEventAt(input.latestSolids ?? []),
  };
}

// lastWokeAt is the end of the most recent CLOSED sleep (the wake-window
// card's anchor), or null when there is none.
export function lastWokeAtOf(sleeps: readonly Sleep[] | undefined): string | null {
  return (
    (sleeps ?? [])
      .filter((s) => s.ended_at != null)
      .map((s) => s.ended_at as string)
      .sort()
      .at(-1) ?? null
  );
}
