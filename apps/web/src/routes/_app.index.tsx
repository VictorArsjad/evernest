import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { format, isToday, parseISO } from "date-fns";

import { useAuthStore } from "../lib/authStore";
import { useBabies, useBottleFeeds, useHouseholds, useLogout } from "../lib/queries";

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

  // CP1 redirects to onboarding when the user has no household yet. Babies
  // without households is impossible (we always seed a settings row), but if
  // somehow a user lands with 0 babies in a household we re-route to onboarding
  // for the simpler "add a baby" flow too.
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

  if (households.isLoading || babies.isLoading) {
    return <PageShell title="…">Loading…</PageShell>;
  }
  if (!baby) {
    return <PageShell title="…">Setting up…</PageShell>;
  }

  const totalMl = feeds.data?.reduce((s, f) => s + Number(f.amount_ml), 0) ?? 0;

  return (
    <PageShell
      title={baby.name}
      subtitle={user ? `Signed in as ${user.display_name}` : undefined}
      onSignOut={() => logout.mutate()}
    >
      <div className="card flex flex-col gap-1 p-5">
        <span className="text-xs uppercase tracking-wide text-white/50">Today</span>
        <span className="text-3xl font-semibold">{totalMl} ml</span>
        <span className="text-xs text-white/50">
          across {feeds.data?.length ?? 0} bottle feed{(feeds.data?.length ?? 0) === 1 ? "" : "s"}
        </span>
      </div>

      <Link to="/log/bottle" className="btn-primary text-lg" search={{ babyId: baby.id }}>
        Log bottle feed
      </Link>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-white/70">Today's feeds</h2>
        {feeds.data && feeds.data.length === 0 && (
          <p className="rounded-xl bg-bg-surface p-4 text-sm text-white/50">
            No feeds logged today yet. Tap the button above to add one.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {feeds.data?.map((f) => {
            const occurred = parseISO(f.occurred_at);
            return (
              <li key={f.id} className="card flex items-center justify-between p-4">
                <div>
                  <div className="text-base font-medium">{Number(f.amount_ml)} ml</div>
                  <div className="text-xs text-white/50">
                    {f.milk_source === "breast" ? "Expressed breastmilk" : "Formula"}
                    {f.notes ? ` · ${f.notes}` : ""}
                  </div>
                </div>
                <div className="text-right text-sm tabular-nums text-white/70">
                  {format(occurred, "HH:mm")}
                  {!isToday(occurred) && (
                    <div className="text-xs text-white/40">{format(occurred, "MMM d")}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </PageShell>
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
    <main className="flex flex-1 flex-col gap-4 p-5 pb-12">
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
