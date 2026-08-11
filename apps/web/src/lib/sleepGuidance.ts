// Age-based sleep guidance for the wake-window card (Today) and the
// daily-sleep-total band (Charts). Same posture as recommendations.ts:
//
// THESE ARE NOT MEDICAL ADVICE. Daily totals are the AAP-endorsed
// consensus ranges (AAP / American Academy of Sleep Medicine,
// healthychildren.org → "Healthy Sleep Habits"); wake windows are
// midpoints of commonly-cited pediatric sleep guidance (they appear in
// broadly similar form across pediatric sleep references — there is no
// single canonical table). Babies vary a lot; the UI copy hedges
// accordingly and everything here hides when the baby has no DoB.
import type { Baby } from "./types";
import { monthsBetween } from "./recommendations";

// WakeWindow is the typical stretch (in minutes) a baby of a given age
// can comfortably stay awake between sleeps. Past `maxMin` the baby is
// increasingly likely to be overtired.
export interface WakeWindow {
  minMin: number;
  maxMin: number;
}

// DailySleepRange is the recommended TOTAL sleep per 24h (naps + night),
// in hours.
export interface DailySleepRange {
  minH: number;
  maxH: number;
}

interface Bracket {
  // Inclusive upper bound in completed months — same convention as
  // recommendations.ts BRACKETS.
  maxMonths: number;
  wake: WakeWindow;
  daily: DailySleepRange;
}

// Keep ordered by maxMonths ascending; lookup walks linearly. Daily
// ranges follow AAP/AASM (0–3mo has no formal AASM recommendation, so we
// use the commonly-cited 14–17h newborn range); wake windows coalesce
// the usual per-month tables into the same brackets.
const BRACKETS: Bracket[] = [
  { maxMonths: 3, wake: { minMin: 45, maxMin: 90 }, daily: { minH: 14, maxH: 17 } },
  { maxMonths: 6, wake: { minMin: 90, maxMin: 150 }, daily: { minH: 12, maxH: 16 } },
  { maxMonths: 9, wake: { minMin: 120, maxMin: 180 }, daily: { minH: 12, maxH: 16 } },
  { maxMonths: 12, wake: { minMin: 150, maxMin: 210 }, daily: { minH: 12, maxH: 16 } },
  { maxMonths: 24, wake: { minMin: 180, maxMin: 240 }, daily: { minH: 11, maxH: 14 } },
  { maxMonths: Infinity, wake: { minMin: 240, maxMin: 360 }, daily: { minH: 10, maxH: 13 } },
];

function bracketFor(
  baby: Pick<Baby, "date_of_birth"> | null,
  now: Date,
): Bracket | null {
  if (!baby || !baby.date_of_birth) return null;
  const dob = new Date(baby.date_of_birth);
  if (Number.isNaN(dob.getTime())) return null;
  if (dob.getTime() > now.getTime()) return null;
  const ageMonths = monthsBetween(dob, now);
  for (const b of BRACKETS) {
    if (ageMonths <= b.maxMonths) return b;
  }
  return BRACKETS[BRACKETS.length - 1];
}

// getWakeWindow returns the typical awake stretch for the baby's age, or
// null when DoB is missing/invalid (callers hide the card).
export function getWakeWindow(
  baby: Pick<Baby, "date_of_birth"> | null,
  now: Date,
): WakeWindow | null {
  return bracketFor(baby, now)?.wake ?? null;
}

// getDailySleepRange returns the recommended total sleep per 24h for the
// baby's age, or null when DoB is missing/invalid (callers hide the
// band).
export function getDailySleepRange(
  baby: Pick<Baby, "date_of_birth"> | null,
  now: Date,
): DailySleepRange | null {
  return bracketFor(baby, now)?.daily ?? null;
}
