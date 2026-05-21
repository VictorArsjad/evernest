// Quick-log form for diapers. Three giant tap targets (wet / soiled / mixed),
// a "When" datetime defaulting to now, and an optional notes field. Same
// shape as the bottle log so the muscle memory carries over.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { useBabies, useCreateDiaper, useHouseholds } from "../lib/queries";
import type { DiaperType } from "../lib/types";

const search = z.object({
  babyId: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_app/log/diaper")({
  validateSearch: search,
  component: LogDiaperPage,
});

function nowLocalDatetimeInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  return new Date(local).toISOString();
}

function LogDiaperPage() {
  const nav = useNavigate();
  const { babyId: babyIdFromSearch } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const fallbackBabyId = babies.data?.[0]?.id ?? null;
  const babyId = babyIdFromSearch ?? fallbackBabyId;

  const [type, setType] = useState<DiaperType>("wet");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    const onFocus = () => setOccurredLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const create = useCreateDiaper();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId) return;
    create.mutate(
      {
        babyId,
        occurred_at: localToISO(occurredLocal),
        type,
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
        <h1 className="text-2xl font-semibold">Log diaper</h1>
        <button onClick={() => nav({ to: "/" })} className="text-sm text-white/60">
          Cancel
        </button>
      </header>

      <form onSubmit={onSubmit} className="card flex flex-col gap-5 p-5">
        <div>
          <span className="text-xs uppercase tracking-wide text-white/50">Type</span>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <TypeButton selected={type === "wet"} onClick={() => setType("wet")}>
              Wet
            </TypeButton>
            <TypeButton selected={type === "soiled"} onClick={() => setType("soiled")}>
              Soiled
            </TypeButton>
            <TypeButton selected={type === "mixed"} onClick={() => setType("mixed")}>
              Mixed
            </TypeButton>
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

        <button type="submit" className="btn-primary text-lg" disabled={create.isPending}>
          {create.isPending ? "Saving…" : "Save"}
        </button>
      </form>
    </main>
  );
}

function TypeButton({
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
        "rounded-xl border p-4 text-center text-base font-medium transition " +
        (selected
          ? "border-accent bg-accent/15 text-accent"
          : "border-white/10 bg-bg-subtle text-white/70 hover:border-white/20")
      }
    >
      {children}
    </button>
  );
}
