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
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { LogFormLayout } from "../components/LogFormLayout";
import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "../lib/datetime";
import {
  useCreateSleep,
  useDeleteSleep,
  useUpdateSleep,
} from "../lib/queries";
import { logSearchSchema, useLogForm, usePrefillOnce, useRestampOnFocus } from "../lib/logForm";
import type { SleepType } from "../lib/types";

export const Route = createFileRoute("/_app/log/sleep")({
  validateSearch: logSearchSchema,
  component: LogSleepPage,
});

function LogSleepPage() {
  const create = useCreateSleep();
  const update = useUpdateSleep();
  const del = useDeleteSleep();
  const form = useLogForm({
    segment: "sleeps",
    search: Route.useSearch(),
    create,
    update,
    del,
  });
  const { isEditMode, existing } = form;
  const editingOpenSession = isEditMode && existing != null && existing.ended_at == null;

  // null = no type picked (the field is optional; tap the selected chip
  // again to deselect it).
  const [sleepType, setSleepType] = useState<SleepType | null>(null);
  const [startedLocal, setStartedLocal] = useState(nowLocalDatetimeInput);
  const [endedLocal, setEndedLocal] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");

  usePrefillOnce(isEditMode, existing, (row) => {
    setSleepType(row.sleep_type ?? null);
    setStartedLocal(isoToLocalDatetimeInput(row.started_at));
    setEndedLocal(row.ended_at ? isoToLocalDatetimeInput(row.ended_at) : "");
    setLocation(row.location ?? "");
    setNotes(row.notes ?? "");
  });

  useRestampOnFocus(isEditMode, setStartedLocal);

  // Manual save needs both times with ended > started; the interval-only
  // check keeps "Start now" (which ignores these fields' emptiness) apart.
  const intervalValid = useMemo(() => {
    if (endedLocal === "") return false;
    const start = new Date(startedLocal).getTime();
    const end = new Date(endedLocal).getTime();
    return Number.isFinite(start) && Number.isFinite(end) && end > start;
  }, [startedLocal, endedLocal]);
  const isValid = intervalValid && !editingOpenSession;

  const onSubmit = () => {
    if (!isValid) return;
    const startedISO = localToISO(startedLocal);
    const endedISO = localToISO(endedLocal);
    form.save({
      create: {
        started_at: startedISO,
        ended_at: endedISO,
        sleep_type: sleepType ?? undefined,
        location: location.trim() || undefined,
        notes: notes.trim() || undefined,
      },
      update: {
        started_at: startedISO,
        ended_at: endedISO,
        ...(sleepType ? { sleep_type: sleepType } : { clear_sleep_type: true }),
        location: location.trim(),
        notes: notes.trim(),
      },
    });
  };

  // Start now: submit an open session (no ended_at) using the Fell asleep
  // field so backdating (baby fell asleep 20 min ago) is respected by the
  // Today elapsed timer. The BE rejects multiple open sessions per baby,
  // so the failure mode is a clean 409 surfaced inline.
  const onStartNow = () => {
    form.createAndExit({
      started_at: localToISO(startedLocal),
      sleep_type: sleepType ?? undefined,
      location: location.trim() || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <LogFormLayout
      form={form}
      createTitle="Log sleep"
      editTitle="Edit sleep"
      onSubmit={onSubmit}
      // Create mode replaces the Save button with Start now + Save. Edit mode
      // keeps the shell's default Save changes (gated on validity).
      {...(isEditMode
        ? { submitDisabled: !isValid }
        : {
            actions: (
          <div className="grid grid-cols-2 gap-2">
            {/* "Start now" comes first because it's the lower-friction path
                ("baby just fell asleep, close it later"), but Save stays the
                primary visual action so users entering a past interval don't
                accidentally open a live session. */}
            <button
              type="button"
              onClick={onStartNow}
              disabled={form.createPending}
              className="rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-base font-medium text-accent transition active:scale-95 disabled:opacity-50"
            >
              Start now
            </button>
            <button
              type="submit"
              className="btn-primary text-lg"
              disabled={form.createPending || !isValid}
            >
              {form.createPending ? "Saving…" : "Save"}
            </button>
          </div>
            ),
          })}
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
    </LogFormLayout>
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
