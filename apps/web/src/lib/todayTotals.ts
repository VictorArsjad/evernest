// Today-banner derivations: daily totals, latest weight, "last X" labels,
// and the sleep /day averages. Pure; no React.
import { lastEventAt, type EventLike } from "./timeSince";
import type { BottleFeed, Growth, Nursing, Pumping, Sleep } from "./types";

// Nursing minutes for one session: left+right seconds, rounded to minutes.
export function nursingMinutes(n: Pick<Nursing, "left_duration_s" | "right_duration_s">): number {
  return Math.round((Number(n.left_duration_s) + Number(n.right_duration_s)) / 60);
}

// Raw (unclamped) minutes of a CLOSED sleep. NOTE: todayTotals uses this
// as-is while formatDaySummary clamps with Math.max(0, …). The difference
// is intentionally preserved pending a product decision.
export function sleepMinutes(s: Pick<Sleep, "started_at"> & { ended_at: string }): number {
  return Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 60_000);
}

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
  const nursingMin = input.nursings?.reduce((s, n) => s + nursingMinutes(n), 0) ?? 0;
  const sleepMin =
    input.sleeps?.reduce((sum, s) => {
      if (s.ended_at == null) return sum;
      return sum + sleepMinutes({ started_at: s.started_at, ended_at: s.ended_at });
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

// lastWokeAtOf is the end of the most recent CLOSED sleep (the wake-window
// card's anchor), or null when there is none. Compared as instants (see
// lastEventAt), not strings.
export function lastWokeAtOf(sleeps: readonly Sleep[] | undefined): string | null {
  return lastEventAt(
    (sleeps ?? []).filter((s) => s.ended_at != null).map((s) => ({ occurred_at: s.ended_at })),
  );
}

// --- /day averages ---

// sleepWindowTotals: total across the window plus the /day average.
// Like charts.summarize, the average excludes `todayYMD` (the partial
// sleep-day) and divides by the past days that have data — here, at least
// one closed sleep attributed to that sleep-day (minutes > 0). Falls back
// to including today when it is the only day; zero when past days exist
// but none has data.
export function sleepWindowTotals(
  totals: readonly { date: string; minutes: number }[],
  todayYMD: string,
): { totalMin: number; avgMin: number } {
  const totalMin = totals.reduce((s, d) => s + d.minutes, 0);
  const pastDays = totals.filter((d) => d.date !== todayYMD);
  let avgMin = 0;
  if (pastDays.length === 0) {
    avgMin = totals.length > 0 ? totalMin / totals.length : 0;
  } else {
    const withData = pastDays.filter((d) => d.minutes > 0);
    avgMin =
      withData.length > 0 ? withData.reduce((s, d) => s + d.minutes, 0) / withData.length : 0;
  }
  return { totalMin, avgMin };
}
