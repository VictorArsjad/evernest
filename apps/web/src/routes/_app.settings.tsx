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
import { format, parseISO } from "date-fns";
import { useEffect, useMemo, useState } from "react";

import { useAuthStore } from "../lib/authStore";
import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  isFeatureVisible,
  setFeatureVisibility,
  type FeatureKey,
  type FeatureVisibilityMap,
} from "../lib/featureVisibility";
import {
  PRESET_LABELS,
  PRESET_NAMES,
  PRESETS,
  SERIES_LABELS,
  resolve,
  type ChartPalette,
  type PresetName,
  type SeriesKey,
} from "../lib/palette";
import {
  useBabies,
  useBabySettings,
  useCreateInvite,
  useHouseholds,
  useInvites,
  useLogout,
  useMyPreferences,
  useRevokeInvite,
  useUpdateBabySettings,
  useUpdateMyPreferences,
} from "../lib/queries";
import { useActiveBaby } from "../lib/useActiveBaby";
import type {
  BabySettings,
  Household,
  HouseholdRole,
  Invite,
  UserPreferences,
} from "../lib/types";

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const user = useAuthStore((s) => s.user);
  const logout = useLogout();

  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const household = households.data?.[0] ?? null;
  const babies = useBabies(householdId);
  const { baby } = useActiveBaby(householdId, babies.data);

  const me = useMyPreferences();
  const settings = useBabySettings(baby?.id ?? null);

  if (households.isLoading || babies.isLoading) {
    return <PageShell title="Settings">Loading…</PageShell>;
  }
  if (!baby || !household) {
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

      <section className="card flex flex-col gap-4 p-5">
        <header>
          <h2 className="text-base font-semibold">Today banner</h2>
        </header>
        {me.isError ? (
          <p className="text-sm text-red-400">
            {me.error?.message ?? "Could not load your preferences."}
          </p>
        ) : (
          <TodayBannerFields prefs={me.data} disabled={!me.data} />
        )}
      </section>

      <section className="card flex flex-col gap-4 p-5">
        <header>
          <h2 className="text-base font-semibold">Bottle feeding</h2>
        </header>
        {me.isError ? (
          <p className="text-sm text-red-400">
            {me.error?.message ?? "Could not load your preferences."}
          </p>
        ) : (
          <BottleFeedingFields prefs={me.data} disabled={!me.data} />
        )}
      </section>

      <section className="card flex flex-col gap-4 p-5">
        <header>
          <h2 className="text-base font-semibold">Visible features</h2>
        </header>
        {me.isError ? (
          <p className="text-sm text-red-400">
            {me.error?.message ?? "Could not load your preferences."}
          </p>
        ) : (
          <FeatureVisibilityFields prefs={me.data} disabled={!me.data} />
        )}
      </section>

      <section className="card flex flex-col gap-4 p-5">
        <header className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">Chart colors</h2>
          <span className="text-xs text-white/40">Per user</span>
        </header>
        {me.isError ? (
          <p className="text-sm text-red-400">
            {me.error?.message ?? "Could not load your preferences."}
          </p>
        ) : (
          <ChartColorsFields prefs={me.data} disabled={!me.data} />
        )}
      </section>

      <HouseholdSection household={household} />
    </PageShell>
  );
}

// --- household + invites ---

// HouseholdSection renders the household card on the settings page:
// member list (synthesized from the caller's perspective until the BE
// ships a dedicated members endpoint), pending invites with revoke, and
// the owner-only "Create invite link" form. All owner-gated controls are
// hidden for caregivers — the BE also enforces this via 403, the UI
// gating is for UX (don't show a button that always fails).
function HouseholdSection({ household }: { household: Household }) {
  const isOwner = household.role === "owner";
  const invites = useInvites(household.id);

  return (
    <section className="card flex flex-col gap-4 p-5">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">Household</h2>
        <span className="text-xs text-white/40">{household.name}</span>
      </header>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs uppercase tracking-wide text-white/50">Members</h3>
        <p className="text-[11px] text-white/40">
          You're listed as <span className="capitalize">{household.role}</span>. Other members appear on the household after they accept your invite.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-xs uppercase tracking-wide text-white/50">Pending invites</h3>
        {invites.isLoading ? (
          <p className="text-sm text-white/40">Loading…</p>
        ) : invites.isError ? (
          <p className="text-sm text-red-400">
            {invites.error?.message ?? "Could not load invites."}
          </p>
        ) : invites.data && invites.data.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {invites.data.map((inv) => (
              <PendingInviteRow
                key={inv.token_hint}
                invite={inv}
                householdId={household.id}
                canRevoke={isOwner}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-white/40">No outstanding invites.</p>
        )}
      </div>

      {isOwner && <CreateInviteForm householdId={household.id} />}
    </section>
  );
}

function PendingInviteRow({
  invite,
  householdId,
  canRevoke,
}: {
  invite: Invite;
  householdId: string;
  canRevoke: boolean;
}) {
  // The list endpoint deliberately doesn't echo the plaintext token, so
  // we can only revoke an invite that was just minted in this session
  // (the create form keeps a small in-memory cache mapping hint -> token
  // to support this). For invites created in another tab/session the
  // revoke button is disabled with a tooltip; the owner can revoke from
  // the original create flow's UI.
  const revoke = useRevokeInvite(householdId);
  const cachedToken = useRevokeableToken(invite.token_hint);

  const onRevoke = () => {
    if (!cachedToken) return;
    revoke.mutate({ token: cachedToken });
  };

  const expiresIso = invite.expires_at;
  const expires = format(parseISO(expiresIso), "MMM d");

  return (
    <li className="flex items-center gap-3 rounded-xl bg-bg-subtle px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <code className="text-xs text-white/80">…{invite.token_hint}</code>
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/60">
            {invite.role}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-white/40">Expires {expires}</p>
      </div>
      {canRevoke && (
        <button
          type="button"
          onClick={onRevoke}
          disabled={!cachedToken || revoke.isPending}
          title={cachedToken ? "Revoke this invite" : "Revoke from the tab where it was created"}
          className="rounded-lg border border-white/10 px-3 py-1 text-xs text-white/70 hover:bg-white/5 disabled:opacity-40"
        >
          {revoke.isPending ? "…" : "Revoke"}
        </button>
      )}
    </li>
  );
}

const EXPIRY_OPTIONS: { label: string; hours: number }[] = [
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
];

function CreateInviteForm({ householdId }: { householdId: string }) {
  const create = useCreateInvite(householdId);
  const [role, setRole] = useState<HouseholdRole>("caregiver");
  const [hours, setHours] = useState<number>(EXPIRY_OPTIONS[1].hours);
  const [copied, setCopied] = useState(false);
  const remember = useRememberToken();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      { role, expires_in_hours: hours },
      {
        onSuccess: (inv) => {
          if (inv.token) {
            remember(inv.token_hint, inv.token);
          }
        },
      },
    );
  };

  const onCopy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older browsers w/o clipboard API: user can long-press the link.
    }
  };

  return (
    <form
      onSubmit={onSubmit}
      className="mt-2 flex flex-col gap-3 rounded-xl border border-white/10 p-3"
    >
      <h3 className="text-xs uppercase tracking-wide text-white/50">
        Create invite link
      </h3>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/40">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as HouseholdRole)}
            className="rounded-xl bg-bg-subtle px-3 py-2 text-base text-white outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="caregiver">Caregiver</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wide text-white/40">Expires</span>
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="rounded-xl bg-bg-subtle px-3 py-2 text-base text-white outline-none focus:ring-2 focus:ring-accent"
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.hours} value={o.hours}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="submit"
        disabled={create.isPending}
        className="btn-primary"
      >
        {create.isPending ? "Generating…" : "Generate link"}
      </button>
      {create.isError && (
        <p className="text-sm text-red-400">
          {create.error?.message ?? "Could not create invite."}
        </p>
      )}
      {create.data?.invite_url && (
        <div className="flex flex-col gap-2 rounded-xl bg-bg-subtle p-3 text-xs">
          <p className="text-white/60">
            Share this link with your co-caregiver. It can be used once; we
            only store a hash so we cannot recover the link if you lose it.
          </p>
          <code className="break-all rounded-lg bg-black/20 p-2 text-xs text-white/90">
            {create.data.invite_url}
          </code>
          <button
            type="button"
            onClick={() => onCopy(create.data!.invite_url!)}
            className="self-start rounded-lg border border-white/10 px-3 py-1 text-xs text-white/80 hover:bg-white/5"
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}
    </form>
  );
}

// useRevokeableToken / useRememberToken: tiny in-memory cache (lives on
// the module, NOT in any cross-route store) that maps a token_hint back
// to the plaintext token for the rest of the current session. The list
// endpoint never returns plaintext, so we can only revoke invites that
// were minted in this tab. This is a deliberate trade-off:
//   - we never persist the plaintext (refreshing the page wipes the cache)
//   - the owner can always revoke an invite *they just made* (the common
//     case: "oops, wrong role, give me the right one")
//   - in the rare case where the owner needs to revoke an invite from
//     another device they can delete + re-create the household, but we
//     consider this acceptable for v1.
const tokenCache = new Map<string, string>();

function useRememberToken(): (hint: string, token: string) => void {
  return useMemo(
    () => (hint: string, token: string) => {
      tokenCache.set(hint, token);
    },
    [],
  );
}

function useRevokeableToken(hint: string): string | undefined {
  return tokenCache.get(hint);
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
        show_recommended_targets: prefs.show_recommended_targets,
        chart_palette: prefs.chart_palette,
        feature_visibility: prefs.feature_visibility,
        autofill_bottle_amount: prefs.autofill_bottle_amount,
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

// --- today-banner toggle ---

// TodayBannerFields surfaces the per-user "show recommended targets"
// toggle that gates the progress bars on the Today screen's daily-totals
// banner. Single boolean field, so we use a checkbox-style switch rather
// than a select for a more tactile mobile feel. Uses the same
// `useUpdateMyPreferences` full-replace endpoint as the clock field —
// each toggle is its own optimistic mutation.
function TodayBannerFields({
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

  const onToggle = (next: boolean) => {
    if (!prefs) return;
    update.mutate(
      {
        time_format: prefs.time_format,
        timezone: prefs.timezone,
        locale: prefs.locale,
        show_recommended_targets: next,
        chart_palette: prefs.chart_palette,
        feature_visibility: prefs.feature_visibility,
        autofill_bottle_amount: prefs.autofill_bottle_amount,
      },
      { onSuccess: () => setSavedTick((t) => t + 1) },
    );
  };

  const checked = prefs?.show_recommended_targets ?? true;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          disabled={disabled}
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-1 h-5 w-5 shrink-0 cursor-pointer rounded border-white/20 bg-bg-subtle text-accent accent-accent focus:ring-2 focus:ring-accent disabled:opacity-50"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Show daily target bars</span>
          <span className="text-[11px] text-white/40">
            Compare today's totals against typical ranges for your baby's
            age. These are general guidelines, not medical advice — turn
            this off if you'd rather not see comparisons.
          </span>
        </span>
      </label>
      <SaveAffordance
        show={showSaved}
        pending={update.isPending}
        error={update.error?.message ?? null}
      />
    </div>
  );
}

// --- bottle-feeding autofill toggle ---

// BottleFeedingFields surfaces the per-user "auto-fill amount from recent
// feeds" toggle. When on, the bottle-feed log form prefills the Amount
// field with the most common amount logged over the last ~14 days (bottle
// amounts are usually constant, so this saves a tap on the app's most
// frequent action). Same single-boolean optimistic-checkbox pattern as
// TodayBannerFields; rides the same full-replace useUpdateMyPreferences.
function BottleFeedingFields({
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

  const onToggle = (next: boolean) => {
    if (!prefs) return;
    update.mutate(
      {
        time_format: prefs.time_format,
        timezone: prefs.timezone,
        locale: prefs.locale,
        show_recommended_targets: prefs.show_recommended_targets,
        chart_palette: prefs.chart_palette,
        feature_visibility: prefs.feature_visibility,
        autofill_bottle_amount: next,
      },
      { onSuccess: () => setSavedTick((t) => t + 1) },
    );
  };

  const checked = prefs?.autofill_bottle_amount ?? true;

  return (
    <div className="flex flex-col gap-3">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          disabled={disabled}
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
          className="mt-1 h-5 w-5 shrink-0 cursor-pointer rounded border-white/20 bg-bg-subtle text-accent accent-accent focus:ring-2 focus:ring-accent disabled:opacity-50"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Auto-fill amount from recent feeds</span>
          <span className="text-[11px] text-white/40">
            Prefill the bottle Amount with your most common recent amount so
            logging is one tap faster. It's always editable, and adapts as
            your baby's usual feed changes. Turn this off to start from an
            empty field.
          </span>
        </span>
      </label>
      <SaveAffordance
        show={showSaved}
        pending={update.isPending}
        error={update.error?.message ?? null}
      />
    </div>
  );
}

// --- feature visibility toggles ---

// FeatureVisibilityFields surfaces the per-user "Visible features" card:
// one toggle per event kind (bottle / nursing / pumping / diaper / growth)
// that controls whether the kind's BannerStat cell, action Tile, and
// /charts ChartCard render.
//
// Toggle ON saves immediately (silent — same affordance as the other
// settings on this page). Toggle OFF stages the change and opens a
// confirm modal that reassures the user no data is destroyed; only on
// confirm do we call useUpdateMyPreferences. This matches the user's
// explicit ask: "when turned off, show a popup to confirm action; mention
// data will not be lost (only UI changes)".
//
// Storage is sparse — visible features are stripped from the map so a
// fully-default user always serializes back to {}. See
// lib/featureVisibility.ts.
function FeatureVisibilityFields({
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

  // Pending hide is the staged "user clicked the toggle off" state. We
  // don't save until the user confirms — clicking Cancel returns the
  // checkbox to its prior state without a network round trip.
  const [pendingHide, setPendingHide] = useState<FeatureKey | null>(null);

  const visibility = prefs?.feature_visibility ?? {};

  const save = (next: FeatureVisibilityMap) => {
    if (!prefs) return;
    update.mutate(
      {
        time_format: prefs.time_format,
        timezone: prefs.timezone,
        locale: prefs.locale,
        show_recommended_targets: prefs.show_recommended_targets,
        chart_palette: prefs.chart_palette,
        feature_visibility: next,
        autofill_bottle_amount: prefs.autofill_bottle_amount,
      },
      { onSuccess: () => setSavedTick((t) => t + 1) },
    );
  };

  const onChange = (key: FeatureKey, nextVisible: boolean) => {
    if (!prefs) return;
    if (nextVisible) {
      // Re-enabling is non-destructive — save without a confirm step.
      save(setFeatureVisibility(visibility, key, true));
    } else {
      setPendingHide(key);
    }
  };

  const onConfirmHide = () => {
    if (!pendingHide) return;
    save(setFeatureVisibility(visibility, pendingHide, false));
    setPendingHide(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {FEATURE_KEYS.map((key) => {
          const visible = isFeatureVisible(visibility, key);
          return (
            <li
              key={key}
              className="flex items-center justify-between gap-3 rounded-xl bg-bg-subtle px-3 py-2"
            >
              <span className="text-sm font-medium">{FEATURE_LABELS[key]}</span>
              <input
                type="checkbox"
                aria-label={`Show ${FEATURE_LABELS[key]}`}
                disabled={disabled || update.isPending}
                checked={visible}
                onChange={(e) => onChange(key, e.target.checked)}
                className="h-5 w-5 shrink-0 cursor-pointer rounded border-white/20 bg-bg-surface text-accent accent-accent focus:ring-2 focus:ring-accent disabled:opacity-50"
              />
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-white/40">
        Hiding a feature only changes what you see — past entries and totals
        are kept.
      </p>
      <SaveAffordance
        show={showSaved}
        pending={update.isPending}
        error={update.error?.message ?? null}
      />
      {pendingHide && (
        <ConfirmHideModal
          featureKey={pendingHide}
          pending={update.isPending}
          onCancel={() => setPendingHide(null)}
          onConfirm={onConfirmHide}
        />
      )}
    </div>
  );
}

// ConfirmHideModal mirrors the EndNursingModal layout used elsewhere in
// the app: full-screen dim backdrop on phones, centered card on `sm:`,
// safe-area-aware bottom padding so the action row clears the iOS home
// indicator. Copy is intentionally brief — the help text under the
// toggle list already explains the semantics; this dialog is the
// confirmation gesture, not the explanation.
function ConfirmHideModal({
  featureKey,
  pending,
  onCancel,
  onConfirm,
}: {
  featureKey: FeatureKey;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const label = FEATURE_LABELS[featureKey];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-hide-title"
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-bg-surface p-5 shadow-xl"
      >
        <h2 id="confirm-hide-title" className="text-lg font-semibold">
          Hide {label}?
        </h2>
        <p className="mt-2 text-sm text-white/70">
          Your data is kept — this only hides the UI.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white/80 hover:bg-white/5 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="rounded-lg bg-red-500/20 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-500/30 disabled:opacity-50"
          >
            {pending ? "Hiding…" : "Hide"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- chart colors ---

// ChartColorsFields renders the "Chart colors" Settings card: a row of
// preset chips (each showing three preview dots), a divider, and an
// "Advanced — customize per series" disclosure with one row per
// SeriesKey for per-series overrides.
//
// Every change calls useUpdateMyPreferences with the FULL preferences
// payload — the BE PUT is full-replace and now requires chart_palette,
// so unchanged fields (time_format / timezone / locale /
// show_recommended_targets) come from useMyPreferences().data and ride
// along on every save.
//
// Preset selection preserves any in-flight overrides — only the
// per-series "Reset" link removes an override. This matches user
// intuition: "I want the warm vibe but keep my custom nursing color."
function ChartColorsFields({
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

  const palette: ChartPalette = useMemo(
    () => prefs?.chart_palette ?? { preset: "default", overrides: {} },
    [prefs?.chart_palette],
  );
  const resolved = useMemo(() => resolve(palette), [palette]);

  const save = (next: ChartPalette) => {
    if (!prefs) return;
    update.mutate(
      {
        time_format: prefs.time_format,
        timezone: prefs.timezone,
        locale: prefs.locale,
        show_recommended_targets: prefs.show_recommended_targets,
        chart_palette: next,
        feature_visibility: prefs.feature_visibility,
        autofill_bottle_amount: prefs.autofill_bottle_amount,
      },
      { onSuccess: () => setSavedTick((t) => t + 1) },
    );
  };

  const onPick = (preset: PresetName) => {
    save({ preset, overrides: palette.overrides });
  };
  const onOverride = (key: SeriesKey, color: string) => {
    save({
      preset: palette.preset,
      overrides: { ...palette.overrides, [key]: color },
    });
  };
  const onReset = (key: SeriesKey) => {
    const rest: Partial<Record<SeriesKey, string>> = {};
    for (const k of Object.keys(palette.overrides) as SeriesKey[]) {
      if (k !== key) rest[k] = palette.overrides[k];
    }
    save({ preset: palette.preset, overrides: rest });
  };

  // Three sample series the chip preview dots show. Picked so each
  // preset gives an immediate, glance-able sense of the vibe: a warm
  // hue, a cool hue, and a yellow accent.
  const PREVIEW_KEYS: SeriesKey[] = ["bottle_breast", "nursing", "diaper_wet"];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-wide text-white/50">
          Preset
        </span>
        <div className="flex flex-wrap gap-2">
          {PRESET_NAMES.map((name) => {
            const selected = palette.preset === name;
            return (
              <button
                key={name}
                type="button"
                disabled={disabled || update.isPending}
                onClick={() => onPick(name)}
                aria-pressed={selected}
                className={
                  "flex flex-col items-center gap-1 rounded-lg border border-white/10 px-3 py-2 text-xs transition disabled:opacity-50 " +
                  (selected
                    ? "bg-white/10 text-white"
                    : "text-white/70 hover:bg-white/5")
                }
              >
                <span className="flex gap-1">
                  {PREVIEW_KEYS.map((k) => (
                    <span
                      key={k}
                      aria-hidden="true"
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: PRESETS[name][k] }}
                    />
                  ))}
                </span>
                <span>{PRESET_LABELS[name]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <hr className="border-t border-white/5" />

      <details className="group flex flex-col gap-2">
        <summary className="cursor-pointer text-xs uppercase tracking-wide text-white/50 marker:text-white/40">
          Advanced — customize per series
        </summary>
        <ul className="mt-2 flex flex-col gap-2">
          {(Object.keys(SERIES_LABELS) as SeriesKey[]).map((key) => {
            const value = resolved[key];
            const hasOverride = key in palette.overrides;
            return (
              <li
                key={key}
                className="flex items-center gap-3 rounded-lg bg-bg-subtle px-3 py-2 text-sm"
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-4 w-4 shrink-0 rounded"
                  style={{ backgroundColor: value }}
                />
                <span className="min-w-0 flex-1 truncate text-white/80">
                  {SERIES_LABELS[key]}
                </span>
                <input
                  type="color"
                  aria-label={`${SERIES_LABELS[key]} color`}
                  disabled={disabled || update.isPending}
                  value={value}
                  onChange={(e) => onOverride(key, e.target.value)}
                  className="h-7 w-10 cursor-pointer rounded border border-white/10 bg-transparent p-0 disabled:opacity-50"
                />
                {hasOverride ? (
                  <button
                    type="button"
                    disabled={disabled || update.isPending}
                    onClick={() => onReset(key)}
                    className="text-xs text-white/50 hover:text-white disabled:opacity-50"
                  >
                    Reset
                  </button>
                ) : (
                  // Reserve the column so rows don't reflow as overrides
                  // are added/removed.
                  <span aria-hidden="true" className="w-[2.75rem]" />
                )}
              </li>
            );
          })}
        </ul>
      </details>

      <p className="text-[11px] text-white/40">
        Display only — never changes saved data.
      </p>

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
