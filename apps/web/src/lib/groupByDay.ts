// Day-bucketing helper for the History view. Groups a flat newest-first
// list of RecentEvents into per-local-day buckets so the route can
// render a "Today / Yesterday / EEE, MMM d" section per day.
//
// Local-tz keying is the whole point: an event whose UTC instant lands
// on day N in UTC may be on day N-1 in the user's local tz (or vice
// versa). Slicing the ISO string would show the wrong day for anyone
// not in UTC, so we route the day key through Date#getFullYear /
// getMonth / getDate which read the wall-clock date in the runtime's
// local tz.
import type { RecentEvent } from "./recentEvents";

export interface DayGroup {
  /** Local-tz `YYYY-MM-DD`. Stable enough to use as a React key. */
  dayKey: string;
  /** A `Date` at local midnight of that day, suitable for `date-fns`
   *  formatters (e.g. `format(date, "EEE, MMM d")`). */
  date: Date;
  /** Events in the same order they appeared in the input slice. */
  events: RecentEvent[];
}

function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localMidnight(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  return m;
}

// groupByLocalDay buckets events by the local-tz day of `event.at`.
// Buckets come back newest-day-first; per-bucket event order mirrors
// the input (so a newest-first input yields newest-first events inside
// each day, matching the call-site contract from `mergeRecent`).
//
// Note: bucket *order* sorts by the day's local-midnight `Date`, not
// by the dayKey string — that handles the offline edge where a
// year-rollover crossing or a hypothetical out-of-order input still
// sorts the way a human reads a timeline.
export function groupByLocalDay(events: RecentEvent[]): DayGroup[] {
  const byKey = new Map<string, DayGroup>();
  for (const ev of events) {
    const at = new Date(ev.at);
    const key = localDayKey(at);
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { dayKey: key, date: localMidnight(at), events: [] };
      byKey.set(key, bucket);
    }
    bucket.events.push(ev);
  }
  return Array.from(byKey.values()).sort(
    (a, b) => b.date.getTime() - a.date.getTime(),
  );
}
