// Pure helpers for the open-nursing in-progress chip on the Today screen.
// The chip needs an "elapsed since start" string that can be recomputed
// every 30s without re-rendering the whole tile, so the formatter is kept
// here as a pure function (and unit-tested in nursingTimer.test.ts).

// formatElapsedHHMM returns "H:MM" elapsed between `startedAt` and `now`.
// Hours are unpadded so a 5-minute session reads "0:05" rather than
// "00:05" (less visually heavy on the chip). Negative deltas (clock skew
// between server and client clamping `started_at` slightly into the
// future) and any non-finite math collapse to "0:00" so the chip never
// renders garbage like "NaN:NaN".
export function formatElapsedHHMM(startedAt: Date | string, now: Date | string): string {
  const startMs = toMillis(startedAt);
  const nowMs = toMillis(now);
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return "0:00";
  const deltaMs = nowMs - startMs;
  if (deltaMs <= 0) return "0:00";
  const totalMinutes = Math.floor(deltaMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function toMillis(t: Date | string): number {
  if (t instanceof Date) return t.getTime();
  return new Date(t).getTime();
}
