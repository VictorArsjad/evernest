// TanStack Query keys + mutations.
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiQueued } from "./api";
import { useAuthStore } from "./authStore";
import type { FeatureVisibilityMap } from "./featureVisibility";
import { kickAfterReauth } from "./outbox";
import type { ChartPalette } from "./palette";
import type {
  Baby,
  BabySettings,
  BottleFeed,
  ChartsDailyResponse,
  Diaper,
  DiaperType,
  Growth,
  Household,
  HouseholdRole,
  Invite,
  InviteInfo,
  Nursing,
  NursingSide,
  Pumping,
  StartingBreast,
  TokenResponse,
  User,
  UserPreferences,
} from "./types";

// CP6b note: write mutations on the per-baby event kinds use apiQueued
// so they survive an offline window. The hooks generate the row id
// client-side (UUIDv7-shaped via crypto.randomUUID — the BE accepts a
// client-provided id and ON CONFLICT (id) DO NOTHING makes replay
// idempotent) and inject a synthesized row into the cache via
// upsertList so the Today list reflects the user's intent immediately
// even when the network request is queued. When online, the real
// server response replaces the synthetic row on the same id and
// invalidate triggers a refetch in the background; when offline, the
// synthetic row stays until sync() drains and the cache settles.

// makeId: client-generated row id. crypto.randomUUID is everywhere we
// ship (modern browsers + the dev runtime). UUIDv7 ordering would be
// nicer for chart-axis sorting but isn't load-bearing — sorts use
// occurred_at / measured_at / started_at, never the id.
function makeId(): string {
  return crypto.randomUUID();
}

// upsertList — apply a single row update to every cached list query
// whose key has the given prefix. Used by mutation onSuccess to inject
// the new (or just-saved) row without waiting on a network refetch.
// Replace by id when present, prepend otherwise. Keeps the rest of the
// list in its existing order so the user's view doesn't jump.
function upsertList<T extends { id: string }>(
  qc: QueryClient,
  prefix: readonly unknown[],
  row: T,
): void {
  qc.setQueriesData<T[] | undefined>({ queryKey: prefix }, (old) => {
    if (!old) return old;
    const idx = old.findIndex((r) => r.id === row.id);
    if (idx >= 0) {
      const next = old.slice();
      next[idx] = row;
      return next;
    }
    return [row, ...old];
  });
}

// removeFromList — symmetric helper for delete mutations.
function removeFromList<T extends { id: string }>(
  qc: QueryClient,
  prefix: readonly unknown[],
  id: string,
): void {
  qc.setQueriesData<T[] | undefined>({ queryKey: prefix }, (old) => {
    if (!old) return old;
    return old.filter((r) => r.id !== id);
  });
}

// Multi-device sync cadence. Same account on N devices => caregivers
// want a recent edit to show up across phones without manual reload.
// We poll the per-baby lists at LIVE_LIST_REFETCH_MS, the open-nursing
// single-row endpoint a touch faster (it drives a live "in progress"
// chip), and lower-urgency / heavier payloads at HEAVY_REFETCH_MS.
// `refetchIntervalInBackground: false` (set in main.tsx) ensures none
// of these poll while the tab is hidden.
const LIVE_LIST_REFETCH_MS = 15_000;
const OPEN_NURSING_REFETCH_MS = 10_000;
const HEAVY_REFETCH_MS = 5 * 60_000;

// Per-kind list hooks (useBottleFeeds / useDiapers / usePumpings /
// useNursings / useGrowths) accept an optional fourth `opts` arg so
// the History view can request `{ limit: 1000, refetchInterval: false }`
// without spawning a parallel query key per consumer. The default 200
// row cap on the BE would silently truncate a 30-day window for an
// active baby, and polling past data buys nothing — it doesn't change.
// Today / Charts continue to call the hooks with three args and inherit
// the live-poll defaults unchanged.
export interface ListHookOpts {
  limit?: number;
  refetchInterval?: number | false;
}

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
  openNursing: (babyId: string) => ["babies", babyId, "nursing-sessions", "open"] as const,
  growths: (babyId: string, from?: string, to?: string) =>
    ["babies", babyId, "growths", from ?? "", to ?? ""] as const,
  chartsDaily: (babyId: string, from: string, to: string, tz: string) =>
    ["babies", babyId, "charts", "daily", from, to, tz] as const,
  myPreferences: ["me", "preferences"] as const,
  babySettings: (babyId: string) => ["babies", babyId, "settings"] as const,
  invites: (householdId: string) => ["households", householdId, "invites"] as const,
  inviteInfo: (token: string) => ["invites", token] as const,
};

// --- auth ---

export function useRegister() {
  return useMutation({
    mutationFn: (vars: { email: string; password: string; display_name: string }) =>
      api<TokenResponse>("/auth/register", { method: "POST", body: vars, skipAuth: true }),
    onSuccess: (data) => {
      useAuthStore.getState().setSession(data);
      // CP6b: any outbox records that paused on a 401 are now eligible
      // to drain. Clear their soft-wait and re-fire the loop.
      void kickAfterReauth();
    },
  });
}

export function useLogin() {
  return useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      api<TokenResponse>("/auth/login", { method: "POST", body: vars, skipAuth: true }),
    onSuccess: (data) => {
      useAuthStore.getState().setSession(data);
      void kickAfterReauth();
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => {
      // Send the stored refresh token so the BE can revoke this exact
      // session row. We use skipAuth because the access token may already
      // be 401-stale and we don't want the api() refresh dance kicking in
      // for the very call that's supposed to end the session.
      const refresh_token = useAuthStore.getState().refreshToken;
      return api<void>("/auth/logout", {
        method: "POST",
        body: refresh_token ? { refresh_token } : undefined,
        skipAuth: true,
      });
    },
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

// --- invites ---
//
// Invite endpoints split along three TanStack-friendly seams:
//   - useInvites / useCreateInvite / useRevokeInvite live in the settings
//     screen (owner can see / create / revoke).
//   - useInviteInfo + useAcceptInvite power the public redeem route at
//     /invite/$token. useInviteInfo deliberately disables `retry` for
//     401/403/404 globally (set in main.tsx) so an expired or revoked
//     token renders an "invalid link" message immediately.

export function useInvites(householdId: string | null) {
  return useQuery({
    queryKey: householdId ? qk.invites(householdId) : ["households", "none", "invites"],
    enabled: !!householdId,
    queryFn: () => api<Invite[]>(`/households/${householdId}/invites`),
  });
}

export function useCreateInvite(householdId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { role: HouseholdRole; expires_in_hours?: number }) => {
      if (!householdId) throw new Error("missing householdId");
      return api<Invite>(`/households/${householdId}/invites`, {
        method: "POST",
        body: {
          role: vars.role,
          expires_in_hours: vars.expires_in_hours,
        },
      });
    },
    onSuccess: () => {
      if (householdId) qc.invalidateQueries({ queryKey: qk.invites(householdId) });
    },
  });
}

export function useRevokeInvite(householdId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    // Revoke takes the plaintext token. The token is only present in memory
    // on the create response (and again briefly via the create form result
    // before the user navigates away) — for the list view we use the
    // token_hint as a display value and revoke via a hint->token mapping
    // the caller keeps from the create response. In practice the UI only
    // surfaces "revoke" right after create, so we always have the plaintext.
    mutationFn: (vars: { token: string }) =>
      api<void>(`/invites/${vars.token}`, { method: "DELETE" }),
    onSuccess: () => {
      if (householdId) qc.invalidateQueries({ queryKey: qk.invites(householdId) });
    },
  });
}

export function useInviteInfo(token: string | null) {
  return useQuery({
    queryKey: token ? qk.inviteInfo(token) : ["invites", "none"],
    enabled: !!token,
    queryFn: () => api<InviteInfo>(`/invites/${token}`),
    retry: false,
  });
}

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { token: string }) =>
      api<Household>(`/invites/${vars.token}/accept`, { method: "POST" }),
    onSuccess: () => {
      // A successful accept changes the caller's household list (a new
      // membership was added), so blow away the cached households + babies.
      qc.invalidateQueries({ queryKey: qk.households });
      qc.invalidateQueries({ queryKey: ["households"] });
    },
  });
}

// --- bottle feeds ---

export function useBottleFeeds(
  babyId: string | null,
  from?: string,
  to?: string,
  opts?: ListHookOpts,
) {
  return useQuery({
    queryKey: babyId ? qk.bottleFeeds(babyId, from, to) : ["babies", "none", "bottle-feeds"],
    enabled: !!babyId,
    refetchInterval: opts?.refetchInterval ?? LIVE_LIST_REFETCH_MS,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (opts?.limit != null) params.set("limit", String(opts.limit));
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
    }) => {
      const id = makeId();
      const synthetic: BottleFeed = {
        id,
        baby_id: vars.babyId,
        occurred_at: vars.occurred_at,
        milk_source: vars.milk_source,
        amount_ml: vars.amount_ml,
        notes: vars.notes ?? null,
        source: "manual",
        created_at: new Date().toISOString(),
      };
      return apiQueued<BottleFeed>(`/babies/${vars.babyId}/bottle-feeds`, {
        method: "POST",
        body: {
          id,
          occurred_at: vars.occurred_at,
          milk_source: vars.milk_source,
          amount_ml: vars.amount_ml,
          notes: vars.notes || undefined,
        },
        idempotencyKey: id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      // Inject the row (real or synthesized) into every cached
      // bottle-feeds list under this baby so the Today hub updates
      // immediately, even when offline. invalidate triggers a
      // background refetch when online (no-op when offline).
      upsertList<BottleFeed>(qc, ["babies", vars.babyId, "bottle-feeds"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "bottle-feeds"] });
    },
  });
}

export function useDeleteBottleFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      apiQueued<void>(`/bottle-feeds/${vars.id}`, {
        method: "DELETE",
        idempotencyKey: `del-bottle-${vars.id}`,
        synthesize: () => undefined as unknown as void,
      }),
    onSuccess: (_data, vars) => {
      removeFromList<BottleFeed>(qc, ["babies", vars.babyId, "bottle-feeds"], vars.id);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "bottle-feeds"] });
    },
  });
}

// useUpdateBottleFeed sends a partial PATCH. Notes follow the
// "send empty string to clear" convention from the BE handler — the
// FE form converts blank notes into an empty string so the user can
// remove an accidentally-typed note. Synthesize reads the existing
// row out of the cache and merges in the requested edits so the
// optimistic upsert reflects the change even while offline.
export function useUpdateBottleFeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      babyId: string;
      occurred_at?: string;
      milk_source?: "breast" | "formula";
      amount_ml?: number;
      notes?: string;
    }) => {
      const lists = qc.getQueriesData<BottleFeed[] | undefined>({
        queryKey: ["babies", vars.babyId, "bottle-feeds"],
      }) as Array<[unknown, BottleFeed[] | undefined]>;
      const existing = lists
        .flatMap(([, list]) => list ?? [])
        .find((r) => r.id === vars.id);
      const synthetic: BottleFeed = {
        id: vars.id,
        baby_id: existing?.baby_id ?? vars.babyId,
        occurred_at: vars.occurred_at ?? existing?.occurred_at ?? new Date().toISOString(),
        milk_source: vars.milk_source ?? existing?.milk_source ?? "formula",
        amount_ml: vars.amount_ml ?? existing?.amount_ml ?? 0,
        notes:
          vars.notes === undefined
            ? existing?.notes ?? null
            : vars.notes === ""
              ? null
              : vars.notes,
        source: existing?.source ?? "manual",
        created_at: existing?.created_at ?? new Date().toISOString(),
      };
      const body: Record<string, unknown> = {};
      if (vars.occurred_at !== undefined) body.occurred_at = vars.occurred_at;
      if (vars.milk_source !== undefined) body.milk_source = vars.milk_source;
      if (vars.amount_ml !== undefined) body.amount_ml = vars.amount_ml;
      if (vars.notes !== undefined) body.notes = vars.notes;
      return apiQueued<BottleFeed>(`/bottle-feeds/${vars.id}`, {
        method: "PATCH",
        body,
        idempotencyKey: vars.id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      upsertList<BottleFeed>(qc, ["babies", vars.babyId, "bottle-feeds"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "bottle-feeds"] });
    },
  });
}

// --- diapers ---

export function useDiapers(
  babyId: string | null,
  from?: string,
  to?: string,
  opts?: ListHookOpts,
) {
  return useQuery({
    queryKey: babyId ? qk.diapers(babyId, from, to) : ["babies", "none", "diapers"],
    enabled: !!babyId,
    refetchInterval: opts?.refetchInterval ?? LIVE_LIST_REFETCH_MS,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (opts?.limit != null) params.set("limit", String(opts.limit));
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
    }) => {
      const id = makeId();
      const synthetic: Diaper = {
        id,
        baby_id: vars.babyId,
        occurred_at: vars.occurred_at,
        type: vars.type,
        notes: vars.notes ?? null,
        source: "manual",
        created_at: new Date().toISOString(),
      };
      return apiQueued<Diaper>(`/babies/${vars.babyId}/diapers`, {
        method: "POST",
        body: {
          id,
          occurred_at: vars.occurred_at,
          type: vars.type,
          notes: vars.notes || undefined,
        },
        idempotencyKey: id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      upsertList<Diaper>(qc, ["babies", vars.babyId, "diapers"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "diapers"] });
    },
  });
}

export function useDeleteDiaper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      apiQueued<void>(`/diapers/${vars.id}`, {
        method: "DELETE",
        idempotencyKey: `del-diaper-${vars.id}`,
        synthesize: () => undefined as unknown as void,
      }),
    onSuccess: (_data, vars) => {
      removeFromList<Diaper>(qc, ["babies", vars.babyId, "diapers"], vars.id);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "diapers"] });
    },
  });
}

export function useUpdateDiaper() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      babyId: string;
      occurred_at?: string;
      type?: DiaperType;
      notes?: string;
    }) => {
      const lists = qc.getQueriesData<Diaper[] | undefined>({
        queryKey: ["babies", vars.babyId, "diapers"],
      }) as Array<[unknown, Diaper[] | undefined]>;
      const existing = lists
        .flatMap(([, list]) => list ?? [])
        .find((r) => r.id === vars.id);
      const synthetic: Diaper = {
        id: vars.id,
        baby_id: existing?.baby_id ?? vars.babyId,
        occurred_at: vars.occurred_at ?? existing?.occurred_at ?? new Date().toISOString(),
        type: vars.type ?? existing?.type ?? "wet",
        notes:
          vars.notes === undefined
            ? existing?.notes ?? null
            : vars.notes === ""
              ? null
              : vars.notes,
        source: existing?.source ?? "manual",
        created_at: existing?.created_at ?? new Date().toISOString(),
      };
      const body: Record<string, unknown> = {};
      if (vars.occurred_at !== undefined) body.occurred_at = vars.occurred_at;
      if (vars.type !== undefined) body.type = vars.type;
      if (vars.notes !== undefined) body.notes = vars.notes;
      return apiQueued<Diaper>(`/diapers/${vars.id}`, {
        method: "PATCH",
        body,
        idempotencyKey: vars.id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      upsertList<Diaper>(qc, ["babies", vars.babyId, "diapers"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "diapers"] });
    },
  });
}

// --- pumpings ---

export function usePumpings(
  babyId: string | null,
  from?: string,
  to?: string,
  opts?: ListHookOpts,
) {
  return useQuery({
    queryKey: babyId ? qk.pumpings(babyId, from, to) : ["babies", "none", "pumpings"],
    enabled: !!babyId,
    refetchInterval: opts?.refetchInterval ?? LIVE_LIST_REFETCH_MS,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (opts?.limit != null) params.set("limit", String(opts.limit));
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
    }) => {
      const id = makeId();
      const synthetic: Pumping = {
        id,
        baby_id: vars.babyId,
        occurred_at: vars.occurred_at,
        amount_ml: vars.amount_ml,
        duration_seconds: vars.duration_seconds ?? null,
        notes: vars.notes ?? null,
        source: "manual",
        created_at: new Date().toISOString(),
      };
      return apiQueued<Pumping>(`/babies/${vars.babyId}/pumpings`, {
        method: "POST",
        body: {
          id,
          occurred_at: vars.occurred_at,
          amount_ml: vars.amount_ml,
          duration_seconds: vars.duration_seconds,
          notes: vars.notes || undefined,
        },
        idempotencyKey: id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      upsertList<Pumping>(qc, ["babies", vars.babyId, "pumpings"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "pumpings"] });
    },
  });
}

export function useDeletePumping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      apiQueued<void>(`/pumpings/${vars.id}`, {
        method: "DELETE",
        idempotencyKey: `del-pumping-${vars.id}`,
        synthesize: () => undefined as unknown as void,
      }),
    onSuccess: (_data, vars) => {
      removeFromList<Pumping>(qc, ["babies", vars.babyId, "pumpings"], vars.id);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "pumpings"] });
    },
  });
}

export function useUpdatePumping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      babyId: string;
      occurred_at?: string;
      amount_ml?: number;
      duration_seconds?: number;
      notes?: string;
    }) => {
      const lists = qc.getQueriesData<Pumping[] | undefined>({
        queryKey: ["babies", vars.babyId, "pumpings"],
      }) as Array<[unknown, Pumping[] | undefined]>;
      const existing = lists
        .flatMap(([, list]) => list ?? [])
        .find((r) => r.id === vars.id);
      const synthetic: Pumping = {
        id: vars.id,
        baby_id: existing?.baby_id ?? vars.babyId,
        occurred_at: vars.occurred_at ?? existing?.occurred_at ?? new Date().toISOString(),
        amount_ml: vars.amount_ml ?? existing?.amount_ml ?? 0,
        duration_seconds:
          vars.duration_seconds ?? existing?.duration_seconds ?? null,
        notes:
          vars.notes === undefined
            ? existing?.notes ?? null
            : vars.notes === ""
              ? null
              : vars.notes,
        source: existing?.source ?? "manual",
        created_at: existing?.created_at ?? new Date().toISOString(),
      };
      const body: Record<string, unknown> = {};
      if (vars.occurred_at !== undefined) body.occurred_at = vars.occurred_at;
      if (vars.amount_ml !== undefined) body.amount_ml = vars.amount_ml;
      if (vars.duration_seconds !== undefined) body.duration_seconds = vars.duration_seconds;
      if (vars.notes !== undefined) body.notes = vars.notes;
      return apiQueued<Pumping>(`/pumpings/${vars.id}`, {
        method: "PATCH",
        body,
        idempotencyKey: vars.id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      upsertList<Pumping>(qc, ["babies", vars.babyId, "pumpings"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "pumpings"] });
    },
  });
}

// --- nursing sessions ---

export function useNursings(
  babyId: string | null,
  from?: string,
  to?: string,
  opts?: ListHookOpts,
) {
  return useQuery({
    queryKey: babyId ? qk.nursings(babyId, from, to) : ["babies", "none", "nursing-sessions"],
    enabled: !!babyId,
    refetchInterval: opts?.refetchInterval ?? LIVE_LIST_REFETCH_MS,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (opts?.limit != null) params.set("limit", String(opts.limit));
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
      // ended_at + per-side durations are all optional now: omitting all
      // three opens an "in progress" session that the FE later closes via
      // useEndNursing. The server enforces "all three together or none."
      ended_at?: string;
      starting_breast?: StartingBreast;
      nursing_side: NursingSide;
      left_duration_s?: number;
      right_duration_s?: number;
      notes?: string;
    }) => {
      const id = makeId();
      const synthetic: Nursing = {
        id,
        baby_id: vars.babyId,
        started_at: vars.started_at,
        ended_at: vars.ended_at ?? null,
        starting_breast: vars.starting_breast ?? null,
        nursing_side: vars.nursing_side,
        left_duration_s: vars.left_duration_s ?? 0,
        right_duration_s: vars.right_duration_s ?? 0,
        notes: vars.notes ?? null,
        source: "manual",
        created_at: new Date().toISOString(),
      };
      return apiQueued<Nursing>(`/babies/${vars.babyId}/nursing-sessions`, {
        method: "POST",
        body: {
          id,
          started_at: vars.started_at,
          ended_at: vars.ended_at,
          starting_breast: vars.starting_breast,
          nursing_side: vars.nursing_side,
          left_duration_s: vars.left_duration_s,
          right_duration_s: vars.right_duration_s,
          notes: vars.notes || undefined,
        },
        idempotencyKey: id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      upsertList<Nursing>(qc, ["babies", vars.babyId, "nursing-sessions"], data);
      // If we just opened an in-progress session (no ended_at), prime
      // the open-nursing query so the in-progress tile shows up
      // immediately even before the next refetch.
      if (!data.ended_at) {
        qc.setQueryData(qk.openNursing(vars.babyId), data);
      }
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "nursing-sessions"] });
    },
  });
}

// useOpenNursing polls /open for a single in-progress session. The endpoint
// returns 204 when nothing is running (which our api wrapper surfaces as
// `undefined`); we normalize that to `null` so consumers can use a simple
// `data ?? null` check instead of distinguishing undefined-while-loading
// from undefined-because-empty.
export function useOpenNursing(babyId: string | null) {
  return useQuery({
    queryKey: babyId ? qk.openNursing(babyId) : ["babies", "none", "nursing-sessions", "open"],
    enabled: !!babyId,
    // Kept faster than the list refetch so a partner ending the
    // session on another device clears the in-progress tile quickly.
    refetchInterval: OPEN_NURSING_REFETCH_MS,
    queryFn: async () => {
      const data = await api<Nursing | undefined>(`/babies/${babyId}/nursing-sessions/open`);
      return data ?? null;
    },
  });
}

export function useEndNursing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      babyId: string;
      ended_at: string;
      left_duration_s: number;
      right_duration_s: number;
    }) => {
      // Best-effort synthesize by patching whichever cached open-nursing
      // (or list) row carries this id. The fallback covers offline use
      // where we may not have a complete row in cache; the BE response
      // will replace it once sync drains.
      const fromOpen = qc.getQueryData<Nursing | null>(qk.openNursing(vars.babyId));
      const fromList = (
        qc.getQueriesData<Nursing[] | undefined>({
          queryKey: ["babies", vars.babyId, "nursing-sessions"],
        }) as Array<[unknown, Nursing[] | undefined]>
      )
        .flatMap(([, list]) => list ?? [])
        .find((n) => n.id === vars.id);
      const base = fromList ?? fromOpen ?? null;
      const synthetic: Nursing = {
        id: vars.id,
        baby_id: base?.baby_id ?? vars.babyId,
        started_at: base?.started_at ?? new Date().toISOString(),
        ended_at: vars.ended_at,
        starting_breast: base?.starting_breast ?? null,
        nursing_side: base?.nursing_side ?? "both",
        left_duration_s: vars.left_duration_s,
        right_duration_s: vars.right_duration_s,
        notes: base?.notes ?? null,
        source: base?.source ?? "manual",
        created_at: base?.created_at ?? new Date().toISOString(),
      };
      return apiQueued<Nursing>(`/nursing-sessions/${vars.id}`, {
        method: "PATCH",
        body: {
          ended_at: vars.ended_at,
          left_duration_s: vars.left_duration_s,
          right_duration_s: vars.right_duration_s,
        },
        // Use the same row id as the key — re-ending the same session
        // is a no-op server-side (the row is already ended) and the
        // outbox dedupes the second PATCH against the first.
        idempotencyKey: `end-nursing-${vars.id}`,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      // The open-nursing chip should disappear immediately once we've
      // recorded an ended_at, so clear that query and replace the row
      // in the list cache.
      qc.setQueryData(qk.openNursing(vars.babyId), null);
      upsertList<Nursing>(qc, ["babies", vars.babyId, "nursing-sessions"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "nursing-sessions"] });
    },
  });
}

export function useDeleteNursing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      apiQueued<void>(`/nursing-sessions/${vars.id}`, {
        method: "DELETE",
        idempotencyKey: `del-nursing-${vars.id}`,
        synthesize: () => undefined as unknown as void,
      }),
    onSuccess: (_data, vars) => {
      removeFromList<Nursing>(qc, ["babies", vars.babyId, "nursing-sessions"], vars.id);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "nursing-sessions"] });
      // If the deleted row was the currently-open session, drop it.
      const open = qc.getQueryData<Nursing | null>(qk.openNursing(vars.babyId));
      if (open && open.id === vars.id) {
        qc.setQueryData(qk.openNursing(vars.babyId), null);
      }
    },
  });
}

// useUpdateNursing patches a CLOSED nursing session. The BE refuses to
// touch open sessions on the edit path (the close-session PATCH owns
// that transition via useEndNursing). The form should hide the edit
// affordance for open rows, and useNursing-derived caller code can
// assume ended_at is non-null here.
export function useUpdateNursing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      babyId: string;
      started_at?: string;
      ended_at?: string;
      starting_breast?: StartingBreast;
      clear_starting_breast?: boolean;
      nursing_side?: NursingSide;
      left_duration_s?: number;
      right_duration_s?: number;
      notes?: string;
    }) => {
      const lists = qc.getQueriesData<Nursing[] | undefined>({
        queryKey: ["babies", vars.babyId, "nursing-sessions"],
      }) as Array<[unknown, Nursing[] | undefined]>;
      const existing = lists
        .flatMap(([, list]) => list ?? [])
        .find((r) => r.id === vars.id);
      const synthetic: Nursing = {
        id: vars.id,
        baby_id: existing?.baby_id ?? vars.babyId,
        started_at: vars.started_at ?? existing?.started_at ?? new Date().toISOString(),
        ended_at: vars.ended_at ?? existing?.ended_at ?? null,
        starting_breast: vars.clear_starting_breast
          ? null
          : vars.starting_breast ?? existing?.starting_breast ?? null,
        nursing_side: vars.nursing_side ?? existing?.nursing_side ?? "both",
        left_duration_s: vars.left_duration_s ?? existing?.left_duration_s ?? 0,
        right_duration_s: vars.right_duration_s ?? existing?.right_duration_s ?? 0,
        notes:
          vars.notes === undefined
            ? existing?.notes ?? null
            : vars.notes === ""
              ? null
              : vars.notes,
        source: existing?.source ?? "manual",
        created_at: existing?.created_at ?? new Date().toISOString(),
      };
      const body: Record<string, unknown> = {};
      if (vars.started_at !== undefined) body.started_at = vars.started_at;
      if (vars.ended_at !== undefined) body.ended_at = vars.ended_at;
      if (vars.starting_breast !== undefined) body.starting_breast = vars.starting_breast;
      if (vars.clear_starting_breast) body.clear_starting_breast = true;
      if (vars.nursing_side !== undefined) body.nursing_side = vars.nursing_side;
      if (vars.left_duration_s !== undefined) body.left_duration_s = vars.left_duration_s;
      if (vars.right_duration_s !== undefined) body.right_duration_s = vars.right_duration_s;
      if (vars.notes !== undefined) body.notes = vars.notes;
      return apiQueued<Nursing>(`/nursing-sessions/${vars.id}`, {
        method: "PATCH",
        body,
        idempotencyKey: vars.id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      upsertList<Nursing>(qc, ["babies", vars.babyId, "nursing-sessions"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "nursing-sessions"] });
    },
  });
}

// --- growths ---

export function useGrowths(
  babyId: string | null,
  from?: string,
  to?: string,
  opts?: ListHookOpts,
) {
  return useQuery({
    queryKey: babyId ? qk.growths(babyId, from, to) : ["babies", "none", "growths"],
    enabled: !!babyId,
    refetchInterval: opts?.refetchInterval ?? HEAVY_REFETCH_MS,
    queryFn: () => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (opts?.limit != null) params.set("limit", String(opts.limit));
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
    }) => {
      const id = makeId();
      const synthetic: Growth = {
        id,
        baby_id: vars.babyId,
        measured_at: vars.measured_at,
        weight_g: vars.weight_g ?? null,
        height_cm: vars.height_cm ?? null,
        head_circumference_cm: vars.head_circumference_cm ?? null,
        notes: vars.notes ?? null,
        source: "manual",
        created_at: new Date().toISOString(),
      };
      return apiQueued<Growth>(`/babies/${vars.babyId}/growths`, {
        method: "POST",
        body: {
          id,
          measured_at: vars.measured_at,
          weight_g: vars.weight_g,
          height_cm: vars.height_cm,
          head_circumference_cm: vars.head_circumference_cm,
          notes: vars.notes || undefined,
        },
        idempotencyKey: id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      upsertList<Growth>(qc, ["babies", vars.babyId, "growths"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "growths"] });
    },
  });
}

export function useDeleteGrowth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; babyId: string }) =>
      apiQueued<void>(`/growths/${vars.id}`, {
        method: "DELETE",
        idempotencyKey: `del-growth-${vars.id}`,
        synthesize: () => undefined as unknown as void,
      }),
    onSuccess: (_data, vars) => {
      removeFromList<Growth>(qc, ["babies", vars.babyId, "growths"], vars.id);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "growths"] });
    },
  });
}

// useUpdateGrowth supports explicit per-measurement clearing via
// the BE's clear_* flags. The growth form passes the clear flag when
// the user empties an input that previously held a value.
export function useUpdateGrowth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      babyId: string;
      measured_at?: string;
      weight_g?: number;
      clear_weight_g?: boolean;
      height_cm?: number;
      clear_height_cm?: boolean;
      head_circumference_cm?: number;
      clear_head_circumference_cm?: boolean;
      notes?: string;
    }) => {
      const lists = qc.getQueriesData<Growth[] | undefined>({
        queryKey: ["babies", vars.babyId, "growths"],
      }) as Array<[unknown, Growth[] | undefined]>;
      const existing = lists
        .flatMap(([, list]) => list ?? [])
        .find((r) => r.id === vars.id);
      const synthetic: Growth = {
        id: vars.id,
        baby_id: existing?.baby_id ?? vars.babyId,
        measured_at: vars.measured_at ?? existing?.measured_at ?? new Date().toISOString(),
        weight_g: vars.clear_weight_g
          ? null
          : vars.weight_g ?? existing?.weight_g ?? null,
        height_cm: vars.clear_height_cm
          ? null
          : vars.height_cm ?? existing?.height_cm ?? null,
        head_circumference_cm: vars.clear_head_circumference_cm
          ? null
          : vars.head_circumference_cm ?? existing?.head_circumference_cm ?? null,
        notes:
          vars.notes === undefined
            ? existing?.notes ?? null
            : vars.notes === ""
              ? null
              : vars.notes,
        source: existing?.source ?? "manual",
        created_at: existing?.created_at ?? new Date().toISOString(),
      };
      const body: Record<string, unknown> = {};
      if (vars.measured_at !== undefined) body.measured_at = vars.measured_at;
      if (vars.weight_g !== undefined) body.weight_g = vars.weight_g;
      if (vars.clear_weight_g) body.clear_weight_g = true;
      if (vars.height_cm !== undefined) body.height_cm = vars.height_cm;
      if (vars.clear_height_cm) body.clear_height_cm = true;
      if (vars.head_circumference_cm !== undefined) body.head_circumference_cm = vars.head_circumference_cm;
      if (vars.clear_head_circumference_cm) body.clear_head_circumference_cm = true;
      if (vars.notes !== undefined) body.notes = vars.notes;
      return apiQueued<Growth>(`/growths/${vars.id}`, {
        method: "PATCH",
        body,
        idempotencyKey: vars.id,
        synthesize: () => synthetic,
      });
    },
    onSuccess: (data, vars) => {
      upsertList<Growth>(qc, ["babies", vars.babyId, "growths"], data);
      qc.invalidateQueries({ queryKey: ["babies", vars.babyId, "growths"] });
    },
  });
}

// --- preferences (user + per-baby settings) ---

// useMyPreferences fetches the per-user prefs row (time_format, tz,
// locale). Defaults are seeded on user-create so this query should never
// 404 in practice; the BE also lazily seeds-on-read as a safety net.
export function useMyPreferences() {
  return useQuery({
    queryKey: qk.myPreferences,
    queryFn: () => api<UserPreferences>("/me/preferences"),
  });
}

export function useUpdateMyPreferences() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      time_format: "24h" | "12h";
      timezone: string;
      locale: string;
      // Today-banner progress-bar toggle. Server defaults to true on
      // user-create, but the FE always sends the current value on PUT
      // since the endpoint is full-replace (not PATCH).
      show_recommended_targets: boolean;
      // chart_palette is required by the BE — the PUT handler rejects
      // payloads missing it. Callers must always read the current value
      // (via useMyPreferences) and round-trip it on every save, even
      // when the field they're toggling is unrelated.
      chart_palette: ChartPalette;
      // feature_visibility follows the same "always round-trip" rule as
      // chart_palette: required by the BE, sparse on the wire (an empty
      // {} means no features hidden). Callers read the current value
      // from useMyPreferences and pass it back on every save.
      feature_visibility: FeatureVisibilityMap;
    }) => api<UserPreferences>("/me/preferences", { method: "PUT", body: vars }),
    onSuccess: (data) => qc.setQueryData(qk.myPreferences, data),
  });
}

// useBabySettings fetches the per-baby unit prefs (volume/length/weight).
// `babyId` is nullable because the Today/charts shell mounts before the
// active baby resolves; the query stays disabled until then so we don't
// spam a 400.
export function useBabySettings(babyId: string | null) {
  return useQuery({
    queryKey: babyId ? qk.babySettings(babyId) : ["babies", "none", "settings"],
    enabled: !!babyId,
    queryFn: () => api<BabySettings>(`/babies/${babyId}/settings`),
  });
}

export function useUpdateBabySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      babyId: string;
      unit_volume: "ml" | "oz";
      unit_length: "cm" | "in";
      unit_weight: "kg" | "lb";
    }) =>
      api<BabySettings>(`/babies/${vars.babyId}/settings`, {
        method: "PUT",
        body: {
          unit_volume: vars.unit_volume,
          unit_length: vars.unit_length,
          unit_weight: vars.unit_weight,
        },
      }),
    onSuccess: (data, vars) => qc.setQueryData(qk.babySettings(vars.babyId), data),
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
    refetchInterval: HEAVY_REFETCH_MS,
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
