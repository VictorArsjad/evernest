// Quick-log form for nursing sessions. Most form-heavy of the event kinds:
// side picker (left/right/both) gates whether one or two duration inputs
// show. "When" is the session START. End time is auto-computed from
// started_at + total duration when saving as a closed session; "Start
// now" submits an open session (no ended_at, no per-side durations) which
// the Today screen later closes via the in-progress chip.
//
// In edit mode (`?edit=<uuid>`):
//   - Only CLOSED sessions can be field-edited. If the row is still open
//     (ended_at IS NULL), we show an inline notice and disable Save —
//     the End-now modal on Today owns that transition. Delete remains
//     enabled so "I tapped Start nursing by accident" is still cleanable.
//   - The "Start now" button is hidden (no relogging while editing).
//   - The submit recomputes ended_at from started_at + total duration
//     just like the create path, so a duration tweak keeps the row
//     internally consistent.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import {
  useBabies,
  useCreateNursing,
  useDeleteNursing,
  useHouseholds,
  useUpdateNursing,
} from "../lib/queries";
import { useActiveBaby } from "../lib/useActiveBaby";
import type { Nursing, NursingSide, StartingBreast } from "../lib/types";
import { DeleteEntryButton } from "./_app.log.bottle";

const search = z.object({
  babyId: z.string().uuid().optional(),
  edit: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_app/log/nursing")({
  validateSearch: search,
  component: LogNursingPage,
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

function parseMinutes(raw: string): number {
  if (raw.trim() === "") return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function LogNursingPage() {
  const nav = useNavigate();
  const { babyId: babyIdFromSearch, edit: editId } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const { baby: activeBaby } = useActiveBaby(householdId, babies.data);
  const babyId = babyIdFromSearch ?? activeBaby?.id ?? null;

  const isEditMode = !!editId;
  const qc = useQueryClient();
  const existing: Nursing | null = useMemo(() => {
    if (!editId || !babyId) return null;
    const lists = qc.getQueriesData<Nursing[] | undefined>({
      queryKey: ["babies", babyId, "nursing-sessions"],
    }) as Array<[unknown, Nursing[] | undefined]>;
    return (
      lists.flatMap(([, list]) => list ?? []).find((r) => r.id === editId) ?? null
    );
  }, [qc, editId, babyId]);
  const editingOpenSession = isEditMode && existing != null && existing.ended_at == null;

  const [side, setSide] = useState<NursingSide>("both");
  // starting_breast only meaningful when both sides nursed.
  const [startingBreast, setStartingBreast] = useState<StartingBreast>("left");
  const [leftMin, setLeftMin] = useState("");
  const [rightMin, setRightMin] = useState("");
  const [startedLocal, setStartedLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  const create = useCreateNursing();
  const update = useUpdateNursing();
  const del = useDeleteNursing();

  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!isEditMode || prefilledRef.current || !existing) return;
    setSide(existing.nursing_side);
    if (existing.starting_breast) setStartingBreast(existing.starting_breast);
    setLeftMin(
      existing.left_duration_s > 0
        ? String(Math.round(existing.left_duration_s / 60))
        : "",
    );
    setRightMin(
      existing.right_duration_s > 0
        ? String(Math.round(existing.right_duration_s / 60))
        : "",
    );
    setStartedLocal(isoToLocalDatetimeInput(existing.started_at));
    setNotes(existing.notes ?? "");
    prefilledRef.current = true;
  }, [isEditMode, existing]);

  useEffect(() => {
    if (isEditMode) return;
    const onFocus = () => setStartedLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isEditMode]);

  const leftMinNum = useMemo(() => parseMinutes(leftMin), [leftMin]);
  const rightMinNum = useMemo(() => parseMinutes(rightMin), [rightMin]);
  const leftActive = side === "left" || side === "both";
  const rightActive = side === "right" || side === "both";
  const leftValid = !leftActive || (Number.isFinite(leftMinNum) && leftMinNum <= 360);
  const rightValid = !rightActive || (Number.isFinite(rightMinNum) && rightMinNum <= 360);
  const totalSeconds =
    (leftActive ? Math.round(leftMinNum * 60) : 0) +
    (rightActive ? Math.round(rightMinNum * 60) : 0);
  const isValid =
    leftValid && rightValid && totalSeconds > 0 && !editingOpenSession;

  const pending = isEditMode ? update.isPending : create.isPending;
  const errorMsg = isEditMode ? update.error?.message : create.error?.message;
  const hadError = isEditMode ? update.isError : create.isError;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId || !isValid) return;
    const startedISO = localToISO(startedLocal);
    const endedISO = new Date(new Date(startedISO).getTime() + totalSeconds * 1000).toISOString();
    if (isEditMode && editId) {
      update.mutate(
        {
          id: editId,
          babyId,
          started_at: startedISO,
          ended_at: endedISO,
          starting_breast: side === "both" ? startingBreast : (side as StartingBreast),
          nursing_side: side,
          left_duration_s: leftActive ? Math.round(leftMinNum * 60) : 0,
          right_duration_s: rightActive ? Math.round(rightMinNum * 60) : 0,
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
        starting_breast: side === "both" ? startingBreast : (side as StartingBreast),
        nursing_side: side,
        left_duration_s: leftActive ? Math.round(leftMinNum * 60) : 0,
        right_duration_s: rightActive ? Math.round(rightMinNum * 60) : 0,
        notes: notes.trim() || undefined,
      },
      { onSuccess: () => nav({ to: "/" }) },
    );
  };

  // Start now: submit an open session (no ended_at, no per-side durations).
  // Always uses the live `now()` so the user doesn't have to round-trip
  // through the datetime input — the BE rejects multiple open sessions
  // per baby, so the failure mode is a clean 409 surfaced inline rather
  // than an inconsistent state.
  const onStartNow = () => {
    if (!babyId) return;
    create.mutate(
      {
        babyId,
        started_at: new Date().toISOString(),
        nursing_side: side,
        starting_breast: side === "both" ? startingBreast : undefined,
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
          {isEditMode ? "Edit nursing" : "Log nursing"}
        </h1>
        <button onClick={() => nav({ to: "/" })} className="text-sm text-white/60">
          Cancel
        </button>
      </header>

      <form onSubmit={onSubmit} className="card flex flex-col gap-5 p-5">
        {editingOpenSession && (
          <p className="rounded-xl border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-xs text-amber-200">
            This session is still in progress. End it from the Today screen
            before editing its fields. Delete is still available below if
            you started it by mistake.
          </p>
        )}

        <div>
          <span className="text-xs uppercase tracking-wide text-white/50">Side</span>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <SideButton selected={side === "left"} onClick={() => setSide("left")}>
              Left
            </SideButton>
            <SideButton selected={side === "right"} onClick={() => setSide("right")}>
              Right
            </SideButton>
            <SideButton selected={side === "both"} onClick={() => setSide("both")}>
              Both
            </SideButton>
          </div>
        </div>

        {side === "both" && (
          <div>
            <span className="text-xs uppercase tracking-wide text-white/50">Started on</span>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <SideButton
                selected={startingBreast === "left"}
                onClick={() => setStartingBreast("left")}
              >
                Left first
              </SideButton>
              <SideButton
                selected={startingBreast === "right"}
                onClick={() => setStartingBreast("right")}
              >
                Right first
              </SideButton>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          {leftActive && (
            <DurationInput
              label="Left"
              value={leftMin}
              onChange={setLeftMin}
              autoFocus={!isEditMode && (side === "left" || side === "both")}
            />
          )}
          {rightActive && (
            <DurationInput
              label="Right"
              value={rightMin}
              onChange={setRightMin}
              autoFocus={!isEditMode && side === "right"}
            />
          )}
        </div>

        <label className="flex flex-col gap-1 text-sm">
          When started
          <input
            type="datetime-local"
            required
            value={startedLocal}
            onChange={(e) => setStartedLocal(e.target.value)}
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
                ("baby latched, fill out details later"), but Save stays the
                primary visual action so users who already have the durations
                don't accidentally drop them. */}
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

function SideButton({
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

function DurationInput({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wide text-white/50">{label}</label>
      <div className="mt-1 flex items-baseline gap-2">
        <input
          type="number"
          inputMode="decimal"
          autoFocus={autoFocus}
          min={0}
          max={360}
          step={1}
          placeholder="10"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl bg-bg-subtle px-4 py-3 text-3xl font-semibold tabular-nums outline-none focus:ring-2 focus:ring-accent"
        />
        <span className="text-base text-white/60">min</span>
      </div>
    </div>
  );
}
