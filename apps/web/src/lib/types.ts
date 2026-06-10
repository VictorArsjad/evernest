// Server response types. We mirror the Go structs by hand here; later we
// may generate from the OpenAPI spec.

import type { FeatureVisibilityMap } from "./featureVisibility";
import type { ChartPalette } from "./palette";

export interface User {
  id: string;
  email: string;
  display_name: string;
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  user: User;
}

export type HouseholdRole = "owner" | "caregiver";

export interface Household {
  id: string;
  name: string;
  role: HouseholdRole;
  created_at: string;
}

// HouseholdMember is the row shape used by the (forthcoming) members
// listing on the settings page. The BE doesn't expose a list endpoint
// today — the FE renders members synthesized from /households for now;
// this type is kept here for the next iteration that adds the dedicated
// endpoint.
export interface HouseholdMember {
  user_id: string;
  display_name: string;
  role: HouseholdRole;
  joined_at: string;
}

// Invite is the owner-visible shape returned by POST /v1/households/{id}/invites
// (with `token` + `invite_url` populated) and GET /v1/households/{id}/invites
// (without — only the short hint is safe to surface in the UI after creation).
export interface Invite {
  // Plaintext token, only present on POST response. Never persisted.
  token?: string;
  // Last 8 chars of the URL-safe token (or the first 6 bytes of the SHA-256
  // hash, rendered base64url, when listing). Safe to log.
  token_hint: string;
  // Full invite URL `<PUBLIC_WEB_ORIGIN>/invite/<token>` for one-tap copy.
  // Only present on POST response.
  invite_url?: string;
  role: HouseholdRole;
  expires_at: string;
  created_at: string;
  created_by: string;
  accepted_at?: string | null;
}

// InviteInfo is the unauthenticated public-lookup shape returned by
// GET /v1/invites/{token}. Deliberately omits the household id and the
// inviter identity — the link itself is the only proof the caller offers.
export interface InviteInfo {
  household_name: string;
  role: HouseholdRole;
  expires_at: string;
}

export interface Baby {
  id: string;
  household_id: string;
  name: string;
  date_of_birth?: string | null;
  sex?: string | null;
  created_at: string;
}

export interface BottleFeed {
  id: string;
  baby_id: string;
  occurred_at: string;
  milk_source: "breast" | "formula";
  amount_ml: number;
  notes?: string | null;
  source: string;
  created_at: string;
}

export type DiaperType = "wet" | "soiled" | "mixed";

export interface Diaper {
  id: string;
  baby_id: string;
  occurred_at: string;
  type: DiaperType;
  notes?: string | null;
  source: string;
  created_at: string;
}

export interface Pumping {
  id: string;
  baby_id: string;
  occurred_at: string;
  amount_ml: number;
  duration_seconds?: number | null;
  notes?: string | null;
  source: string;
  created_at: string;
}

export type NursingSide = "left" | "right" | "both";
export type StartingBreast = "left" | "right";

export interface Nursing {
  id: string;
  baby_id: string;
  started_at: string;
  ended_at?: string | null;
  starting_breast?: StartingBreast | null;
  nursing_side: NursingSide;
  left_duration_s: number;
  right_duration_s: number;
  notes?: string | null;
  source: string;
  created_at: string;
}

export interface Growth {
  id: string;
  baby_id: string;
  measured_at: string;
  weight_g?: number | null;
  height_cm?: number | null;
  head_circumference_cm?: number | null;
  notes?: string | null;
  source: string;
  created_at: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// --- preferences ---

// User-level preferences. Lives in `user_preferences` on the BE; one row
// per user keyed by user_id. The FE only renders `time_format` today
// (charts and recent-row HH:mm strings) but timezone/locale are returned
// in case future surfaces want them.
export interface UserPreferences {
  user_id: string;
  time_format: "24h" | "12h";
  timezone: string;
  locale: string;
  // show_recommended_targets gates the Today banner's per-metric progress
  // bars (which compare today's totals against age-based daily targets).
  // Default true; user can hide bars from the settings screen.
  show_recommended_targets: boolean;
  // chart_palette controls the /charts page series colors. Stored as a
  // JSONB column on user_preferences (migration 000008). The BE column
  // default keeps legacy rows visually identical to the previous
  // hard-coded fills — see lib/palette.ts for the resolve() helper that
  // flattens (preset, overrides) into a concrete color per series.
  chart_palette: ChartPalette;
  // feature_visibility lets the user hide event kinds (bottle / nursing /
  // pumping / diaper / growth) from the Today banner stats, the action
  // tile grid, and the /charts cards. Stored sparsely as JSONB on
  // user_preferences (migration 000009): a key only appears when
  // explicitly hidden, e.g. {"bottle": false}. Missing key ⇒ visible.
  // See lib/featureVisibility.ts for the helper used at every render
  // surface.
  feature_visibility: FeatureVisibilityMap;
  updated_at: string;
}

// Per-baby unit preferences. Lives in `baby_settings` on the BE; one row
// per baby keyed by baby_id. The split (units per-baby, time-format
// per-user) is intentional — see apps/api/migrations/000004 commentary.
export interface BabySettings {
  baby_id: string;
  unit_volume: "ml" | "oz";
  unit_length: "cm" | "in";
  unit_weight: "kg" | "lb";
}

// --- charts ---

// ChartGrowthSnapshot carries the latest non-null reading per metric on a
// given day. Each field is independently nullable (a single growth row can
// record only one metric), and `null` distinguishes "no measurement" from
// "measured as 0" — the FE renders the difference as a broken line vs a
// zero baseline.
export interface ChartGrowthSnapshot {
  weight_g: number | null;
  height_cm: number | null;
  head_cm: number | null;
}

// ChartDaily mirrors the Go `chart.Daily` struct — keep the field names in
// sync. One row per calendar day in the requested timezone.
export interface ChartDaily {
  date: string;
  // bottle_ml is the combined per-day total across milk sources (kept for
  // the summary tile and old-BE compatibility). The per-source fields
  // below split it into breast vs formula so the bottle chart can render
  // a 2-segment stacked bar.
  bottle_ml: number;
  bottle_ml_breast: number;
  bottle_ml_formula: number;
  nursing_minutes: number;
  pumping_ml: number;
  diaper_total: number;
  diaper_wet: number;
  diaper_soiled: number;
  diaper_mixed: number;
  growth: ChartGrowthSnapshot;
}

export interface ChartsDailyResponse {
  days: ChartDaily[];
}
