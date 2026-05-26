// Quick-log form for growth measurements. Three optional numeric inputs
// (weight, height, head circumference) plus a "When" timestamp. The form
// is only valid when at least one of the three numbers is filled in —
// matches the API rule and keeps the user from accidentally submitting
// an empty measurement. Inputs accept the user's chosen display units
// (kg/lb for weight, cm/in for length); we convert to canonical g/cm at
// submit time so the BE always sees the canonical row regardless of
// what the user prefers to look at.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { useBabies, useCreateGrowth, useHouseholds } from "../lib/queries";
import { useActiveBaby } from "../lib/useActiveBaby";
import {
  displayLengthToCm,
  displayWeightToG,
  lengthUnitLabel,
  weightUnitLabel,
} from "../lib/units";
import { usePreferences } from "../lib/usePreferences";

const search = z.object({
  babyId: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_app/log/growth")({
  validateSearch: search,
  component: LogGrowthPage,
});

function nowLocalDatetimeInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  return new Date(local).toISOString();
}

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
  const nav = useNavigate();
  const { babyId: babyIdFromSearch } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const { baby: activeBaby } = useActiveBaby(householdId, babies.data);
  const babyId = babyIdFromSearch ?? activeBaby?.id ?? null;

  const [weightStr, setWeightStr] = useState("");
  const [heightStr, setHeightStr] = useState("");
  const [headStr, setHeadStr] = useState("");
  const [measuredLocal, setMeasuredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    const onFocus = () => setMeasuredLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const create = useCreateGrowth();
  const { prefs } = usePreferences(babyId);
  const wLabel = weightUnitLabel(prefs.unit_weight);
  const lLabel = lengthUnitLabel(prefs.unit_length);

  // Display-unit bounds: ceilings derived from the API's canonical
  // bounds (30,000 g / 200 cm / 80 cm) so we can't accept a value that
  // would 422 on submit. Numbers rounded up so e.g. the lb ceiling
  // covers 30 kg exactly without a sub-unit gap.
  const weightMaxDisplay = prefs.unit_weight === "lb" ? 70 : 30; // 70 lb ≈ 31.7 kg, 30 kg = 30,000 g
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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId || !isValid) return;
    create.mutate(
      {
        babyId,
        measured_at: localToISO(measuredLocal),
        weight_g:
          weightDisp !== undefined
            ? displayWeightToG(weightDisp, prefs.unit_weight)
            : undefined,
        height_cm:
          heightDisp !== undefined
            ? displayLengthToCm(heightDisp, prefs.unit_length)
            : undefined,
        head_circumference_cm:
          headDisp !== undefined
            ? displayLengthToCm(headDisp, prefs.unit_length)
            : undefined,
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
        <h1 className="text-2xl font-semibold">Log growth</h1>
        <button onClick={() => nav({ to: "/" })} className="text-sm text-white/60">
          Cancel
        </button>
      </header>

      <form onSubmit={onSubmit} className="card flex flex-col gap-5 p-5">
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

        {create.isError && (
          <p className="text-sm text-red-400">{create.error?.message ?? "could not save"}</p>
        )}

        <button
          type="submit"
          className="btn-primary text-lg"
          disabled={create.isPending || !isValid}
        >
          {create.isPending ? "Saving…" : "Save"}
        </button>
      </form>
    </main>
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
