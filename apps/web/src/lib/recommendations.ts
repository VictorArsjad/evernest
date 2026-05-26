// Age-based daily-target recommendations for the Today banner's progress
// bars. Returns sensible per-metric denominators given a baby's date of
// birth, or `null` when DoB is missing (banner hides bars in that case).
//
// THESE ARE NOT MEDICAL ADVICE. The numbers are reasonable midpoints of
// commonly-cited US/EU pediatric guidance (AAP feeding pages, La Leche
// League, NHS infant feeding pages — all generic, not patient-specific)
// rounded to feel like targets rather than precise instructions. The
// settings toggle exists so a user can hide them entirely if they find
// the bars stressful or unhelpful — that's the recommended posture if
// you're working with a pediatrician's own plan.
//
// Numbers chosen so the bars hit ~80% on a "typical" day and >100% on a
// big day. We deliberately cap displayed fill at 100% so the visual
// stays honest (no "200% of target" spectacle) but the underlying values
// in `DailyTargets` are exact for any caller that wants the raw target.
import type { Baby } from "./types";

// DailyTargets enumerates one number per metric the Today banner draws a
// progress bar for. Growth is omitted intentionally — it has no daily
// total in this app's data model.
export interface DailyTargets {
  bottle_ml: number;
  nursing_min: number;
  pumping_ml: number;
  diapers: number;
}

// Age brackets (in completed months) → per-metric daily targets.
//
// Sources, in priority order when they disagree:
//   1. AAP guidance (https://www.healthychildren.org → "How Much and How
//      Often" series).
//   2. WHO "Infant and young child feeding" fact sheet for solids ramp.
//   3. La Leche League milk-removal numbers for the pumping column (this
//      is supply, not intake — see comment on `pumping_ml`).
//
// The brackets coalesce intervals where the guidance is similar enough
// that a single number is more honest than a per-month curve.
//
// Keep the table ordered by `maxMonths` ascending; the lookup walks
// it linearly and picks the first match.
interface Bracket {
  // Inclusive upper bound in completed months. The first row's range is
  // [0, maxMonths]; subsequent rows are (prev.maxMonths, this.maxMonths].
  // The final row uses Infinity so any age beyond 12 months resolves.
  maxMonths: number;
  targets: DailyTargets;
}

const BRACKETS: Bracket[] = [
  // 0–1 month: ~480 ml/day intake (8 feeds × ~60ml). Diapers ~8/day is
  // the low end of "enough" — pediatricians often use 6+ as a hydration
  // floor. Nursing min is duration not intake; an exclusively-breastfed
  // newborn typically nurses 8×~15min ≈ 120 min, but we render it as a
  // bar against a generous target so under-feeding doesn't look like
  // a green checkmark — hence the slightly higher number than the
  // typical floor.
  { maxMonths: 1, targets: { bottle_ml: 480, nursing_min: 160, pumping_ml: 600, diapers: 8 } },
  // 1–3 months: intake ramps as the stomach grows; feeds are fewer but
  // larger (≈ 6 feeds × 120 ml).
  { maxMonths: 3, targets: { bottle_ml: 720, nursing_min: 140, pumping_ml: 720, diapers: 6 } },
  // 3–6 months: peak intake right before solids start. After ~6mo
  // solids displace some milk, so the curve plateaus rather than
  // continuing to rise.
  { maxMonths: 6, targets: { bottle_ml: 900, nursing_min: 120, pumping_ml: 720, diapers: 6 } },
  // 6–12 months: solids ramp. Milk intake stays meaningful but
  // diapers per day drops as digestion matures.
  { maxMonths: 12, targets: { bottle_ml: 720, nursing_min: 100, pumping_ml: 480, diapers: 5 } },
  // 12+ months: toddler. Cow's milk / cup. Numbers are floor-y; the bars
  // are mostly decorative at this age and most users will toggle them
  // off, but the app still tracks feeds for some families through 18mo.
  { maxMonths: Infinity, targets: { bottle_ml: 480, nursing_min: 60, pumping_ml: 240, diapers: 4 } },
];

// monthsBetween returns whole completed months between two timestamps.
// Exported for the test seam. We deliberately do not use date-fns
// differenceInMonths here because we want a simple, predictable
// "calendar months elapsed including partial day rounding down" — which
// is exactly what subtracting year+month with a day-correction gives us.
export function monthsBetween(start: Date, end: Date): number {
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  // If the end day-of-month hasn't reached the start day-of-month, the
  // current month isn't yet "completed" — back off by one.
  if (end.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

// getDailyTargets returns the recommended daily target for each metric
// given a baby's DoB and "now". Returns null if DoB is missing or
// invalid; callers should hide the progress bars in that case rather
// than silently using bracket-0 numbers (which would be misleading for
// e.g. a 5-year-old's data still being viewed in the app).
export function getDailyTargets(
  baby: Pick<Baby, "date_of_birth"> | null,
  now: Date,
): DailyTargets | null {
  if (!baby || !baby.date_of_birth) return null;
  const dob = new Date(baby.date_of_birth);
  if (Number.isNaN(dob.getTime())) return null;
  if (dob.getTime() > now.getTime()) return null;
  const ageMonths = monthsBetween(dob, now);
  for (const b of BRACKETS) {
    if (ageMonths <= b.maxMonths) return b.targets;
  }
  // Unreachable given the Infinity sentinel above, but keep TS happy and
  // serve as a defensive return if someone removes the last bracket.
  return BRACKETS[BRACKETS.length - 1].targets;
}
