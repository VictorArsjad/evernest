// Charts screen — last 7 / 14 / 30 day overview of every metric the
// app tracks. One inline-SVG card per metric; no chart library, since
// the PWA install size matters more than the marginal feature density
// recharts/visx would buy us. Mobile-first: full-width cards on narrow
// viewports, two-up on `sm:`.
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { useAuthStore } from "../lib/authStore";
import {
  barLayout,
  dailyWindowEndingToday,
  formatDayShort,
  linePoints,
  stackedDiaperLayout,
  summarize,
  type LinePoint,
  type SparkBar,
} from "../lib/charts";
import {
  useBabies,
  useDailyCharts,
  useHouseholds,
  useLogout,
} from "../lib/queries";
import type { ChartDaily } from "../lib/types";

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
  const baby = babies.data?.[0] ?? null;

  // Pinning `now` per-render is fine — TanStack only refetches when
  // the queryKey changes, and the YYYY-MM-DD strings only change at
  // local midnight. We don't need to memoize harder than that.
  const window = useMemo(() => dailyWindowEndingToday(new Date(), range), [range]);
  const charts = useDailyCharts(baby?.id ?? null, window.from, window.to, BROWSER_TZ);

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
        <ChartGrid days={days} />
      )}
    </PageShell>
  );
}

// --- grid + cards ---

function ChartGrid({ days }: { days: ChartDaily[] }) {
  // All four bar charts and the line chart share the same X axis (one
  // slot per day). Geometry is recomputed only when `days` changes.
  const totals = useMemo(() => summarize(days), [days]);
  const bottle = useMemo(() => barLayout(days.map((d) => d.bottle_ml)), [days]);
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

  if (days.length === 0) {
    return (
      <p className="rounded-xl bg-bg-surface p-4 text-sm text-white/50">
        No data in this window yet.
      </p>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <ChartCard
        title="Bottle"
        unit="ml/day"
        accent="text-orange-300"
        primary={`${Math.round(totals.bottleTotalMl)} ml total`}
        secondary={`${Math.round(totals.bottleAvgMl)} ml/day avg`}
      >
        <BarChart bars={bottle.bars} max={bottle.max} fill="rgb(253 186 116)" />
        <Axis days={days} />
      </ChartCard>

      <ChartCard
        title="Nursing"
        unit="min/day"
        accent="text-emerald-300"
        primary={`${totals.nursingTotalMin} min total`}
        secondary={`${Math.round(totals.nursingAvgMin)} min/day avg`}
      >
        <BarChart bars={nursing.bars} max={nursing.max} fill="rgb(110 231 183)" />
        <Axis days={days} />
      </ChartCard>

      <ChartCard
        title="Pumping"
        unit="ml/day"
        accent="text-sky-300"
        primary={`${Math.round(totals.pumpingTotalMl)} ml total`}
        secondary={`${Math.round(totals.pumpingAvgMl)} ml/day avg`}
      >
        <BarChart bars={pumping.bars} max={pumping.max} fill="rgb(125 211 252)" />
        <Axis days={days} />
      </ChartCard>

      <ChartCard
        title="Diapers"
        unit="count/day"
        accent="text-yellow-300"
        primary={`${totals.diaperTotal} total`}
        secondary={`${totals.diaperAvg.toFixed(1)} /day avg`}
      >
        <DiaperStackChart stacked={stacked} />
        <Axis days={days} />
        <DiaperLegend />
      </ChartCard>

      <ChartCard
        title="Weight"
        unit="g"
        accent="text-violet-300"
        primary={
          totals.latestWeightG != null ? formatWeight(totals.latestWeightG) : "no readings"
        }
        secondary={
          weight.hasData ? rangeSummary(weight.min, weight.max) : ""
        }
        wide
      >
        {weight.hasData ? (
          <LineChart points={weight.points} stroke="rgb(196 181 253)" />
        ) : (
          <EmptyState>No measurements in this window</EmptyState>
        )}
        <Axis days={days} />
      </ChartCard>
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

function BarChart({ bars, max, fill }: { bars: SparkBar[]; max: number; fill: string }) {
  return (
    <div className="relative h-20 w-full">
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
            />
          );
        })}
      </svg>
    </div>
  );
}

function DiaperStackChart({
  stacked,
}: {
  stacked: ReturnType<typeof stackedDiaperLayout>;
}) {
  return (
    <div className="relative h-20 w-full">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
        role="img"
        aria-label="Daily diaper count stacked bar chart"
      >
        {stacked.wet.map((b) => (
          <SegmentRect key={`w${b.index}`} bar={b} fill={DIAPER_FILL.wet} />
        ))}
        {stacked.soiled.map((b) => (
          <SegmentRect key={`s${b.index}`} bar={b} fill={DIAPER_FILL.soiled} />
        ))}
        {stacked.mixed.map((b) => (
          <SegmentRect key={`m${b.index}`} bar={b} fill={DIAPER_FILL.mixed} />
        ))}
      </svg>
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

const DIAPER_FILL = {
  wet: "rgb(253 224 71)",
  soiled: "rgb(217 119 6)",
  mixed: "rgb(180 83 9)",
} as const;

function DiaperLegend() {
  return (
    <ul className="flex gap-3 text-[10px] text-white/60">
      <LegendDot color={DIAPER_FILL.wet} label="wet" />
      <LegendDot color={DIAPER_FILL.soiled} label="soiled" />
      <LegendDot color={DIAPER_FILL.mixed} label="mixed" />
    </ul>
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

function LineChart({ points, stroke }: { points: LinePoint[]; stroke: string }) {
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

  return (
    <div className="relative h-24 w-full">
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
          .map((p) => (
            <circle key={p.index} cx={p.x * VB_W} cy={VB_H - p.y * VB_H} r={1.2} fill={stroke} />
          ))}
      </svg>
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

function formatWeight(g: number): string {
  // Mirrors the Today screen: 2-decimal kg above 1 kg, whole grams
  // below (rare in practice for this tracker but possible for very
  // young preemies).
  return g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.round(g)} g`;
}

function rangeSummary(min: number, max: number): string {
  return min === max
    ? `${formatWeight(min)} in window`
    : `${formatWeight(min)} – ${formatWeight(max)} in window`;
}
