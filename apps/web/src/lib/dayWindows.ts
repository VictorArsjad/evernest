// Query windows for the Today banner and the Charts & History screen:
// local-calendar "today", the sleep-day window, the visible chart range
// and the raw-event / sleep-rhythm history windows. Pure; no React.
import { currentSleepDayBounds } from "./sleepDays";

// Lookback for "last fed / last diaper": the banner surfaces the most
// recent event regardless of day, so 30 days matches formatTimeSince's
// ceiling (older than that renders "—" anyway).
const SINCE_DAYS = 30;

// todayWindows returns ISO instants for the local-calendar "today" and
// the 30-day lookback start, all anchored at local midnight.
export function todayWindows(now: Date): {
  from: string;
  to: string;
  since: string;
} {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  const since = new Date(now);
  since.setDate(since.getDate() - SINCE_DAYS);
  since.setHours(0, 0, 0, 0);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    since: since.toISOString(),
  };
}

// todaySleepWindow follows the baby's sleep-day cutover (e.g. 6am→6am),
// independent of the calendar-midnight window used for other metrics.
export function todaySleepWindow(now: Date, dayStartHour: number): { from: string; to: string } {
  const { start, end } = currentSleepDayBounds(now, dayStartHour);
  return { from: start.toISOString(), to: end.toISOString() };
}

// chartEndDate is the last day of the visible window: local midnight of
// today when offset is 0, otherwise `offset * range` days earlier. setDate
// (not MS_PER_DAY offsets) keeps windows on wall-clock day boundaries
// across DST transitions.
export function chartEndDate(now: Date, range: number, offset: number): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offset * range);
  return d;
}

// historyWindows returns the raw-event window (the `range` days ending on
// `endDate`) and the sleep-rhythm window, which reaches one extra lookback
// day: an overnight sleep that STARTED before the window still paints the
// window's first morning once clipped at the cutover.
export function historyWindows(
  endDate: Date,
  range: number,
): {
  history: { from: string; to: string };
  rhythm: { from: string; to: string };
} {
  const historyFrom = new Date(endDate);
  historyFrom.setDate(historyFrom.getDate() - (range - 1));
  const to = new Date(endDate);
  to.setHours(23, 59, 59, 999);
  const toIso = to.toISOString();
  const rhythmFrom = new Date(endDate);
  rhythmFrom.setDate(rhythmFrom.getDate() - range);
  return {
    history: { from: historyFrom.toISOString(), to: toIso },
    rhythm: { from: rhythmFrom.toISOString(), to: toIso },
  };
}
