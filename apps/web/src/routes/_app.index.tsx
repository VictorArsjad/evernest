// Today screen layout:
//   - TodayBanner infographic card (daily totals + 7-day sparkline)
//   - 3-column action tile grid: 5 event kinds (Bottle / Nursing /
//     Pumping / Diaper / Growth). Removing the old 6th "summary" tile
//     leaves the second row left-aligned with one empty slot, which
//     matches the design intent — the summary now lives above the grid.
//   - Unified recent-events list across all kinds, newest first
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { InstallPromptBanner } from "../components/InstallPromptBanner";
import { RecentRow } from "../components/RecentRow";
import { SyncStatusBadge } from "../components/SyncStatusBadge";
import { useAuthStore } from "../lib/authStore";
import { dailyWindowEndingToday } from "../lib/charts";
import { isFeatureVisible } from "../lib/featureVisibility";
import { formatElapsedHHMM } from "../lib/nursingTimer";
import {
  useBabies,
  useBottleFeeds,
  useDailyCharts,
  useDiapers,
  useEndNursing,
  useGrowths,
  useHouseholds,
  useLogout,
  useNursings,
  useOpenNursing,
  usePumpings,
} from "../lib/queries";
import { getDailyTargets, type DailyTargets } from "../lib/recommendations";
import { mergeRecent } from "../lib/recentEvents";
import { submitOnEnter } from "../lib/submitOnEnter";
import { formatTimeSince, lastEventAt, useNow } from "../lib/timeSince";
import type { Baby, Nursing } from "../lib/types";
import { useActiveBaby } from "../lib/useActiveBaby";
import { useEscapeKey } from "../lib/useEscapeKey";
import { useOutbox } from "../lib/useOutbox";
import { formatTime, formatVolume, formatWeight } from "../lib/units";
import { type CombinedPreferences, usePreferences } from "../lib/usePreferences";

// Browser tz pinned at module init — the user's tz effectively never
// changes mid-session, and re-reading on every render would invalidate
// the sparkline query key on every paint. Mirrors the same pattern in
// _app.charts.tsx.
const BROWSER_TZ =
  (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";

export const Route = createFileRoute("/_app/")({
  component: TodayPage,
});

function TodayPage() {
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();

  // CP6b: subscribe to the offline outbox so the badge + recent-row
  // "syncing…" hints + "all caught up" toast all read from a single
  // hook. inflightKeys is a Set<string> of idempotencyKeys still in
  // the queue; RecentRow toggles a small clock icon when its row id
  // is in this set.
  const outbox = useOutbox();
  const [caughtUpToast, setCaughtUpToast] = useState<number | null>(null);
  useEffect(() => {
    if (outbox.caughtUpAt == null) return;
    setCaughtUpToast(outbox.caughtUpAt);
    // Auto-dismiss after 3s so it doesn't linger across navigations.
    const id = window.setTimeout(() => setCaughtUpToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [outbox.caughtUpAt]);

  const households = useHouseholds();
  // First household is the "active" household for now — multi-household UI
  // is out of scope for CP5; only multi-baby. When that lands, lift the
  // household selection alongside this hook the same way.
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const { baby, setActiveBabyId, all: allBabies } = useActiveBaby(
    householdId,
    babies.data,
  );

  useEffect(() => {
    if (households.isSuccess && households.data.length === 0) {
      nav({ to: "/onboarding" });
      return;
    }
    if (babies.isSuccess && babies.data.length === 0 && householdId) {
      nav({ to: "/onboarding" });
    }
  }, [households.data, households.isSuccess, babies.data, babies.isSuccess, householdId, nav]);

  const todayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);
  const todayEnd = useMemo(() => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }, []);

  const feeds = useBottleFeeds(baby?.id ?? null, todayStart, todayEnd);
  const diapers = useDiapers(baby?.id ?? null, todayStart, todayEnd);
  const pumpings = usePumpings(baby?.id ?? null, todayStart, todayEnd);
  const nursings = useNursings(baby?.id ?? null, todayStart, todayEnd);
  // Display preferences for the active baby + user. Falls back to
  // canonical units while the queries hydrate so the tile grid renders
  // immediately rather than blocking on a settings round-trip.
  const { prefs } = usePreferences(baby?.id ?? null);
  // Cheap "is one running?" check — the BE returns 204 when nothing is
  // open, which the hook normalizes to `null`. We render the in-progress
  // chip in place of the standard Nursing tile when this resolves to a row.
  const openNursing = useOpenNursing(baby?.id ?? null);
  const growthsToday = useGrowths(baby?.id ?? null, todayStart, todayEnd);
  // Latest measurement ever — fed into the banner's Growth cell. The
  // default server-side window for growths covers the past year, which
  // is plenty for "most-recent weight" since the rows return DESC by
  // measured_at.
  const growthsLatest = useGrowths(baby?.id ?? null);
  // 7-day sparkline data — pulled from the same daily-aggregations
  // endpoint that powers /charts. Memo'd window so the queryKey is
  // stable across re-renders mid-day; it only flips at local midnight.
  const sparkWindow = useMemo(() => dailyWindowEndingToday(new Date(), 7), []);
  const sparkCharts = useDailyCharts(baby?.id ?? null, sparkWindow.from, sparkWindow.to, BROWSER_TZ);
  // Single shared "now" tick for the banner's "X ago" labels. 60s is
  // fast enough that "5m ago" never sits stale for more than a minute
  // and slow enough to be invisible in CPU profiles.
  const now = useNow(60_000);

  if (households.isLoading || babies.isLoading) {
    return <PageShell title="…">Loading…</PageShell>;
  }
  if (!baby) {
    return <PageShell title="…">Setting up…</PageShell>;
  }

  const totalMl = feeds.data?.reduce((s, f) => s + Number(f.amount_ml), 0) ?? 0;
  const diaperCount = diapers.data?.length ?? 0;
  const pumpedMl = pumpings.data?.reduce((s, p) => s + Number(p.amount_ml), 0) ?? 0;
  const nursingMin =
    nursings.data?.reduce(
      (s, n) => s + Math.round((Number(n.left_duration_s) + Number(n.right_duration_s)) / 60),
      0,
    ) ?? 0;
  // Latest weight is the only growth metric on the summary tile — height
  // and head circumference get a full chart in CP4 but are visually
  // overkill for a 2x3 hub cell. Plain expression (not useMemo) because
  // the early return above means we can't add another hook here without
  // tripping rules-of-hooks; the find() over a small list is cheap.
  const latestWeightRow = growthsLatest.data?.find((g) => g.weight_g != null);
  const latestWeightG =
    latestWeightRow?.weight_g != null ? Number(latestWeightRow.weight_g) : null;

  // Targets are gated by both the user pref AND the baby having a DoB.
  // When either is unsatisfied, the banner renders cells without
  // progress bars — visually cleaner than a long row of empty bars.
  const targets: DailyTargets | null = prefs.show_recommended_targets
    ? getDailyTargets(baby, now)
    : null;
  // "Last fed" combines bottle feeds and *completed* nursing sessions.
  // An open nursing session is rendered as "Nursing now" with higher
  // priority in TodayBanner, so we exclude open sessions here to avoid
  // double-counting.
  const lastFedAt = lastEventAt([
    ...(feeds.data ?? []),
    ...((nursings.data ?? []).filter((n) => n.ended_at != null)),
  ]);
  const lastDiaperAt = lastEventAt(diapers.data ?? []);

  const recent = mergeRecent({
    bottleFeeds: feeds.data,
    diapers: diapers.data,
    pumpings: pumpings.data,
    nursings: nursings.data,
    growths: growthsToday.data,
  });

  return (
    <PageShell
      titleNode={
        allBabies.length > 1 ? (
          <BabySwitcher
            babies={allBabies}
            activeId={baby.id}
            onChange={setActiveBabyId}
          />
        ) : (
          <h1 className="text-2xl font-semibold">{baby.name}</h1>
        )
      }
      subtitle={user ? `Signed in as ${user.display_name}` : undefined}
      onSignOut={() => logout.mutate()}
      headerExtra={
        <div className="flex items-center gap-3">
          <SyncStatusBadge />
          <Link to="/charts" className="text-xs text-white/60 hover:text-white">
            Charts & history →
          </Link>
          <Link
            to="/settings"
            className="text-xs text-white/60 hover:text-white"
            aria-label="Settings"
            title="Settings"
          >
            ⚙︎
          </Link>
        </div>
      }
    >
      <TodayBanner
        totalMl={totalMl}
        pumpedMl={pumpedMl}
        nursingMin={nursingMin}
        diaperCount={diaperCount}
        latestWeightG={latestWeightG}
        lastFedAt={lastFedAt}
        lastDiaperAt={lastDiaperAt}
        openNursing={openNursing.data ?? null}
        now={now}
        sparkline={(sparkCharts.data?.days ?? []).map((d) => d.bottle_ml)}
        targets={targets}
        prefs={prefs}
      />

      <section className="grid grid-cols-3 gap-3">
        {isFeatureVisible(prefs.feature_visibility, "bottle") && (
          <Tile to="/log/bottle" babyId={baby.id} icon="🍼" label="Bottle" accent="peach" />
        )}
        {isFeatureVisible(prefs.feature_visibility, "nursing") &&
          (openNursing.data ? (
            <NursingInProgressTile
              session={openNursing.data}
              babyId={baby.id}
              prefs={prefs}
            />
          ) : (
            <Tile to="/log/nursing" babyId={baby.id} icon="👶" label="Nursing" accent="mint" />
          ))}
        {isFeatureVisible(prefs.feature_visibility, "pumping") && (
          <Tile to="/log/pumping" babyId={baby.id} icon="💧" label="Pumping" accent="sky" />
        )}
        {isFeatureVisible(prefs.feature_visibility, "diaper") && (
          <Tile to="/log/diaper" babyId={baby.id} icon="🧷" label="Diaper" accent="lemon" />
        )}
        {isFeatureVisible(prefs.feature_visibility, "growth") && (
          <Tile to="/log/growth" babyId={baby.id} icon="📏" label="Growth" accent="lilac" />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-white/70">Recent</h2>
          <span className="text-xs text-white/40">today</span>
        </div>
        {recent.length === 0 && (
          <p className="rounded-xl bg-bg-surface p-4 text-sm text-white/50">
            Nothing logged today yet. Tap a tile above to add one.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {recent.map((ev) => (
            <RecentRow
              key={`${ev.kind}-${ev.data.id}`}
              ev={ev}
              prefs={prefs}
              syncing={outbox.inflightKeys.has(ev.data.id)}
            />
          ))}
        </ul>
      </section>

      {/* Install-prompt banner is the single mount point in the app —
          deliberately placed at the bottom of Today so it doesn't push
          the tile grid below the fold on first paint, and so future
          edits to the header (e.g. CP5's baby switcher) merge cleanly
          without conflicting with this card. Auto-hides when installed
          or recently dismissed; see useInstallPrompt for the gating. */}
      <InstallPromptBanner />

      {caughtUpToast != null && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] z-40 mx-auto flex max-w-xs items-center justify-center"
        >
          <div className="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-4 py-1.5 text-xs font-medium text-emerald-100 shadow-lg">
            All caught up
          </div>
        </div>
      )}
    </PageShell>
  );
}

// --- tiles ---

type Accent = "peach" | "mint" | "sky" | "lemon" | "lilac";

const accentClass: Record<Accent, string> = {
  peach: "border-orange-300/20 bg-orange-300/5",
  mint: "border-emerald-300/20 bg-emerald-300/5",
  sky: "border-sky-300/20 bg-sky-300/5",
  lemon: "border-yellow-300/20 bg-yellow-300/5",
  lilac: "border-violet-300/20 bg-violet-300/5",
};

function Tile({
  to,
  babyId,
  icon,
  label,
  accent,
}: {
  to: string;
  babyId: string;
  icon: string;
  label: string;
  accent: Accent;
}) {
  return (
    <Link
      to={to}
      search={{ babyId }}
      className={
        "flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border p-3 text-center transition active:scale-95 " +
        accentClass[accent]
      }
    >
      <span className="text-3xl leading-none">{icon}</span>
      <span className="text-sm font-medium">{label}</span>
    </Link>
  );
}

// NursingInProgressTile replaces the standard Nursing tile while a
// session is open. Shows live HH:MM elapsed (recomputed every 30s — the
// chip floors to whole minutes so a 1s tick would just be wasted
// renders) and exposes "End now" which opens an inline modal for
// per-side minutes. Kept inline in this file to keep the Today edit
// surgical for the parallel chart-link merge.
function NursingInProgressTile({
  session,
  babyId,
  prefs,
}: {
  session: Nursing;
  babyId: string;
  prefs: CombinedPreferences;
}) {
  const [now, setNow] = useState(() => new Date());
  const [showEnd, setShowEnd] = useState(false);

  useEffect(() => {
    // 30s tick: matches the formatter's whole-minute resolution. Anything
    // faster is wasted renders; anything slower and the elapsed value
    // visibly lags reality on the lock screen / when the user opens the
    // PWA after a few minutes.
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = formatElapsedHHMM(session.started_at, now);

  return (
    <>
      <div
        className={
          "flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl border p-3 text-center " +
          accentClass.mint
        }
      >
        <span className="text-[10px] uppercase tracking-wide text-white/50">Nursing</span>
        <span className="text-2xl font-semibold tabular-nums leading-tight">{elapsed}</span>
        <span className="text-[10px] text-white/50">in progress</span>
        <button
          type="button"
          onClick={() => setShowEnd(true)}
          className="mt-1 rounded-full bg-emerald-300/20 px-3 py-1 text-xs font-medium text-emerald-200 transition active:scale-95"
        >
          End now
        </button>
      </div>
      {showEnd && (
        <EndNursingModal
          session={session}
          babyId={babyId}
          now={now}
          prefs={prefs}
          onClose={() => setShowEnd(false)}
        />
      )}
    </>
  );
}

function EndNursingModal({
  session,
  babyId,
  now,
  prefs,
  onClose,
}: {
  session: Nursing;
  babyId: string;
  now: Date;
  prefs: CombinedPreferences;
  onClose: () => void;
}) {
  useEscapeKey(onClose);
  // Default each side to half the elapsed minutes when nursing both
  // sides; otherwise put the full elapsed time on the active side. The
  // user can override; this just removes the "blank input" friction for
  // the common case.
  const elapsedMin = Math.max(
    0,
    Math.floor((now.getTime() - new Date(session.started_at).getTime()) / 60_000),
  );
  const defaults = useMemo(() => {
    if (session.nursing_side === "left") return { left: String(elapsedMin), right: "0" };
    if (session.nursing_side === "right") return { left: "0", right: String(elapsedMin) };
    const half = Math.floor(elapsedMin / 2);
    return { left: String(half), right: String(elapsedMin - half) };
  }, [session.nursing_side, elapsedMin]);

  const [leftMin, setLeftMin] = useState(defaults.left);
  const [rightMin, setRightMin] = useState(defaults.right);
  const end = useEndNursing();

  const leftN = Number.parseFloat(leftMin);
  const rightN = Number.parseFloat(rightMin);
  const isValid =
    Number.isFinite(leftN) &&
    leftN >= 0 &&
    leftN <= 360 &&
    Number.isFinite(rightN) &&
    rightN >= 0 &&
    rightN <= 360;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    end.mutate(
      {
        id: session.id,
        babyId,
        ended_at: new Date().toISOString(),
        left_duration_s: Math.round(leftN * 60),
        right_duration_s: Math.round(rightN * 60),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center">
      <form
        onSubmit={onSubmit}
        onKeyDown={submitOnEnter}
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-bg-surface p-5 shadow-xl"
      >
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">End nursing</h2>
          <button type="button" onClick={onClose} className="text-sm text-white/60">
            Cancel
          </button>
        </div>
        <p className="mb-4 text-xs text-white/50">
          Started {formatTime(session.started_at, prefs.time_format)} · {formatElapsedHHMM(session.started_at, now)} elapsed
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-white/50">
            Left
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={360}
              step={1}
              value={leftMin}
              onChange={(e) => setLeftMin(e.target.value)}
              className="rounded-xl bg-bg-subtle px-3 py-2 text-2xl font-semibold tabular-nums text-white outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-white/50">
            Right
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={360}
              step={1}
              value={rightMin}
              onChange={(e) => setRightMin(e.target.value)}
              className="rounded-xl bg-bg-subtle px-3 py-2 text-2xl font-semibold tabular-nums text-white outline-none focus:ring-2 focus:ring-accent"
            />
          </label>
        </div>
        {end.isError && (
          <p className="mt-3 text-sm text-red-400">{end.error?.message ?? "could not save"}</p>
        )}
        <button
          type="submit"
          disabled={!isValid || end.isPending}
          className="btn-primary mt-4 w-full text-base"
        >
          {end.isPending ? "Saving…" : "Confirm end"}
        </button>
      </form>
    </div>
  );
}

// TodayBanner replaces the old square 6th-cell SummaryTile with a wider
// infographic that:
//   - leads with a glanceable "Fed Xh Ym ago" headline (or "Nursing
//     now · 12m" when a session is open, taking priority over last-fed)
//   - shows a thin 7-day sparkline of bottle ml in the top-right
//   - renders 5 inline stat cells (one per activity) with optional
//     progress bars vs. age-based daily targets when both
//     `prefs.show_recommended_targets` is on AND the baby has a DoB.
// Bars are clamped at 100% — overflow days don't shout, they just sit
// at full bar. Growth has no daily total, so its cell shows the latest
// weight with no bar regardless of settings.
function TodayBanner({
  totalMl,
  pumpedMl,
  nursingMin,
  diaperCount,
  latestWeightG,
  lastFedAt,
  lastDiaperAt,
  openNursing,
  now,
  sparkline,
  targets,
  prefs,
}: {
  totalMl: number;
  pumpedMl: number;
  nursingMin: number;
  diaperCount: number;
  latestWeightG: number | null;
  lastFedAt: string | null;
  lastDiaperAt: string | null;
  openNursing: Nursing | null;
  now: Date;
  sparkline: number[];
  targets: DailyTargets | null;
  prefs: CombinedPreferences;
}) {
  const nursingInProgressFor = openNursing
    ? formatElapsedHHMM(openNursing.started_at, now)
    : null;

  return (
    <section className="rounded-2xl border border-white/10 bg-bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Today</span>
          {nursingInProgressFor ? (
            <div className="mt-1 text-lg font-semibold leading-tight">
              Nursing now
              <span className="ml-2 text-sm font-normal tabular-nums text-emerald-300">
                · {nursingInProgressFor}
              </span>
            </div>
          ) : lastFedAt ? (
            <div className="mt-1 text-lg font-semibold leading-tight">
              Fed {formatTimeSince(lastFedAt, now)}
              {totalMl > 0 && (
                <span className="ml-2 text-sm font-normal text-white/60">
                  · {formatVolume(totalMl, prefs.unit_volume)}
                </span>
              )}
            </div>
          ) : (
            <div className="mt-1 text-lg font-semibold leading-tight text-white/60">
              No feeds yet today
            </div>
          )}
          {lastDiaperAt && (
            <div className="text-xs text-white/60">
              Last diaper {formatTimeSince(lastDiaperAt, now)}
            </div>
          )}
        </div>
        <Sparkline values={sparkline} />
      </div>

      <BannerStatRow
        prefs={prefs}
        totalMl={totalMl}
        nursingMin={nursingMin}
        pumpedMl={pumpedMl}
        diaperCount={diaperCount}
        latestWeightG={latestWeightG}
        targets={targets}
      />
    </section>
  );
}

// BannerStatRow renders the row of inline stats below the banner headline.
// Each cell is gated by feature_visibility; the grid template is computed
// from the visible-cell count so 3 visible features fill the row at 1/3
// each rather than leaving empty grid tracks. When zero features are
// visible the whole row collapses (separator included) so the banner
// shrinks to just the "Last fed" headline + sparkline.
function BannerStatRow({
  prefs,
  totalMl,
  nursingMin,
  pumpedMl,
  diaperCount,
  latestWeightG,
  targets,
}: {
  prefs: CombinedPreferences;
  totalMl: number;
  nursingMin: number;
  pumpedMl: number;
  diaperCount: number;
  latestWeightG: number | null;
  targets: DailyTargets | null;
}) {
  const cells: React.ReactNode[] = [];
  if (isFeatureVisible(prefs.feature_visibility, "bottle")) {
    cells.push(
      <BannerStat
        key="bottle"
        icon="🍼"
        rendered={formatVolume(totalMl, prefs.unit_volume)}
        barFill={targets ? totalMl / targets.bottle_ml : null}
        barClass="bg-orange-300/70"
      />,
    );
  }
  if (isFeatureVisible(prefs.feature_visibility, "nursing")) {
    cells.push(
      <BannerStat
        key="nursing"
        icon="👶"
        valueLabel={String(nursingMin)}
        unitLabel="min"
        barFill={targets ? nursingMin / targets.nursing_min : null}
        barClass="bg-emerald-300/70"
      />,
    );
  }
  if (isFeatureVisible(prefs.feature_visibility, "pumping")) {
    cells.push(
      <BannerStat
        key="pumping"
        icon="💧"
        rendered={formatVolume(pumpedMl, prefs.unit_volume)}
        barFill={targets ? pumpedMl / targets.pumping_ml : null}
        barClass="bg-sky-300/70"
      />,
    );
  }
  if (isFeatureVisible(prefs.feature_visibility, "diaper")) {
    cells.push(
      <BannerStat
        key="diaper"
        icon="🧷"
        valueLabel={String(diaperCount)}
        barFill={targets ? diaperCount / targets.diapers : null}
        barClass="bg-yellow-300/70"
      />,
    );
  }
  if (isFeatureVisible(prefs.feature_visibility, "growth")) {
    cells.push(
      <BannerStat
        key="growth"
        icon="📏"
        rendered={
          latestWeightG != null ? formatWeight(latestWeightG, prefs.unit_weight) : "—"
        }
        // Growth doesn't have a daily total → no bar, ever.
        barFill={null}
        barClass=""
      />,
    );
  }
  if (cells.length === 0) return null;
  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${cells.length}, minmax(0, 1fr))`,
        }}
      >
        {cells}
      </div>
    </div>
  );
}

// BannerStat renders one of the five inline stat cells in TodayBanner.
// Accepts EITHER a pre-rendered "60 ml" string (unit-aware metrics) OR a
// plain value/unit pair (fixed-unit metrics like nursing minutes or
// diaper count). Same shape as the old SummaryRow but laid out
// vertically so the bar can sit beneath the value.
//
// barFill is in [0, ∞). null → no bar rendered (Growth, or targets off).
// Values >1 clamp visually at 100% so a 200% day doesn't push the bar
// off-cell or make smaller days look insignificant by comparison.
function BannerStat({
  icon,
  rendered,
  valueLabel,
  unitLabel,
  barFill,
  barClass,
}: {
  icon: string;
  rendered?: string;
  valueLabel?: string;
  unitLabel?: string;
  barFill: number | null;
  barClass: string;
}) {
  let head = valueLabel ?? "";
  let tail = unitLabel ?? "";
  if (rendered != null) {
    const parts = rendered.split(" ");
    head = parts[0];
    tail = parts.slice(1).join(" ");
  }
  const pct =
    barFill == null
      ? null
      : Math.max(0, Math.min(1, Number.isFinite(barFill) ? barFill : 0));
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex items-baseline gap-1">
        <span className="text-xs leading-none">{icon}</span>
        <span className="text-base font-semibold tabular-nums">{head}</span>
        {tail && <span className="text-[10px] text-white/60">{tail}</span>}
      </div>
      {pct != null && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full ${barClass}`}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}

// Sparkline draws a tiny 7-bar SVG of recent daily totals. The last bar
// is "today" and gets the accent fill; the others are dim. No axis or
// labels — it's a glance affordance, not an analytical chart (the full
// chart lives on /charts and is reachable via the header link).
function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) return <div className="w-20" aria-hidden />;
  const max = Math.max(0, ...values);
  const vbW = 70;
  const vbH = 28;
  const slot = vbW / values.length;
  const barWidth = slot * 0.6;
  const pad = (slot - barWidth) / 2;
  return (
    <svg
      viewBox={`0 0 ${vbW} ${vbH}`}
      className="h-7 w-20 shrink-0"
      role="img"
      aria-label={`7-day bottle intake sparkline (${values.length} day${values.length === 1 ? "" : "s"})`}
    >
      {values.map((v, i) => {
        const h = max === 0 ? 0 : Math.max(1, (v / max) * vbH);
        const isToday = i === values.length - 1;
        return (
          <rect
            key={i}
            x={i * slot + pad}
            y={vbH - h}
            width={barWidth}
            height={h}
            rx={1}
            className={isToday ? "fill-accent" : "fill-white/25"}
          />
        );
      })}
    </svg>
  );
}

function PageShell({
  title,
  titleNode,
  subtitle,
  onSignOut,
  headerExtra,
  children,
}: {
  title?: string;
  titleNode?: React.ReactNode;
  subtitle?: string;
  onSignOut?: () => void;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col gap-5 p-5 pb-12">
      <header className="flex items-start justify-between gap-3">
        <div>
          {titleNode ?? <h1 className="text-2xl font-semibold">{title}</h1>}
          {subtitle && <p className="text-xs text-white/50">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-4">
          {headerExtra}
          {onSignOut && (
            <button onClick={onSignOut} className="text-xs text-white/50 hover:text-white">
              Sign out
            </button>
          )}
        </div>
      </header>
      {children}
    </main>
  );
}

// BabySwitcher renders as a native <select> styled to read like a
// headline. Native select gets us correct mobile UX (sheet picker on
// iOS / drop-down on desktop) for free — a custom popover would be
// strictly worse on phones and we're shipping phone-first.
function BabySwitcher({
  babies,
  activeId,
  onChange,
}: {
  babies: Baby[];
  activeId: string;
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-baseline gap-2">
      <select
        value={activeId}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Active baby"
        className="bg-transparent text-2xl font-semibold text-white outline-none focus:ring-2 focus:ring-accent"
      >
        {babies.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <span aria-hidden className="text-xs text-white/40">▾</span>
    </label>
  );
}
