// Quick-log form for bottle feeds. Defaults to "now" (24h local time) and
// uses big tap targets — designed for one-handed logging. In edit mode
// (`?edit=<uuid>`) the form is reused to update an existing row instead
// of creating a new one, with a Delete button at the bottom for the
// "logged this twice by mistake" case.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import {
  useBabies,
  useBottleFeeds,
  useCreateBottleFeed,
  useDeleteBottleFeed,
  useHouseholds,
  useUpdateBottleFeed,
} from "../lib/queries";
import { suggestBottleAmountMl, DEFAULT_WINDOW_DAYS } from "../lib/bottleDefault";
import type { BottleFeed } from "../lib/types";
import { useActiveBaby } from "../lib/useActiveBaby";
import {
  displayVolumeToMl,
  mlToDisplayVolume,
  volumeUnitLabel,
} from "../lib/units";
import { usePreferences } from "../lib/usePreferences";

const search = z.object({
  babyId: z.string().uuid().optional(),
  edit: z.string().uuid().optional(),
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

function isoToLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  // Browser parses "YYYY-MM-DDTHH:mm" as local; toISOString converts to UTC.
  return new Date(local).toISOString();
}

function LogBottlePage() {
  const nav = useNavigate();
  const { babyId: babyIdFromSearch, edit: editId } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  // Fall back to the user's active baby selection (persisted per household
  // in localStorage by useActiveBaby) when the form is opened directly
  // without a `?babyId=` search param, e.g. via a PWA shortcut.
  const { baby: activeBaby } = useActiveBaby(householdId, babies.data);
  const babyId = babyIdFromSearch ?? activeBaby?.id ?? null;

  const isEditMode = !!editId;

  // In edit mode, pull the row out of any cached bottle-feeds list so we
  // can prefill the form fields. Recent only shows today, so the cache is
  // warm in practice; for cold-cache deep links the user sees an empty
  // form and re-enters values (acceptable v1 trade-off — no extra GET).
  const qc = useQueryClient();
  const existing: BottleFeed | null = useMemo(() => {
    if (!editId || !babyId) return null;
    const lists = qc.getQueriesData<BottleFeed[] | undefined>({
      queryKey: ["babies", babyId, "bottle-feeds"],
    }) as Array<[unknown, BottleFeed[] | undefined]>;
    return (
      lists.flatMap(([, list]) => list ?? []).find((r) => r.id === editId) ?? null
    );
  }, [qc, editId, babyId]);

  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<"breast" | "formula">("formula");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  const create = useCreateBottleFeed();
  const update = useUpdateBottleFeed();
  const del = useDeleteBottleFeed();
  const { prefs, isLoading: prefsLoading } = usePreferences(babyId);
  const volLabel = volumeUnitLabel(prefs.unit_volume);

  // Recent feeds power the create-mode amount suggestion. Memoize the
  // lookback window once on mount so the query key stays stable across
  // re-renders (a fresh `now` each render would thrash the cache). The
  // GET is cheap and usually already warm from the Today screen.
  const recentWindow = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }, []);
  // Only the create flow needs the suggestion; skip the fetch entirely in
  // edit mode (where the form prefills from the existing row instead).
  const recentFeeds = useBottleFeeds(
    isEditMode ? null : babyId,
    recentWindow.from,
    recentWindow.to,
  );

  // suggestedDisplay is the autofill candidate already converted to the
  // baby's display unit (null when there's no usable history or autofill
  // is off). autofillApplied drives the "tap to clear" hint and is reset
  // the moment the user edits the field, so the hint only shows while the
  // value is still the untouched suggestion.
  const [autofillApplied, setAutofillApplied] = useState(false);
  const autofilledRef = useRef(false);
  const suggestedDisplay = useMemo(() => {
    if (!prefs.autofill_bottle_amount) return null;
    const ml = suggestBottleAmountMl(recentFeeds.data ?? [], new Date());
    if (ml == null) return null;
    return mlToDisplayVolume(ml, prefs.unit_volume);
  }, [prefs.autofill_bottle_amount, prefs.unit_volume, recentFeeds.data]);

  // Prefill once when the row arrives. Ref-guarded so a later cache
  // update (e.g. the user's own optimistic upsert after submit) doesn't
  // clobber in-progress typing.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!isEditMode || prefilledRef.current || !existing) return;
    setAmount(String(mlToDisplayVolume(Number(existing.amount_ml), prefs.unit_volume)));
    setSource(existing.milk_source);
    setOccurredLocal(isoToLocalDatetimeInput(existing.occurred_at));
    setNotes(existing.notes ?? "");
    prefilledRef.current = true;
  }, [isEditMode, existing, prefs.unit_volume]);

  // Re-snap "now" if the page sat unsubmitted for a while — but ONLY in
  // create mode. Restamping a user's deliberate edit would silently
  // overwrite the original timestamp.
  useEffect(() => {
    if (isEditMode) return;
    const onFocus = () => setOccurredLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isEditMode]);

  // Create-mode amount prefill: once preferences + recent feeds have
  // settled, seed the empty Amount field with the suggested value. Ref-
  // guarded so it fires at most once and never clobbers in-progress typing
  // (the guard also means clicking "Clear" sticks instead of re-filling).
  useEffect(() => {
    if (isEditMode || autofilledRef.current) return;
    if (prefsLoading || recentFeeds.isLoading) return;
    if (suggestedDisplay == null || amount !== "") return;
    setAmount(String(suggestedDisplay));
    setAutofillApplied(true);
    autofilledRef.current = true;
  }, [isEditMode, prefsLoading, recentFeeds.isLoading, suggestedDisplay, amount]);

  // Display-unit bounds: 2000 ml ≈ 67.6 oz. Same physical ceiling
  // either way; the canonical-ml clamp on submit re-applies the API
  // constraint so a partial-conversion edge can't sneak past.
  const maxDisplay = prefs.unit_volume === "oz" ? 70 : 2000;

  const amountNum = useMemo(() => Number.parseFloat(amount), [amount]);
  const isAmountValid =
    Number.isFinite(amountNum) && amountNum > 0 && amountNum <= maxDisplay;

  const pending = isEditMode ? update.isPending : create.isPending;
  const errorMsg = isEditMode ? update.error?.message : create.error?.message;
  const hadError = isEditMode ? update.isError : create.isError;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId || !isAmountValid) return;
    const canonicalMl = displayVolumeToMl(amountNum, prefs.unit_volume);
    if (isEditMode && editId) {
      update.mutate(
        {
          id: editId,
          babyId,
          occurred_at: localToISO(occurredLocal),
          milk_source: source,
          amount_ml: canonicalMl,
          // Empty string clears the note server-side; non-empty replaces it.
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
        <h1 className="text-2xl font-semibold">
          {isEditMode ? "Edit bottle feed" : "Log bottle feed"}
        </h1>
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
              onChange={(e) => {
                setAmount(e.target.value);
                if (autofillApplied) setAutofillApplied(false);
              }}
              className="w-full rounded-xl bg-bg-subtle px-4 py-4 text-4xl font-semibold tabular-nums outline-none focus:ring-2 focus:ring-accent"
            />
            <span className="text-xl text-white/60">{volLabel}</span>
          </div>
          {autofillApplied && (
            <div className="mt-1.5 flex items-center gap-2 text-xs text-white/40">
              <span>Suggested from recent feeds</span>
              <button
                type="button"
                onClick={() => {
                  setAmount("");
                  setAutofillApplied(false);
                }}
                className="text-accent/80 hover:text-accent"
              >
                Clear
              </button>
            </div>
          )}
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

        {hadError && (
          <p className="text-sm text-red-400">{errorMsg ?? "could not save"}</p>
        )}

        <button
          type="submit"
          className="btn-primary text-lg"
          disabled={pending || !isAmountValid}
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

// DeleteEntryButton — two-tap inline confirm. First tap arms; second tap
// fires. The arm auto-resets after 3s if the user does nothing, so a
// stray finger on Delete on phone-edge never deletes anything.
export function DeleteEntryButton({
  pending,
  onConfirm,
}: {
  pending: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        onConfirm();
      }}
      disabled={pending}
      className={
        "mt-1 rounded-xl border px-4 py-3 text-sm font-medium transition disabled:opacity-50 " +
        (armed
          ? "border-red-400/60 bg-red-400/15 text-red-200"
          : "border-red-400/30 bg-transparent text-red-300 hover:bg-red-400/5")
      }
    >
      {pending
        ? "Deleting…"
        : armed
          ? "Tap again to confirm delete"
          : "Delete entry"}
    </button>
  );
}
