// Quick-log form for bottle feeds. Defaults to "now" (24h local time) and
// uses big tap targets — designed for one-handed logging. In edit mode
// (`?edit=<uuid>`) the form is reused to update an existing row instead
// of creating a new one, with a Delete button at the bottom for the
// "logged this twice by mistake" case.
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState, useEffect } from "react";

import { LogFormLayout } from "../components/LogFormLayout";
import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "../lib/datetime";
import {
  useBottleFeeds,
  useCreateBottleFeed,
  useDeleteBottleFeed,
  useUpdateBottleFeed,
} from "../lib/queries";
import { suggestBottleAmountMl, DEFAULT_WINDOW_DAYS } from "../lib/bottleDefault";
import { logSearchSchema, useLogForm, usePrefillOnce, useRestampOnFocus } from "../lib/logForm";
import {
  displayVolumeToMl,
  mlToDisplayVolume,
  volumeUnitLabel,
} from "../lib/units";
import { usePreferences } from "../lib/usePreferences";

export const Route = createFileRoute("/_app/log/bottle")({
  validateSearch: logSearchSchema,
  component: LogBottlePage,
});

function LogBottlePage() {
  const create = useCreateBottleFeed();
  const update = useUpdateBottleFeed();
  const del = useDeleteBottleFeed();
  const form = useLogForm({
    segment: "bottle-feeds",
    search: Route.useSearch(),
    create,
    update,
    del,
  });
  const { babyId, isEditMode, existing } = form;

  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<"breast" | "formula">("formula");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

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

  // Prefill once when the row arrives.
  usePrefillOnce(isEditMode, existing, (row) => {
    setAmount(String(mlToDisplayVolume(Number(row.amount_ml), prefs.unit_volume)));
    setSource(row.milk_source);
    setOccurredLocal(isoToLocalDatetimeInput(row.occurred_at));
    setNotes(row.notes ?? "");
  });

  useRestampOnFocus(isEditMode, setOccurredLocal);

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

  const onSubmit = () => {
    if (!isAmountValid) return;
    const canonicalMl = displayVolumeToMl(amountNum, prefs.unit_volume);
    form.save({
      create: {
        occurred_at: localToISO(occurredLocal),
        milk_source: source,
        amount_ml: canonicalMl,
        notes: notes.trim() || undefined,
      },
      update: {
        occurred_at: localToISO(occurredLocal),
        milk_source: source,
        amount_ml: canonicalMl,
        // Empty string clears the note server-side; non-empty replaces it.
        notes: notes.trim(),
      },
    });
  };

  return (
    <LogFormLayout
      form={form}
      createTitle="Log bottle feed"
      editTitle="Edit bottle feed"
      onSubmit={onSubmit}
      submitDisabled={!isAmountValid}
    >
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
    </LogFormLayout>
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
