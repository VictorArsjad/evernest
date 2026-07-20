// WHO Child Growth Standards — percentile / z-score math.
//
// Pure functions over the bundled LMS tables (see ./wfa, ./lhfa, ./hcfa).
// The LMS method models each indicator's distribution at a given age with
// three parameters — L (Box-Cox power), M (median), S (coefficient of
// variation) — so a raw measurement maps to a z-score, and any percentile
// maps back to a raw value (the reference curves the chart draws).
//
// THESE ARE NOT MEDICAL ADVICE. WHO standards describe how a healthy
// reference population grows; an individual baby tracking a bit above or
// below the median is usually perfectly normal. `classify` is deliberately
// non-alarmist for that reason.
//
// Unit contract: the caller passes `value` in the table's own unit —
// kilograms for weight-for-age, centimetres for length/head. Growth rows
// are stored in grams/cm, so convert weight (g / 1000) before calling.
import { hcfa } from "./hcfa";
import { lhfa } from "./lhfa";
import type { LmsRow, SexTables } from "./types";
import { wfa } from "./wfa";

export type GrowthMetric = "weight" | "length" | "head";

// The three indicators map 1:1 to the metrics the app already logs.
const TABLES: Record<GrowthMetric, SexTables> = {
  weight: wfa,
  length: lhfa,
  head: hcfa,
};

// WHO tables are split by sex (boys / girls). Baby.sex is free text in the
// DB but the UI only ever writes "male" | "female" | "unspecified"; anything
// that isn't a clear male/female returns null so the caller falls back to a
// trend-only view rather than guessing.
export function rowsFor(metric: GrowthMetric, sex: string | null | undefined): LmsRow[] | null {
  if (sex === "male") return TABLES[metric].boys;
  if (sex === "female") return TABLES[metric].girls;
  return null;
}

// The oldest age the bundled standards cover. WHO Child Growth Standards
// run 0–60 months; past that we can't place a percentile and the caller
// shows the raw trend instead.
export const MAX_AGE_MONTHS = 60;

export interface Lms {
  l: number;
  m: number;
  s: number;
}

// ageInMonths returns fractional completed months between two instants,
// using the average Gregorian month (30.4375 days). Fractional (not the
// whole-month `monthsBetween` in recommendations.ts) so LMS interpolation
// tracks a baby's real age between the monthly table rows.
const DAYS_PER_MONTH = 30.4375;
export function ageInMonths(dob: Date, at: Date): number {
  return (at.getTime() - dob.getTime()) / (1000 * 60 * 60 * 24 * DAYS_PER_MONTH);
}

// lmsAt linearly interpolates L/M/S for a fractional age between the two
// bracketing monthly rows. Returns null when the age is outside the table
// (negative, or beyond the last row) so the caller can degrade gracefully.
// Assumes `rows` is ascending by age with integer month steps (the bundled
// tables are), which lets us index directly instead of scanning.
export function lmsAt(rows: LmsRow[], ageMonths: number): Lms | null {
  if (rows.length === 0) return null;
  const first = rows[0].age;
  const last = rows[rows.length - 1].age;
  if (ageMonths < first || ageMonths > last) return null;
  // Find the lower bracket. Rows step by 1 month from `first`, so the index
  // is just the offset; guard with a scan fallback in case that ever changes.
  let lo = Math.floor(ageMonths) - first;
  if (lo < 0 || lo >= rows.length || rows[lo].age > ageMonths) {
    lo = 0;
    while (lo < rows.length - 1 && rows[lo + 1].age <= ageMonths) lo++;
  }
  const a = rows[lo];
  if (a.age === ageMonths || lo === rows.length - 1) {
    return { l: a.l, m: a.m, s: a.s };
  }
  const b = rows[lo + 1];
  const t = (ageMonths - a.age) / (b.age - a.age);
  return {
    l: a.l + (b.l - a.l) * t,
    m: a.m + (b.m - a.m) * t,
    s: a.s + (b.s - a.s) * t,
  };
}

// zScore applies the WHO LMS transform, including WHO's recommended
// correction for the extreme tails (|z| > 3): beyond 3 SD the distribution
// is re-expressed in units of the distance between the 2nd and 3rd SD so a
// wildly out-of-range value doesn't blow up through the power term. See the
// WHO Anthro "Computation of centiles and z-scores" note.
export function zScore(lms: Lms, value: number): number {
  const { l, m, s } = lms;
  const raw = l === 0 ? Math.log(value / m) / s : (Math.pow(value / m, l) - 1) / (l * s);
  if (raw > 3) {
    const sd3 = valueAtZ(lms, 3);
    const sd2 = valueAtZ(lms, 2);
    return 3 + (value - sd3) / (sd3 - sd2);
  }
  if (raw < -3) {
    const sd3 = valueAtZ(lms, -3);
    const sd2 = valueAtZ(lms, -2);
    return -3 + (value - sd3) / (sd2 - sd3);
  }
  return raw;
}

// valueAtZ is the inverse LMS transform: the measurement at a given z.
export function valueAtZ(lms: Lms, z: number): number {
  const { l, m, s } = lms;
  return l === 0 ? m * Math.exp(s * z) : m * Math.pow(1 + l * s * z, 1 / l);
}

// valueAtPercentile converts a percentile (0–100) to the measurement that
// sits on that curve — this is what draws the reference lines.
export function valueAtPercentile(lms: Lms, pct: number): number {
  return valueAtZ(lms, zFromPercentile(pct));
}

// erf via Abramowitz & Stegun 7.1.26 (max abs error ~1.5e-7) — enough for
// percentile display and curve placement without pulling in a stats lib.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// percentileFromZ maps a z-score to a percentile in [0, 100].
export function percentileFromZ(z: number): number {
  return 100 * 0.5 * (1 + erf(z / Math.SQRT2));
}

// zFromPercentile: inverse standard-normal CDF via Acklam's rational
// approximation (relative error < 1.15e-9). Used to place the reference
// curves at fixed percentiles. Clamps the open interval so p=0/100 don't
// produce ±Infinity.
export function zFromPercentile(pct: number): number {
  let p = pct / 100;
  const eps = 1e-9;
  if (p <= 0) p = eps;
  if (p >= 1) p = 1 - eps;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  let r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export interface PercentileResult {
  z: number;
  // Percentile rounded for display (WHO tables publish whole/one-decimal
  // percentiles; we round to the nearest whole for the headline).
  percentile: number;
  lms: Lms;
}

// measurePercentile is the one-call entry point for a single reading:
// resolves the table, interpolates LMS for the age, and returns z +
// percentile. Returns null when sex is unknown or age is out of range —
// the caller then shows the trend-only view.
export function measurePercentile(
  metric: GrowthMetric,
  sex: string | null | undefined,
  ageMonths: number,
  value: number,
): PercentileResult | null {
  const rows = rowsFor(metric, sex);
  if (!rows) return null;
  const lms = lmsAt(rows, ageMonths);
  if (!lms) return null;
  const z = zScore(lms, value);
  return { z, percentile: percentileFromZ(z), lms };
}

export type GrowthTone = "typical" | "edge" | "outer";

export interface GrowthClassification {
  tone: GrowthTone;
  label: string;
}

// classify turns a percentile into a calm, plain-language headline. The
// bands mirror WHO's own "3rd–97th is the reference range" framing; nothing
// here is a diagnosis, and the copy avoids alarm on purpose.
export function classify(percentile: number): GrowthClassification {
  if (percentile < 3 || percentile > 97) {
    return {
      tone: "outer",
      label: "Outside the WHO 3rd–97th range — worth a mention at the next check-up.",
    };
  }
  if (percentile < 15 || percentile > 85) {
    const side = percentile < 15 ? "lower" : "higher";
    return { tone: "edge", label: `On the ${side} side, still within the typical range.` };
  }
  return { tone: "typical", label: "Tracking within the typical range." };
}

// ordinal renders a whole-number percentile as "48th", "1st", "22nd" etc.
// for the headline pill.
export function ordinal(n: number): string {
  const v = Math.round(n);
  const s = ["th", "st", "nd", "rd"];
  const mod = v % 100;
  return v + (s[(mod - 20) % 10] ?? s[mod] ?? s[0]);
}
