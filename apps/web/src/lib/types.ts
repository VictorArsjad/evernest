// Server response types. We mirror the Go structs by hand here; later we
// may generate from the OpenAPI spec.

export interface User {
  id: string;
  email: string;
  display_name: string;
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  expires_at: string;
  user: User;
}

export interface Household {
  id: string;
  name: string;
  role: "owner" | "caregiver";
  created_at: string;
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
  bottle_ml: number;
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
