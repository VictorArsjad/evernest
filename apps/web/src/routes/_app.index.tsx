// Today screen layout:
//   - 2x3 tile grid: 5 event kinds + a compact "Today" summary tile
//   - Unified recent-events list across all kinds, newest first
// Tiles for kinds that aren't shipped yet are visibly "Soon" placeholders
// rather than dead links, and get wired up as each kind lands.
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { format, isToday, parseISO } from "date-fns";

import { InstallPromptBanner } from "../components/InstallPromptBanner";
import { useAuthStore } from "../lib/authStore";
import { formatElapsedHHMM } from "../lib/nursingTimer";
import {
  useBabies,
  useBottleFeeds,
  useDiapers,
  useEndNursing,
  useGrowths,
  useHouseholds,
  useLogout,
  useNursings,
  useOpenNursing,
  usePumpings,
} from "../lib/queries";
import { mergeRecent, type RecentEvent } from "../lib/recentEvents";
import type { Baby, Nursing } from "../lib/types";
import { useActiveBaby } from "../lib/useActiveBaby";
import {
  formatLength,
  formatTime,
  formatVolume,
  formatWeight,
} from "../lib/units";
import { type CombinedPreferences, usePreferences } from "../lib/usePreferences";

export const Route = createFileRoute("/_app/")({
  component: TodayPage,
});

function TodayPage() {
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();

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
  // Latest measurement ever — fed into the summary tile. The default
  // server-side window for growths covers the past year, which is plenty
  // for "most-recent weight" since the rows return DESC by measured_at.
  const growthsLatest = useGrowths(baby?.id ?? null);

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
          <Link to="/charts" className="text-xs text-white/60 hover:text-white">
            View charts →
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
      <section className="grid grid-cols-3 gap-3">
        <Tile to="/log/bottle" babyId={baby.id} icon="🍼" label="Bottle" accent="peach" />
        {openNursing.data ? (
          <NursingInProgressTile
            session={openNursing.data}
            babyId={baby.id}
            prefs={prefs}
          />
        ) : (
          <Tile to="/log/nursing" babyId={baby.id} icon="👶" label="Nursing" accent="mint" />
        )}
        <Tile to="/log/pumping" babyId={baby.id} icon="💧" label="Pumping" accent="sky" />
        <Tile to="/log/diaper" babyId={baby.id} icon="🧷" label="Diaper" accent="lemon" />
        <Tile to="/log/growth" babyId={baby.id} icon="📏" label="Growth" accent="lilac" />
        <SummaryTile
          totalMl={totalMl}
          pumpedMl={pumpedMl}
          nursingMin={nursingMin}
          diaperCount={diaperCount}
          latestWeightG={latestWeightG}
          prefs={prefs}
        />
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
            <RecentRow key={`${ev.kind}-${ev.data.id}`} ev={ev} prefs={prefs} />
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <form
        onSubmit={onSubmit}
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

function SummaryTile({
  totalMl,
  pumpedMl,
  nursingMin,
  diaperCount,
  latestWeightG,
  prefs,
}: {
  totalMl: number;
  pumpedMl: number;
  nursingMin: number;
  diaperCount: number;
  latestWeightG: number | null;
  prefs: CombinedPreferences;
}) {
  // The first four rows are "today" totals; weight is the latest reading
  // ever (growth measurements are infrequent — a daily total would mostly
  // be 0). It piggy-backs on the same tile so we don't blow out the 2x3
  // grid for a one-row stat. Volume + weight values respect the user's
  // chosen display unit; canonical math (sum of ml) happens upstream so
  // the formatter only has to convert + render.
  return (
    <div className="flex aspect-square flex-col items-start justify-center gap-[2px] rounded-2xl border border-white/10 bg-bg-surface p-3">
      <span className="text-[10px] uppercase tracking-wide text-white/40">Today</span>
      <SummaryRow icon="🍼" rendered={formatVolume(totalMl, prefs.unit_volume)} />
      <SummaryRow icon="👶" value={nursingMin} unit="min" />
      <SummaryRow icon="💧" rendered={formatVolume(pumpedMl, prefs.unit_volume)} />
      <SummaryRow icon="🧷" value={diaperCount} unit="" />
      <SummaryRow
        icon="📏"
        rendered={
          latestWeightG != null ? formatWeight(latestWeightG, prefs.unit_weight) : "—"
        }
      />
    </div>
  );
}

function growthSummary(
  g: {
    weight_g?: number | null;
    height_cm?: number | null;
    head_circumference_cm?: number | null;
  },
  prefs: CombinedPreferences,
): string {
  // Compose the Recent-list label from whichever fields are present —
  // dropping NULL columns rather than rendering "0 kg / 0 cm" placeholders.
  const parts: string[] = [];
  if (g.weight_g != null) {
    parts.push(formatWeight(Number(g.weight_g), prefs.unit_weight));
  }
  if (g.height_cm != null) {
    parts.push(formatLength(Number(g.height_cm), prefs.unit_length));
  }
  if (g.head_circumference_cm != null) {
    parts.push(`${formatLength(Number(g.head_circumference_cm), prefs.unit_length)} head`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Measurement";
}

// SummaryRow takes EITHER a pre-rendered string (e.g. "60 ml") via
// `rendered`, OR a value+unit pair for cases where the unit is fixed
// regardless of preferences (nursing minutes, diaper count). The two
// shapes share styling — single component keeps the tile vertical-rhythm
// pixel-stable when prefs flip.
function SummaryRow({
  icon,
  value,
  unit,
  rendered,
}: {
  icon: string;
  value?: number | string;
  unit?: string;
  rendered?: string;
}) {
  if (rendered != null) {
    const [head, ...rest] = rendered.split(" ");
    const tail = rest.join(" ");
    return (
      <div className="flex items-baseline gap-1">
        <span className="text-xs leading-none">{icon}</span>
        <span className="text-base font-semibold tabular-nums">{head}</span>
        {tail && <span className="text-[10px] text-white/60">{tail}</span>}
      </div>
    );
  }
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-xs leading-none">{icon}</span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
      {unit && <span className="text-[10px] text-white/60">{unit}</span>}
    </div>
  );
}

// --- recent list ---

function RecentRow({ ev, prefs }: { ev: RecentEvent; prefs: CombinedPreferences }) {
  const at = parseISO(ev.at);
  const icon =
    ev.kind === "bottle"
      ? "🍼"
      : ev.kind === "diaper"
        ? "🧷"
        : ev.kind === "pumping"
          ? "💧"
          : ev.kind === "growth"
            ? "📏"
            : "👶";
  return (
    <li className="card flex items-center gap-3 p-3">
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-2xl leading-none">{icon}</span>
        <span className="text-sm tabular-nums text-white/60 w-16">
          {formatTime(ev.at, prefs.time_format)}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        {ev.kind === "bottle" && (
          <>
            <div className="text-base font-medium">
              {formatVolume(Number(ev.data.amount_ml), prefs.unit_volume)}
              <span className="ml-2 text-xs font-normal text-white/50">
                {ev.data.milk_source === "breast" ? "expressed" : "formula"}
              </span>
            </div>
            {ev.data.notes && (
              <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
            )}
          </>
        )}
        {ev.kind === "diaper" && (
          <>
            <div className="text-base font-medium capitalize">{ev.data.type} diaper</div>
            {ev.data.notes && (
              <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
            )}
          </>
        )}
        {ev.kind === "pumping" && (
          <>
            <div className="text-base font-medium">
              {formatVolume(Number(ev.data.amount_ml), prefs.unit_volume)} pumped
              {ev.data.duration_seconds != null && (
                <span className="ml-2 text-xs font-normal text-white/50">
                  · {Math.round(ev.data.duration_seconds / 60)} min
                </span>
              )}
            </div>
            {ev.data.notes && (
              <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
            )}
          </>
        )}
        {ev.kind === "nursing" && (
          <>
            <div className="text-base font-medium">
              Nursed {Math.round((ev.data.left_duration_s + ev.data.right_duration_s) / 60)} min
              <span className="ml-2 text-xs font-normal capitalize text-white/50">
                · {ev.data.nursing_side}
              </span>
            </div>
            {ev.data.notes && (
              <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
            )}
          </>
        )}
        {ev.kind === "growth" && (
          <>
            <div className="text-base font-medium">{growthSummary(ev.data, prefs)}</div>
            {ev.data.notes && (
              <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
            )}
          </>
        )}
        {!isToday(at) && (
          <div className="text-xs text-white/40">{format(at, "MMM d")}</div>
        )}
      </div>
    </li>
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
