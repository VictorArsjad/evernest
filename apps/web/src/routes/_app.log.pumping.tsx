// Quick-log form for pumping sessions. Required: volume in ml. Optional:
// duration in minutes (UI minutes -> stored as duration_seconds). Default
// "When" is now; same focus-restamp behaviour as the other log forms.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { useBabies, useCreatePumping, useHouseholds } from "../lib/queries";

const search = z.object({
  babyId: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_app/log/pumping")({
  validateSearch: search,
  component: LogPumpingPage,
});

function nowLocalDatetimeInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  return new Date(local).toISOString();
}

function LogPumpingPage() {
  const nav = useNavigate();
  const { babyId: babyIdFromSearch } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const fallbackBabyId = babies.data?.[0]?.id ?? null;
  const babyId = babyIdFromSearch ?? fallbackBabyId;

  const [amount, setAmount] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    const onFocus = () => setOccurredLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const create = useCreatePumping();

  const amountNum = useMemo(() => Number.parseFloat(amount), [amount]);
  const isAmountValid = Number.isFinite(amountNum) && amountNum >= 0 && amountNum <= 2000;
  const durationMinNum = useMemo(() => Number.parseFloat(durationMin), [durationMin]);
  const isDurationValid =
    durationMin === "" || (Number.isFinite(durationMinNum) && durationMinNum >= 0 && durationMinNum <= 360);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId || !isAmountValid || !isDurationValid) return;
    create.mutate(
      {
        babyId,
        occurred_at: localToISO(occurredLocal),
        amount_ml: amountNum,
        duration_seconds:
          durationMin === "" ? undefined : Math.round(durationMinNum * 60),
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
        <h1 className="text-2xl font-semibold">Log pumping</h1>
        <button onClick={() => nav({ to: "/" })} className="text-sm text-white/60">
          Cancel
        </button>
      </header>

      <form onSubmit={onSubmit} className="card flex flex-col gap-5 p-5">
        <div>
          <label className="text-xs uppercase tracking-wide text-white/50">Amount expressed</label>
          <div className="mt-1 flex items-baseline gap-2">
            <input
              type="number"
              inputMode="decimal"
              autoFocus
              required
              min={0}
              max={2000}
              step={1}
              placeholder="80"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-xl bg-bg-subtle px-4 py-4 text-4xl font-semibold tabular-nums outline-none focus:ring-2 focus:ring-accent"
            />
            <span className="text-xl text-white/60">ml</span>
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-wide text-white/50">Duration (optional)</label>
          <div className="mt-1 flex items-baseline gap-2">
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={360}
              step={1}
              placeholder="15"
              value={durationMin}
              onChange={(e) => setDurationMin(e.target.value)}
              className="w-full rounded-xl bg-bg-subtle px-4 py-3 text-2xl font-medium tabular-nums outline-none focus:ring-2 focus:ring-accent"
            />
            <span className="text-base text-white/60">min</span>
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
          disabled={create.isPending || !isAmountValid || !isDurationValid}
        >
          {create.isPending ? "Saving…" : "Save"}
        </button>
      </form>
    </main>
  );
}
