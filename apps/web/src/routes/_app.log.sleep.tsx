// Quick-log form for sleep sessions. Two shapes: "Start now" submits an
// open session (no ended_at) which the Today screen later closes via the
// in-progress tile, and "Save" records a manual past interval ("fell
// asleep" + "woke up"). Nap/Night is an optional toggleable picker (tap
// the selected one again to deselect), and location/notes are optional.
//
// In edit mode (`?edit=<uuid>`):
//   - Only CLOSED sessions can be field-edited. If the row is still open
//     (ended_at IS NULL), we show an inline notice and disable Save —
//     the End-now modal on Today owns that transition. Delete remains
//     enabled so "I tapped Start sleep by accident" is still cleanable.
//   - The "Start now" button is hidden (no relogging while editing).
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import {
  useBabies,
  useCreateSleep,
  useDeleteSleep,
  useHouseholds,
  useUpdateSleep,
} from "../lib/queries";
import { useActiveBaby } from "../lib/useActiveBaby";
import { submitOnEnter } from "../lib/submitOnEnter";
import type { Sleep, SleepType } from "../lib/types";
import { useEscapeKey } from "../lib/useEscapeKey";
import { DeleteEntryButton } from "./_app.log.bottle";

const search = z.object({
  babyId: z.string().uuid().optional(),
  edit: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_app/log/sleep")({
  validateSearch: search,
  component: LogSleepPage,
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

function LogSleepPage() {
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
  const existing: Sleep | null = useMemo(() => {
    if (!editId || !babyId) return null;
    const lists = qc.getQueriesData<Sleep[] | undefined>({
      queryKey: ["babies", babyId, "sleeps"],
    }) as Array<[unknown, Sleep[] | undefined]>;
    return (
      lists.flatMap(([, list]) => list ?? []).find((r) => r.id === editId) ?? null
    );
  }, [qc, editId, babyId]);
  const editingOpenSession = isEditMode && existing != null && existing.ended_at == null;

  // null = no type picked (the field is optional; tap the selected chip
  // again to deselect it).
  const [sleepType, setSleepType] = useState<SleepType | null>(null);
  const [startedLocal, setStartedLocal] = useState(nowLocalDatetimeInput);
  const [endedLocal, setEndedLocal] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");

  const create = useCreateSleep();
  const update = useUpdateSleep();
  const del = useDeleteSleep();

  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!isEditMode || prefilledRef.current || !existing) return;
    setSleepType(existing.sleep_type ?? null);
    setStartedLocal(isoToLocalDatetimeInput(existing.started_at));
    setEndedLocal(existing.ended_at ? isoToLocalDatetimeInput(existing.ended_at) : "");
    setLocation(existing.location ?? "");
    setNotes(existing.notes ?? "");
    prefilledRef.current = true;
  }, [isEditMode, existing]);

  useEffect(() => {
    if (isEditMode) return;
    const onFocus = () => setStartedLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isEditMode]);

  // Manual save needs both times with ended > started; the interval-only
  // check keeps "Start now" (which ignores these fields' emptiness) apart.
  const intervalValid = useMemo(() => {
    if (endedLocal === "") return false;
    const start = new Date(startedLocal).getTime();
    const end = new Date(endedLocal).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && end > start;
  }, [startedLocal, endedLocal]);
  const isValid = intervalValid && !editingOpenSession;

  const pending = isEditMode ? update.isPending : create.isPending;
  const errorMsg = isEditMode ? update.error?.message : create.error?.message;
  const hadError = isEditMode ? update.isError : create.isError;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId || !isValid) return;
    const startedISO = localToISO(startedLocal);
    const endedISO = localToISO(endedLocal);
    if (isEditMode && editId) {
      update.mutate(
        {
          id: editId,
          babyId,
          started_at: startedISO,
          ended_at: endedISO,
          ...(sleepType ? { sleep_type: sleepType } : { clear_sleep_type: true }),
          location: location.trim(),
          notes: notes.trim(),
        },
        { onSuccess: () => nav({ to: "/" }) },
      );
      return;
    }
    create.mutate(
      {
        babyId,
        started_at: startedISO,
        ended_at: endedISO,
        sleep_type: sleepType ?? undefined,
        location: location.trim() || undefined,
        notes: notes.trim() || undefined,
      },
      { onSuccess: () => nav({ to: "/" }) },
    );
  };

  // Start now: submit an open session (no ended_at). Always uses the live
  // `now()` so the user doesn't have to round-trip through the datetime
  // input — the BE rejects multiple open sessions per baby, so the
  // failure mode is a clean 409 surfaced inline.
  const onStartNow = () => {
    if (!babyId) return;
    create.mutate(
      {
        babyId,
        started_at: new Date().toISOString(),
        sleep_type: sleepType ?? undefined,
        location: location.trim() || undefined,
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
          {isEditMode ? "Edit sleep" : "Log sleep"}
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
        {editingOpenSession && (
          <p className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-200">
            This sleep is still in progress. End it from the Today screen
            before editing its fields. Delete is still available below if
            you started it by mistake.
          </p>
        )}

        <div>
          <span className="text-xs uppercase tracking-wide text-white/50">
            Type (optional)
          </span>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <TypeButton
              selected={sleepType === "nap"}
              onClick={() => setSleepType((t) => (t === "nap" ? null : "nap"))}
            >
              Nap
            </TypeButton>
            <TypeButton
              selected={sleepType === "night"}
              onClick={() => setSleepType((t) => (t === "night" ? null : "night"))}
            >
              Night
            </TypeButton>
          </div>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Fell asleep
          <input
            type="datetime-local"
            required
            value={startedLocal}
            onChange={(e) => setStartedLocal(e.target.value)}
            className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Woke up {isEditMode ? "" : "(leave empty and tap Start now to track live)"}
          <input
            type="datetime-local"
            value={endedLocal}
            onChange={(e) => setEndedLocal(e.target.value)}
            className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Location (optional)
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={100}
            placeholder="Crib, stroller, arms…"
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

        {isEditMode ? (
          <button
            type="submit"
            className="btn-primary text-lg"
            disabled={pending || !isValid}
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {/* "Start now" comes first because it's the lower-friction path
                ("baby just fell asleep, close it later"), but Save stays the
                primary visual action so users entering a past interval don't
                accidentally open a live session. */}
            <button
              type="button"
              onClick={onStartNow}
              disabled={create.isPending}
              className="rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-base font-medium text-accent transition active:scale-95 disabled:opacity-50"
            >
              Start now
            </button>
            <button
              type="submit"
              className="btn-primary text-lg"
              disabled={create.isPending || !isValid}
            >
              {create.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        )}

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
