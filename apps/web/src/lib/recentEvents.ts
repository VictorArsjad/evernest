// Pure helpers for the Today screen "Recent" list. Kept here (rather than
// inline in the route) so the comparator can be tested in isolation —
// see recentEvents.test.ts.
import type { BottleFeed, Diaper, Pumping } from "./types";

export type RecentEvent =
  | { kind: "bottle"; at: string; data: BottleFeed }
  | { kind: "diaper"; at: string; data: Diaper }
  | { kind: "pumping"; at: string; data: Pumping };

export interface RecentEventSources {
  bottleFeeds?: readonly BottleFeed[];
  diapers?: readonly Diaper[];
  pumpings?: readonly Pumping[];
}

// compareRecentDesc sorts events newest first by `occurred_at` instant,
// breaking ties on `created_at` so events that genuinely share an
// `occurred_at` (very common with the "Now" preset in the log forms)
// render in deterministic logging order.
//
// Compare as instants (not strings): ISO timestamps from the API may
// differ in fractional-second precision or timezone offset between rows,
// so a lexicographic string compare can put a strictly-later instant
// behind an earlier one.
export function compareRecentDesc(a: RecentEvent, b: RecentEvent): number {
  const occurredDelta = new Date(b.at).getTime() - new Date(a.at).getTime();
  if (occurredDelta !== 0) return occurredDelta;
  return new Date(b.data.created_at).getTime() - new Date(a.data.created_at).getTime();
}

// mergeRecent flattens the per-kind query results into a single
// time-sorted list ready for rendering.
export function mergeRecent(sources: RecentEventSources): RecentEvent[] {
  const events: RecentEvent[] = [
    ...(sources.bottleFeeds ?? []).map<RecentEvent>((f) => ({
      kind: "bottle",
      at: f.occurred_at,
      data: f,
    })),
    ...(sources.diapers ?? []).map<RecentEvent>((d) => ({
      kind: "diaper",
      at: d.occurred_at,
      data: d,
    })),
    ...(sources.pumpings ?? []).map<RecentEvent>((p) => ({
      kind: "pumping",
      at: p.occurred_at,
      data: p,
    })),
  ];
  events.sort(compareRecentDesc);
  return events;
}
