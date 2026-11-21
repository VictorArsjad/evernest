// One module for the per-baby event kinds (bottle, diaper, solids, note,
// pumping, nursing, sleep, growth). Each kind supplies a small descriptor
// (path segment, body mapping, synthesized rows, optional photo / open-session
// capability) and gets back the list / create / update / delete hooks.
//
// Writes go through apiQueued so they survive an offline window. The hooks
// generate the row id client-side (the BE accepts a client id and does
// ON CONFLICT (id) DO NOTHING, so replay is idempotent) and inject the real or
// synthesized row into every cached list under the baby so the Today list
// reflects the user's intent immediately. When online the server row replaces
// the synthetic one and the invalidate refetches in the background.
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiQueued } from "./api";

// makeId: client-generated row id. crypto.randomUUID is everywhere we
// ship (modern browsers + the dev runtime). UUIDv7 ordering would be
// nicer for chart-axis sorting but isn't load-bearing — sorts use
// occurred_at / measured_at / started_at, never the id.
export function makeId(): string {
  return crypto.randomUUID();
}

// Multi-device sync cadence. Same account on N devices => caregivers
// want a recent edit to show up across phones without manual reload.
// We poll the per-baby lists at LIVE_LIST_REFETCH_MS, the open-session
// single-row endpoints a touch faster (they drive a live "in progress"
// chip), and lower-urgency / heavier payloads at HEAVY_REFETCH_MS.
// `refetchIntervalInBackground: false` (set in main.tsx) ensures none
// of these poll while the tab is hidden.
export const LIVE_LIST_REFETCH_MS = 15_000;
export const OPEN_SESSION_REFETCH_MS = 10_000;
export const HEAVY_REFETCH_MS = 5 * 60_000;

// Per-kind list hooks accept an optional fourth `opts` arg so the History
// view can request `{ limit: 1000, refetchInterval: false }` without
// spawning a parallel query key per consumer. The default 200 row cap on the
// BE would silently truncate a 30-day window for an active baby, and polling
// past data buys nothing — it doesn't change. Today / Charts call the hooks
// with three args and inherit the live-poll defaults unchanged.
export interface ListHookOpts {
  limit?: number;
  refetchInterval?: number | false;
}

// Cache keys. `segment` is both the URL segment under /babies/{id}/ and the
// cache segment, so one string drives the list path and every key.
export const listKeyFor =
  (segment: string) =>
  (babyId: string, from?: string, to?: string) =>
    ["babies", babyId, segment, from ?? "", to ?? ""] as const;

export const openKeyFor = (segment: string) => (babyId: string) =>
  ["babies", babyId, segment, "open"] as const;

const prefixFor = (babyId: string, segment: string) => ["babies", babyId, segment] as const;

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

// Reads the existing row out of any cached list so an update can merge the
// requested edits into it and the optimistic upsert reflects the change even
// while offline.
function findCached<T extends { id: string }>(
  qc: QueryClient,
  prefix: readonly unknown[],
  id: string,
): T | undefined {
  const lists = qc.getQueriesData<T[] | undefined>({ queryKey: prefix }) as Array<
    [unknown, T[] | undefined]
  >;
  return lists.flatMap(([, list]) => list ?? []).find((r) => r.id === id);
}

// --- synthesis helpers shared by the descriptors ---

export interface EventRow {
  id: string;
  baby_id: string;
  source: string;
  created_at: string;
}

// Fields every freshly created row starts with.
export function newRowBase(id: string, babyId: string) {
  return { id, baby_id: babyId, source: "manual", created_at: new Date().toISOString() };
}

// Fields an updated row inherits from the cached row (or defaults when the
// row isn't cached, e.g. offline with a cold cache).
export function updatedRowBase(
  id: string,
  babyId: string,
  existing: EventRow | undefined,
) {
  return {
    id,
    baby_id: existing?.baby_id ?? babyId,
    source: existing?.source ?? "manual",
    created_at: existing?.created_at ?? new Date().toISOString(),
  };
}

// Notes-style text edit: undefined leaves the column, "" clears it.
export function editedText(
  next: string | undefined,
  existing: string | null | undefined,
): string | null {
  return next === undefined ? (existing ?? null) : next === "" ? null : next;
}

export interface EventKindDescriptor<
  Row extends EventRow,
  CreateVars extends { babyId: string },
  UpdateVars extends { id: string; babyId: string },
> {
  // URL segment under /babies/{id}/ and the cache segment.
  segment: string;
  // Base path for PATCH / DELETE: `${itemPath}/${id}`.
  itemPath: string;
  // Idempotency key prefix of the delete hook: `${deleteKeyPrefix}${id}`.
  deleteKeyPrefix: string;
  refetchMs: number;
  createBody(vars: CreateVars, id: string): Record<string, unknown>;
  createRow(vars: CreateVars, id: string): Row;
  updateBody(vars: UpdateVars): Record<string, unknown>;
  updateRow(vars: UpdateVars, existing: Row | undefined): Row;
}

export function defineEventKind<
  Row extends EventRow,
  CreateVars extends { babyId: string },
  UpdateVars extends { id: string; babyId: string },
>(d: EventKindDescriptor<Row, CreateVars, UpdateVars>) {
  const listKey = listKeyFor(d.segment);

  function useList(babyId: string | null, from?: string, to?: string, opts?: ListHookOpts) {
    return useQuery({
      queryKey: babyId ? listKey(babyId, from, to) : ["babies", "none", d.segment],
      enabled: !!babyId,
      refetchInterval: opts?.refetchInterval ?? d.refetchMs,
      queryFn: () => {
        const params = new URLSearchParams();
        if (from) params.set("from", from);
        if (to) params.set("to", to);
        if (opts?.limit != null) params.set("limit", String(opts.limit));
        const qs = params.toString();
        return api<Row[]>(`/babies/${babyId}/${d.segment}${qs ? `?${qs}` : ""}`);
      },
    });
  }

  function useCreate() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (vars: CreateVars) => {
        const id = makeId();
        const synthetic = d.createRow(vars, id);
        return apiQueued<Row>(`/babies/${vars.babyId}/${d.segment}`, {
          method: "POST",
          body: d.createBody(vars, id),
          idempotencyKey: id,
          synthesize: () => synthetic,
        });
      },
      onSuccess: (data, vars) => {
        // Inject the row (real or synthesized) into every cached list
        // under this baby so the Today hub updates immediately, even when
        // offline. invalidate triggers a background refetch when online
        // (no-op when offline).
        upsertList<Row>(qc, prefixFor(vars.babyId, d.segment), data);
        qc.invalidateQueries({ queryKey: prefixFor(vars.babyId, d.segment) });
      },
    });
  }

  function useUpdate() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (vars: UpdateVars) => {
        const existing = findCached<Row>(qc, prefixFor(vars.babyId, d.segment), vars.id);
        const synthetic = d.updateRow(vars, existing);
        return apiQueued<Row>(`${d.itemPath}/${vars.id}`, {
          method: "PATCH",
          body: d.updateBody(vars),
          idempotencyKey: vars.id,
          synthesize: () => synthetic,
        });
      },
      onSuccess: (data, vars) => {
        upsertList<Row>(qc, prefixFor(vars.babyId, d.segment), data);
        qc.invalidateQueries({ queryKey: prefixFor(vars.babyId, d.segment) });
      },
    });
  }

  function useDelete() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (vars: { id: string; babyId: string }) =>
        apiQueued<void>(`${d.itemPath}/${vars.id}`, {
          method: "DELETE",
          idempotencyKey: `${d.deleteKeyPrefix}${vars.id}`,
          synthesize: () => undefined as unknown as void,
        }),
      onSuccess: (_data, vars) => {
        removeFromList<Row>(qc, prefixFor(vars.babyId, d.segment), vars.id);
        qc.invalidateQueries({ queryKey: prefixFor(vars.babyId, d.segment) });
      },
    });
  }

  return { segment: d.segment, listKey, useList, useCreate, useUpdate, useDelete };
}
