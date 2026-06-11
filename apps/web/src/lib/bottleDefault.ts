// Suggests a default bottle-feed amount from recent history for the log
// form's prefill. Bottle amounts are usually constant (a baby drinks the
// same ~120 ml feed after feed), changing only across a growth spurt or a
// difficult patch — so the most useful default is the MODE (most common
// amount) over a recent window, not an average. An average would drift to
// non-round values nobody actually pours; the mode snaps to a real,
// regularly-poured amount and naturally migrates to a new steady state
// once that amount becomes the norm.
//
// Framework-agnostic on purpose (no React, no date-fns): operates on
// canonical ml + ISO timestamps so it's trivially unit-tested and cheap to
// call from any render path. The caller converts the returned ml to the
// baby's display unit.

// FeedSample is the minimal shape suggestBottleAmountMl needs; the full
// BottleFeed type structurally satisfies it.
export interface FeedSample {
  amount_ml: number;
  occurred_at: string;
}

// Default lookback window. Two weeks is long enough to gather a stable
// sample for a baby feeding several times a day, but short enough that a
// genuine change in the usual amount (growth spurt) takes over the mode
// within a few days of becoming the new routine.
export const DEFAULT_WINDOW_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// suggestBottleAmountMl returns the most common amount_ml among feeds in
// the last `windowDays`, or null when there's no usable history (the form
// then stays empty, as it did before this feature). Ties are broken toward
// the amount seen in the MOST RECENT qualifying feed, so a single one-off
// odd feed (a small top-up, a big catch-up) never wins on its own, but a
// newly-adopted amount climbs to the top as soon as it ties the old one.
export function suggestBottleAmountMl(
  feeds: readonly FeedSample[],
  now: Date = new Date(),
  windowDays: number = DEFAULT_WINDOW_DAYS,
): number | null {
  const cutoff = now.getTime() - windowDays * MS_PER_DAY;

  // For each distinct amount, track how often it appears and the most
  // recent time it was logged (for the tie-break).
  const stats = new Map<number, { count: number; lastSeen: number }>();
  for (const feed of feeds) {
    const amount = feed.amount_ml;
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const t = new Date(feed.occurred_at).getTime();
    if (!Number.isFinite(t) || t < cutoff || t > now.getTime()) continue;
    const prev = stats.get(amount);
    if (prev) {
      prev.count += 1;
      if (t > prev.lastSeen) prev.lastSeen = t;
    } else {
      stats.set(amount, { count: 1, lastSeen: t });
    }
  }

  let best: { amount: number; count: number; lastSeen: number } | null = null;
  for (const [amount, { count, lastSeen }] of stats) {
    if (
      !best ||
      count > best.count ||
      (count === best.count && lastSeen > best.lastSeen)
    ) {
      best = { amount, count, lastSeen };
    }
  }

  return best ? best.amount : null;
}
