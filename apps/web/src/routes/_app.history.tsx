// History screen — past event logs grouped by local day, scoped to a
// 7d / 14d / 30d window. Sibling of /charts: charts are the "what
// totals look like" view; history is the "what individual events
// happened" view. Reuses the Today RecentRow card so a row looks the
// same wherever it shows up.
import { Link, createFileRoute } from "@tanstack/react-router";
import { format, isToday, isYesterday } from "date-fns";
import { useMemo, useState } from "react";

import { RecentRow } from "../components/RecentRow";
import { groupByLocalDay, type DayGroup } from "../lib/groupByDay";
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
import { useAuthStore } from "../lib/authStore";
import { useActiveBaby } from "../lib/useActiveBaby";
import { formatVolume } from "../lib/units";
import { type CombinedPreferences, usePreferences } from "../lib/usePreferences";

type WindowDays = 7 | 14 | 30;

const RANGES: { value: WindowDays; label: string }[] = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
];

// Pin the browser tz at module init for the same reason as Charts —
// reading on every render would invalidate query keys derived from it.
const BROWSER_TZ =
  (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";

// Hooks for History deliberately bypass the live-poll defaults: past
// events don't change, and a 30-day window for an active baby blows
// past the BE's 200-row default cap. `limit: 1000` matches the BE
// max; `refetchInterval: false` shuts off the 15s/5min poll loops.
const HISTORY_HOOK_OPTS = { limit: 1000, refetchInterval: false } as const;

const MS_PER_DAY = 86_400_000;

export const Route = createFileRoute("/_app/history")({
  component: HistoryPage,
});

function HistoryPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();
  const [range, setRange] = useState<WindowDays>(7);
  // Per-day expand overrides. Absence of a key means "fall through to the
  // default", which is `idx === 0` (the newest group is open). Storing
  // overrides instead of an explicit expanded set lets switching range
  // (7d/14d/30d) preserve toggles without a reseed effect.
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({});

  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const { baby } = useActiveBaby(householdId, babies.data);

  const window = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const fromDate = new Date(start.getTime() - (range - 1) * MS_PER_DAY);
    const toDate = new Date();
    toDate.setHours(23, 59, 59, 999);
    return { from: fromDate.toISOString(), to: toDate.toISOString(), fromDate, toDate };
  }, [range]);

  const babyId = baby?.id ?? null;
  const feeds = useBottleFeeds(babyId, window.from, window.to, HISTORY_HOOK_OPTS);
  const diapers = useDiapers(babyId, window.from, window.to, HISTORY_HOOK_OPTS);
  const pumpings = usePumpings(babyId, window.from, window.to, HISTORY_HOOK_OPTS);
  const nursings = useNursings(babyId, window.from, window.to, HISTORY_HOOK_OPTS);
  const growths = useGrowths(babyId, window.from, window.to, HISTORY_HOOK_OPTS);
  const { prefs } = usePreferences(babyId);

  if (households.isLoading || babies.isLoading) {
    return <PageShell title="History">Loading…</PageShell>;
  }
  if (!baby) {
    return <PageShell title="History">No baby selected.</PageShell>;
  }

  const recent = mergeRecent({
    bottleFeeds: feeds.data,
    diapers: diapers.data,
    pumpings: pumpings.data,
    nursings: nursings.data,
    growths: growths.data,
  });
  const groups = groupByLocalDay(recent);

  const anyLoading =
    feeds.isLoading ||
    diapers.isLoading ||
    pumpings.isLoading ||
    nursings.isLoading ||
    growths.isLoading;

  return (
    <PageShell
      title="History"
      subtitle={user ? `Signed in as ${user.display_name}` : undefined}
      onSignOut={() => logout.mutate()}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs text-white/60">
          {format(window.fromDate, "MMM d")} – {format(window.toDate, "MMM d")} · {BROWSER_TZ}
        </div>
        <SegmentedControl value={range} onChange={setRange} />
      </div>

      {anyLoading && groups.length === 0 ? (
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
                onToggle={() =>
                  setExpandOverrides((prev) => ({ ...prev, [g.dayKey]: !isExpanded }))
                }
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

function DaySection({
  group,
  prefs,
  isExpanded,
  onToggle,
}: {
  group: DayGroup;
  prefs: CombinedPreferences;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const heading = isToday(group.date)
    ? "Today"
    : isYesterday(group.date)
      ? "Yesterday"
      : format(group.date, "EEE, MMM d");
  const summary = formatDaySummary(group.events, prefs);
  const contentId = `history-day-${group.dayKey}`;
  return (
    <section className="flex flex-col gap-2">
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
    }
  }
  const parts: string[] = [];
  if (bottleMl > 0) parts.push(formatVolume(bottleMl, prefs.unit_volume));
  if (nursingMin > 0) parts.push(`${nursingMin} min nursing`);
  if (pumpedMl > 0) parts.push(`${formatVolume(pumpedMl, prefs.unit_volume)} pumped`);
  if (diaperCount > 0) parts.push(`${diaperCount} ${diaperCount === 1 ? "diaper" : "diapers"}`);
  if (growthCount > 0) parts.push(`${growthCount} growth`);
  return parts.join(" · ");
}

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
