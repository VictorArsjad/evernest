// Quick-log form for pumping sessions. Required: volume in ml. Optional:
// duration in minutes (UI minutes -> stored as duration_seconds). Default
// "When" is now; same focus-restamp behaviour as the other log forms.
// In edit mode (`?edit=<uuid>`) the form patches an existing row and
// exposes a Delete button for accidental double-logs.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import {
  useBabies,
  useCreatePumping,
  useDeletePumping,
  useHouseholds,
  useUpdatePumping,
} from "../lib/queries";
import { submitOnEnter } from "../lib/submitOnEnter";
import { useActiveBaby } from "../lib/useActiveBaby";
import type { Pumping } from "../lib/types";
import {
  displayVolumeToMl,
  mlToDisplayVolume,
  volumeUnitLabel,
} from "../lib/units";
import { useEscapeKey } from "../lib/useEscapeKey";
import { usePreferences } from "../lib/usePreferences";
import { DeleteEntryButton } from "./_app.log.bottle";

const search = z.object({
  babyId: z.string().uuid().optional(),
  edit: z.string().uuid().optional(),
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

function isoToLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  return new Date(local).toISOString();
}

function LogPumpingPage() {
  const nav = useNavigate();
  useEscapeKey(() => nav({ to: "/" }));
  const { babyId: babyIdFromSearch, edit: editId } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const { baby: activeBaby } = useActiveBaby(householdId, babies.data);
  const babyId = babyIdFromSearch ?? activeBaby?.id ?? null;

  const isEditMode = !!editId;
  const qc = useQueryClient();
  const existing: Pumping | null = useMemo(() => {
    if (!editId || !babyId) return null;
    const lists = qc.getQueriesData<Pumping[] | undefined>({
      queryKey: ["babies", babyId, "pumpings"],
    }) as Array<[unknown, Pumping[] | undefined]>;
    return (
      lists.flatMap(([, list]) => list ?? []).find((r) => r.id === editId) ?? null
    );
  }, [qc, editId, babyId]);

  const [amount, setAmount] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  const create = useCreatePumping();
  const update = useUpdatePumping();
  const del = useDeletePumping();
  const { prefs } = usePreferences(babyId);
  const volLabel = volumeUnitLabel(prefs.unit_volume);
  const maxDisplay = prefs.unit_volume === "oz" ? 70 : 2000;

  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!isEditMode || prefilledRef.current || !existing) return;
    setAmount(String(mlToDisplayVolume(Number(existing.amount_ml), prefs.unit_volume)));
    setDurationMin(
      existing.duration_seconds != null
        ? String(Math.round(Number(existing.duration_seconds) / 60))
        : "",
    );
    setOccurredLocal(isoToLocalDatetimeInput(existing.occurred_at));
    setNotes(existing.notes ?? "");
    prefilledRef.current = true;
  }, [isEditMode, existing, prefs.unit_volume]);

  useEffect(() => {
    if (isEditMode) return;
    const onFocus = () => setOccurredLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isEditMode]);

  const amountNum = useMemo(() => Number.parseFloat(amount), [amount]);
  const isAmountValid =
    Number.isFinite(amountNum) && amountNum >= 0 && amountNum <= maxDisplay;
  const durationMinNum = useMemo(() => Number.parseFloat(durationMin), [durationMin]);
  const isDurationValid =
    durationMin === "" || (Number.isFinite(durationMinNum) && durationMinNum >= 0 && durationMinNum <= 360);

  const pending = isEditMode ? update.isPending : create.isPending;
  const errorMsg = isEditMode ? update.error?.message : create.error?.message;
  const hadError = isEditMode ? update.isError : create.isError;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId || !isAmountValid || !isDurationValid) return;
    const amount_ml = displayVolumeToMl(amountNum, prefs.unit_volume);
    const duration_seconds =
      durationMin === "" ? undefined : Math.round(durationMinNum * 60);
    if (isEditMode && editId) {
      update.mutate(
        {
          id: editId,
          babyId,
          occurred_at: localToISO(occurredLocal),
          amount_ml,
          duration_seconds,
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
        amount_ml,
        duration_seconds,
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
          {isEditMode ? "Edit pumping" : "Log pumping"}
        </h1>
        <button onClick={() => nav({ to: "/" })} className="text-sm text-white/60">
          Cancel
        </button>
      </header>

      <form
        onSubmit={onSubmit}
        onKeyDown={submitOnEnter}
        className="card flex flex-col gap-5 p-5"
      >
        <div>
          <label className="text-xs uppercase tracking-wide text-white/50">Amount expressed</label>
          <div className="mt-1 flex items-baseline gap-2">
            <input
              type="number"
              inputMode="decimal"
              autoFocus
              required
              min={0}
              max={maxDisplay}
              step={prefs.unit_volume === "oz" ? 0.1 : 1}
              placeholder={prefs.unit_volume === "oz" ? "3" : "80"}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-xl bg-bg-subtle px-4 py-4 text-4xl font-semibold tabular-nums outline-none focus:ring-2 focus:ring-accent"
            />
            <span className="text-xl text-white/60">{volLabel}</span>
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

        {hadError && (
          <p className="text-sm text-red-400">{errorMsg ?? "could not save"}</p>
        )}

        <button
          type="submit"
          className="btn-primary text-lg"
          disabled={pending || !isAmountValid || !isDurationValid}
        >
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
