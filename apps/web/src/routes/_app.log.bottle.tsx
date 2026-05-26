// Quick-log form for bottle feeds. Defaults to "now" (24h local time) and
// uses big tap targets — designed for one-handed logging.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { useBabies, useCreateBottleFeed, useHouseholds } from "../lib/queries";
import { useActiveBaby } from "../lib/useActiveBaby";
import { displayVolumeToMl, volumeUnitLabel } from "../lib/units";
import { usePreferences } from "../lib/usePreferences";

const search = z.object({
  babyId: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_app/log/bottle")({
  validateSearch: search,
  component: LogBottlePage,
});

function nowLocalDatetimeInput(): string {
  // <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in LOCAL time.
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  // Browser parses "YYYY-MM-DDTHH:mm" as local; toISOString converts to UTC.
  return new Date(local).toISOString();
}

function LogBottlePage() {
  const nav = useNavigate();
  const { babyId: babyIdFromSearch } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  // Fall back to the user's active baby selection (persisted per household
  // in localStorage by useActiveBaby) when the form is opened directly
  // without a `?babyId=` search param, e.g. via a PWA shortcut.
  const { baby: activeBaby } = useActiveBaby(householdId, babies.data);
  const babyId = babyIdFromSearch ?? activeBaby?.id ?? null;

  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<"breast" | "formula">("formula");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  // Re-snap "now" if the page sat unsubmitted for a while.
  useEffect(() => {
    const onFocus = () => setOccurredLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const create = useCreateBottleFeed();
  const { prefs } = usePreferences(babyId);
  const volLabel = volumeUnitLabel(prefs.unit_volume);
  // Display-unit bounds: 2000 ml ≈ 67.6 oz. Same physical ceiling
  // either way; the canonical-ml clamp on submit re-applies the API
  // constraint so a partial-conversion edge can't sneak past.
  const maxDisplay = prefs.unit_volume === "oz" ? 70 : 2000;

  const amountNum = useMemo(() => Number.parseFloat(amount), [amount]);
  const isAmountValid =
    Number.isFinite(amountNum) && amountNum > 0 && amountNum <= maxDisplay;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId || !isAmountValid) return;
    const canonicalMl = displayVolumeToMl(amountNum, prefs.unit_volume);
    create.mutate(
      {
        babyId,
        occurred_at: localToISO(occurredLocal),
        milk_source: source,
        amount_ml: canonicalMl,
        notes: notes.trim() || undefined,
      },
      { onSuccess: () => nav({ to: "/" }) },
    );
  };

  if (!babyId) {
    return <p className="p-6 text-white/60">No baby selected.</p>;
  }

  return (
    <main className="flex flex-1 flex-col gap-4 p-5">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Log bottle feed</h1>
        <button onClick={() => nav({ to: "/" })} className="text-sm text-white/60">
          Cancel
        </button>
      </header>

      <form onSubmit={onSubmit} className="card flex flex-col gap-5 p-5">
        <div>
          <label className="text-xs uppercase tracking-wide text-white/50">Amount</label>
          <div className="mt-1 flex items-baseline gap-2">
            <input
              type="number"
              inputMode="decimal"
              autoFocus
              required
              min={prefs.unit_volume === "oz" ? 0.1 : 1}
              max={maxDisplay}
              step={prefs.unit_volume === "oz" ? 0.1 : 1}
              placeholder={prefs.unit_volume === "oz" ? "2" : "60"}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-xl bg-bg-subtle px-4 py-4 text-4xl font-semibold tabular-nums outline-none focus:ring-2 focus:ring-accent"
            />
            <span className="text-xl text-white/60">{volLabel}</span>
          </div>
        </div>

        <div>
          <span className="text-xs uppercase tracking-wide text-white/50">Source</span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <SourceButton selected={source === "breast"} onClick={() => setSource("breast")}>
              Expressed
              <span className="block text-xs font-normal text-white/50">breastmilk</span>
            </SourceButton>
            <SourceButton selected={source === "formula"} onClick={() => setSource("formula")}>
              Formula
            </SourceButton>
          </div>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          When
          <input
            type="datetime-local"
            required
            value={occurredLocal}
            onChange={(e) => setOccurredLocal(e.target.value)}
            className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Notes (optional)
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={200}
            placeholder="Anything to remember?"
            className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        {create.isError && (
          <p className="text-sm text-red-400">{create.error?.message ?? "could not save"}</p>
        )}

        <button
          type="submit"
          className="btn-primary text-lg"
          disabled={create.isPending || !isAmountValid}
        >
          {create.isPending ? "Saving…" : "Save"}
        </button>
      </form>
    </main>
  );
}

function SourceButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-xl border p-4 text-left text-base font-medium transition " +
        (selected
          ? "border-accent bg-accent/15 text-accent"
          : "border-white/10 bg-bg-subtle text-white/70 hover:border-white/20")
      }
    >
      {children}
    </button>
  );
}
