// TanStack Query keys + mutations.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useAuthStore } from "./authStore";
import type { Baby, BottleFeed, Household, TokenResponse, User } from "./types";

export const qk = {
  me: ["me"] as const,
  households: ["households"] as const,
  babies: (householdId: string) => ["households", householdId, "babies"] as const,
  bottleFeeds: (babyId: string, from?: string, to?: string) =>
    ["babies", babyId, "bottle-feeds", from ?? "", to ?? ""] as const,
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
