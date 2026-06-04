// Quick-log form for diapers. Three giant tap targets (wet / soiled / mixed),
// a "When" datetime defaulting to now, and an optional notes field. Same
// shape as the bottle log so the muscle memory carries over. In edit mode
// (`?edit=<uuid>`) the form patches an existing row and exposes a Delete
// button for accidental double-logs.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import {
  useBabies,
  useCreateDiaper,
  useDeleteDiaper,
  useHouseholds,
  useUpdateDiaper,
} from "../lib/queries";
import { useActiveBaby } from "../lib/useActiveBaby";
import type { Diaper, DiaperType } from "../lib/types";
import { DeleteEntryButton } from "./_app.log.bottle";

const search = z.object({
  babyId: z.string().uuid().optional(),
  edit: z.string().uuid().optional(),
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

function isoToLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  return new Date(local).toISOString();
}

function LogDiaperPage() {
  const nav = useNavigate();
  const { babyId: babyIdFromSearch, edit: editId } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const { baby: activeBaby } = useActiveBaby(householdId, babies.data);
  const babyId = babyIdFromSearch ?? activeBaby?.id ?? null;

  const isEditMode = !!editId;
  const qc = useQueryClient();
  const existing: Diaper | null = useMemo(() => {
    if (!editId || !babyId) return null;
    const lists = qc.getQueriesData<Diaper[] | undefined>({
      queryKey: ["babies", babyId, "diapers"],
    }) as Array<[unknown, Diaper[] | undefined]>;
    return (
      lists.flatMap(([, list]) => list ?? []).find((r) => r.id === editId) ?? null
    );
  }, [qc, editId, babyId]);

  const [type, setType] = useState<DiaperType>("wet");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  const create = useCreateDiaper();
  const update = useUpdateDiaper();
  const del = useDeleteDiaper();

  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!isEditMode || prefilledRef.current || !existing) return;
    setType(existing.type);
    setOccurredLocal(isoToLocalDatetimeInput(existing.occurred_at));
    setNotes(existing.notes ?? "");
    prefilledRef.current = true;
  }, [isEditMode, existing]);

  useEffect(() => {
    if (isEditMode) return;
    const onFocus = () => setOccurredLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isEditMode]);

  const pending = isEditMode ? update.isPending : create.isPending;
  const errorMsg = isEditMode ? update.error?.message : create.error?.message;
  const hadError = isEditMode ? update.isError : create.isError;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId) return;
    if (isEditMode && editId) {
      update.mutate(
        {
          id: editId,
          babyId,
          occurred_at: localToISO(occurredLocal),
          type,
          notes: notes.trim(),
        },
        { onSuccess: () => nav({ to: "/" }) },
      );
      return;
    }
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
        <h1 className="text-2xl font-semibold">
          {isEditMode ? "Edit diaper" : "Log diaper"}
        </h1>
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

        {hadError && (
          <p className="text-sm text-red-400">{errorMsg ?? "could not save"}</p>
        )}

        <button type="submit" className="btn-primary text-lg" disabled={pending}>
          {pending ? "Saving…" : isEditMode ? "Save changes" : "Save"}
        </button>

        {isEditMode && editId && (
          <DeleteEntryButton
            pending={del.isPending}
            onConfirm={() =>
              del.mutate(
                { id: editId, babyId },
                { onSuccess: () => nav({ to: "/" }) },
              )
            }
          />
        )}
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
