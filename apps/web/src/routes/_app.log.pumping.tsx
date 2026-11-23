// Quick-log form for pumping sessions. Required: volume in ml. Optional:
// duration in minutes (UI minutes -> stored as duration_seconds). Default
// "When" is now; same focus-restamp behaviour as the other log forms.
// In edit mode (`?edit=<uuid>`) the form patches an existing row and
// exposes a Delete button for accidental double-logs.
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { LogFormLayout } from "../components/LogFormLayout";
import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "../lib/datetime";
import {
  useCreatePumping,
  useDeletePumping,
  useUpdatePumping,
} from "../lib/queries";
import { logSearchSchema, useLogForm, usePrefillOnce, useRestampOnFocus } from "../lib/logForm";
import {
  displayVolumeToMl,
  mlToDisplayVolume,
  volumeUnitLabel,
} from "../lib/units";
import { usePreferences } from "../lib/usePreferences";

export const Route = createFileRoute("/_app/log/pumping")({
  validateSearch: logSearchSchema,
  component: LogPumpingPage,
});

function LogPumpingPage() {
  const create = useCreatePumping();
  const update = useUpdatePumping();
  const del = useDeletePumping();
  const form = useLogForm({
    segment: "pumpings",
    search: Route.useSearch(),
    create,
    update,
    del,
  });
  const { babyId, isEditMode, existing } = form;

  const [amount, setAmount] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  const { prefs } = usePreferences(babyId);
  const volLabel = volumeUnitLabel(prefs.unit_volume);
  const maxDisplay = prefs.unit_volume === "oz" ? 70 : 2000;

  usePrefillOnce(isEditMode, existing, (row) => {
    setAmount(String(mlToDisplayVolume(Number(row.amount_ml), prefs.unit_volume)));
    setDurationMin(
      row.duration_seconds != null
        ? String(Math.round(Number(row.duration_seconds) / 60))
        : "",
    );
    setOccurredLocal(isoToLocalDatetimeInput(row.occurred_at));
    setNotes(row.notes ?? "");
  });

  useRestampOnFocus(isEditMode, setOccurredLocal);

  const amountNum = useMemo(() => Number.parseFloat(amount), [amount]);
  const isAmountValid =
    Number.isFinite(amountNum) && amountNum >= 0 && amountNum <= maxDisplay;
  const durationMinNum = useMemo(() => Number.parseFloat(durationMin), [durationMin]);
  const isDurationValid =
    durationMin === "" || (Number.isFinite(durationMinNum) && durationMinNum >= 0 && durationMinNum <= 360);

  const onSubmit = () => {
    if (!isAmountValid || !isDurationValid) return;
    const amount_ml = displayVolumeToMl(amountNum, prefs.unit_volume);
    const duration_seconds =
      durationMin === "" ? undefined : Math.round(durationMinNum * 60);
    form.save({
      create: {
        occurred_at: localToISO(occurredLocal),
        amount_ml,
        duration_seconds,
        notes: notes.trim() || undefined,
      },
      update: {
        occurred_at: localToISO(occurredLocal),
        amount_ml,
        duration_seconds: duration_seconds ?? null,
        notes: notes.trim(),
      },
    });
  };

  return (
    <LogFormLayout
      form={form}
      createTitle="Log pumping"
      editTitle="Edit pumping"
      onSubmit={onSubmit}
      submitDisabled={!isAmountValid || !isDurationValid}
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
    </LogFormLayout>
  );
}
