// Per-day History rows: the one-line day summary and the set of days that
// have entries. Pure; no React.
import type { DayGroup } from "./groupByDay";
import type { RecentEvent } from "./recentEvents";
import { sleepDayKey } from "./sleepDays";
import { nursingMinutes, sleepMinutes } from "./todayTotals";
import { formatDurationHM, formatVolume } from "./units";
import type { CombinedPreferences } from "./usePreferences";

// entryDayKeys: the local days that actually have History entries, so a
// chart bar for an empty day offers no jump.
export function entryDayKeys(groups: readonly DayGroup[]): Set<string> {
  return new Set(groups.map((g) => g.dayKey));
}

export type DaySummaryPrefs = Pick<CombinedPreferences, "unit_volume" | "day_start_hour">;

// Roll up the day's events into a one-line "60 ml · 12 min nursing · …"
// summary. Zero parts are dropped so a quiet day reads "2 diapers"
// rather than "0 ml · 0 min nursing · 0 pumped · 2 diapers · 0 growth".
// Sleep minutes are attributed by sleep-day key (prefs.day_start_hour),
// matching Today + sleep totals — so they may come from a neighboring
// calendar group's events when the cutover ≠ midnight.
export function formatDaySummary(
  events: RecentEvent[],
  prefs: DaySummaryPrefs,
  dayKey: string,
  allEvents: RecentEvent[],
): string {
  let bottleMl = 0;
  let nursingMin = 0;
  let pumpedMl = 0;
  let diaperCount = 0;
  let growthCount = 0;
  let sleepMin = 0;
  let noteCount = 0;
  for (const ev of events) {
    switch (ev.kind) {
      case "bottle":
        bottleMl += Number(ev.data.amount_ml) || 0;
        break;
      case "nursing":
        nursingMin += nursingMinutes(ev.data);
        break;
      case "pumping":
        pumpedMl += Number(ev.data.amount_ml) || 0;
        break;
      case "diaper":
        diaperCount += 1;
        break;
      case "growth":
        growthCount += 1;
        break;
      case "note":
        noteCount += 1;
        break;
      // sleep handled below via sleep-day key across allEvents
    }
  }
  for (const ev of allEvents) {
    if (ev.kind !== "sleep" || ev.data.ended_at == null) continue;
    if (sleepDayKey(new Date(ev.data.started_at), prefs.day_start_hour) !== dayKey) continue;
    sleepMin += Math.max(
      0,
      sleepMinutes({
        started_at: ev.data.started_at,
        ended_at: ev.data.ended_at,
      }),
    );
  }
  const parts: string[] = [];
  if (bottleMl > 0) parts.push(formatVolume(bottleMl, prefs.unit_volume));
  if (nursingMin > 0) parts.push(`${nursingMin} min nursing`);
  if (pumpedMl > 0) parts.push(`${formatVolume(pumpedMl, prefs.unit_volume)} pumped`);
  if (diaperCount > 0) parts.push(`${diaperCount} ${diaperCount === 1 ? "diaper" : "diapers"}`);
  if (growthCount > 0) parts.push(`${growthCount} growth`);
  if (sleepMin > 0) parts.push(`${formatDurationHM(sleepMin)} sleep`);
  if (noteCount > 0) parts.push(`${noteCount} ${noteCount === 1 ? "note" : "notes"}`);
  return parts.join(" · ");
}
