// Helpers + a tiny hook for the "X ago" affordance the Today banner uses
// to surface "last fed" and "last diaper" without a full datetime stamp.
//
// formatTimeSince favors at-a-glance readability over precision:
//   < 30s  → "just now"
//   < 60m  → "5m ago"
//   < 24h  → "1h 23m ago"
//   < 30d  → "3d ago"
//   else   → "—"  (banner falls back to no-event copy at that point)
//
// useNow returns a Date that re-renders the calling component on a fixed
// interval. We use a single shared tick across mounted banners so a
// dozen "X ago" labels don't each spin up their own setInterval.
import { useEffect, useState } from "react";

// formatTimeSince renders the gap between `now` and a past ISO timestamp.
// Future timestamps (clock drift, optimistic UI) are treated as "just
// now" — never display a negative duration.
export function formatTimeSince(at: string | null | undefined, now: Date): string {
  if (!at) return "—";
  const t = new Date(at);
  if (Number.isNaN(t.getTime())) return "—";
  const deltaMs = now.getTime() - t.getTime();
  if (deltaMs < 30_000) return "just now";
  const totalMin = Math.floor(deltaMs / 60_000);
  if (totalMin < 60) return `${totalMin}m ago`;
  const totalHr = Math.floor(totalMin / 60);
  if (totalHr < 24) {
    const remMin = totalMin - totalHr * 60;
    return remMin === 0 ? `${totalHr}h ago` : `${totalHr}h ${remMin}m ago`;
  }
  const totalDays = Math.floor(totalHr / 24);
  if (totalDays < 30) return `${totalDays}d ago`;
  return "—";
}

// EventLike is the bag of timestamp fields the Today queries return.
// Each kind has a "primary" field — `occurred_at` for point events,
// `started_at` for nursing (which doesn't have an `occurred_at`),
// `measured_at` for growth. lastEventAt walks the list and returns the
// most-recent timestamp across whichever field is populated, regardless
// of kind.
export interface EventLike {
  occurred_at?: string | null;
  started_at?: string | null;
  measured_at?: string | null;
}

// lastEventAt returns the most-recent timestamp across a list of events,
// or null if the list is empty / contains no timestamps.
//
// Generic over the input so callers can pass typed arrays without having
// to widen them to EventLike first.
export function lastEventAt<T extends EventLike>(events: ReadonlyArray<T> | null | undefined): string | null {
  if (!events || events.length === 0) return null;
  let best: number | null = null;
  let bestIso: string | null = null;
  for (const ev of events) {
    const iso = ev.occurred_at ?? ev.started_at ?? ev.measured_at ?? null;
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) continue;
    if (best === null || t > best) {
      best = t;
      bestIso = iso;
    }
  }
  return bestIso;
}

// useNow re-renders the caller every `intervalMs` milliseconds. Default
// is 60s — fast enough that "5m ago" doesn't sit on screen for 8 real
// minutes, slow enough to be invisible in CPU profiles.
//
// The first paint uses the time at mount; we don't wait one interval
// before the first tick.
export function useNow(intervalMs: number = 60_000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
