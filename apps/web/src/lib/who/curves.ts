// Pure geometry for the growth chart. Turns the WHO LMS tables into
// value-space reference curves and works out the axis extents; the SVG
// component does the trivial linear projection into its viewBox. Kept
// separate (and unit-tested in curves.test.ts) so the sampling / bounds /
// tick math has a home independent of rendering — mirrors the role
// lib/charts.ts plays for the activity sparklines.
import type { LmsRow } from "./types";
import { lmsAt, valueAtPercentile } from "./whoGrowth";

// The percentile lines the chart draws. 3rd/97th bound the shaded band,
// 50th is emphasized; 15th/85th give the eye the healthy middle. This
// matches the percentile set on a standard WHO growth chart.
export const PERCENTILE_LINES = [3, 15, 50, 85, 97] as const;

export interface CurveSample {
  age: number; // months
  value: number; // table unit (kg or cm)
}

export interface ReferenceCurve {
  pct: number;
  samples: CurveSample[];
}

// sampleReferenceCurves samples each drawn percentile across [0, ageMax]
// at `stepMonths` resolution (default 0.5), skipping any age the table
// can't cover. The sub-month step keeps the curves smooth even though the
// underlying LMS table is monthly.
export function sampleReferenceCurves(
  rows: LmsRow[],
  ageMax: number,
  stepMonths = 0.5,
): ReferenceCurve[] {
  const curves: ReferenceCurve[] = PERCENTILE_LINES.map((pct) => ({ pct, samples: [] }));
  for (let age = 0; age <= ageMax + 1e-9; age += stepMonths) {
    const a = Math.min(age, ageMax);
    const lms = lmsAt(rows, a);
    if (!lms) continue;
    for (const c of curves) c.samples.push({ age: a, value: valueAtPercentile(lms, c.pct) });
  }
  return curves;
}

// valueBounds returns the [min, max] value span to fit on the y-axis: the
// reference curves plus any measurement values, padded ~6% so nothing
// kisses the frame. Falls back to a unit span when there's nothing to plot.
export function valueBounds(
  curves: ReferenceCurve[],
  extra: number[],
): { min: number; max: number } {
  const vals: number[] = extra.slice();
  for (const c of curves) for (const s of c.samples) vals.push(s.value);
  if (vals.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

// niceAgeMax picks the x-axis extent: a bit past the child's current age,
// snapped to a friendly month boundary, capped at the standards' 60-month
// range. A newborn still gets a readable 3-month window.
export function niceAgeMax(currentAgeMonths: number): number {
  const target = Math.max(3, currentAgeMonths * 1.05);
  const steps = [3, 6, 9, 12, 18, 24, 36, 48, 60];
  for (const s of steps) if (target <= s) return s;
  return 60;
}

// niceTicks produces up to ~count round tick values spanning [min, max]
// using the classic 1/2/5×10ⁿ "nice number" rounding. Used for both axes.
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min) || count < 1) return [min];
  const range = niceNum(max - min, false);
  const step = niceNum(range / (count - 1 || 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  // Accumulate in integer steps of `step` to avoid float drift, and keep
  // only ticks actually inside the data range.
  const n = Math.round((niceMax - niceMin) / step);
  for (let i = 0; i <= n; i++) {
    const v = niceMin + i * step;
    if (v >= min - step * 1e-6 && v <= max + step * 1e-6) ticks.push(round(v, step));
  }
  return ticks.length ? ticks : [round(niceMin, step)];
}

function round(v: number, step: number): number {
  // Round to the step's precision so 0.30000000000000004 → 0.3.
  const decimals = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  return Number(v.toFixed(decimals));
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nf: number;
  if (round) {
    if (frac < 1.5) nf = 1;
    else if (frac < 3) nf = 2;
    else if (frac < 7) nf = 5;
    else nf = 10;
  } else {
    if (frac <= 1) nf = 1;
    else if (frac <= 2) nf = 2;
    else if (frac <= 5) nf = 5;
    else nf = 10;
  }
  return nf * Math.pow(10, exp);
}
