// Server response types. We mirror the Go structs by hand here for CP1; later
// we may generate from the OpenAPI spec.

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

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
