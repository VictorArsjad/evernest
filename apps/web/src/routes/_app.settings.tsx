// Settings screen — surfaces both the per-user prefs (time_format) and
// the active baby's per-baby units (volume/length/weight) on a single
// page. The split at the storage layer is invisible here: each select
// fires its own dedicated mutation and shows a brief "Saved" affordance
// on success, so the user perceives them as four equivalent toggles.
//
// No save button. Each select is its own optimistic mutation — small
// surface (4 fields), and "press button, see toast" feels heavier than a
// settings change deserves on a phone-first UI.
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useAuthStore } from "../lib/authStore";
import {
  useBabies,
  useBabySettings,
  useHouseholds,
  useLogout,
  useMyPreferences,
  useUpdateBabySettings,
  useUpdateMyPreferences,
} from "../lib/queries";
import type { BabySettings, UserPreferences } from "../lib/types";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();

  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const baby = babies.data?.[0] ?? null;

  const me = useMyPreferences();
  const settings = useBabySettings(baby?.id ?? null);

  if (households.isLoading || babies.isLoading) {
    return <PageShell title="Settings">Loading…</PageShell>;
  }
  if (!baby) {
    return <PageShell title="Settings">No baby selected.</PageShell>;
  }

  return (
    <PageShell
      title="Settings"
      subtitle={user ? `Signed in as ${user.display_name}` : undefined}
      onSignOut={() => logout.mutate()}
    >
      <section className="card flex flex-col gap-4 p-5">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Units</h2>
          <span className="text-xs text-white/40">{baby.name}</span>
        </header>
        {settings.isError ? (
          <p className="text-sm text-red-400">
            {settings.error?.message ?? "Could not load unit settings."}
          </p>
        ) : (
          <BabyUnitFields
            babyId={baby.id}
            settings={settings.data}
            disabled={!settings.data}
          />
        )}
        <p className="text-[11px] text-white/40">
          Display only — historical entries always stay in their canonical units (ml, cm, grams), so switching never rewrites past data.
        </p>
      </section>

      <section className="card flex flex-col gap-4 p-5">
        <header>
          <h2 className="text-base font-semibold">Time</h2>
        </header>
        {me.isError ? (
          <p className="text-sm text-red-400">
            {me.error?.message ?? "Could not load your preferences."}
          </p>
        ) : (
          <UserTimeFields prefs={me.data} disabled={!me.data} />
        )}
      </section>
    </PageShell>
  );
}

// --- per-baby unit selects ---

function BabyUnitFields({
  babyId,
  settings,
  disabled,
}: {
  babyId: string;
  settings: BabySettings | undefined;
  disabled: boolean;
}) {
  const update = useUpdateBabySettings();
  const [savedTick, setSavedTick] = useState(0);

  // Hide the "Saved" affordance after a short delay so it doesn't sit
  // on screen forever on mid-flight slow connections.
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (savedTick === 0) return;
    setShowSaved(true);
    const id = window.setTimeout(() => setShowSaved(false), 1800);
    return () => window.clearTimeout(id);
  }, [savedTick]);

  const onChange = (
    field: "unit_volume" | "unit_length" | "unit_weight",
    value: string,
  ) => {
    if (!settings) return;
    update.mutate(
      {
        babyId,
        unit_volume: field === "unit_volume" ? (value as "ml" | "oz") : settings.unit_volume,
        unit_length: field === "unit_length" ? (value as "cm" | "in") : settings.unit_length,
        unit_weight: field === "unit_weight" ? (value as "kg" | "lb") : settings.unit_weight,
      },
      { onSuccess: () => setSavedTick((t) => t + 1) },
    );
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <SelectField
        label="Volume"
        value={settings?.unit_volume ?? "ml"}
        disabled={disabled}
        onChange={(v) => onChange("unit_volume", v)}
        options={[
          { value: "ml", label: "Millilitres (ml)" },
          { value: "oz", label: "Fluid ounces (oz)" },
        ]}
      />
      <SelectField
        label="Length"
        value={settings?.unit_length ?? "cm"}
        disabled={disabled}
        onChange={(v) => onChange("unit_length", v)}
        options={[
          { value: "cm", label: "Centimetres (cm)" },
          { value: "in", label: "Inches (in)" },
        ]}
      />
      <SelectField
        label="Weight"
        value={settings?.unit_weight ?? "kg"}
        disabled={disabled}
        onChange={(v) => onChange("unit_weight", v)}
        options={[
          { value: "kg", label: "Kilograms (kg)" },
          { value: "lb", label: "Pounds (lb)" },
        ]}
      />
      <SaveAffordance
        show={showSaved}
        pending={update.isPending}
        error={update.error?.message ?? null}
      />
    </div>
  );
}

// --- per-user time-format select ---

function UserTimeFields({
  prefs,
  disabled,
}: {
  prefs: UserPreferences | undefined;
  disabled: boolean;
}) {
  const update = useUpdateMyPreferences();
  const [savedTick, setSavedTick] = useState(0);
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (savedTick === 0) return;
    setShowSaved(true);
    const id = window.setTimeout(() => setShowSaved(false), 1800);
    return () => window.clearTimeout(id);
  }, [savedTick]);

  const onChange = (value: string) => {
    if (!prefs) return;
    update.mutate(
      {
        time_format: value as "24h" | "12h",
        timezone: prefs.timezone,
        locale: prefs.locale,
      },
      { onSuccess: () => setSavedTick((t) => t + 1) },
    );
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <SelectField
        label="Clock"
        value={prefs?.time_format ?? "24h"}
        disabled={disabled}
        onChange={onChange}
        options={[
          { value: "24h", label: "24-hour (14:30)" },
          { value: "12h", label: "12-hour (2:30 PM)" },
        ]}
      />
      <SaveAffordance
        show={showSaved}
        pending={update.isPending}
        error={update.error?.message ?? null}
      />
    </div>
  );
}

// --- shared select field ---

function SelectField({
  label,
  value,
  disabled,
  onChange,
  options,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs uppercase tracking-wide text-white/50">{label}</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-xl bg-bg-subtle px-3 py-3 text-base text-white outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

// --- save affordance ---

// SaveAffordance lives in the same grid as the selects so it doesn't
// reflow the section when toggling on/off. It shows three states:
//   - mid-flight: "Saving…" (dim)
//   - success:    "Saved" (green, fades after ~1.8s)
//   - error:      red message; never auto-fades — user has to react
function SaveAffordance({
  show,
  pending,
  error,
}: {
  show: boolean;
  pending: boolean;
  error: string | null;
}) {
  if (error) {
    return (
      <p className="self-end text-xs text-red-400 sm:col-span-full">
        Could not save: {error}
      </p>
    );
  }
  if (pending) {
    return (
      <p className="self-end text-xs text-white/40 sm:col-span-full">Saving…</p>
    );
  }
  if (show) {
    return (
      <p className="self-end text-xs text-emerald-300 sm:col-span-full">
        Saved
      </p>
    );
  }
  return <span className="hidden sm:col-span-full sm:block" />;
}

// --- page shell ---

function PageShell({
  title,
  subtitle,
  onSignOut,
  children,
}: {
  title: string;
  subtitle?: string;
  onSignOut?: () => void;
  children: React.ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col gap-4 p-5 pb-12">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <Link
            to="/"
            className="text-xs text-white/50 hover:text-white"
            aria-label="Back to Today"
          >
            ← Today
          </Link>
          <div>
            <h1 className="text-2xl font-semibold">{title}</h1>
            {subtitle && <p className="text-xs text-white/50">{subtitle}</p>}
          </div>
        </div>
        {onSignOut && (
          <button onClick={onSignOut} className="text-xs text-white/50 hover:text-white">
            Sign out
          </button>
        )}
      </header>
      {children}
    </main>
  );
}
