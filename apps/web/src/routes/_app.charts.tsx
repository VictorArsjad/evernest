// Charts screen — last 7 / 14 / 30 day overview of every metric the
// app tracks. One inline-SVG card per metric; no chart library, since
// the PWA install size matters more than the marginal feature density
// recharts/visx would buy us. Mobile-first: full-width cards on narrow
// viewports, two-up on `sm:`.
import { Link, createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAuthStore } from "../lib/authStore";
import {
  barLayout,
  dailyWindowEndingToday,
  formatDayShort,
  linePoints,
  stacked2Layout,
  stackedDiaperLayout,
  summarize,
  tooltipXPercent,
  type LinePoint,
  type SparkBar,
} from "../lib/charts";
import { isFeatureVisible } from "../lib/featureVisibility";
import { DEFAULT_PALETTE, resolve } from "../lib/palette";
import {
  useBabies,
  useDailyCharts,
  useHouseholds,
  useLogout,
} from "../lib/queries";
import type { ChartDaily } from "../lib/types";
import { useActiveBaby } from "../lib/useActiveBaby";
import {
  formatVolume,
  formatWeight,
  volumeUnitLabel,
  weightUnitLabel,
} from "../lib/units";
import { type CombinedPreferences, usePreferences } from "../lib/usePreferences";

type WindowDays = 7 | 14 | 30;

const RANGES: { value: WindowDays; label: string }[] = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
];

// Read the browser tz once at module init — the user's tz effectively
// never changes mid-session, and re-reading on every render would
// invalidate the queryKey on every paint.
const BROWSER_TZ =
  (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";

// Shared inner viewBox for every card. 100 wide gives bars sub-pixel
// granularity at any reasonable card width; 40 high reads as a
// sparkline rather than a "real" chart.
const VB_W = 100;
const VB_H = 40;

// --- chart hover primitive ---

// useChartHover owns the active-bar index for a single chart card. The
// hover state is per-chart (not global) so tooltips on different cards
// don't fight each other when the user drags across the grid.
//
// - `setActive(i)` shows the tooltip at `i`.
// - `clear()` hides it.
// - `toggle(i)` is the mobile tap behavior: tap a bar shows it; tapping
//   the same bar again toggles off; tapping a different bar moves it.
// - `containerRef` is attached to the chart wrapper; the effect below
//   listens for a `pointerdown` anywhere on the document and clears the
//   active state when the event landed outside this chart, so a mobile
//   user can dismiss a tooltip by tapping anywhere off-chart.
function useChartHover() {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const setActive = useCallback((i: number) => setActiveIndex(i), []);
  const clear = useCallback(() => setActiveIndex(null), []);
  const toggle = useCallback((i: number) => {
    setActiveIndex((prev) => (prev === i ? null : i));
  }, []);

  useEffect(() => {
    if (activeIndex == null) return;
    const onDown = (e: PointerEvent) => {
      const c = containerRef.current;
      if (!c) return;
      if (e.target instanceof Node && c.contains(e.target)) return;
      setActiveIndex(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [activeIndex]);

  return { activeIndex, setActive, clear, toggle, containerRef };
}

type ChartHover = ReturnType<typeof useChartHover>;

// ChartTooltip is the dark popover anchored above the active bar. It is
// absolutely positioned with `pointer-events-none` so it never affects
// layout or eats events; the `clamp(8%, x%, 92%)` keeps the popover from
// running off the edges of the card without any JS measurement.
function ChartTooltip({
  xPct,
  children,
}: {
  xPct: number;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-bg-subtle px-2 py-1.5 text-[11px] tabular-nums text-white shadow-lg"
      style={{ left: `clamp(8%, ${xPct}%, 92%)` }}
    >
      {children}
      <span
        aria-hidden="true"
        className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-white/10"
      />
    </div>
  );
}

// HitOverlays renders one full-height transparent rect per day-slot for
// bar-style charts. Rendered AFTER the visible bars (it's the last
// child of the <svg>) so it always wins the pointer hit-test, which
// matters for zero-days where the visible bar is a half-pixel tick.
//
// Pointer-type gating: mouse uses hover (enter/leave), touch/pen uses
// tap-toggle (pointerdown). The outside-tap dismiss is owned by
// useChartHover so we don't need an explicit "tap away" handler here.
function HitOverlays({
  n,
  hover,
  days,
  ariaValue,
}: {
  n: number;
  hover: ChartHover;
  days: ChartDaily[];
  ariaValue: (i: number) => string;
}) {
  if (n === 0) return null;
  const slot = VB_W / n;
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const isActive = hover.activeIndex === i;
        return (
          <rect
            key={`hit-${i}`}
            x={i * slot}
            y={0}
            width={slot}
            height={VB_H}
            fill="transparent"
            role="button"
            tabIndex={-1}
            aria-label={`${formatDayShort(days[i].date)}: ${ariaValue(i)}`}
            aria-pressed={isActive}
            onPointerEnter={(e) => {
              if (e.pointerType === "mouse") hover.setActive(i);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === "mouse") hover.clear();
            }}
            onPointerDown={(e) => {
              if (e.pointerType !== "mouse") hover.toggle(i);
            }}
          />
        );
      })}
    </>
  );
}

function TooltipBody({
  date,
  children,
}: {
  date: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-white/60">{formatDayShort(date)}</div>
      {children}
    </div>
  );
}

function DiaperTooltipRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-white/80">
      <span className="flex items-center gap-1 capitalize">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-sm"
          style={{ backgroundColor: color }}
        />
        {label}
      </span>
      <span>{value}</span>
    </div>
  );
}

export const Route = createFileRoute("/_app/charts")({
  component: ChartsPage,
});

function ChartsPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();
  const [range, setRange] = useState<WindowDays>(14);

  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  // Follow the same active-baby selection the Today hub persists so a
  // baby flip on Today carries over to Charts (and vice versa).
  const { baby } = useActiveBaby(householdId, babies.data);

  // Pinning `now` per-render is fine — TanStack only refetches when
  // the queryKey changes, and the YYYY-MM-DD strings only change at
  // local midnight. We don't need to memoize harder than that.
  const window = useMemo(() => dailyWindowEndingToday(new Date(), range), [range]);
  const charts = useDailyCharts(baby?.id ?? null, window.from, window.to, BROWSER_TZ);
  const { prefs } = usePreferences(baby?.id ?? null);

  if (households.isLoading || babies.isLoading) {
    return <PageShell title="Charts">Loading…</PageShell>;
  }
  if (!baby) {
    return <PageShell title="Charts">No baby selected.</PageShell>;
  }

  const days = charts.data?.days ?? [];

  return (
    <PageShell
      title="Charts"
      subtitle={user ? `Signed in as ${user.display_name}` : undefined}
      onSignOut={() => logout.mutate()}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs text-white/60">
          {formatDayShort(window.from)} – {formatDayShort(window.to)} · {BROWSER_TZ}
        </div>
        <SegmentedControl value={range} onChange={setRange} />
      </div>

      {charts.isLoading ? (
        <p className="rounded-xl bg-bg-surface p-4 text-sm text-white/50">Loading…</p>
      ) : charts.isError ? (
        <p className="rounded-xl bg-red-500/10 p-4 text-sm text-red-200">
          Could not load charts: {charts.error?.message ?? "unknown error"}
        </p>
      ) : (
        <ChartGrid days={days} prefs={prefs} />
      )}
    </PageShell>
  );
}

// --- grid + cards ---

function ChartGrid({ days, prefs }: { days: ChartDaily[]; prefs: CombinedPreferences }) {
  // All four bar charts and the line chart share the same X axis (one
  // slot per day). Geometry is recomputed only when `days` changes.
  const totals = useMemo(() => summarize(days), [days]);
  const nursing = useMemo(() => barLayout(days.map((d) => d.nursing_minutes)), [days]);
  const pumping = useMemo(() => barLayout(days.map((d) => d.pumping_ml)), [days]);
  const stacked = useMemo(
    () =>
      stackedDiaperLayout(
        days.map((d) => ({ wet: d.diaper_wet, soiled: d.diaper_soiled, mixed: d.diaper_mixed })),
      ),
    [days],
  );
  const weight = useMemo(
    () => linePoints(days.map((d) => d.growth?.weight_g ?? null)),
    [days],
  );
  // Resolve the user's palette once per render and pass concrete colors
  // down to each chart. `?? DEFAULT_PALETTE` handles both old-BE
  // (chart_palette absent on the response) and the brief loading window
  // before useMyPreferences hydrates.
  const colors = useMemo(
    () => resolve(prefs.chart_palette ?? DEFAULT_PALETTE),
    [prefs.chart_palette],
  );
  const diaperColors = useMemo(
    () => ({
      wet: colors.diaper_wet,
      soiled: colors.diaper_soiled,
      mixed: colors.diaper_mixed,
    }),
    [colors.diaper_wet, colors.diaper_soiled, colors.diaper_mixed],
  );

  if (days.length === 0) {
    return (
      <p className="rounded-xl bg-bg-surface p-4 text-sm text-white/50">
        No data in this window yet.
      </p>
    );
  }

  const volLabel = volumeUnitLabel(prefs.unit_volume);
  const wLabel = weightUnitLabel(prefs.unit_weight);
  // Per-feature visibility gates each ChartCard. Hidden cards drop out of
  // the grid entirely; the `grid-cols-2` layout reflows naturally. The
  // Weight card keeps its `wide` column-span when visible, so a 3-card
  // layout (e.g. Bottle/Nursing visible, Weight visible) renders as
  // two-up + full-width below rather than leaving a gap.
  const showBottle = isFeatureVisible(prefs.feature_visibility, "bottle");
  const showNursing = isFeatureVisible(prefs.feature_visibility, "nursing");
  const showPumping = isFeatureVisible(prefs.feature_visibility, "pumping");
  const showDiaper = isFeatureVisible(prefs.feature_visibility, "diaper");
  const showGrowth = isFeatureVisible(prefs.feature_visibility, "growth");
  if (!showBottle && !showNursing && !showPumping && !showDiaper && !showGrowth) {
    return (
      <p className="rounded-xl bg-bg-surface p-4 text-sm text-white/50">
        All charts are hidden. Re-enable a feature in Settings to see its chart.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {showBottle && (
      <ChartCard
        title="Bottle"
        unit={`${volLabel}/day`}
        accent="text-orange-300"
        primary={`${formatVolume(totals.bottleTotalMl, prefs.unit_volume)} total`}
        secondary={`${formatVolume(totals.bottleAvgMl, prefs.unit_volume)}/day avg`}
      >
        <BottleStackChart
          days={days}
          breastColor={colors.bottle_breast}
          formulaColor={colors.bottle_formula}
          ariaValue={(i) =>
            `${formatVolume(days[i].bottle_ml_breast ?? 0, prefs.unit_volume)} breast, ${formatVolume(days[i].bottle_ml_formula ?? 0, prefs.unit_volume)} formula, ${formatVolume(days[i].bottle_ml, prefs.unit_volume)} total`
          }
          renderTooltip={(i) => (
            <TooltipBody date={days[i].date}>
              <BottleTooltipRow
                color={colors.bottle_breast}
                label="Breast"
                value={formatVolume(days[i].bottle_ml_breast ?? 0, prefs.unit_volume)}
              />
              <BottleTooltipRow
                color={colors.bottle_formula}
                label="Formula"
                value={formatVolume(days[i].bottle_ml_formula ?? 0, prefs.unit_volume)}
              />
              <div className="mt-0.5 border-t border-white/10 pt-0.5 font-medium text-white">
                {formatVolume(days[i].bottle_ml, prefs.unit_volume)} total
              </div>
            </TooltipBody>
          )}
        />
        <Axis days={days} />
        <BottleLegend
          breastColor={colors.bottle_breast}
          formulaColor={colors.bottle_formula}
        />
      </ChartCard>
      )}

      {showNursing && (
      <ChartCard
        title="Nursing"
        unit="min/day"
        accent="text-emerald-300"
        primary={`${totals.nursingTotalMin} min total`}
        secondary={`${Math.round(totals.nursingAvgMin)} min/day avg`}
      >
        <BarChart
          bars={nursing.bars}
          max={nursing.max}
          fill={colors.nursing}
          days={days}
          ariaValue={(i) => `${days[i].nursing_minutes} min`}
          renderTooltip={(i) => (
            <TooltipBody date={days[i].date}>
              <div>{days[i].nursing_minutes} min</div>
            </TooltipBody>
          )}
        />
        <Axis days={days} />
      </ChartCard>
      )}

      {showPumping && (
      <ChartCard
        title="Pumping"
        unit={`${volLabel}/day`}
        accent="text-sky-300"
        primary={`${formatVolume(totals.pumpingTotalMl, prefs.unit_volume)} total`}
        secondary={`${formatVolume(totals.pumpingAvgMl, prefs.unit_volume)}/day avg`}
      >
        <BarChart
          bars={pumping.bars}
          max={pumping.max}
          fill={colors.pumping}
          days={days}
          ariaValue={(i) => formatVolume(days[i].pumping_ml, prefs.unit_volume)}
          renderTooltip={(i) => (
            <TooltipBody date={days[i].date}>
              <div>{formatVolume(days[i].pumping_ml, prefs.unit_volume)}</div>
            </TooltipBody>
          )}
        />
        <Axis days={days} />
      </ChartCard>
      )}

      {showDiaper && (
      <ChartCard
        title="Diapers"
        unit="count/day"
        accent="text-yellow-300"
        primary={`${totals.diaperTotal} total`}
        secondary={`${totals.diaperAvg.toFixed(1)} /day avg`}
      >
        <DiaperStackChart
          stacked={stacked}
          colors={diaperColors}
          days={days}
          ariaValue={(i) =>
            `${days[i].diaper_wet} wet, ${days[i].diaper_soiled} soiled, ${days[i].diaper_mixed} mixed`
          }
          renderTooltip={(i) => (
            <TooltipBody date={days[i].date}>
              <DiaperTooltipRow
                color={diaperColors.wet}
                label="Wet"
                value={days[i].diaper_wet}
              />
              <DiaperTooltipRow
                color={diaperColors.soiled}
                label="Soiled"
                value={days[i].diaper_soiled}
              />
              <DiaperTooltipRow
                color={diaperColors.mixed}
                label="Mixed"
                value={days[i].diaper_mixed}
              />
              <div className="mt-0.5 border-t border-white/10 pt-0.5 text-white">
                {days[i].diaper_total} total
              </div>
            </TooltipBody>
          )}
        />
        <Axis days={days} />
        <DiaperLegend colors={diaperColors} />
      </ChartCard>
      )}

      {showGrowth && (
      <ChartCard
        title="Weight"
        unit={wLabel}
        accent="text-violet-300"
        primary={
          totals.latestWeightG != null
            ? formatWeight(totals.latestWeightG, prefs.unit_weight)
            : "no readings"
        }
        secondary={
          weight.hasData ? rangeSummary(weight.min, weight.max, prefs) : ""
        }
        wide
      >
        {weight.hasData ? (
          <LineChart
            points={weight.points}
            stroke={colors.weight}
            days={days}
            ariaValue={(i) => {
              const g = days[i].growth?.weight_g;
              return g != null ? formatWeight(g, prefs.unit_weight) : "";
            }}
            renderTooltip={(i) => {
              const g = days[i].growth?.weight_g;
              if (g == null) return null;
              return (
                <TooltipBody date={days[i].date}>
                  <div>{formatWeight(g, prefs.unit_weight)}</div>
                </TooltipBody>
              );
            }}
          />
        ) : (
          <EmptyState>No measurements in this window</EmptyState>
        )}
        <Axis days={days} />
      </ChartCard>
      )}
    </div>
  );
}

function ChartCard({
  title,
  unit,
  accent,
  primary,
  secondary,
  wide,
  children,
}: {
  title: string;
  unit: string;
  accent: string;
  primary: string;
  secondary: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={"card flex flex-col gap-2 p-4" + (wide ? " sm:col-span-2" : "")}>
      <header className="flex items-baseline justify-between gap-2">
        <h2 className={"text-sm font-medium " + accent}>{title}</h2>
        <span className="text-[10px] uppercase tracking-wide text-white/40">{unit}</span>
      </header>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{primary}</span>
        {secondary && <span className="text-xs text-white/50">{secondary}</span>}
      </div>
      {children}
    </section>
  );
}

function BarChart({
  bars,
  max,
  fill,
  days,
  ariaValue,
  renderTooltip,
}: {
  bars: SparkBar[];
  max: number;
  fill: string;
  days: ChartDaily[];
  ariaValue: (i: number) => string;
  renderTooltip: (i: number) => React.ReactNode;
}) {
  const hover = useChartHover();
  const n = days.length;
  return (
    <div
      ref={hover.containerRef}
      className="relative h-20 w-full"
      style={{ touchAction: "manipulation" }}
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        role="img"
        aria-label="Daily totals bar chart"
      >
        {bars.map((b) => {
          const h = (b.yTop - b.yBottom) * VB_H;
          const y = VB_H - b.yTop * VB_H;
          const isActive = hover.activeIndex === b.index;
          return (
            <rect
              key={b.index}
              x={b.x * VB_W}
              y={y}
              // Floor at 0.5px so a zero-day still renders a faint
              // tick at the baseline; otherwise empty days are
              // invisible and the user can't tell logging is missing.
              width={b.width * VB_W}
              height={Math.max(h, 0.5)}
              fill={fill}
              opacity={max === 0 ? 0.2 : h === 0 ? 0.3 : 0.85}
              rx={0.5}
              stroke={isActive ? "white" : undefined}
              strokeWidth={isActive ? 0.5 : 0}
              vectorEffect={isActive ? "non-scaling-stroke" : undefined}
            />
          );
        })}
        <HitOverlays n={n} hover={hover} days={days} ariaValue={ariaValue} />
      </svg>
      {hover.activeIndex != null && (
        <ChartTooltip xPct={tooltipXPercent(hover.activeIndex, n)}>
          {renderTooltip(hover.activeIndex)}
        </ChartTooltip>
      )}
    </div>
  );
}

function DiaperStackChart({
  stacked,
  colors,
  days,
  ariaValue,
  renderTooltip,
}: {
  stacked: ReturnType<typeof stackedDiaperLayout>;
  colors: { wet: string; soiled: string; mixed: string };
  days: ChartDaily[];
  ariaValue: (i: number) => string;
  renderTooltip: (i: number) => React.ReactNode;
}) {
  const hover = useChartHover();
  const n = days.length;
  // Topmost stack height per day (in VB units) so the active outline
  // wraps the full visible stack rather than just one segment.
  const stackTops = useMemo(() => {
    return stacked.mixed.map((m) => m.yTop);
  }, [stacked.mixed]);
  return (
    <div
      ref={hover.containerRef}
      className="relative h-20 w-full"
      style={{ touchAction: "manipulation" }}
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        role="img"
        aria-label="Daily diaper count stacked bar chart"
      >
        {stacked.wet.map((b) => (
          <SegmentRect key={`w${b.index}`} bar={b} fill={colors.wet} />
        ))}
        {stacked.soiled.map((b) => (
          <SegmentRect key={`s${b.index}`} bar={b} fill={colors.soiled} />
        ))}
        {stacked.mixed.map((b) => (
          <SegmentRect key={`m${b.index}`} bar={b} fill={colors.mixed} />
        ))}
        {hover.activeIndex != null &&
          stacked.wet[hover.activeIndex] &&
          stackTops[hover.activeIndex] > 0 && (
            <rect
              x={stacked.wet[hover.activeIndex].x * VB_W}
              y={VB_H - stackTops[hover.activeIndex] * VB_H}
              width={stacked.wet[hover.activeIndex].width * VB_W}
              height={stackTops[hover.activeIndex] * VB_H}
              fill="none"
              stroke="white"
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
              rx={0.5}
            />
          )}
        <HitOverlays n={n} hover={hover} days={days} ariaValue={ariaValue} />
      </svg>
      {hover.activeIndex != null && (
        <ChartTooltip xPct={tooltipXPercent(hover.activeIndex, n)}>
          {renderTooltip(hover.activeIndex)}
        </ChartTooltip>
      )}
    </div>
  );
}

function SegmentRect({ bar, fill }: { bar: SparkBar; fill: string }) {
  const h = (bar.yTop - bar.yBottom) * VB_H;
  if (h <= 0) return null;
  const y = VB_H - bar.yTop * VB_H;
  return (
    <rect
      x={bar.x * VB_W}
      y={y}
      width={bar.width * VB_W}
      height={h}
      fill={fill}
      rx={0.5}
    />
  );
}

function DiaperLegend({
  colors,
}: {
  colors: { wet: string; soiled: string; mixed: string };
}) {
  return (
    <ul className="flex gap-3 text-[10px] text-white/60">
      <LegendDot color={colors.wet} label="Wet" />
      <LegendDot color={colors.soiled} label="Soiled" />
      <LegendDot color={colors.mixed} label="Mixed" />
    </ul>
  );
}

// BottleStackChart renders a 2-segment stacked bar (breast bottom,
// formula top) for the Bottle card. Mirrors DiaperStackChart's layout —
// transparent full-slot HitOverlays own the pointer hit-test, and the
// active-state outline is drawn ONCE around the full visible stack
// rather than stroking each segment.
//
// Defensive fallback: when `bottle_ml_breast` and `bottle_ml_formula`
// are both 0/undefined but the combined `bottle_ml` is positive (an old
// BE that doesn't return per-source totals), render the combined total
// as a single formula-colored segment so the chart isn't blank during
// a mid-deploy window. The tooltip in that case still reads
// "breast 0 ml / formula 0 ml / N ml total" — consciously acceptable.
function BottleStackChart({
  days,
  breastColor,
  formulaColor,
  ariaValue,
  renderTooltip,
}: {
  days: ChartDaily[];
  breastColor: string;
  formulaColor: string;
  ariaValue: (i: number) => string;
  renderTooltip: (i: number) => React.ReactNode;
}) {
  const stacked = useMemo(() => {
    return stacked2Layout(
      days.map((d) => {
        const breast = d.bottle_ml_breast ?? 0;
        const formula = d.bottle_ml_formula ?? 0;
        const total = d.bottle_ml ?? 0;
        if (breast === 0 && formula === 0 && total > 0) {
          return { bottom: 0, top: total };
        }
        return { bottom: breast, top: formula };
      }),
    );
  }, [days]);
  const hover = useChartHover();
  const n = days.length;
  // Top of the visible stack per day (in VB units) so the active
  // outline wraps the full stack from y=0 to top[i].yTop.
  const stackTops = useMemo(() => stacked.top.map((t) => t.yTop), [stacked.top]);
  return (
    <div
      ref={hover.containerRef}
      className="relative h-20 w-full"
      style={{ touchAction: "manipulation" }}
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        role="img"
        aria-label="Daily bottle volume stacked bar chart"
      >
        {stacked.bottom.map((b) => (
          <SegmentRect key={`bb${b.index}`} bar={b} fill={breastColor} />
        ))}
        {stacked.top.map((b) => (
          <SegmentRect key={`bt${b.index}`} bar={b} fill={formulaColor} />
        ))}
        {hover.activeIndex != null &&
          stacked.bottom[hover.activeIndex] &&
          stackTops[hover.activeIndex] > 0 && (
            <rect
              x={stacked.bottom[hover.activeIndex].x * VB_W}
              y={VB_H - stackTops[hover.activeIndex] * VB_H}
              width={stacked.bottom[hover.activeIndex].width * VB_W}
              height={stackTops[hover.activeIndex] * VB_H}
              fill="none"
              stroke="white"
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
              rx={0.5}
            />
          )}
        <HitOverlays n={n} hover={hover} days={days} ariaValue={ariaValue} />
      </svg>
      {hover.activeIndex != null && (
        <ChartTooltip xPct={tooltipXPercent(hover.activeIndex, n)}>
          {renderTooltip(hover.activeIndex)}
        </ChartTooltip>
      )}
    </div>
  );
}

function BottleLegend({
  breastColor,
  formulaColor,
}: {
  breastColor: string;
  formulaColor: string;
}) {
  return (
    <ul className="flex gap-3 text-[10px] text-white/60">
      <LegendDot color={breastColor} label="Breast" />
      <LegendDot color={formulaColor} label="Formula" />
    </ul>
  );
}

function BottleTooltipRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-white/80">
      <span className="flex items-center gap-1 capitalize">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-sm"
          style={{ backgroundColor: color }}
        />
        {label}
      </span>
      <span>{value}</span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <li className="flex items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color }} />
      <span>{label}</span>
    </li>
  );
}

function LineChart({
  points,
  stroke,
  days,
  ariaValue,
  renderTooltip,
}: {
  points: LinePoint[];
  stroke: string;
  days: ChartDaily[];
  ariaValue: (i: number) => string;
  renderTooltip: (i: number) => React.ReactNode;
}) {
  // Build polyline segments split on null gaps. Each contiguous run of
  // defined points becomes one polyline; nulls between runs break the
  // line so a missing measurement renders as an empty stretch rather
  // than a baseline pull-down. Dots remain rendered at every defined
  // point.
  const segments: LinePoint[][] = [];
  let current: LinePoint[] = [];
  for (const p of points) {
    if (p.defined) {
      current.push(p);
    } else if (current.length > 0) {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);

  const hover = useChartHover();
  const n = days.length;
  return (
    <div
      ref={hover.containerRef}
      className="relative h-24 w-full"
      style={{ touchAction: "manipulation" }}
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        role="img"
        aria-label="Weight line chart"
      >
        {segments.map((seg, i) => (
          <polyline
            key={i}
            fill="none"
            stroke={stroke}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            points={seg.map((p) => `${p.x * VB_W},${VB_H - p.y * VB_H}`).join(" ")}
          />
        ))}
        {points
          .filter((p) => p.defined)
          .map((p) => {
            const isActive = hover.activeIndex === p.index;
            const cx = p.x * VB_W;
            const cy = VB_H - p.y * VB_H;
            return (
              <g key={p.index}>
                {isActive && (
                  <circle cx={cx} cy={cy} r={4} fill={stroke} opacity={0.25} />
                )}
                <circle cx={cx} cy={cy} r={isActive ? 2.4 : 1.2} fill={stroke} />
              </g>
            );
          })}
        {/* Hit overlays only on defined days — undefined days have no
            dot to hover and we don't want a tooltip showing "—". */}
        {points.map((p) => {
          if (!p.defined) return null;
          const slot = VB_W / n;
          const x = p.index * slot;
          const isActive = hover.activeIndex === p.index;
          return (
            <rect
              key={`hit-${p.index}`}
              x={x}
              y={0}
              width={slot}
              height={VB_H}
              fill="transparent"
              role="button"
              tabIndex={-1}
              aria-label={`${formatDayShort(days[p.index].date)}: ${ariaValue(p.index)}`}
              aria-pressed={isActive}
              onPointerEnter={(e) => {
                if (e.pointerType === "mouse") hover.setActive(p.index);
              }}
              onPointerLeave={(e) => {
                if (e.pointerType === "mouse") hover.clear();
              }}
              onPointerDown={(e) => {
                if (e.pointerType !== "mouse") hover.toggle(p.index);
              }}
            />
          );
        })}
      </svg>
      {hover.activeIndex != null && points[hover.activeIndex]?.defined && (
        <ChartTooltip xPct={tooltipXPercent(hover.activeIndex, n)}>
          {renderTooltip(hover.activeIndex)}
        </ChartTooltip>
      )}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-20 items-center justify-center text-xs text-white/40">{children}</div>
  );
}

function Axis({ days }: { days: ChartDaily[] }) {
  if (days.length === 0) return null;
  // First, middle, and last day. Adding more would crowd at 7d and
  // become illegible at 30d on a phone; deduping handles 1- or 2-day
  // edge cases.
  const lastIdx = days.length - 1;
  const ticks = Array.from(new Set([0, Math.floor(days.length / 2), lastIdx])).sort(
    (a, b) => a - b,
  );
  return (
    <div className="flex justify-between text-[10px] tabular-nums text-white/40">
      {ticks.map((i) => (
        <span key={i}>{formatDayShort(days[i].date)}</span>
      ))}
    </div>
  );
}

// --- segmented control ---

function SegmentedControl({
  value,
  onChange,
}: {
  value: WindowDays;
  onChange: (n: WindowDays) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-bg-subtle p-0.5">
      {RANGES.map((r) => (
        <button
          key={r.value}
          type="button"
          onClick={() => onChange(r.value)}
          className={
            "rounded-md px-3 py-1 text-xs font-medium tabular-nums transition " +
            (value === r.value ? "bg-white/10 text-white" : "text-white/60 hover:text-white")
          }
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// --- shell + formatters ---

function PageShell({
  title,
  subtitle,
  onSignOut,
  children,
}: {
  title: string;
  subtitle?: string;
  onSignOut?: () => void;
  children: React.ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col gap-5 p-5 pb-12">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Link
            to="/"
            className="text-xs text-white/50 hover:text-white"
            aria-label="Back to Today"
          >
            ← Today
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">{title}</h1>
            {subtitle && <p className="text-xs text-white/50">{subtitle}</p>}
          </div>
        </div>
        {onSignOut && (
          <button onClick={onSignOut} className="text-xs text-white/50 hover:text-white">
            Sign out
          </button>
        )}
      </header>
      {children}
    </main>
  );
}

function rangeSummary(min: number, max: number, prefs: CombinedPreferences): string {
  return min === max
    ? `${formatWeight(min, prefs.unit_weight)} in window`
    : `${formatWeight(min, prefs.unit_weight)} – ${formatWeight(max, prefs.unit_weight)} in window`;
}
