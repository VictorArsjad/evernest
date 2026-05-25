// Today screen layout:
//   - 2x3 tile grid: 5 event kinds + a compact "Today" summary tile
//   - Unified recent-events list across all kinds, newest first
// Tiles for kinds that aren't shipped yet are visibly "Soon" placeholders
// rather than dead links, and get wired up as each kind lands.
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { format, isToday, parseISO } from "date-fns";

import { useAuthStore } from "../lib/authStore";
import {
  useBabies,
  useBottleFeeds,
  useDiapers,
  useGrowths,
  useHouseholds,
  useLogout,
  useNursings,
  usePumpings,
} from "../lib/queries";
import { mergeRecent, type RecentEvent } from "../lib/recentEvents";

export const Route = createFileRoute("/_app/")({
  component: TodayPage,
});

function TodayPage() {
  const nav = useNavigate();
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();

  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const baby = babies.data?.[0] ?? null;

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
      title={baby.name}
      subtitle={user ? `Signed in as ${user.display_name}` : undefined}
      onSignOut={() => logout.mutate()}
    >
      <section className="grid grid-cols-3 gap-3">
        <Tile to="/log/bottle" babyId={baby.id} icon="🍼" label="Bottle" accent="peach" />
        <Tile to="/log/nursing" babyId={baby.id} icon="👶" label="Nursing" accent="mint" />
        <Tile to="/log/pumping" babyId={baby.id} icon="💧" label="Pumping" accent="sky" />
        <Tile to="/log/diaper" babyId={baby.id} icon="🧷" label="Diaper" accent="lemon" />
        <Tile to="/log/growth" babyId={baby.id} icon="📏" label="Growth" accent="lilac" />
        <SummaryTile
          totalMl={totalMl}
          pumpedMl={pumpedMl}
          nursingMin={nursingMin}
          diaperCount={diaperCount}
          latestWeightG={latestWeightG}
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
            <RecentRow key={`${ev.kind}-${ev.data.id}`} ev={ev} />
          ))}
        </ul>
      </section>
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

function SummaryTile({
  totalMl,
  pumpedMl,
  nursingMin,
  diaperCount,
  latestWeightG,
}: {
  totalMl: number;
  pumpedMl: number;
  nursingMin: number;
  diaperCount: number;
  latestWeightG: number | null;
}) {
  // The first four rows are "today" totals; weight is the latest reading
  // ever (growth measurements are infrequent — a daily total would mostly
  // be 0). It piggy-backs on the same tile so we don't blow out the 2x3
  // grid for a one-row stat.
  return (
    <div className="flex aspect-square flex-col items-start justify-center gap-[2px] rounded-2xl border border-white/10 bg-bg-surface p-3">
      <span className="text-[10px] uppercase tracking-wide text-white/40">Today</span>
      <SummaryRow icon="🍼" value={totalMl} unit="ml" />
      <SummaryRow icon="👶" value={nursingMin} unit="min" />
      <SummaryRow icon="💧" value={pumpedMl} unit="ml" />
      <SummaryRow icon="🧷" value={diaperCount} unit="" />
      <SummaryRow
        icon="📏"
        value={latestWeightG != null ? formatWeight(latestWeightG) : "—"}
        unit={latestWeightG != null ? (latestWeightG >= 1000 ? "kg" : "g") : ""}
      />
    </div>
  );
}

function formatWeight(g: number): string {
  // 1 decimal for kg ranges (>= 1000g) — the precision below that is
  // noise on the summary tile. Below 1kg (extreme preemies, rare in
  // practice for this tracker) we show whole grams.
  return g >= 1000 ? (g / 1000).toFixed(1) : Math.round(g).toString();
}

function growthSummary(g: {
  weight_g?: number | null;
  height_cm?: number | null;
  head_circumference_cm?: number | null;
}): string {
  // Compose the Recent-list label from whichever fields are present —
  // dropping NULL columns rather than rendering "0 kg / 0 cm" placeholders.
  const parts: string[] = [];
  if (g.weight_g != null) {
    const w = Number(g.weight_g);
    parts.push(w >= 1000 ? `${(w / 1000).toFixed(2)} kg` : `${Math.round(w)} g`);
  }
  if (g.height_cm != null) parts.push(`${Number(g.height_cm)} cm`);
  if (g.head_circumference_cm != null) parts.push(`${Number(g.head_circumference_cm)} cm head`);
  return parts.length > 0 ? parts.join(" · ") : "Measurement";
}

function SummaryRow({ icon, value, unit }: { icon: string; value: number | string; unit: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-xs leading-none">{icon}</span>
      <span className="text-base font-semibold tabular-nums">{value}</span>
      {unit && <span className="text-[10px] text-white/60">{unit}</span>}
    </div>
  );
}

// --- recent list ---

function RecentRow({ ev }: { ev: RecentEvent }) {
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
        <span className="text-sm tabular-nums text-white/60 w-12">{format(at, "HH:mm")}</span>
      </div>
      <div className="min-w-0 flex-1">
        {ev.kind === "bottle" && (
          <>
            <div className="text-base font-medium">
              {Number(ev.data.amount_ml)} ml
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
              {Number(ev.data.amount_ml)} ml pumped
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
            <div className="text-base font-medium">
              {growthSummary(ev.data)}
            </div>
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
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          {subtitle && <p className="text-xs text-white/50">{subtitle}</p>}
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
