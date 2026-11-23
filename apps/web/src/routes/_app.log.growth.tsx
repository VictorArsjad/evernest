// Quick-log form for growth measurements. Three optional numeric inputs
// (weight, height, head circumference) plus a "When" timestamp. The form
// is only valid when at least one of the three numbers is filled in —
// matches the API rule and keeps the user from accidentally submitting
// an empty measurement. Inputs accept the user's chosen display units
// (kg/lb for weight, cm/in for length); we convert to canonical g/cm at
// submit time so the BE always sees the canonical row regardless of
// what the user prefers to look at. In edit mode (`?edit=<uuid>`) the
// form patches an existing row and exposes a Delete button for accidental
// double-logs. In edit mode a blank field sends `null` (merge-patch)
// so the BE sets the column to NULL.
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { LogFormLayout } from "../components/LogFormLayout";
import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "../lib/datetime";
import {
  useCreateGrowth,
  useDeleteGrowth,
  useUpdateGrowth,
} from "../lib/queries";
import { logSearchSchema, useLogForm, usePrefillOnce, useRestampOnFocus } from "../lib/logForm";
import {
  cmToDisplayLength,
  displayLengthToCm,
  displayWeightToG,
  gToDisplayWeight,
  lengthUnitLabel,
  weightUnitLabel,
} from "../lib/units";
import { usePreferences } from "../lib/usePreferences";

export const Route = createFileRoute("/_app/log/growth")({
  validateSearch: logSearchSchema,
  component: LogGrowthPage,
});

// parseOptional returns:
//   - undefined if the input is blank (means "not measured")
//   - NaN if the input is non-blank but unparseable / out of bounds (form blocks submit)
//   - the number otherwise
function parseOptional(raw: string, max: number): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= max) return Number.NaN;
  return n;
}

function LogGrowthPage() {
  const create = useCreateGrowth();
  const update = useUpdateGrowth();
  const del = useDeleteGrowth();
  const form = useLogForm({
    segment: "growths",
    search: Route.useSearch(),
    create,
    update,
    del,
  });
  const { babyId, isEditMode, existing } = form;

  const [weightStr, setWeightStr] = useState("");
  const [heightStr, setHeightStr] = useState("");
  const [headStr, setHeadStr] = useState("");
  const [measuredLocal, setMeasuredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  const { prefs } = usePreferences(babyId);
  const wLabel = weightUnitLabel(prefs.unit_weight);
  const lLabel = lengthUnitLabel(prefs.unit_length);

  usePrefillOnce(isEditMode, existing, (row) => {
    setWeightStr(
      row.weight_g != null
        ? String(gToDisplayWeight(Number(row.weight_g), prefs.unit_weight))
        : "",
    );
    setHeightStr(
      row.height_cm != null
        ? String(cmToDisplayLength(Number(row.height_cm), prefs.unit_length))
        : "",
    );
    setHeadStr(
      row.head_circumference_cm != null
        ? String(cmToDisplayLength(Number(row.head_circumference_cm), prefs.unit_length))
        : "",
    );
    setMeasuredLocal(isoToLocalDatetimeInput(row.measured_at));
    setNotes(row.notes ?? "");
  });

  useRestampOnFocus(isEditMode, setMeasuredLocal);

  // Display-unit bounds: ceilings derived from the API's canonical
  // bounds (30,000 g / 200 cm / 80 cm) so we can't accept a value that
  // would 422 on submit.
  const weightMaxDisplay = prefs.unit_weight === "lb" ? 70 : 30;
  const heightMaxDisplay = prefs.unit_length === "in" ? 80 : 200;
  const headMaxDisplay = prefs.unit_length === "in" ? 32 : 80;

  const weightDisp = useMemo(() => parseOptional(weightStr, weightMaxDisplay), [weightStr, weightMaxDisplay]);
  const heightDisp = useMemo(() => parseOptional(heightStr, heightMaxDisplay), [heightStr, heightMaxDisplay]);
  const headDisp = useMemo(() => parseOptional(headStr, headMaxDisplay), [headStr, headMaxDisplay]);

  const allFieldsValid =
    !Number.isNaN(weightDisp as number) &&
    !Number.isNaN(heightDisp as number) &&
    !Number.isNaN(headDisp as number);
  const atLeastOnePresent =
    weightDisp !== undefined || heightDisp !== undefined || headDisp !== undefined;
  const isValid = allFieldsValid && atLeastOnePresent;

  const onSubmit = () => {
    if (!isValid) return;
    const weightG =
      weightDisp !== undefined ? displayWeightToG(weightDisp, prefs.unit_weight) : undefined;
    const heightCM =
      heightDisp !== undefined ? displayLengthToCm(heightDisp, prefs.unit_length) : undefined;
    const headCM =
      headDisp !== undefined ? displayLengthToCm(headDisp, prefs.unit_length) : undefined;
    form.save({
      create: {
        measured_at: localToISO(measuredLocal),
        weight_g: weightG,
        height_cm: heightCM,
        head_circumference_cm: headCM,
        notes: notes.trim() || undefined,
      },
      // In edit mode a blank input sends null (clears the column); a filled
      // input replaces it.
      update: {
        measured_at: localToISO(measuredLocal),
        weight_g: weightG ?? null,
        height_cm: heightCM ?? null,
        head_circumference_cm: headCM ?? null,
        notes: notes.trim(),
      },
    });
  };

  return (
    <LogFormLayout
      form={form}
      createTitle="Log growth"
      editTitle="Edit growth"
      onSubmit={onSubmit}
      submitDisabled={!isValid}
    >
        <p className="text-xs text-white/50">
          Fill in any combination — at least one is required.
        </p>

        <MeasurementInput
          label="Weight"
          unit={wLabel}
          value={weightStr}
          onChange={setWeightStr}
          placeholder={prefs.unit_weight === "lb" ? "14" : "6.5"}
          step={prefs.unit_weight === "lb" ? 0.1 : 0.01}
          autoFocus
        />
        <MeasurementInput
          label="Height"
          unit={lLabel}
          value={heightStr}
          onChange={setHeightStr}
          placeholder={prefs.unit_length === "in" ? "24" : "62"}
          step={0.1}
        />
        <MeasurementInput
          label="Head circumference"
          unit={lLabel}
          value={headStr}
          onChange={setHeadStr}
          placeholder={prefs.unit_length === "in" ? "16" : "42"}
          step={0.1}
        />

        <label className="flex flex-col gap-1 text-sm">
          When measured
          <input
            type="datetime-local"
            required
            value={measuredLocal}
            onChange={(e) => setMeasuredLocal(e.target.value)}
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

function MeasurementInput({
  label,
  unit,
  value,
  onChange,
  placeholder,
  step,
  autoFocus,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  step: number;
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
          step={step}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl bg-bg-subtle px-4 py-3 text-3xl font-semibold tabular-nums outline-none focus:ring-2 focus:ring-accent"
        />
        <span className="text-base text-white/60">{unit}</span>
      </div>
    </div>
  );
}
