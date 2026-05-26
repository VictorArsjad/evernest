// TanStack Query keys + mutations.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useAuthStore } from "./authStore";
import type {
  Baby,
  BottleFeed,
  ChartsDailyResponse,
  Diaper,
  DiaperType,
  Growth,
  Household,
  Nursing,
  NursingSide,
  Pumping,
  StartingBreast,
  TokenResponse,
  User,
} from "./types";

export const qk = {
  me: ["me"] as const,
  households: ["households"] as const,
  babies: (householdId: string) => ["households", householdId, "babies"] as const,
  bottleFeeds: (babyId: string, from?: string, to?: string) =>
    ["babies", babyId, "bottle-feeds", from ?? "", to ?? ""] as const,
  diapers: (babyId: string, from?: string, to?: string) =>
    ["babies", babyId, "diapers", from ?? "", to ?? ""] as const,
  pumpings: (babyId: string, from?: string, to?: string) =>
    ["babies", babyId, "pumpings", from ?? "", to ?? ""] as const,
  nursings: (babyId: string, from?: string, to?: string) =>
    ["babies", babyId, "nursing-sessions", from ?? "", to ?? ""] as const,
  growths: (babyId: string, from?: string, to?: string) =>
    ["babies", babyId, "growths", from ?? "", to ?? ""] as const,
  chartsDaily: (babyId: string, from: string, to: string, tz: string) =>
    ["babies", babyId, "charts", "daily", from, to, tz] as const,
};

// --- auth ---

export function useRegister() {
  return useMutation({
    mutationFn: (vars: { email: string; password: string; display_name: string }) =>
      api<TokenResponse>("/auth/register", { method: "POST", body: vars, skipAuth: true }),
    onSuccess: (data) => useAuthStore.getState().setSession(data),
  });
}

export function useLogin() {
  return useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      api<TokenResponse>("/auth/login", { method: "POST", body: vars, skipAuth: true }),
    onSuccess: (data) => useAuthStore.getState().setSession(data),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/auth/logout", { method: "POST" }),
    onSettled: () => {
      useAuthStore.getState().clear();
      qc.clear();
    },
  });
}

// --- households / babies ---

export function useMe() {
  return useQuery({ queryKey: qk.me, queryFn: () => api<User>("/me") });
}

export function useHouseholds() {
  return useQuery({ queryKey: qk.households, queryFn: () => api<Household[]>("/households") });
}

export function useCreateHousehold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { name: string }) =>
      api<Household>("/households", { method: "POST", body: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.households }),
  });
}

export function useBabies(householdId: string | null) {
  return useQuery({
    queryKey: householdId ? qk.babies(householdId) : ["households", "none", "babies"],
    enabled: !!householdId,
    queryFn: () => api<Baby[]>(`/households/${householdId}/babies`),
  });
}

export function useCreateBaby() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { householdId: string; name: string; date_of_birth?: string; sex?: string }) =>
      api<Baby>(`/households/${vars.householdId}/babies`, {
        method: "POST",
        body: { name: vars.name, date_of_birth: vars.date_of_birth, sex: vars.sex },
      }),
    onSuccess: (_data, vars) => qc.invalidateQueries({ queryKey: qk.babies(vars.householdId) }),
  });
}

// --- bottle feeds ---

export function useBottleFeeds(babyId: string | null, from?: string, to?: string) {
  return useQuery({
    queryKey: babyId ? qk.bottleFeeds(babyId, from, to) : ["babies", "none", "bottle-feeds"],
    enabled: !!babyId,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return api<BottleFeed[]>(`/babies/${babyId}/bottle-feeds${qs ? `?${qs}` : ""}`);
    },
  });
}

export function useCreateBottleFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      babyId: string;
      occurred_at: string;
      milk_source: "breast" | "formula";
      amount_ml: number;
      notes?: string;
    }) =>
      api<BottleFeed>(`/babies/${vars.babyId}/bottle-feeds`, {
        method: "POST",
        body: {
          occurred_at: vars.occurred_at,
          milk_source: vars.milk_source,
          amount_ml: vars.amount_ml,
          notes: vars.notes || undefined,
        },
      }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "bottle-feeds"] }),
  });
}

export function useDeleteBottleFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      api<void>(`/bottle-feeds/${vars.id}`, { method: "DELETE" }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "bottle-feeds"] }),
  });
}

// --- diapers ---

export function useDiapers(babyId: string | null, from?: string, to?: string) {
  return useQuery({
    queryKey: babyId ? qk.diapers(babyId, from, to) : ["babies", "none", "diapers"],
    enabled: !!babyId,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return api<Diaper[]>(`/babies/${babyId}/diapers${qs ? `?${qs}` : ""}`);
    },
  });
}

export function useCreateDiaper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      babyId: string;
      occurred_at: string;
      type: DiaperType;
      notes?: string;
    }) =>
      api<Diaper>(`/babies/${vars.babyId}/diapers`, {
        method: "POST",
        body: {
          occurred_at: vars.occurred_at,
          type: vars.type,
          notes: vars.notes || undefined,
        },
      }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "diapers"] }),
  });
}

export function useDeleteDiaper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      api<void>(`/diapers/${vars.id}`, { method: "DELETE" }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "diapers"] }),
  });
}

// --- pumpings ---

export function usePumpings(babyId: string | null, from?: string, to?: string) {
  return useQuery({
    queryKey: babyId ? qk.pumpings(babyId, from, to) : ["babies", "none", "pumpings"],
    enabled: !!babyId,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return api<Pumping[]>(`/babies/${babyId}/pumpings${qs ? `?${qs}` : ""}`);
    },
  });
}

export function useCreatePumping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      babyId: string;
      occurred_at: string;
      amount_ml: number;
      duration_seconds?: number;
      notes?: string;
    }) =>
      api<Pumping>(`/babies/${vars.babyId}/pumpings`, {
        method: "POST",
        body: {
          occurred_at: vars.occurred_at,
          amount_ml: vars.amount_ml,
          duration_seconds: vars.duration_seconds,
          notes: vars.notes || undefined,
        },
      }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "pumpings"] }),
  });
}

export function useDeletePumping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      api<void>(`/pumpings/${vars.id}`, { method: "DELETE" }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "pumpings"] }),
  });
}

// --- nursing sessions ---

export function useNursings(babyId: string | null, from?: string, to?: string) {
  return useQuery({
    queryKey: babyId ? qk.nursings(babyId, from, to) : ["babies", "none", "nursing-sessions"],
    enabled: !!babyId,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return api<Nursing[]>(`/babies/${babyId}/nursing-sessions${qs ? `?${qs}` : ""}`);
    },
  });
}

export function useCreateNursing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      babyId: string;
      started_at: string;
      ended_at?: string;
      starting_breast?: StartingBreast;
      nursing_side: NursingSide;
      left_duration_s: number;
      right_duration_s: number;
      notes?: string;
    }) =>
      api<Nursing>(`/babies/${vars.babyId}/nursing-sessions`, {
        method: "POST",
        body: {
          started_at: vars.started_at,
          ended_at: vars.ended_at,
          starting_breast: vars.starting_breast,
          nursing_side: vars.nursing_side,
          left_duration_s: vars.left_duration_s,
          right_duration_s: vars.right_duration_s,
          notes: vars.notes || undefined,
        },
      }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "nursing-sessions"] }),
  });
}

export function useDeleteNursing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      api<void>(`/nursing-sessions/${vars.id}`, { method: "DELETE" }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "nursing-sessions"] }),
  });
}

// --- growths ---

export function useGrowths(babyId: string | null, from?: string, to?: string) {
  return useQuery({
    queryKey: babyId ? qk.growths(babyId, from, to) : ["babies", "none", "growths"],
    enabled: !!babyId,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const qs = params.toString();
      return api<Growth[]>(`/babies/${babyId}/growths${qs ? `?${qs}` : ""}`);
    },
  });
}

export function useCreateGrowth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      babyId: string;
      measured_at: string;
      weight_g?: number;
      height_cm?: number;
      head_circumference_cm?: number;
      notes?: string;
    }) =>
      api<Growth>(`/babies/${vars.babyId}/growths`, {
        method: "POST",
        body: {
          measured_at: vars.measured_at,
          weight_g: vars.weight_g,
          height_cm: vars.height_cm,
          head_circumference_cm: vars.head_circumference_cm,
          notes: vars.notes || undefined,
        },
      }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "growths"] }),
  });
}

export function useDeleteGrowth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      api<void>(`/growths/${vars.id}`, { method: "DELETE" }),
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "growths"] }),
  });
}

// --- charts ---

// useDailyCharts pulls the unified daily-aggregations endpoint that powers
// the /charts screen. `from`/`to` are YYYY-MM-DD strings interpreted in
// `tz` (an IANA timezone name). The query is disabled until babyId + both
// dates are present so the FE can mount the route before defaults resolve.
export function useDailyCharts(
  babyId: string | null,
  from: string | null,
  to: string | null,
  tz: string,
) {
  const enabled = !!babyId && !!from && !!to;
  return useQuery({
    queryKey: enabled
      ? qk.chartsDaily(babyId as string, from as string, to as string, tz)
      : ["babies", "none", "charts", "daily"],
    enabled,
    queryFn: () => {
      const params = new URLSearchParams({
        from: from as string,
        to: to as string,
        tz,
      });
      return api<ChartsDailyResponse>(
        `/babies/${babyId}/charts/daily?${params.toString()}`,
      );
    },
  });
}
