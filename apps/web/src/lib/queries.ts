// TanStack Query keys + mutations.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useAuthStore } from "./authStore";
import type { FeatureVisibilityMap } from "./featureVisibility";
import {
  createdPhoto,
  createPhotoBody,
  defineEventKind,
  definePhotoUrl,
  editedText,
  HEAVY_REFETCH_MS,
  listKeyFor,
  LIVE_LIST_REFETCH_MS,
  openKeyFor,
  type ListHookOpts,
  newRowBase,
  patchBody,
  type PhotoVars,
  updatedPhoto,
  updatedRowBase,
  updatePhotoBody,
} from "./eventKind";
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
  Note,
  Nursing,
  NursingSide,
  Pumping,
  Sleep,
  SleepType,
  SolidMeal,
  SolidMealReaction,
  StartingBreast,
  TokenResponse,
  User,
  UserPreferences,
} from "./types";

// TanStack Query keys + hooks. The per-baby event kinds (bottle, diaper,
// solids, note, pumping, nursing, sleep, growth) are descriptors fed to
// defineEventKind in lib/eventKind.ts; the hooks below are its output, kept
// under the names the routes import.

export type { ListHookOpts };

export const qk = {
  me: ["me"] as const,
  households: ["households"] as const,
  babies: (householdId: string) => ["households", householdId, "babies"] as const,
  bottleFeeds: listKeyFor("bottle-feeds"),
  diapers: listKeyFor("diapers"),
  pumpings: listKeyFor("pumpings"),
  nursings: listKeyFor("nursing-sessions"),
  openNursing: openKeyFor("nursing-sessions"),
  growths: listKeyFor("growths"),
  sleeps: listKeyFor("sleeps"),
  openSleep: openKeyFor("sleeps"),
  notes: listKeyFor("notes"),
  solidMeals: listKeyFor("solid-meals"),
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
    mutationFn: () =>
      // The first-party refresh cookie identifies the session to revoke;
      // `credentials: 'include'` sends it. skipAuth because the access
      // token may already be 401-stale and we don't want the api() refresh
      // dance kicking in for the very call that's supposed to end the
      // session.
      api<void>("/auth/logout", {
        method: "POST",
        skipAuth: true,
        credentials: "include",
      }),
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

interface CreateBottleFeedVars {
  babyId: string;
  occurred_at: string;
  milk_source: "breast" | "formula";
  amount_ml: number;
  notes?: string;
}

// Notes follow the "send empty string to clear" convention from the BE
// handler — the FE form converts blank notes into an empty string so the
// user can remove an accidentally-typed note.
interface UpdateBottleFeedVars {
  id: string;
  babyId: string;
  occurred_at?: string;
  milk_source?: "breast" | "formula";
  amount_ml?: number;
  notes?: string;
}

const bottle = defineEventKind<BottleFeed, CreateBottleFeedVars, UpdateBottleFeedVars>({
  segment: "bottle-feeds",
  itemPath: "/bottle-feeds",
  deleteKeyPrefix: "del-bottle-",
  refetchMs: LIVE_LIST_REFETCH_MS,
  createRow: (vars, id) => ({
    ...newRowBase(id, vars.babyId),
    occurred_at: vars.occurred_at,
    milk_source: vars.milk_source,
    amount_ml: vars.amount_ml,
    notes: vars.notes ?? null,
  }),
  createBody: (vars, id) => ({
    id,
    occurred_at: vars.occurred_at,
    milk_source: vars.milk_source,
    amount_ml: vars.amount_ml,
    notes: vars.notes || undefined,
  }),
  updateRow: (vars, existing) => ({
    ...updatedRowBase(vars.id, vars.babyId, existing),
    occurred_at: vars.occurred_at ?? existing?.occurred_at ?? new Date().toISOString(),
    milk_source: vars.milk_source ?? existing?.milk_source ?? "formula",
    amount_ml: vars.amount_ml ?? existing?.amount_ml ?? 0,
    notes: editedText(vars.notes, existing?.notes),
  }),
  updateBody: (vars) => patchBody(vars, ["occurred_at", "milk_source", "amount_ml", "notes"]),
});

export const useBottleFeeds = bottle.useList;
export const useCreateBottleFeed = bottle.useCreate;
export const useUpdateBottleFeed = bottle.useUpdate;
export const useDeleteBottleFeed = bottle.useDelete;

// --- diapers ---

interface CreateDiaperVars extends PhotoVars {
  babyId: string;
  occurred_at: string;
  type: DiaperType;
  notes?: string;
}

interface UpdateDiaperVars extends PhotoVars {
  id: string;
  babyId: string;
  occurred_at?: string;
  type?: DiaperType;
  notes?: string;
}

const diaper = defineEventKind<Diaper, CreateDiaperVars, UpdateDiaperVars>({
  segment: "diapers",
  itemPath: "/diapers",
  deleteKeyPrefix: "del-diaper-",
  refetchMs: LIVE_LIST_REFETCH_MS,
  createRow: (vars, id) => ({
    ...newRowBase(id, vars.babyId),
    occurred_at: vars.occurred_at,
    type: vars.type,
    notes: vars.notes ?? null,
    ...createdPhoto(vars),
  }),
  createBody: (vars, id) => ({
    id,
    occurred_at: vars.occurred_at,
    type: vars.type,
    notes: vars.notes || undefined,
    ...createPhotoBody(vars),
  }),
  updateRow: (vars, existing) => ({
    ...updatedRowBase(vars.id, vars.babyId, existing),
    occurred_at: vars.occurred_at ?? existing?.occurred_at ?? new Date().toISOString(),
    type: vars.type ?? existing?.type ?? "wet",
    notes: editedText(vars.notes, existing?.notes),
    ...updatedPhoto(vars, existing),
  }),
  updateBody: (vars) => ({ ...patchBody(vars, ["occurred_at", "type", "notes"]), ...updatePhotoBody(vars) }),
});

export const useDiapers = diaper.useList;
export const useCreateDiaper = diaper.useCreate;
export const useUpdateDiaper = diaper.useUpdate;
export const useDeleteDiaper = diaper.useDelete;
export const useDiaperPhotoUrl = definePhotoUrl(diaper);

// --- solid meals ---

interface CreateSolidMealVars extends PhotoVars {
  babyId: string;
  occurred_at: string;
  foods: string[];
  reaction?: SolidMealReaction | null;
  amount_g?: number | null;
  notes?: string;
}

interface UpdateSolidMealVars extends PhotoVars {
  id: string;
  babyId: string;
  occurred_at?: string;
  foods?: string[];
  // undefined = leave; null / "" = clear
  reaction?: SolidMealReaction | null | "";
  amount_g?: number | null;
  clear_amount_g?: boolean;
  notes?: string;
}

const solidMeal = defineEventKind<SolidMeal, CreateSolidMealVars, UpdateSolidMealVars>({
  segment: "solid-meals",
  itemPath: "/solid-meals",
  deleteKeyPrefix: "del-solid-meal-",
  refetchMs: LIVE_LIST_REFETCH_MS,
  createRow: (vars, id) => ({
    ...newRowBase(id, vars.babyId),
    occurred_at: vars.occurred_at,
    foods: vars.foods,
    reaction: vars.reaction ?? null,
    amount_g: vars.amount_g ?? null,
    notes: vars.notes ?? null,
    ...createdPhoto(vars),
  }),
  createBody: (vars, id) => {
    const body: Record<string, unknown> = {
      id,
      occurred_at: vars.occurred_at,
      foods: vars.foods,
    };
    if (vars.reaction) body.reaction = vars.reaction;
    if (vars.amount_g != null) body.amount_g = vars.amount_g;
    if (vars.notes) body.notes = vars.notes;
    return { ...body, ...createPhotoBody(vars) };
  },
  updateRow: (vars, existing) => {
    let reaction: SolidMealReaction | null | undefined = existing?.reaction ?? null;
    if (vars.reaction === "" || vars.reaction === null) {
      reaction = null;
    } else if (vars.reaction !== undefined) {
      reaction = vars.reaction;
    }

    let amount: number | null | undefined = existing?.amount_g ?? null;
    if (vars.clear_amount_g) {
      amount = null;
    } else if (vars.amount_g !== undefined) {
      amount = vars.amount_g;
    }

    return {
      ...updatedRowBase(vars.id, vars.babyId, existing),
      occurred_at: vars.occurred_at ?? existing?.occurred_at ?? new Date().toISOString(),
      foods: vars.foods ?? existing?.foods ?? [],
      reaction: reaction ?? null,
      amount_g: amount ?? null,
      notes: editedText(vars.notes, existing?.notes),
      ...updatedPhoto(vars, existing),
    };
  },
  updateBody: (vars) => {
    const body: Record<string, unknown> = {};
    if (vars.occurred_at !== undefined) body.occurred_at = vars.occurred_at;
    if (vars.foods !== undefined) body.foods = vars.foods;
    if (vars.reaction !== undefined) body.reaction = vars.reaction === null ? "" : vars.reaction;
    if (vars.clear_amount_g) body.clear_amount_g = true;
    else if (vars.amount_g !== undefined && vars.amount_g !== null) body.amount_g = vars.amount_g;
    if (vars.notes !== undefined) body.notes = vars.notes;
    return { ...body, ...updatePhotoBody(vars) };
  },
});

export const useSolidMeals = solidMeal.useList;
export const useCreateSolidMeal = solidMeal.useCreate;
export const useUpdateSolidMeal = solidMeal.useUpdate;
export const useDeleteSolidMeal = solidMeal.useDelete;
export const useSolidMealPhotoUrl = definePhotoUrl(solidMeal);

// --- notes ---

interface CreateNoteVars extends PhotoVars {
  babyId: string;
  occurred_at: string;
  body: string;
}

interface UpdateNoteVars extends PhotoVars {
  id: string;
  babyId: string;
  occurred_at?: string;
  body?: string;
}

const note = defineEventKind<Note, CreateNoteVars, UpdateNoteVars>({
  segment: "notes",
  itemPath: "/notes",
  deleteKeyPrefix: "del-note-",
  refetchMs: LIVE_LIST_REFETCH_MS,
  createRow: (vars, id) => ({
    ...newRowBase(id, vars.babyId),
    occurred_at: vars.occurred_at,
    body: vars.body,
    ...createdPhoto(vars),
  }),
  createBody: (vars, id) => ({
    id,
    occurred_at: vars.occurred_at,
    body: vars.body,
    ...createPhotoBody(vars),
  }),
  updateRow: (vars, existing) => ({
    ...updatedRowBase(vars.id, vars.babyId, existing),
    occurred_at: vars.occurred_at ?? existing?.occurred_at ?? new Date().toISOString(),
    body: vars.body ?? existing?.body ?? "",
    ...updatedPhoto(vars, existing),
  }),
  updateBody: (vars) => ({ ...patchBody(vars, ["occurred_at", "body"]), ...updatePhotoBody(vars) }),
});

export const useNotes = note.useList;
export const useCreateNote = note.useCreate;
export const useUpdateNote = note.useUpdate;
export const useDeleteNote = note.useDelete;
export const useNotePhotoUrl = definePhotoUrl(note);

// --- pumpings ---

interface CreatePumpingVars {
  babyId: string;
  occurred_at: string;
  amount_ml: number;
  duration_seconds?: number;
  notes?: string;
}

interface UpdatePumpingVars {
  id: string;
  babyId: string;
  occurred_at?: string;
  amount_ml?: number;
  duration_seconds?: number;
  notes?: string;
}

const pumping = defineEventKind<Pumping, CreatePumpingVars, UpdatePumpingVars>({
  segment: "pumpings",
  itemPath: "/pumpings",
  deleteKeyPrefix: "del-pumping-",
  refetchMs: LIVE_LIST_REFETCH_MS,
  createRow: (vars, id) => ({
    ...newRowBase(id, vars.babyId),
    occurred_at: vars.occurred_at,
    amount_ml: vars.amount_ml,
    duration_seconds: vars.duration_seconds ?? null,
    notes: vars.notes ?? null,
  }),
  createBody: (vars, id) => ({
    id,
    occurred_at: vars.occurred_at,
    amount_ml: vars.amount_ml,
    duration_seconds: vars.duration_seconds,
    notes: vars.notes || undefined,
  }),
  updateRow: (vars, existing) => ({
    ...updatedRowBase(vars.id, vars.babyId, existing),
    occurred_at: vars.occurred_at ?? existing?.occurred_at ?? new Date().toISOString(),
    amount_ml: vars.amount_ml ?? existing?.amount_ml ?? 0,
    duration_seconds: vars.duration_seconds ?? existing?.duration_seconds ?? null,
    notes: editedText(vars.notes, existing?.notes),
  }),
  updateBody: (vars) => patchBody(vars, ["occurred_at", "amount_ml", "duration_seconds", "notes"]),
});

export const usePumpings = pumping.useList;
export const useCreatePumping = pumping.useCreate;
export const useUpdatePumping = pumping.useUpdate;
export const useDeletePumping = pumping.useDelete;

// --- nursing sessions ---

interface CreateNursingVars {
  babyId: string;
  started_at: string;
  // ended_at + per-side durations are all optional now: omitting all three
  // opens an "in progress" session that the FE later closes via
  // useEndNursing. The server enforces "all three together or none."
  ended_at?: string;
  starting_breast?: StartingBreast;
  nursing_side: NursingSide;
  left_duration_s?: number;
  right_duration_s?: number;
  notes?: string;
}

// Patches a CLOSED nursing session. The BE refuses to touch open sessions on
// the edit path (the close-session PATCH owns that transition via
// useEndNursing). The form should hide the edit affordance for open rows, and
// caller code can assume ended_at is non-null here.
interface UpdateNursingVars {
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
}

interface EndNursingVars {
  id: string;
  babyId: string;
  ended_at: string;
  left_duration_s: number;
  right_duration_s: number;
}

const nursing = defineEventKind<Nursing, CreateNursingVars, UpdateNursingVars, EndNursingVars>({
  segment: "nursing-sessions",
  itemPath: "/nursing-sessions",
  deleteKeyPrefix: "del-nursing-",
  refetchMs: LIVE_LIST_REFETCH_MS,
  open: {
    endKeyPrefix: "end-nursing-",
    endBody: (vars) => ({
      ended_at: vars.ended_at,
      left_duration_s: vars.left_duration_s,
      right_duration_s: vars.right_duration_s,
    }),
    endRow: (vars, base) => ({
      ...updatedRowBase(vars.id, vars.babyId, base ?? undefined),
      started_at: base?.started_at ?? new Date().toISOString(),
      ended_at: vars.ended_at,
      starting_breast: base?.starting_breast ?? null,
      nursing_side: base?.nursing_side ?? "both",
      left_duration_s: vars.left_duration_s,
      right_duration_s: vars.right_duration_s,
      notes: base?.notes ?? null,
    }),
  },
  createRow: (vars, id) => ({
    ...newRowBase(id, vars.babyId),
    started_at: vars.started_at,
    ended_at: vars.ended_at ?? null,
    starting_breast: vars.starting_breast ?? null,
    nursing_side: vars.nursing_side,
    left_duration_s: vars.left_duration_s ?? 0,
    right_duration_s: vars.right_duration_s ?? 0,
    notes: vars.notes ?? null,
  }),
  createBody: (vars, id) => ({
    id,
    started_at: vars.started_at,
    ended_at: vars.ended_at,
    starting_breast: vars.starting_breast,
    nursing_side: vars.nursing_side,
    left_duration_s: vars.left_duration_s,
    right_duration_s: vars.right_duration_s,
    notes: vars.notes || undefined,
  }),
  updateRow: (vars, existing) => ({
    ...updatedRowBase(vars.id, vars.babyId, existing),
    started_at: vars.started_at ?? existing?.started_at ?? new Date().toISOString(),
    ended_at: vars.ended_at ?? existing?.ended_at ?? null,
    starting_breast: vars.clear_starting_breast
      ? null
      : (vars.starting_breast ?? existing?.starting_breast ?? null),
    nursing_side: vars.nursing_side ?? existing?.nursing_side ?? "both",
    left_duration_s: vars.left_duration_s ?? existing?.left_duration_s ?? 0,
    right_duration_s: vars.right_duration_s ?? existing?.right_duration_s ?? 0,
    notes: editedText(vars.notes, existing?.notes),
  }),
  updateBody: (vars) =>
    patchBody(vars, [
      "started_at",
      "ended_at",
      "starting_breast",
      "clear_starting_breast",
      "nursing_side",
      "left_duration_s",
      "right_duration_s",
      "notes",
    ]),
});

export const useNursings = nursing.useList;
export const useCreateNursing = nursing.useCreate;
export const useUpdateNursing = nursing.useUpdate;
export const useDeleteNursing = nursing.useDelete;
export const useOpenNursing = nursing.useOpen;
export const useEndNursing = nursing.useEnd;

// --- sleeps ---

interface CreateSleepVars {
  babyId: string;
  started_at: string;
  // Omitting ended_at opens an "in progress" session that the FE later closes
  // via useEndSleep.
  ended_at?: string;
  sleep_type?: SleepType;
  location?: string;
  notes?: string;
}

// Patches a CLOSED sleep session. The BE refuses to touch open sessions on
// the edit path (the close-session PATCH owns that transition via
// useEndSleep). The form hides the edit affordance for open rows.
interface UpdateSleepVars {
  id: string;
  babyId: string;
  started_at?: string;
  ended_at?: string;
  sleep_type?: SleepType;
  clear_sleep_type?: boolean;
  location?: string;
  notes?: string;
}

interface EndSleepVars {
  id: string;
  babyId: string;
  ended_at: string;
}

const sleep = defineEventKind<Sleep, CreateSleepVars, UpdateSleepVars, EndSleepVars>({
  segment: "sleeps",
  itemPath: "/sleeps",
  deleteKeyPrefix: "del-sleep-",
  refetchMs: LIVE_LIST_REFETCH_MS,
  open: {
    endKeyPrefix: "end-sleep-",
    endBody: (vars) => ({ ended_at: vars.ended_at }),
    endRow: (vars, base) => ({
      ...updatedRowBase(vars.id, vars.babyId, base ?? undefined),
      started_at: base?.started_at ?? new Date().toISOString(),
      ended_at: vars.ended_at,
      sleep_type: base?.sleep_type ?? null,
      location: base?.location ?? null,
      notes: base?.notes ?? null,
    }),
  },
  createRow: (vars, id) => ({
    ...newRowBase(id, vars.babyId),
    started_at: vars.started_at,
    ended_at: vars.ended_at ?? null,
    sleep_type: vars.sleep_type ?? null,
    location: vars.location ?? null,
    notes: vars.notes ?? null,
  }),
  createBody: (vars, id) => ({
    id,
    started_at: vars.started_at,
    ended_at: vars.ended_at,
    sleep_type: vars.sleep_type,
    location: vars.location || undefined,
    notes: vars.notes || undefined,
  }),
  updateRow: (vars, existing) => ({
    ...updatedRowBase(vars.id, vars.babyId, existing),
    started_at: vars.started_at ?? existing?.started_at ?? new Date().toISOString(),
    ended_at: vars.ended_at ?? existing?.ended_at ?? null,
    sleep_type: vars.clear_sleep_type ? null : (vars.sleep_type ?? existing?.sleep_type ?? null),
    location: editedText(vars.location, existing?.location),
    notes: editedText(vars.notes, existing?.notes),
  }),
  updateBody: (vars) =>
    patchBody(vars, [
      "started_at",
      "ended_at",
      "sleep_type",
      "clear_sleep_type",
      "location",
      "notes",
    ]),
});

export const useSleeps = sleep.useList;
export const useCreateSleep = sleep.useCreate;
export const useUpdateSleep = sleep.useUpdate;
export const useDeleteSleep = sleep.useDelete;
export const useOpenSleep = sleep.useOpen;
export const useEndSleep = sleep.useEnd;

// --- growths ---

interface CreateGrowthVars {
  babyId: string;
  measured_at: string;
  weight_g?: number;
  height_cm?: number;
  head_circumference_cm?: number;
  notes?: string;
}

// Supports explicit per-measurement clearing via the BE's clear_* flags. The
// growth form passes the clear flag when the user empties an input that
// previously held a value.
interface UpdateGrowthVars {
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
}

const growth = defineEventKind<Growth, CreateGrowthVars, UpdateGrowthVars>({
  segment: "growths",
  itemPath: "/growths",
  deleteKeyPrefix: "del-growth-",
  refetchMs: HEAVY_REFETCH_MS,
  createRow: (vars, id) => ({
    ...newRowBase(id, vars.babyId),
    measured_at: vars.measured_at,
    weight_g: vars.weight_g ?? null,
    height_cm: vars.height_cm ?? null,
    head_circumference_cm: vars.head_circumference_cm ?? null,
    notes: vars.notes ?? null,
  }),
  createBody: (vars, id) => ({
    id,
    measured_at: vars.measured_at,
    weight_g: vars.weight_g,
    height_cm: vars.height_cm,
    head_circumference_cm: vars.head_circumference_cm,
    notes: vars.notes || undefined,
  }),
  updateRow: (vars, existing) => ({
    ...updatedRowBase(vars.id, vars.babyId, existing),
    measured_at: vars.measured_at ?? existing?.measured_at ?? new Date().toISOString(),
    weight_g: vars.clear_weight_g ? null : (vars.weight_g ?? existing?.weight_g ?? null),
    height_cm: vars.clear_height_cm ? null : (vars.height_cm ?? existing?.height_cm ?? null),
    head_circumference_cm: vars.clear_head_circumference_cm
      ? null
      : (vars.head_circumference_cm ?? existing?.head_circumference_cm ?? null),
    notes: editedText(vars.notes, existing?.notes),
  }),
  updateBody: (vars) =>
    patchBody(vars, [
      "measured_at",
      "weight_g",
      "clear_weight_g",
      "height_cm",
      "clear_height_cm",
      "head_circumference_cm",
      "clear_head_circumference_cm",
      "notes",
    ]),
});

export const useGrowths = growth.useList;
export const useCreateGrowth = growth.useCreate;
export const useUpdateGrowth = growth.useUpdate;
export const useDeleteGrowth = growth.useDelete;

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
      // autofill_bottle_amount toggles the bottle-form prefill. The BE
      // preserves-on-omit, but the FE always round-trips the current value
      // (read from useMyPreferences) so an unrelated settings change never
      // depends on that fallback.
      autofill_bottle_amount: boolean;
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
      day_start_hour: number;
    }) =>
      api<BabySettings>(`/babies/${vars.babyId}/settings`, {
        method: "PUT",
        body: {
          unit_volume: vars.unit_volume,
          unit_length: vars.unit_length,
          unit_weight: vars.unit_weight,
          day_start_hour: vars.day_start_hour,
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
  opts?: { refetchInterval?: number | false },
) {
  const enabled = !!babyId && !!from && !!to;
  return useQuery({
    queryKey: enabled
      ? qk.chartsDaily(babyId as string, from as string, to as string, tz)
      : ["babies", "none", "charts", "daily"],
    enabled,
    refetchInterval: opts?.refetchInterval ?? HEAVY_REFETCH_MS,
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
