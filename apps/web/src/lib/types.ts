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
