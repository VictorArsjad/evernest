// Quick-log form for growth measurements. Three optional numeric inputs
// (weight in grams, height in cm, head circumference in cm) plus a "When"
// timestamp. The form is only valid when at least one of the three numbers
// is filled in — matches the API rule and keeps the user from accidentally
// submitting an empty measurement. No unit-conversion UI yet (CP4 ships
// kg/lb/oz toggles); the inputs accept the canonical unit straight.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";

import { useBabies, useCreateGrowth, useHouseholds } from "../lib/queries";

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
  const fallbackBabyId = babies.data?.[0]?.id ?? null;
  const babyId = babyIdFromSearch ?? fallbackBabyId;

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

  // Bounds match the API:
  //   weight 0 < g < 30,000  (≈ 30kg ceiling)
  //   height 0 < cm < 200
  //   head   0 < cm < 80
  const weightG = useMemo(() => parseOptional(weightStr, 30000), [weightStr]);
  const heightCM = useMemo(() => parseOptional(heightStr, 200), [heightStr]);
  const headCM = useMemo(() => parseOptional(headStr, 80), [headStr]);

  const allFieldsValid =
    !Number.isNaN(weightG as number) &&
    !Number.isNaN(heightCM as number) &&
    !Number.isNaN(headCM as number);
  const atLeastOnePresent =
    weightG !== undefined || heightCM !== undefined || headCM !== undefined;
  const isValid = allFieldsValid && atLeastOnePresent;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId || !isValid) return;
    create.mutate(
      {
        babyId,
        measured_at: localToISO(measuredLocal),
        weight_g: weightG,
        height_cm: heightCM,
        head_circumference_cm: headCM,
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
          unit="g"
          value={weightStr}
          onChange={setWeightStr}
          placeholder="6500"
          step={1}
          autoFocus
        />
        <MeasurementInput
          label="Height"
          unit="cm"
          value={heightStr}
          onChange={setHeightStr}
          placeholder="62"
          step={0.1}
        />
        <MeasurementInput
          label="Head circumference"
          unit="cm"
          value={headStr}
          onChange={setHeadStr}
          placeholder="42"
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
