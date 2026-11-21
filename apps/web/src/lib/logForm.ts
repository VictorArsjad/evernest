// Shared plumbing for the /log/* form routes (see components/LogFormLayout.tsx
// for the matching markup). A route keeps only its fields and kind-specific
// rules; this module owns the parts every one of them used to copy:
//   household → babies → active baby → babyId, the `?babyId=&edit=` search
//   schema, edit-mode row lookup from the query cache, Esc/Cancel → "/",
//   save/delete wiring with navigate-on-success, and mutation error state.
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { z } from "zod";

import { nowLocalDatetimeInput } from "./datetime";
import { useBabies, useHouseholds } from "./queries";
import { useActiveBaby } from "./useActiveBaby";
import { useEscapeKey } from "./useEscapeKey";

export const logSearchSchema = z.object({
  babyId: z.string().uuid().optional(),
  edit: z.string().uuid().optional(),
});

export type LogSearch = z.infer<typeof logSearchSchema>;

// In edit mode the row comes out of any cached list for the kind (Recent only
// shows today, so the cache is warm in practice). A cold-cache deep link gets
// an empty form — an accepted v1 trade-off, there is deliberately no extra GET.
export function findCachedRow<Row extends { id: string }>(
  qc: QueryClient,
  segment: string,
  babyId: string | null,
  editId: string | undefined,
): Row | null {
  if (!editId || !babyId) return null;
  const lists = qc.getQueriesData<Row[] | undefined>({
    queryKey: ["babies", babyId, segment],
  }) as Array<[unknown, Row[] | undefined]>;
  return lists.flatMap(([, list]) => list ?? []).find((r) => r.id === editId) ?? null;
}

// Structural slice of a TanStack mutation result; keeps the shell independent
// of each kind's row/response types.
export interface LogMutation<Vars, Data = unknown> {
  // `data` is only here so the row type can be inferred from the create hook.
  data: Data | undefined;
  mutate(vars: Vars, options?: { onSuccess?: () => void }): void;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
}

export interface UseLogFormOptions<
  Row,
  CreateVars extends { babyId: string },
  UpdateVars extends { id: string; babyId: string },
> {
  // Cache/list segment of the kind, e.g. "bottle-feeds".
  segment: string;
  // The route's `Route.useSearch()` result.
  search: LogSearch;
  create: LogMutation<CreateVars, Row>;
  update: LogMutation<UpdateVars>;
  del: LogMutation<{ id: string; babyId: string }>;
  // Which mutations feed `pending` / `hadError` / `errorMsg`:
  //   "active" — only the one matching the mode (create, or update in edit mode)
  //   "either" — create OR update (solids has always read both)
  errorScope?: "active" | "either";
}

export function useLogForm<
  Row extends { id: string },
  CreateVars extends { babyId: string },
  UpdateVars extends { id: string; babyId: string },
>(opts: UseLogFormOptions<Row, CreateVars, UpdateVars>) {
  const { segment, search, create, update, del, errorScope = "active" } = opts;
  const nav = useNavigate();
  const exit = () => nav({ to: "/" });
  useEscapeKey(exit);

  const { babyId: babyIdFromSearch, edit: editId } = search;
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  // Fall back to the user's active baby selection (persisted per household in
  // localStorage by useActiveBaby) when the form is opened without `?babyId=`,
  // e.g. via a PWA shortcut.
  const { baby: activeBaby } = useActiveBaby(householdId, babies.data);
  const babyId = babyIdFromSearch ?? activeBaby?.id ?? null;

  const isEditMode = !!editId;
  const qc = useQueryClient();
  const existing = useMemo(
    () => findCachedRow<Row>(qc, segment, babyId, editId),
    [qc, segment, editId, babyId],
  );

  const either = errorScope === "either";
  const pending = either
    ? create.isPending || update.isPending
    : isEditMode
      ? update.isPending
      : create.isPending;
  const hadError = either
    ? create.isError || update.isError
    : isEditMode
      ? update.isError
      : create.isError;
  const errorMsg = either
    ? (create.error ?? update.error)?.message
    : isEditMode
      ? update.error?.message
      : create.error?.message;

  // Create-or-update by mode. `babyId` (and `id`, on update) are added here, so
  // a route passes only the kind's own fields. Both bodies are built eagerly;
  // the one that doesn't match the mode is simply dropped.
  const save = (vars: {
    create: Omit<CreateVars, "babyId">;
    update: Omit<UpdateVars, "id" | "babyId">;
  }) => {
    if (!babyId) return;
    if (isEditMode && editId) {
      update.mutate({ ...vars.update, id: editId, babyId } as UpdateVars, { onSuccess: exit });
      return;
    }
    create.mutate({ ...vars.create, babyId } as CreateVars, { onSuccess: exit });
  };

  // Create without the edit branch (nursing/sleep "Start now").
  const createAndExit = (vars: Omit<CreateVars, "babyId">) => {
    if (!babyId) return;
    create.mutate({ ...vars, babyId } as CreateVars, { onSuccess: exit });
  };

  const remove = () => {
    if (!babyId || !editId) return;
    del.mutate({ id: editId, babyId }, { onSuccess: exit });
  };

  return {
    exit,
    babyId,
    editId,
    isEditMode,
    existing,
    pending,
    hadError,
    errorMsg,
    save,
    createAndExit,
    remove,
    createPending: create.isPending,
    deleting: del.isPending,
  };
}

// What LogFormLayout reads. Narrower than the full hook result so a form typed
// to one kind (whose `save` takes that kind's vars) is still assignable.
export type LogFormChrome = Pick<
  ReturnType<typeof useLogForm>,
  "exit" | "babyId" | "editId" | "isEditMode" | "pending" | "hadError" | "errorMsg" | "remove" | "deleting"
>;

// Copies the cached row into the form fields once, when it first arrives.
// Ref-guarded so a later cache update (e.g. the user's own optimistic upsert
// after submit) doesn't clobber in-progress typing. Deliberately has no deps
// array: `apply` closes over the render's preferences, exactly like the
// per-route effect it replaces.
export function usePrefillOnce<Row>(
  enabled: boolean,
  existing: Row | null,
  apply: (row: Row) => void,
): void {
  const done = useRef(false);
  useEffect(() => {
    if (!enabled || done.current || !existing) return;
    apply(existing);
    done.current = true;
  });
}

// Re-snaps a "now" field when the window regains focus after sitting
// unsubmitted — create mode only, since restamping an edit would silently
// overwrite the original timestamp.
export function useRestampOnFocus(isEditMode: boolean, set: (local: string) => void): void {
  useEffect(() => {
    if (isEditMode) return;
    const onFocus = () => set(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isEditMode, set]);
}
