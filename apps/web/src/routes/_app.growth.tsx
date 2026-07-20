// Growth screen — plots each measurement against the baby's *age* on top
// of the WHO Child Growth Standards percentile curves, so a caregiver can
// see not just "how big" but "how are we tracking". One metric at a time
// (weight / length / head), a plain-language current-percentile headline,
// and at-a-glance chips for the other two.
//
// Growth plays out over months, so — unlike the activity charts on
// /charts — there's no day-range control here; the x-axis is the child's
// whole life so far. All percentile math lives in lib/who (pure + tested);
// this file is rendering only. Canonical grams/cm are converted for
// display via lib/units, and the WHO tables work in kg/cm so weight is
// divided by 1000 before the z-score.
//
// NOT MEDICAL ADVICE — the footnote says so, and the copy stays calm on
// purpose (see who/whoGrowth.ts `classify`).
import { Link, createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import { useMemo, useState } from "react";

import { ChartTooltip } from "../components/ChartTooltip";
import { useBabies, useGrowths, useHouseholds } from "../lib/queries";
import type { Growth } from "../lib/types";
import { useActiveBaby } from "../lib/useActiveBaby";
import { useChartHover } from "../lib/useChartHover";
import {
  cmToDisplayLength,
  formatLength,
  formatWeight,
  gToDisplayWeight,
  lengthUnitLabel,
  weightUnitLabel,
} from "../lib/units";
import { usePreferences } from "../lib/usePreferences";
import {
  type ReferenceCurve,
  niceAgeMax,
  niceTicks,
  sampleReferenceCurves,
  valueBounds,
} from "../lib/who/curves";
import {
  type GrowthMetric,
  MAX_AGE_MONTHS,
  ageInMonths,
  classify,
  measurePercentile,
  ordinal,
  rowsFor,
} from "../lib/who/whoGrowth";

export const Route = createFileRoute("/_app/growth")({
  component: GrowthPage,
});

const METRICS: { key: GrowthMetric; label: string }[] = [
  { key: "weight", label: "Weight" },
  { key: "length", label: "Length" },
  { key: "head", label: "Head" },
];

// One resolved measurement for the active metric, in canonical units
// (grams for weight, cm for length/head), with the age it was taken at.
interface Point {
  id: string;
  at: Date;
  ageMonths: number;
  canonical: number;
}

function canonicalField(g: Growth, metric: GrowthMetric): number | null {
  const raw =
    metric === "weight"
      ? g.weight_g
      : metric === "length"
        ? g.height_cm
        : g.head_circumference_cm;
  return raw == null ? null : Number(raw);
}

function GrowthPage() {
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  // Follow the same active-baby selection the Today hub persists.
  const { baby } = useActiveBaby(householdId, babies.data);
  const babyId = baby?.id ?? null;
  const { prefs } = usePreferences(babyId);
  const [metric, setMetric] = useState<GrowthMetric>("weight");

  const dob = useMemo(() => {
    if (!baby?.date_of_birth) return null;
    const d = new Date(baby.date_of_birth);
    return Number.isNaN(d.getTime()) ? null : d;
  }, [baby?.date_of_birth]);

  // Fetch the *whole* history from birth (the list endpoint otherwise
  // defaults to the last 365 days). Measurements are sparse so the volume
  // is trivial. ISO instants match how the charts page calls this hook.
  // Memoized so the query key is stable — an inline `new Date()` would
  // change every render and churn the key into a refetch loop.
  const range = useMemo(
    () => ({
      from: dob ? dob.toISOString() : undefined,
      to: dob ? new Date().toISOString() : undefined,
    }),
    [dob],
  );
  const growths = useGrowths(babyId, range.from, range.to);

  const points = useMemo<Point[]>(() => {
    if (!dob) return [];
    const rows = growths.data ?? [];
    return rows
      .map((g) => {
        const canonical = canonicalField(g, metric);
        if (canonical == null) return null;
        const at = new Date(g.measured_at);
        return { id: g.id, at, ageMonths: ageInMonths(dob, at), canonical };
      })
      .filter((p): p is Point => p != null && p.ageMonths >= 0)
      .sort((a, b) => a.ageMonths - b.ageMonths);
  }, [growths.data, metric, dob]);

  if (!baby) {
    return <p className="p-6 text-white/60">No baby selected.</p>;
  }

  const referenceRows = rowsFor(metric, baby.sex);
  const hasReference = !!referenceRows && !!dob;

  return (
    <main className="flex flex-1 flex-col gap-5 p-5 pb-12">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Link to="/" className="text-xs text-white/50 hover:text-white" aria-label="Back to Today">
            ← Today
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">Growth</h1>
            <p className="text-xs text-white/50">
              {baby.name}
              {dob ? ` · ${ageLabel(ageInMonths(dob, new Date()))}` : ""}
            </p>
          </div>
        </div>
      </header>

      <MetricToggle value={metric} onChange={setMetric} />

      {!dob ? (
        <NeedsProfile
          message="Add your baby's date of birth to chart growth against age."
        />
      ) : points.length === 0 ? (
        <EmptyGrowth babyId={baby.id} />
      ) : (
        <GrowthChartCard
          metric={metric}
          points={points}
          referenceRows={hasReference ? referenceRows : null}
          sex={baby.sex ?? null}
          prefs={prefs}
        />
      )}

      {dob && points.length > 0 && (
        <SecondaryChips
          growths={growths.data ?? []}
          active={metric}
          sex={baby.sex ?? null}
          dob={dob}
          prefs={prefs}
          onPick={setMetric}
        />
      )}

      <p className="text-[11px] leading-relaxed text-white/40">
        Compared with the WHO Child Growth Standards (0–5 yr
        {baby.sex === "male" ? ", boys" : baby.sex === "female" ? ", girls" : ""}). These describe how
        a healthy reference population grows and are not medical advice — a baby a little above or
        below the median is usually perfectly normal.
      </p>
    </main>
  );
}

function MetricToggle({
  value,
  onChange,
}: {
  value: GrowthMetric;
  onChange: (m: GrowthMetric) => void;
}) {
  return (
    <div className="inline-flex self-start rounded-lg border border-white/10 bg-bg-subtle p-0.5">
      {METRICS.map((m) => (
        <button
          key={m.key}
          type="button"
          onClick={() => onChange(m.key)}
          className={
            "rounded-md px-4 py-1.5 text-xs font-medium transition " +
            (value === m.key ? "bg-white/10 text-white" : "text-white/60 hover:text-white")
          }
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

// Per-metric display config: how to convert canonical → the chart's plot
// unit and the user's display unit, and how to format a canonical value.
type Prefs = ReturnType<typeof usePreferences>["prefs"];

function metricDisplay(metric: GrowthMetric, prefs: Prefs) {
  if (metric === "weight") {
    return {
      // WHO weight table is in kg; canonical is grams.
      toTable: (canonical: number) => canonical / 1000,
      toDisplay: (canonical: number) => gToDisplayWeight(canonical, prefs.unit_weight),
      // table value (kg) → display number
      tableToDisplay: (kg: number) => gToDisplayWeight(kg * 1000, prefs.unit_weight),
      unit: weightUnitLabel(prefs.unit_weight),
      format: (canonical: number) => formatWeight(canonical, prefs.unit_weight),
    };
  }
  // length + head share cm handling.
  return {
    toTable: (canonical: number) => canonical,
    toDisplay: (canonical: number) => cmToDisplayLength(canonical, prefs.unit_length),
    tableToDisplay: (cm: number) => cmToDisplayLength(cm, prefs.unit_length),
    unit: lengthUnitLabel(prefs.unit_length),
    format: (canonical: number) => formatLength(canonical, prefs.unit_length),
  };
}

// --- chart ---

const VB_W = 320;
const VB_H = 232;
const M_LEFT = 30;
const M_RIGHT = 34;
const M_TOP = 12;
const M_BOTTOM = 26;
const PLOT_L = M_LEFT;
const PLOT_R = VB_W - M_RIGHT;
const PLOT_T = M_TOP;
const PLOT_B = VB_H - M_BOTTOM;

const CURVE_FAINT = "rgba(255,255,255,0.14)";
const CURVE_50 = "rgba(255,255,255,0.42)";
const GRID = "rgba(255,255,255,0.05)";
const BAND = "rgba(124,156,255,0.05)";
const ACCENT = "#7c9cff";
const AXIS_TEXT = "rgba(255,255,255,0.45)";

function GrowthChartCard({
  metric,
  points,
  referenceRows,
  sex,
  prefs,
}: {
  metric: GrowthMetric;
  points: Point[];
  referenceRows: ReturnType<typeof rowsFor>;
  sex: string | null;
  prefs: Prefs;
}) {
  const disp = metricDisplay(metric, prefs);
  const hover = useChartHover();

  const latest = points[points.length - 1];
  const latestResult =
    referenceRows && latest.ageMonths <= MAX_AGE_MONTHS
      ? measurePercentile(metric, sex, latest.ageMonths, disp.toTable(latest.canonical))
      : null;

  const geom = useMemo(() => {
    const currentAge = Math.min(latest.ageMonths, MAX_AGE_MONTHS);
    const ageMax = niceAgeMax(currentAge);
    // Reference curves in display units (convert each WHO sample).
    let curves: ReferenceCurve[] = [];
    if (referenceRows) {
      curves = sampleReferenceCurves(referenceRows, ageMax).map((c) => ({
        pct: c.pct,
        samples: c.samples.map((s) => ({ age: s.age, value: disp.tableToDisplay(s.value) })),
      }));
    }
    const markValues = points.map((p) => disp.toDisplay(p.canonical));
    const { min, max } = valueBounds(curves, markValues);
    return { ageMax, curves, min, max };
  }, [referenceRows, points, latest.ageMonths, disp]);

  const x = (ageMonths: number) => PLOT_L + (ageMonths / geom.ageMax) * (PLOT_R - PLOT_L);
  const y = (value: number) =>
    PLOT_B - ((value - geom.min) / (geom.max - geom.min)) * (PLOT_B - PLOT_T);

  const marks = points.map((p) => ({ ...p, cx: x(p.ageMonths), cy: y(disp.toDisplay(p.canonical)) }));
  const linePts = marks.map((m) => `${m.cx},${m.cy}`).join(" ");

  const yTicks = niceTicks(geom.min, geom.max, 5);
  const xTicks = niceTicks(0, geom.ageMax, 5);
  const active = hover.activeIndex != null ? marks[hover.activeIndex] : null;

  // Shaded band between the 3rd and 97th curves. Cheap to build (a few
  // dozen points) and depends on the per-render x/y projections, so it's a
  // plain computation rather than a memo.
  const band = ((): string => {
    if (geom.curves.length === 0) return "";
    const lo = geom.curves[0];
    const hi = geom.curves[geom.curves.length - 1];
    const top = hi.samples.map((s) => `${x(s.age)},${y(s.value)}`);
    const bot = lo.samples
      .slice()
      .reverse()
      .map((s) => `${x(s.age)},${y(s.value)}`);
    return top.concat(bot).join(" ");
  })();

  return (
    <section className="card flex flex-col gap-3 p-4">
      <StatusHeader
        latest={latest}
        result={latestResult}
        hasReference={!!referenceRows}
        sex={sex}
        disp={disp}
      />

      <div ref={hover.containerRef} className="relative w-full" style={{ touchAction: "manipulation" }}>
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`${metric} growth chart against WHO percentile curves`}
        >
          {band && <polygon points={band} fill={BAND} />}

          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={PLOT_L} y1={y(t)} x2={PLOT_R} y2={y(t)} stroke={GRID} strokeWidth={0.5} />
              <text x={PLOT_L - 4} y={y(t) + 3} textAnchor="end" fontSize={9} fill={AXIS_TEXT}>
                {t}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={`x${t}`} x={x(t)} y={PLOT_B + 13} textAnchor="middle" fontSize={9} fill={AXIS_TEXT}>
              {t}
            </text>
          ))}
          <text x={(PLOT_L + PLOT_R) / 2} y={VB_H - 2} textAnchor="middle" fontSize={8.5} fill={AXIS_TEXT}>
            months
          </text>
          <text x={PLOT_L - 4} y={PLOT_T - 3} textAnchor="end" fontSize={8.5} fill={AXIS_TEXT}>
            {disp.unit}
          </text>

          {geom.curves.map((c) => (
            <polyline
              key={c.pct}
              fill="none"
              stroke={c.pct === 50 ? CURVE_50 : CURVE_FAINT}
              strokeWidth={c.pct === 50 ? 1.1 : 0.8}
              points={c.samples.map((s) => `${x(s.age)},${y(s.value)}`).join(" ")}
            />
          ))}
          {geom.curves
            .filter((c) => c.pct === 3 || c.pct === 50 || c.pct === 97)
            .map((c) => {
              const last = c.samples[c.samples.length - 1];
              return (
                <text
                  key={`lbl${c.pct}`}
                  x={PLOT_R + 2}
                  y={y(last.value) + 3}
                  fontSize={8.5}
                  fill={AXIS_TEXT}
                >
                  {ordinal(c.pct)}
                </text>
              );
            })}

          {marks.length > 1 && (
            <polyline
              fill="none"
              stroke={ACCENT}
              strokeWidth={1.6}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={linePts}
            />
          )}
          {marks.map((m, i) => {
            const isActive = hover.activeIndex === i;
            return (
              <g key={m.id}>
                {isActive && <circle cx={m.cx} cy={m.cy} r={5} fill={ACCENT} opacity={0.25} />}
                <circle cx={m.cx} cy={m.cy} r={isActive ? 3 : 2.2} fill={ACCENT} stroke="#111a2c" strokeWidth={0.8} />
                <circle
                  cx={m.cx}
                  cy={m.cy}
                  r={9}
                  fill="transparent"
                  role="button"
                  tabIndex={-1}
                  style={{ outline: "none" }}
                  aria-label={`${format(m.at, "MMM d, yyyy")}: ${disp.format(m.canonical)}`}
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
              </g>
            );
          })}
        </svg>
        {active && (
          <ChartTooltip xPct={(active.cx / VB_W) * 100}>
            <div className="flex flex-col gap-0.5">
              <div className="text-white/60">
                {format(active.at, "MMM d, yyyy")} · {ageLabel(active.ageMonths)}
              </div>
              <div>{disp.format(active.canonical)}</div>
              <ActivePercentile
                metric={metric}
                sex={sex}
                point={active}
                hasReference={!!referenceRows}
                disp={disp}
              />
            </div>
          </ChartTooltip>
        )}
      </div>

      <ChartLegend hasReference={!!referenceRows} />
    </section>
  );
}

function ActivePercentile({
  metric,
  sex,
  point,
  hasReference,
  disp,
}: {
  metric: GrowthMetric;
  sex: string | null;
  point: Point;
  hasReference: boolean;
  disp: ReturnType<typeof metricDisplay>;
}) {
  if (!hasReference || point.ageMonths > MAX_AGE_MONTHS) return null;
  const r = measurePercentile(metric, sex, point.ageMonths, disp.toTable(point.canonical));
  if (!r) return null;
  return <div className="text-accent">{ordinal(r.percentile)} percentile</div>;
}

function StatusHeader({
  latest,
  result,
  hasReference,
  sex,
  disp,
}: {
  latest: Point;
  result: ReturnType<typeof measurePercentile>;
  hasReference: boolean;
  sex: string | null;
  disp: ReturnType<typeof metricDisplay>;
}) {
  const cls = result ? classify(result.percentile) : null;
  const toneColor =
    cls?.tone === "outer"
      ? "bg-amber-300 text-bg-base"
      : cls?.tone === "edge"
        ? "bg-sky-300 text-bg-base"
        : "bg-emerald-300 text-bg-base";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-semibold tabular-nums">{disp.format(latest.canonical)}</span>
        {result ? (
          <span className={"rounded-full px-2.5 py-0.5 text-xs font-medium " + toneColor}>
            {ordinal(result.percentile)} percentile
          </span>
        ) : (
          <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs text-white/60">
            {sexPromptShort(sex)}
          </span>
        )}
      </div>
      {hasReference && cls ? (
        <p className="text-xs text-white/60">{cls.label}</p>
      ) : (
        <p className="text-xs text-white/60">
          Showing your measurements over time. Set your baby's sex to compare with WHO standards.
        </p>
      )}
    </div>
  );
}

function ChartLegend({ hasReference }: { hasReference: boolean }) {
  return (
    <div className="flex flex-wrap justify-center gap-4 text-[11px] text-white/50">
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-3.5" style={{ backgroundColor: ACCENT }} />
        Measurements
      </span>
      {hasReference && (
        <>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3.5" style={{ backgroundColor: CURVE_50 }} />
            WHO 50th
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0 w-3.5 border-t border-dashed"
              style={{ borderColor: "rgba(255,255,255,0.3)" }}
            />
            3rd–97th
          </span>
        </>
      )}
    </div>
  );
}

// --- secondary chips ---

function SecondaryChips({
  growths,
  active,
  sex,
  dob,
  prefs,
  onPick,
}: {
  growths: Growth[];
  active: GrowthMetric;
  sex: string | null;
  dob: Date;
  prefs: Prefs;
  onPick: (m: GrowthMetric) => void;
}) {
  const others = METRICS.filter((m) => m.key !== active);
  return (
    <div className="flex gap-3">
      {others.map((m) => {
        const disp = metricDisplay(m.key, prefs);
        // newest row carrying this metric
        const latest = growths
          .map((g) => {
            const canonical = canonicalField(g, m.key);
            return canonical == null ? null : { at: new Date(g.measured_at), canonical };
          })
          .filter((p): p is { at: Date; canonical: number } => p != null)
          .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
        const ageMonths = latest ? ageInMonths(dob, latest.at) : null;
        const result =
          latest && ageMonths != null && ageMonths >= 0 && ageMonths <= MAX_AGE_MONTHS
            ? measurePercentile(m.key, sex, ageMonths, disp.toTable(latest.canonical))
            : null;
        return (
          <button
            key={m.key}
            type="button"
            onClick={() => onPick(m.key)}
            className="flex-1 rounded-xl bg-bg-surface p-3 text-left transition hover:bg-white/5"
          >
            <div className="text-[11px] uppercase tracking-wide text-white/50">{m.label}</div>
            <div className="mt-0.5 text-base font-semibold tabular-nums">
              {latest ? disp.format(latest.canonical) : "—"}
              {result && (
                <span className="ml-1.5 text-[11px] font-normal text-accent">
                  {ordinal(result.percentile)}
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// --- empty / fallback states ---

function EmptyGrowth({ babyId }: { babyId: string }) {
  return (
    <div className="card flex flex-col items-center gap-3 p-8 text-center">
      <p className="text-sm text-white/60">No growth measurements yet.</p>
      <Link to="/log/growth" search={{ babyId }} className="btn-primary text-sm">
        Log a measurement
      </Link>
    </div>
  );
}

function NeedsProfile({ message }: { message: string }) {
  return (
    <div className="card flex flex-col gap-2 p-5">
      <p className="text-sm text-white/70">{message}</p>
    </div>
  );
}

// --- helpers ---

function ageLabel(months: number): string {
  const m = Math.max(0, Math.round(months));
  if (m < 24) return `${m} mo`;
  const years = Math.floor(m / 12);
  const rem = m % 12;
  return rem === 0 ? `${years} yr` : `${years}y ${rem}m`;
}

function sexPromptShort(sex: string | null): string {
  return sex === "male" || sex === "female" ? "no reading" : "set sex to compare";
}
