// Pure helpers for the /charts screen. Kept here (rather than inline in
// the route) so the date-window math, the SVG bar/line geometry, and the
// growth-trend reduction can be unit-tested in isolation. See
// charts.test.ts for the contract.
import type { ChartDaily } from "./types";

// dailyWindowEndingToday returns YYYY-MM-DD strings for `[from, today]`
// inclusive in the user's local timezone. We compute in local time so
// "the last 14 days" matches the wall-clock days the user perceives,
// not UTC days (which can be off by one near midnight in either
// direction).
//
// `today` is injected for testability; production callers pass `new
// Date()`.
export function dailyWindowEndingToday(today: Date, days: number): { from: string; to: string } {
  if (days < 1) {
    // Defensive — the segmented control only ever sends 7/14/30, but a
    // future caller might. Treat 0/negative as a single-day window.
    days = 1;
  }
  const to = formatLocalYMD(today);
  const fromDate = new Date(today);
  fromDate.setHours(0, 0, 0, 0);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  return { from: formatLocalYMD(fromDate), to };
}

// formatLocalYMD formats a Date as YYYY-MM-DD using the local time
// fields (not UTC). Avoids toISOString() because that would shift the
// date for users east of UTC at most times of day.
export function formatLocalYMD(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// SparkBar describes one rendered rectangle in a sparkline. Caller-provided
// total counts (DiaperBar) are split into stacked segments so the SVG can
// render them with separate fills.
export interface SparkBar {
  // Index of the day in the source array (0-based, ascending date order).
  index: number;
  // Bottom-left and top-right of this segment, in [0..1] normalized
  // coords. Caller scales to pixels.
  x: number;
  width: number;
  yBottom: number; // closer to 0 (chart base)
  yTop: number; // closer to 1 (chart top)
}

// barLayout converts a series of numeric values into per-bar geometry
// in [0..1] normalized coords. The largest value occupies the full
// height; zeros render as zero-height rectangles (caller can still
// emit a tick at the baseline if desired). Bars use a 70%/30% width-
// to-gap split which reads cleanly even at 7-day windows.
//
// Returns an empty array when `values` is empty so callers can render
// "no data" placeholders without `?.length` checks at every site.
export function barLayout(values: number[]): { bars: SparkBar[]; max: number } {
  if (values.length === 0) return { bars: [], max: 0 };
  const max = Math.max(0, ...values);
  const slot = 1 / values.length;
  const barWidth = slot * 0.7;
  const padding = (slot - barWidth) / 2;
  const bars: SparkBar[] = values.map((v, i) => {
    const h = max === 0 ? 0 : Math.max(0, v) / max;
    return {
      index: i,
      x: i * slot + padding,
      width: barWidth,
      yBottom: 0,
      yTop: h,
    };
  });
  return { bars, max };
}

// stackedDiaperLayout renders three same-x bars stacked wet/soiled/mixed
// using the same shared max as barLayout(totals). The shared scale
// matters: if each color had its own max, the FE would silently lie
// about which day had the most diapers.
export function stackedDiaperLayout(
  rows: { wet: number; soiled: number; mixed: number }[],
): { wet: SparkBar[]; soiled: SparkBar[]; mixed: SparkBar[]; max: number } {
  if (rows.length === 0) {
    return { wet: [], soiled: [], mixed: [], max: 0 };
  }
  const totals = rows.map((r) => r.wet + r.soiled + r.mixed);
  const max = Math.max(0, ...totals);
  const slot = 1 / rows.length;
  const barWidth = slot * 0.7;
  const padding = (slot - barWidth) / 2;
  const wet: SparkBar[] = [];
  const soiled: SparkBar[] = [];
  const mixed: SparkBar[] = [];
  rows.forEach((r, i) => {
    const wetH = max === 0 ? 0 : r.wet / max;
    const soiledH = max === 0 ? 0 : r.soiled / max;
    const mixedH = max === 0 ? 0 : r.mixed / max;
    const x = i * slot + padding;
    wet.push({ index: i, x, width: barWidth, yBottom: 0, yTop: wetH });
    soiled.push({
      index: i,
      x,
      width: barWidth,
      yBottom: wetH,
      yTop: wetH + soiledH,
    });
    mixed.push({
      index: i,
      x,
      width: barWidth,
      yBottom: wetH + soiledH,
      yTop: wetH + soiledH + mixedH,
    });
  });
  return { wet, soiled, mixed, max };
}

// stacked2Layout renders two same-x bars stacked bottom/top against a
// shared max so two series can be compared honestly day-by-day. It is a
// 2-segment specialization of stackedDiaperLayout (same slot/padding
// math, same shared-max semantics) used by the Bottle chart's
// breast (bottom) / formula (top) breakdown. Negative inputs are
// clamped to zero and an all-zero or empty input returns zero-height
// bars without producing NaN.
export function stacked2Layout(
  rows: { bottom: number; top: number }[],
): { bottom: SparkBar[]; top: SparkBar[]; max: number } {
  if (rows.length === 0) {
    return { bottom: [], top: [], max: 0 };
  }
  const totals = rows.map((r) => Math.max(0, r.bottom) + Math.max(0, r.top));
  const max = Math.max(0, ...totals);
  const slot = 1 / rows.length;
  const barWidth = slot * 0.7;
  const padding = (slot - barWidth) / 2;
  const bottom: SparkBar[] = [];
  const top: SparkBar[] = [];
  rows.forEach((r, i) => {
    const b = Math.max(0, r.bottom);
    const t = Math.max(0, r.top);
    const bH = max === 0 ? 0 : b / max;
    const tH = max === 0 ? 0 : t / max;
    const x = i * slot + padding;
    bottom.push({ index: i, x, width: barWidth, yBottom: 0, yTop: bH });
    top.push({
      index: i,
      x,
      width: barWidth,
      yBottom: bH,
      yTop: bH + tH,
    });
  });
  return { bottom, top, max };
}

// LinePoint is one rendered point in a sparkline. `defined=false` means
// the underlying value is null; the polyline renderer uses this to break
// the line so a missing day shows as a gap rather than a zero pull-down.
export interface LinePoint {
  index: number;
  x: number;
  y: number; // [0..1], 1 == top
  defined: boolean;
  raw: number | null;
}

// linePoints projects nullable numeric values onto a [0..1] x [0..1]
// grid. The vertical scale is auto-fit to non-null values; an all-null
// series returns points but with a zero scale (renderer should show
// "no data"). When only one non-null value is present the line stays
// flat at the midline, which is honest given there's no range yet.
export function linePoints(values: (number | null)[]): {
  points: LinePoint[];
  min: number;
  max: number;
  hasData: boolean;
} {
  const defined = values.filter((v): v is number => v != null);
  const hasData = defined.length > 0;
  let min = 0;
  let max = 0;
  if (hasData) {
    min = Math.min(...defined);
    max = Math.max(...defined);
  }
  const slot = values.length > 1 ? 1 / (values.length - 1) : 0;
  const span = max - min;
  const points: LinePoint[] = values.map((v, i) => ({
    index: i,
    x: values.length === 1 ? 0.5 : i * slot,
    y: v == null ? 0.5 : span === 0 ? 0.5 : (v - min) / span,
    defined: v != null,
    raw: v,
  }));
  return { points, min, max, hasData };
}

// tooltipXPercent returns the horizontal center of the day-slot at
// `index` in a series of `total` slots, expressed as a percent of the
// chart container's width. This matches the slot math used by
// `barLayout` / `stackedDiaperLayout` (slot = 1/total, bar centered in
// its slot) so the tooltip caret lines up with the visible bar.
//
// Used by the tooltip primitive in _app.charts.tsx; kept pure here so
// the math has a regression test independent of the SVG rendering.
// Returns 50 for empty / non-positive `total` so the caller never
// produces a NaN style value.
export function tooltipXPercent(index: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 50;
  return ((index + 0.5) / total) * 100;
}

// formatDayShort returns "May 25" style short labels for axis ticks.
// Given the API returns ISO YYYY-MM-DD already in the requested tz, we
// don't need to re-localize — just split and look up the month.
export function formatDayShort(ymd: string): string {
  const [, m, d] = ymd.split("-");
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const mi = Number.parseInt(m, 10) - 1;
  return `${months[mi] ?? m} ${Number.parseInt(d, 10)}`;
}

// summarize folds a window of days into the single-line totals shown
// above the chart cards (e.g. "1,840 ml total · 14 nursing min/day avg").
// The "avg" arms divide by `days.length` (not by non-zero days) so a
// week with low logging shows a low average — that's the honest signal
// when the user is double-checking how often they actually fed today.
export function summarize(days: ChartDaily[]): {
  bottleTotalMl: number;
  bottleAvgMl: number;
  pumpingTotalMl: number;
  pumpingAvgMl: number;
  nursingTotalMin: number;
  nursingAvgMin: number;
  diaperTotal: number;
  diaperAvg: number;
  latestWeightG: number | null;
} {
  const n = days.length;
  if (n === 0) {
    return {
      bottleTotalMl: 0,
      bottleAvgMl: 0,
      pumpingTotalMl: 0,
      pumpingAvgMl: 0,
      nursingTotalMin: 0,
      nursingAvgMin: 0,
      diaperTotal: 0,
      diaperAvg: 0,
      latestWeightG: null,
    };
  }
  let bottleTotalMl = 0;
  let pumpingTotalMl = 0;
  let nursingTotalMin = 0;
  let diaperTotal = 0;
  let latestWeightG: number | null = null;
  for (const d of days) {
    bottleTotalMl += d.bottle_ml ?? 0;
    pumpingTotalMl += d.pumping_ml ?? 0;
    nursingTotalMin += d.nursing_minutes ?? 0;
    diaperTotal += d.diaper_total ?? 0;
    if (d.growth?.weight_g != null) {
      // Days are returned in ascending order so the last assignment
      // wins, which is exactly the latest reading in the window.
      latestWeightG = d.growth.weight_g;
    }
  }
  return {
    bottleTotalMl,
    bottleAvgMl: bottleTotalMl / n,
    pumpingTotalMl,
    pumpingAvgMl: pumpingTotalMl / n,
    nursingTotalMin,
    nursingAvgMin: nursingTotalMin / n,
    diaperTotal,
    diaperAvg: diaperTotal / n,
    latestWeightG,
  };
}
