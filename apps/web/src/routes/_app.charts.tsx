// Charts & History screen — last 7 / 14 / 30 day overview of every
// metric the app tracks (charts, on top), followed by the individual
// event log grouped by local day (History, below). Charts are the
// "what totals look like" view; History is the "what individual events
// happened" view — a single range control drives both.
//
// One inline-SVG card per metric; no chart library, since the PWA
// install size matters more than the marginal feature density
// recharts/visx would buy us. Mobile-first: full-width cards on narrow
// viewports, two-up on `sm:`.
import { createFileRoute } from "@tanstack/react-router";
import { format, isToday, isYesterday } from "date-fns";
import { useEffect, useMemo, useRef, useState } from "react";

import { ChartTooltip } from "../components/ChartTooltip";
import { PageShell } from "../components/PageShell";
import { RecentRow } from "../components/RecentRow";
import { useAuthStore } from "../lib/authStore";
import { useChartHover, type ChartHover } from "../lib/useChartHover";
import {
  barLayout,
  dailyWindowEndingOn,
  formatDayShort,
  formatLocalYMD,
  stacked2Layout,
  stackedDiaperLayout,
  summarize,
  tooltipXPercent,
  type SparkBar,
} from "../lib/charts";
import { isFeatureVisible } from "../lib/featureVisibility";
import { groupByLocalDay, type DayGroup } from "../lib/groupByDay";
import { DEFAULT_PALETTE, resolve } from "../lib/palette";
import {
  useBabies,
  useBottleFeeds,
  useDailyCharts,
  useDiapers,
  useGrowths,
  useHouseholds,
  useNotes,
  useNursings,
  usePumpings,
  useSleeps,
} from "../lib/queries";
import { mergeRecent, type RecentEvent } from "../lib/recentEvents";
import { clipSleepToDays, dailySleepTotals, type SleepDay } from "../lib/sleepDays";
import { getDailySleepRange } from "../lib/sleepGuidance";
import type { Baby, ChartDaily, Sleep } from "../lib/types";
import { useActiveBaby } from "../lib/useActiveBaby";
import { useSwipe } from "../lib/useSwipe";
import { formatDurationHM, formatVolume, volumeUnitLabel } from "../lib/units";
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

// Hooks for the History section deliberately bypass the live-poll
// defaults: past events don't change, and a 30-day window for an active
// baby blows past the BE's 200-row default cap. `limit: 1000` matches
// the BE max; `refetchInterval: false` shuts off the 15s/5min polls.
const HISTORY_HOOK_OPTS = { limit: 1000, refetchInterval: false } as const;

// Shared inner viewBox for every card. 100 wide gives bars sub-pixel
// granularity at any reasonable card width; 40 high reads as a
// sparkline rather than a "real" chart.
const VB_W = 100;
const VB_H = 40;

// --- chart hover primitive ---

// `useChartHover` and `ChartTooltip` are shared chart primitives (also
// used by the growth chart). See lib/useChartHover.ts and
// components/ChartTooltip.tsx.

// "View entries →" link rendered at the foot of a chart tooltip. It's the
// primary way to jump to a day's History on touch (where a bare tap only
// previews the value); on desktop a mouse click on the bar does the same
// thing directly. `pointer-events-auto` overrides the tooltip wrapper's
// `pointer-events-none` so the tap/click actually lands.
function TooltipJumpLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pointer-events-auto mt-1 block w-full border-t border-white/10 pt-1 text-left text-[11px] font-medium text-accent hover:text-accent/80"
    >
      View entries →
    </button>
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
//
// `onSelect` (jump to this day's History) fires on mouse click only —
// touch keeps tap = tooltip preview, and navigates via the tooltip's
// "View entries" link instead, so a stray tap never scrolls the page.
function HitOverlays({
  n,
  hover,
  days,
  ariaValue,
  onSelect,
}: {
  n: number;
  hover: ChartHover;
  // Only `.date` is read — widened past ChartDaily so the sleep charts
  // (which aren't backed by the daily-aggregation endpoint) can reuse
  // the same overlay behavior.
  days: { date: string }[];
  ariaValue: (i: number) => string;
  onSelect?: (i: number) => void;
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
            onPointerUp={(e) => {
              if (e.pointerType === "mouse") onSelect?.(i);
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
  const [range, setRange] = useState<WindowDays>(14);
  // How many whole `range`-day windows back from today the user has
  // navigated (via swipe or the ‹ › chevrons). 0 = the current window
  // ending today; the forward clamp below is what guarantees the view
  // can never move past today.
  const [offset, setOffset] = useState(0);
  // Per-day expand overrides for the History section. Absence of a key
  // means "fall through to the default", which is `idx === 0` (the
  // newest group is open). Storing overrides instead of an explicit
  // expanded set lets switching range preserve toggles without a reseed.
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});
  // The day + metric the user just jumped to from a chart bar. Drives the
  // one-shot glow on the matching History rows; null once it has faded.
  const [highlight, setHighlight] = useState<{ dayKey: string; kind: RecentEvent["kind"] } | null>(
    null,
  );
  const glowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Smooth-scroll the just-selected day into view. Runs after commit, so
  // the (now-expanded) target section is already in the DOM.
  useEffect(() => {
    if (!highlight) return;
    document
      .getElementById(`history-day-section-${highlight.dayKey}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [highlight]);

  // Drop the glow once it has played so the class is gone and ready to
  // re-trigger on the next click (see handleSelectDay's null→value reset).
  useEffect(() => {
    if (!highlight) return;
    glowTimer.current = setTimeout(() => setHighlight(null), 1900);
    return () => {
      if (glowTimer.current) clearTimeout(glowTimer.current);
    };
  }, [highlight]);

  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  // Follow the same active-baby selection the Today hub persists so a
  // baby flip on Today carries over to Charts (and vice versa).
  const { baby } = useActiveBaby(householdId, babies.data);
  const babyId = baby?.id ?? null;

  // Pinning `now` per-render is fine — TanStack only refetches when
  // the queryKey changes, and the YYYY-MM-DD strings only change at
  // local midnight. We don't need to memoize harder than that.
  //
  // `endDate` is the last day of the visible window: today when offset
  // is 0, otherwise `offset * range` days earlier. setDate arithmetic
  // (not MS_PER_DAY offsets) keeps windows on wall-clock day boundaries
  // across DST transitions.
  const endDate = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offset * range);
    return d;
  }, [range, offset]);
  const window = useMemo(() => dailyWindowEndingOn(endDate, range), [endDate, range]);
  const charts = useDailyCharts(babyId, window.from, window.to, BROWSER_TZ, {
    // Past windows are immutable — polling them every 5 min is waste.
    refetchInterval: offset > 0 ? false : undefined,
  });
  const { prefs } = usePreferences(babyId);

  // History covers the same range window, but as ISO instants over the
  // raw event feeds (charts read pre-aggregated daily rows). Both
  // sections are driven by the single range control above.
  const historyWindow = useMemo(() => {
    const fromDate = new Date(endDate);
    fromDate.setDate(fromDate.getDate() - (range - 1));
    const toDate = new Date(endDate);
    toDate.setHours(23, 59, 59, 999);
    return { from: fromDate.toISOString(), to: toDate.toISOString() };
  }, [endDate, range]);
  const feeds = useBottleFeeds(babyId, historyWindow.from, historyWindow.to, HISTORY_HOOK_OPTS);
  const diapers = useDiapers(babyId, historyWindow.from, historyWindow.to, HISTORY_HOOK_OPTS);
  const pumpings = usePumpings(babyId, historyWindow.from, historyWindow.to, HISTORY_HOOK_OPTS);
  const nursings = useNursings(babyId, historyWindow.from, historyWindow.to, HISTORY_HOOK_OPTS);
  const growths = useGrowths(babyId, historyWindow.from, historyWindow.to, HISTORY_HOOK_OPTS);
  const sleeps = useSleeps(babyId, historyWindow.from, historyWindow.to, HISTORY_HOOK_OPTS);
  const notes = useNotes(babyId, historyWindow.from, historyWindow.to, HISTORY_HOOK_OPTS);
  // The rhythm chart needs one extra lookback day: an overnight sleep
  // that STARTED before the window still paints the window's first
  // morning once clipped at midnight. Kept as its own query (separate
  // key) so the History list above never grows a phantom day group.
  const rhythmWindow = useMemo(() => {
    const fromDate = new Date(endDate);
    fromDate.setDate(fromDate.getDate() - range);
    return { from: fromDate.toISOString(), to: historyWindow.to };
  }, [endDate, range, historyWindow.to]);
  const rhythmSleeps = useSleeps(babyId, rhythmWindow.from, rhythmWindow.to, HISTORY_HOOK_OPTS);

  // Window navigation. `goForward`'s clamp at 0 is the only guard we
  // need against moving past today. Changing the range snaps back to
  // the current window — "3 windows back" means something different at
  // 7d vs 30d, so carrying the offset across would jump confusingly.
  const goBack = () => setOffset((o) => o + 1);
  const goForward = () => setOffset((o) => Math.max(0, o - 1));
  const handleRangeChange = (r: WindowDays) => {
    setRange(r);
    setOffset(0);
  };

  // Swipe anywhere on the page body: finger right → older window,
  // finger left → newer. Attached to a wrapper div (not PageShell) so
  // the hook never fights the charts' pointerdown tooltip handlers.
  const swipeRef = useRef<HTMLDivElement>(null);
  useSwipe(swipeRef, { onSwipeRight: goBack, onSwipeLeft: goForward });

  if (households.isLoading || babies.isLoading) {
    return <PageShell title="Charts & History">Loading…</PageShell>;
  }
  if (!baby) {
    return <PageShell title="Charts & History">No baby selected.</PageShell>;
  }

  const days = charts.data?.days ?? [];

  const recent = mergeRecent({
    bottleFeeds: feeds.data,
    diapers: diapers.data,
    pumpings: pumpings.data,
    nursings: nursings.data,
    growths: growths.data,
    sleeps: sleeps.data,
    notes: notes.data,
  });
  const groups = groupByLocalDay(recent);
  const historyLoading =
    feeds.isLoading ||
    diapers.isLoading ||
    pumpings.isLoading ||
    nursings.isLoading ||
    growths.isLoading ||
    sleeps.isLoading ||
    notes.isLoading;

  // Which local days actually have History entries — so a chart bar for
  // an empty day offers no "jump" (no link, and a mouse click no-ops).
  const entryDayKeys = new Set(groups.map((g) => g.dayKey));

  // Jump from a chart bar (metric `kind`, day `date`) to that day's
  // History: expand it, glow the matching rows, scroll it into view. The
  // null→value reset restarts the CSS glow even on a repeat click.
  const handleSelectDay = (date: string, kind: RecentEvent["kind"]) => {
    if (!entryDayKeys.has(date)) return;
    setExpandOverrides((prev) => ({ ...prev, [date]: true }));
    setHighlight(null);
    requestAnimationFrame(() => setHighlight({ dayKey: date, kind }));
  };

  return (
    <PageShell
      title="Charts & History"
      subtitle={user ? `Signed in as ${user.display_name}` : undefined}
    >
      <div ref={swipeRef} className="flex flex-1 flex-col gap-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs text-white/60">
          <button
            type="button"
            aria-label="Previous period"
            onClick={goBack}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-base text-white/70 hover:bg-white/5"
          >
            ‹
          </button>
          <span>
            {formatDayShort(window.from)} – {formatDayShort(window.to)} · {BROWSER_TZ}
          </span>
          <button
            type="button"
            aria-label="Next period"
            onClick={goForward}
            disabled={offset === 0}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-base text-white/70 hover:bg-white/5 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            ›
          </button>
          {offset > 0 && (
            <button
              type="button"
              onClick={() => setOffset(0)}
              className="rounded-lg px-2 py-1 text-white/70 hover:bg-white/5"
            >
              Today
            </button>
          )}
        </div>
        <SegmentedControl value={range} onChange={handleRangeChange} />
      </div>

      {/* Charts — daily totals overview, on top. */}
      {charts.isLoading ? (
        <p className="rounded-xl bg-bg-surface p-4 text-sm text-white/50">Loading…</p>
      ) : charts.isError ? (
        <p className="rounded-xl bg-red-500/10 p-4 text-sm text-red-200">
          Could not load charts: {charts.error?.message ?? "unknown error"}
        </p>
      ) : (
        <ChartGrid
          // Remount on window change: chart hover state is index-based
          // and would otherwise point at the wrong days after a swipe.
          key={`${range}-${offset}`}
          days={days}
          prefs={prefs}
          todayYMD={formatLocalYMD(new Date())}
          onSelectDay={handleSelectDay}
          entryDayKeys={entryDayKeys}
        />
      )}

      {isFeatureVisible(prefs.feature_visibility, "sleep") && (
        <SleepChartsSection
          key={`sleep-${range}-${offset}`}
          baby={baby}
          prefs={prefs}
          sleeps={rhythmSleeps.data ?? []}
          fromYMD={window.from}
          toYMD={window.to}
          todayYMD={formatLocalYMD(new Date())}
          onSelectDay={(date) => handleSelectDay(date, "sleep")}
          entryDayKeys={entryDayKeys}
        />
      )}

      {/* History — individual event log grouped by local day, below. */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-white/70">History</h2>
        {historyLoading && groups.length === 0 ? (
          <p className="rounded-xl bg-bg-surface p-4 text-sm text-white/50">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="rounded-xl bg-bg-surface p-4 text-sm text-white/50">
            Nothing logged in this window yet.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((g, idx) => {
              const isExpanded = expandOverrides[g.dayKey] ?? idx === 0;
              return (
                <DaySection
                  key={g.dayKey}
                  group={g}
                  prefs={prefs}
                  isExpanded={isExpanded}
                  highlightKind={highlight?.dayKey === g.dayKey ? highlight.kind : undefined}
                  onToggle={() =>
                    setExpandOverrides((prev) => ({ ...prev, [g.dayKey]: !isExpanded }))
                  }
                />
              );
            })}
          </div>
        )}
      </section>
      </div>
    </PageShell>
  );
}

// --- grid + cards ---

function ChartGrid({
  days,
  prefs,
  todayYMD,
  onSelectDay,
  entryDayKeys,
}: {
  days: ChartDaily[];
  prefs: CombinedPreferences;
  todayYMD: string;
  onSelectDay?: (date: string, kind: RecentEvent["kind"]) => void;
  entryDayKeys?: Set<string>;
}) {
  // Bind the "does this day have entries to jump to?" predicate once; each
  // card supplies its own metric kind when calling onSelectDay.
  const canSelectDay = (date: string) => !!entryDayKeys?.has(date);
  // All four bar charts and the line chart share the same X axis (one
  // slot per day). Geometry is recomputed only when `days` changes.
  // Pass `todayYMD` so the per-day averages exclude the in-progress
  // current day; otherwise the average would drift down as the day
  // ticks forward and reset every midnight.
  const totals = useMemo(() => summarize(days, todayYMD), [days, todayYMD]);
  const nursing = useMemo(() => barLayout(days.map((d) => d.nursing_minutes)), [days]);
  const pumping = useMemo(() => barLayout(days.map((d) => d.pumping_ml)), [days]);
  const stacked = useMemo(
    () =>
      stackedDiaperLayout(
        days.map((d) => ({ wet: d.diaper_wet, soiled: d.diaper_soiled, mixed: d.diaper_mixed })),
      ),
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
  // Per-feature visibility gates each ChartCard. Hidden cards drop out of
  // the grid entirely; the `grid-cols-2` layout reflows naturally. Growth
  // is no longer charted here — it has its own /growth page.
  const showBottle = isFeatureVisible(prefs.feature_visibility, "bottle");
  const showNursing = isFeatureVisible(prefs.feature_visibility, "nursing");
  const showPumping = isFeatureVisible(prefs.feature_visibility, "pumping");
  const showDiaper = isFeatureVisible(prefs.feature_visibility, "diaper");
  if (!showBottle && !showNursing && !showPumping && !showDiaper) {
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
          onSelectDay={(date) => onSelectDay?.(date, "bottle")}
          canSelectDay={canSelectDay}
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
          onSelectDay={(date) => onSelectDay?.(date, "nursing")}
          canSelectDay={canSelectDay}
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
          onSelectDay={(date) => onSelectDay?.(date, "pumping")}
          canSelectDay={canSelectDay}
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
          onSelectDay={(date) => onSelectDay?.(date, "diaper")}
          canSelectDay={canSelectDay}
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
    </div>
  );
}

// --- sleep charts ---

// formatClockMin renders minutes-from-midnight as "10:05 pm" style short
// clock labels for the rhythm tooltip.
function formatClockMin(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const period = h24 >= 12 ? "pm" : "am";
  let h = h24 % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, "0")} ${period}`;
}

// SleepChartsSection renders the two sleep cards below the main chart
// grid, driven by the same range control. Data comes straight from the
// sleeps list (clipped/aggregated on the FE) — deliberately NOT from
// chart.go's daily endpoint, which knows nothing about sleep.
function SleepChartsSection({
  baby,
  prefs,
  sleeps,
  fromYMD,
  toYMD,
  todayYMD,
  onSelectDay,
  entryDayKeys,
}: {
  baby: Baby;
  prefs: CombinedPreferences;
  sleeps: Sleep[];
  fromYMD: string;
  toYMD: string;
  todayYMD: string;
  onSelectDay?: (date: string) => void;
  entryDayKeys?: Set<string>;
}) {
  const now = new Date();
  // `new Date()` is taken inside the memo (not the outer `now`) so the
  // deps stay stable — an open session's clipped end only needs to be
  // fresh when the inputs change, which any poll refetch triggers.
  const rhythmDays = useMemo(
    () => clipSleepToDays(sleeps, fromYMD, toYMD, new Date()),
    [sleeps, fromYMD, toYMD],
  );
  const totals = useMemo(
    () => dailySleepTotals(sleeps, fromYMD, toYMD),
    [sleeps, fromYMD, toYMD],
  );
  const colors = useMemo(
    () => resolve(prefs.chart_palette ?? DEFAULT_PALETTE),
    [prefs.chart_palette],
  );
  const range = getDailySleepRange(baby, now);
  const canSelectDay = (date: string) => !!entryDayKeys?.has(date);

  // Window totals/avg. The average excludes today (partial day) exactly
  // like summarize() does for the other cards.
  const totalMin = totals.reduce((s, d) => s + d.minutes, 0);
  const pastDays = totals.filter((d) => d.date !== todayYMD);
  const avgDenominator = pastDays.length > 0 ? pastDays.length : totals.length;
  const avgNumerator =
    pastDays.length > 0 ? pastDays.reduce((s, d) => s + d.minutes, 0) : totalMin;
  const avgMin = avgDenominator > 0 ? avgNumerator / avgDenominator : 0;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ChartCard
        title="Sleep rhythm"
        unit="24h/day"
        accent="text-indigo-300"
        primary={`${formatDurationHM(totalMin)} total`}
        secondary="midnight → midnight"
      >
        <SleepRhythmChart
          days={rhythmDays}
          nightColor={colors.sleep_night}
          napColor={colors.sleep_nap}
          onSelectDay={onSelectDay}
          canSelectDay={canSelectDay}
        />
        <Axis days={rhythmDays} />
        <div className="flex items-center gap-3 text-[10px] text-white/50">
          <span className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: colors.sleep_night }}
            />
            Night
          </span>
          <span className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: colors.sleep_nap }}
            />
            Nap
          </span>
        </div>
      </ChartCard>

      <ChartCard
        title="Sleep total"
        unit="h/day"
        accent="text-indigo-300"
        primary={`${formatDurationHM(avgMin)} /day avg`}
        secondary={
          range
            ? `typical ${range.minH}–${range.maxH}h for age — not medical advice`
            : "add a date of birth to see the typical range"
        }
      >
        <SleepTotalChart
          totals={totals}
          range={range}
          fill={colors.sleep_night}
          onSelectDay={onSelectDay}
          canSelectDay={canSelectDay}
        />
        <Axis days={totals} />
      </ChartCard>
    </div>
  );
}

// SleepRhythmChart is the actogram: one column per day, y = the 24 local
// hours top-to-bottom, each sleep interval a rounded block (already
// clipped at midnight by clipSleepToDays). Open sessions render dimmed.
function SleepRhythmChart({
  days,
  nightColor,
  napColor,
  onSelectDay,
  canSelectDay,
}: {
  days: SleepDay[];
  nightColor: string;
  napColor: string;
  onSelectDay?: (date: string) => void;
  canSelectDay?: (date: string) => boolean;
}) {
  const hover = useChartHover();
  const n = days.length;
  const ai = hover.activeIndex;
  const jumpTo = (i: number) => {
    if (canSelectDay?.(days[i].date)) {
      onSelectDay?.(days[i].date);
      hover.clear();
    }
  };
  const slot = VB_W / Math.max(1, n);
  const colWidth = slot * 0.7;
  const pad = (slot - colWidth) / 2;
  return (
    <div
      ref={hover.containerRef}
      className="relative h-36 w-full"
      style={{ touchAction: "manipulation" }}
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        role="img"
        aria-label="Sleep rhythm chart: one column per day over 24 hours"
      >
        {/* 6h gridlines so the eye can anchor morning / noon / evening. */}
        {[6, 12, 18].map((h) => (
          <line
            key={h}
            x1={0}
            x2={VB_W}
            y1={(h / 24) * VB_H}
            y2={(h / 24) * VB_H}
            stroke="white"
            strokeOpacity={0.08}
            strokeWidth={0.3}
          />
        ))}
        {days.map((day, i) => {
          const x = i * slot + pad;
          const isActive = hover.activeIndex === i;
          return (
            <g key={day.date}>
              {/* Faint full-day track so empty days still read as columns. */}
              <rect
                x={x}
                y={0}
                width={colWidth}
                height={VB_H}
                fill="white"
                opacity={0.04}
                rx={0.5}
              />
              {day.segments.map((seg, si) => (
                <rect
                  key={si}
                  x={x}
                  y={(seg.startMin / 1440) * VB_H}
                  width={colWidth}
                  height={Math.max(((seg.endMin - seg.startMin) / 1440) * VB_H, 0.4)}
                  fill={seg.type === "night" ? nightColor : napColor}
                  opacity={seg.open ? 0.45 : 0.9}
                  rx={0.5}
                  stroke={isActive ? "white" : undefined}
                  strokeWidth={isActive ? 0.4 : 0}
                  vectorEffect={isActive ? "non-scaling-stroke" : undefined}
                />
              ))}
            </g>
          );
        })}
        <HitOverlays
          n={n}
          hover={hover}
          days={days}
          ariaValue={(i) => {
            const min = days[i].segments.reduce((s, x) => s + (x.endMin - x.startMin), 0);
            return `${days[i].segments.length} sleep ${days[i].segments.length === 1 ? "block" : "blocks"}, ${formatDurationHM(min)}`;
          }}
          onSelect={jumpTo}
        />
      </svg>
      {ai != null && (
        <ChartTooltip xPct={tooltipXPercent(ai, n)}>
          <TooltipBody date={days[ai].date}>
            {days[ai].segments.length === 0 && <div>No sleep logged</div>}
            {days[ai].segments.map((seg, si) => (
              <div key={si} className="flex items-center justify-between gap-3 text-white/80">
                <span className="flex items-center gap-1 capitalize">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ backgroundColor: seg.type === "night" ? nightColor : napColor }}
                  />
                  {formatClockMin(seg.startMin)}–{seg.open ? "now" : formatClockMin(seg.endMin)}
                </span>
                <span>{formatDurationHM(seg.endMin - seg.startMin)}</span>
              </div>
            ))}
            {days[ai].segments.length > 0 && (
              <div className="mt-0.5 border-t border-white/10 pt-0.5 font-medium text-white">
                {formatDurationHM(
                  days[ai].segments.reduce((s, x) => s + (x.endMin - x.startMin), 0),
                )}{" "}
                in day
              </div>
            )}
          </TooltipBody>
          {canSelectDay?.(days[ai].date) && <TooltipJumpLink onClick={() => jumpTo(ai)} />}
        </ChartTooltip>
      )}
    </div>
  );
}

// SleepTotalChart renders bar-per-day total sleep with the age-based
// recommended band behind the bars. Totals attribute an interval to the
// day it STARTED (see sleepDays.ts), so this chart agrees with the Today
// banner and the History roll-ups.
function SleepTotalChart({
  totals,
  range,
  fill,
  onSelectDay,
  canSelectDay,
}: {
  totals: { date: string; minutes: number }[];
  range: { minH: number; maxH: number } | null;
  fill: string;
  onSelectDay?: (date: string) => void;
  canSelectDay?: (date: string) => boolean;
}) {
  const hover = useChartHover();
  const n = totals.length;
  const ai = hover.activeIndex;
  const jumpTo = (i: number) => {
    if (canSelectDay?.(totals[i].date)) {
      onSelectDay?.(totals[i].date);
      hover.clear();
    }
  };
  // Scale: the band's top must always be on-chart, so the max is the
  // larger of the data max and the recommended max (with headroom).
  const dataMax = Math.max(0, ...totals.map((t) => t.minutes));
  const scaleMax = Math.max(dataMax, range ? range.maxH * 60 * 1.05 : 0, 1);
  const slot = VB_W / Math.max(1, n);
  const barWidth = slot * 0.7;
  const pad = (slot - barWidth) / 2;
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
        aria-label="Daily sleep totals against the typical range for age"
      >
        {range && (
          <rect
            x={0}
            y={VB_H - (range.maxH * 60 / scaleMax) * VB_H}
            width={VB_W}
            height={((range.maxH - range.minH) * 60 / scaleMax) * VB_H}
            fill={fill}
            opacity={0.12}
          />
        )}
        {totals.map((t, i) => {
          const h = (t.minutes / scaleMax) * VB_H;
          const isActive = hover.activeIndex === i;
          const belowBand = range != null && t.minutes > 0 && t.minutes < range.minH * 60;
          return (
            <rect
              key={t.date}
              x={i * slot + pad}
              y={VB_H - h}
              width={barWidth}
              height={Math.max(h, 0.5)}
              fill={fill}
              opacity={t.minutes === 0 ? 0.3 : belowBand ? 0.55 : 0.85}
              rx={0.5}
              stroke={isActive ? "white" : undefined}
              strokeWidth={isActive ? 0.5 : 0}
              vectorEffect={isActive ? "non-scaling-stroke" : undefined}
            />
          );
        })}
        <HitOverlays
          n={n}
          hover={hover}
          days={totals}
          ariaValue={(i) => formatDurationHM(totals[i].minutes)}
          onSelect={jumpTo}
        />
      </svg>
      {ai != null && (
        <ChartTooltip xPct={tooltipXPercent(ai, n)}>
          <TooltipBody date={totals[ai].date}>
            <div>{formatDurationHM(totals[ai].minutes)}</div>
            {range && (
              <div className="text-white/60">
                typical {range.minH}–{range.maxH}h
              </div>
            )}
          </TooltipBody>
          {canSelectDay?.(totals[ai].date) && <TooltipJumpLink onClick={() => jumpTo(ai)} />}
        </ChartTooltip>
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
  onSelectDay,
  canSelectDay,
}: {
  bars: SparkBar[];
  max: number;
  fill: string;
  days: ChartDaily[];
  ariaValue: (i: number) => string;
  renderTooltip: (i: number) => React.ReactNode;
  onSelectDay?: (date: string) => void;
  canSelectDay?: (date: string) => boolean;
}) {
  const hover = useChartHover();
  const n = days.length;
  const ai = hover.activeIndex;
  const jumpTo = (i: number) => {
    if (canSelectDay?.(days[i].date)) {
      onSelectDay?.(days[i].date);
      hover.clear();
    }
  };
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
        <HitOverlays
          n={n}
          hover={hover}
          days={days}
          ariaValue={ariaValue}
          onSelect={jumpTo}
        />
      </svg>
      {ai != null && (
        <ChartTooltip xPct={tooltipXPercent(ai, n)}>
          {renderTooltip(ai)}
          {canSelectDay?.(days[ai].date) && <TooltipJumpLink onClick={() => jumpTo(ai)} />}
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
  onSelectDay,
  canSelectDay,
}: {
  stacked: ReturnType<typeof stackedDiaperLayout>;
  colors: { wet: string; soiled: string; mixed: string };
  days: ChartDaily[];
  ariaValue: (i: number) => string;
  renderTooltip: (i: number) => React.ReactNode;
  onSelectDay?: (date: string) => void;
  canSelectDay?: (date: string) => boolean;
}) {
  const hover = useChartHover();
  const n = days.length;
  const ai = hover.activeIndex;
  const jumpTo = (i: number) => {
    if (canSelectDay?.(days[i].date)) {
      onSelectDay?.(days[i].date);
      hover.clear();
    }
  };
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
        <HitOverlays
          n={n}
          hover={hover}
          days={days}
          ariaValue={ariaValue}
          onSelect={jumpTo}
        />
      </svg>
      {ai != null && (
        <ChartTooltip xPct={tooltipXPercent(ai, n)}>
          {renderTooltip(ai)}
          {canSelectDay?.(days[ai].date) && <TooltipJumpLink onClick={() => jumpTo(ai)} />}
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
  onSelectDay,
  canSelectDay,
}: {
  days: ChartDaily[];
  breastColor: string;
  formulaColor: string;
  ariaValue: (i: number) => string;
  renderTooltip: (i: number) => React.ReactNode;
  onSelectDay?: (date: string) => void;
  canSelectDay?: (date: string) => boolean;
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
  const ai = hover.activeIndex;
  const jumpTo = (i: number) => {
    if (canSelectDay?.(days[i].date)) {
      onSelectDay?.(days[i].date);
      hover.clear();
    }
  };
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
        <HitOverlays
          n={n}
          hover={hover}
          days={days}
          ariaValue={ariaValue}
          onSelect={jumpTo}
        />
      </svg>
      {ai != null && (
        <ChartTooltip xPct={tooltipXPercent(ai, n)}>
          {renderTooltip(ai)}
          {canSelectDay?.(days[ai].date) && <TooltipJumpLink onClick={() => jumpTo(ai)} />}
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

// Only `.date` is read — widened past ChartDaily for the sleep charts.
function Axis({ days }: { days: { date: string }[] }) {
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

// --- history section ---

function DaySection({
  group,
  prefs,
  isExpanded,
  onToggle,
  highlightKind,
}: {
  group: DayGroup;
  prefs: CombinedPreferences;
  isExpanded: boolean;
  onToggle: () => void;
  // When set, rows of this kind glow (the user jumped here from that
  // metric's chart bar). Only ever set on the matching day.
  highlightKind?: RecentEvent["kind"];
}) {
  const heading = isToday(group.date)
    ? "Today"
    : isYesterday(group.date)
      ? "Yesterday"
      : format(group.date, "EEE, MMM d");
  const summary = formatDaySummary(group.events, prefs);
  const contentId = `history-day-${group.dayKey}`;
  return (
    <section
      id={`history-day-section-${group.dayKey}`}
      className="flex scroll-mt-4 flex-col gap-2"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className="-mx-1 flex w-full items-baseline justify-between gap-3 rounded-md px-1 py-0.5 text-left transition hover:bg-white/5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/30"
      >
        <span className="flex items-baseline gap-2">
          <Chevron expanded={isExpanded} />
          <span className="text-sm font-medium text-white/70">{heading}</span>
        </span>
        {summary && (
          <span className="truncate text-xs text-white/50">{summary}</span>
        )}
      </button>
      {isExpanded && (
        <ul id={contentId} className="flex flex-col gap-2">
          {group.events.map((ev) => (
            <RecentRow
              key={`${ev.kind}-${ev.data.id}`}
              ev={ev}
              prefs={prefs}
              syncing={false}
              highlight={highlightKind != null && ev.kind === highlightKind}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className={
        "h-3 w-3 shrink-0 self-center text-white/50 transition-transform duration-150 " +
        (expanded ? "rotate-90" : "")
      }
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 2.5 L8 6 L4 9.5" />
    </svg>
  );
}

// Roll up the day's events into a one-line "60 ml · 12 min nursing · …"
// summary. Zero parts are dropped so a quiet day reads "2 diapers"
// rather than "0 ml · 0 min nursing · 0 pumped · 2 diapers · 0 growth".
function formatDaySummary(events: RecentEvent[], prefs: CombinedPreferences): string {
  let bottleMl = 0;
  let nursingMin = 0;
  let pumpedMl = 0;
  let diaperCount = 0;
  let growthCount = 0;
  let sleepMin = 0;
  let noteCount = 0;
  for (const ev of events) {
    switch (ev.kind) {
      case "bottle":
        bottleMl += Number(ev.data.amount_ml) || 0;
        break;
      case "nursing":
        nursingMin += Math.round(
          (Number(ev.data.left_duration_s) + Number(ev.data.right_duration_s)) / 60,
        );
        break;
      case "pumping":
        pumpedMl += Number(ev.data.amount_ml) || 0;
        break;
      case "diaper":
        diaperCount += 1;
        break;
      case "growth":
        growthCount += 1;
        break;
      case "sleep":
        // Closed intervals only — an open session has no duration yet.
        if (ev.data.ended_at != null) {
          sleepMin += Math.max(
            0,
            Math.round(
              (new Date(ev.data.ended_at).getTime() -
                new Date(ev.data.started_at).getTime()) /
                60_000,
            ),
          );
        }
        break;
      case "note":
        noteCount += 1;
        break;
    }
  }
  const parts: string[] = [];
  if (bottleMl > 0) parts.push(formatVolume(bottleMl, prefs.unit_volume));
  if (nursingMin > 0) parts.push(`${nursingMin} min nursing`);
  if (pumpedMl > 0) parts.push(`${formatVolume(pumpedMl, prefs.unit_volume)} pumped`);
  if (diaperCount > 0) parts.push(`${diaperCount} ${diaperCount === 1 ? "diaper" : "diapers"}`);
  if (growthCount > 0) parts.push(`${growthCount} growth`);
  if (sleepMin > 0) parts.push(`${formatDurationHM(sleepMin)} sleep`);
  if (noteCount > 0) parts.push(`${noteCount} ${noteCount === 1 ? "note" : "notes"}`);
  return parts.join(" · ");
}
