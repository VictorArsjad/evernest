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
import { useEffect, useState } from "react";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiBlob, apiQueued } from "./api";
import { peekQueue } from "./outbox";
import type { DiaperPhotoMime } from "./types";

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

// Idempotency key for a PATCH. The outbox coalesces by key, and the row id is
// already the key of a queued create (or of an earlier queued PATCH), so
// reusing it would drop this edit. Use the bare row id only while nothing is
// queued under it (keeps double-tap coalescing for the first edit); otherwise
// mint a per-edit key so the edit is enqueued behind the earlier record.
async function patchKeyFor(id: string): Promise<string> {
  try {
    const taken = (await peekQueue()).some((r) => r.idempotencyKey === id);
    return taken ? `${id}:patch:${makeId()}` : id;
  } catch {
    return id;
  }
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

// --- optional photo (diaper, solids, note) ---

// Photo create/update vars. photoBase64 must already be the raw base64
// payload (no `data:` prefix); the caller runs lib/image.compressForUpload
// first so the cap and re-encode happen before we hit the network. Both
// fields move as a pair. On update:
//   - undefined: leave the column alone
//   - "":        clear the stored photo (sends `"photo": ""`)
//   - <base64>:  replace; photoMime must be set alongside
export interface PhotoVars {
  photoBase64?: string;
  photoMime?: DiaperPhotoMime;
}

export interface PhotoFields {
  has_photo: boolean;
  photo_mime?: DiaperPhotoMime | null;
}

export function createdPhoto(vars: PhotoVars): Required<PhotoFields> {
  const hasPhoto = !!vars.photoBase64;
  return { has_photo: hasPhoto, photo_mime: hasPhoto ? (vars.photoMime ?? null) : null };
}

export function createPhotoBody(vars: PhotoVars): Record<string, unknown> {
  return vars.photoBase64 ? { photo: vars.photoBase64, photo_mime: vars.photoMime } : {};
}

// Mirrors what the BE will return on replay so the optimistic row in the
// cache matches.
export function updatedPhoto(
  vars: PhotoVars,
  existing: PhotoFields | undefined,
): Required<PhotoFields> {
  let hasPhoto = existing?.has_photo ?? false;
  let mime: DiaperPhotoMime | null | undefined = existing?.photo_mime ?? null;
  if (vars.photoBase64 === "") {
    hasPhoto = false;
    mime = null;
  } else if (vars.photoBase64 !== undefined) {
    hasPhoto = true;
    mime = vars.photoMime ?? mime ?? null;
  }
  return { has_photo: hasPhoto, photo_mime: mime ?? null };
}

export function updatePhotoBody(vars: PhotoVars): Record<string, unknown> {
  if (vars.photoBase64 === undefined) return {};
  const body: Record<string, unknown> = { photo: vars.photoBase64 };
  // photo_mime accompanies a non-empty replace. The BE ignores it for the
  // clear case, but sending it doesn't hurt.
  if (vars.photoBase64 !== "" && vars.photoMime) body.photo_mime = vars.photoMime;
  return body;
}

// definePhotoUrl builds the hook that fetches the raw bytes for a row and
// surfaces them as a blob URL ready to drop into `<img src>`. Lazy: when
// `hasPhoto` is false (or the id is null) nothing is fetched, so
// render-on-scroll callers don't pay for rows without photos.
//
// Lifecycle: each fetched blob lives behind a unique `blob:` URL the browser
// keeps alive until we call URL.revokeObjectURL. We revoke on unmount AND
// when the blob changes (e.g. a PATCH replaced the photo) so we don't leak.
export function definePhotoUrl(kind: { segment: string; itemPath: string }) {
  return function usePhotoUrl(id: string | null, hasPhoto: boolean | undefined): string | null {
    const query = useQuery({
      queryKey: [kind.segment, id ?? "none", "photo"],
      enabled: !!id && !!hasPhoto,
      queryFn: () => apiBlob(`${kind.itemPath}/${id}/photo`),
      // Photos are write-once-per-edit; cache for 5 min before refetch.
      // Matches the BE's `Cache-Control: private, max-age=300`.
      staleTime: 5 * 60_000,
      gcTime: 10 * 60_000,
    });

    const [url, setUrl] = useState<string | null>(null);
    useEffect(() => {
      const blob = query.data;
      if (!blob) {
        setUrl(null);
        return;
      }
      const next = URL.createObjectURL(blob);
      setUrl(next);
      return () => URL.revokeObjectURL(next);
    }, [query.data]);
    return url;
  };
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
  // Open-session capability (nursing, sleep): rows may be created without
  // ended_at, which opens an "in progress" session cached under the open key.
  // Create primes that cache and delete clears it. Pair with defineOpenSession
  // for the open query and the end mutation.
  openSession?: boolean;
}

export function defineEventKind<
  Row extends EventRow,
  CreateVars extends { babyId: string },
  UpdateVars extends { id: string; babyId: string },
>(d: EventKindDescriptor<Row, CreateVars, UpdateVars>) {
  const listKey = listKeyFor(d.segment);
  const openKey = openKeyFor(d.segment);

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
        // If we just opened an in-progress session (no ended_at), prime the
        // open query so the in-progress tile shows up immediately even
        // before the next refetch.
        if (d.openSession && !(data as unknown as { ended_at?: string | null }).ended_at) {
          qc.setQueryData(openKey(vars.babyId), data);
        }
        qc.invalidateQueries({ queryKey: prefixFor(vars.babyId, d.segment) });
      },
    });
  }

  function useUpdate() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: async (vars: UpdateVars) => {
        const existing = findCached<Row>(qc, prefixFor(vars.babyId, d.segment), vars.id);
        const synthetic = d.updateRow(vars, existing);
        return apiQueued<Row>(`${d.itemPath}/${vars.id}`, {
          method: "PATCH",
          body: d.updateBody(vars),
          idempotencyKey: await patchKeyFor(vars.id),
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
        if (d.openSession) {
          // If the deleted row was the currently-open session, drop it.
          const open = qc.getQueryData<Row | null>(openKey(vars.babyId));
          if (open && open.id === vars.id) {
            qc.setQueryData(openKey(vars.babyId), null);
          }
        }
      },
    });
  }

  return { segment: d.segment, itemPath: d.itemPath, listKey, openKey, useList, useCreate, useUpdate, useDelete };
}

// --- open session (nursing, sleep) ---

export interface OpenSessionDescriptor<
  Row extends EventRow,
  EndVars extends { id: string; babyId: string; ended_at: string },
> {
  // Idempotency key prefix of the end hook: `${endKeyPrefix}${id}`. Re-ending
  // the same session is a no-op server-side (the row is already ended) and the
  // outbox dedupes the second PATCH against the first.
  endKeyPrefix: string;
  endBody(vars: EndVars): Record<string, unknown>;
  // `base` is whichever cached row (list, else open) carries this id. When
  // offline we may have no complete row cached; the BE response replaces the
  // synthesized one once sync drains.
  endRow(vars: EndVars, base: Row | null): Row;
}

// useOpen polls /open for a single in-progress session. The endpoint returns
// 204 when nothing is running (which our api wrapper surfaces as `undefined`);
// we normalize that to `null` so consumers can use a simple `data ?? null`
// check instead of distinguishing undefined-while-loading from
// undefined-because-empty.
export function defineOpenSession<
  Row extends EventRow,
  EndVars extends { id: string; babyId: string; ended_at: string },
>(
  kind: {
    segment: string;
    itemPath: string;
    openKey: (babyId: string) => readonly unknown[];
  },
  d: OpenSessionDescriptor<Row, EndVars>,
) {
  function useOpen(babyId: string | null) {
    return useQuery({
      queryKey: babyId ? kind.openKey(babyId) : ["babies", "none", kind.segment, "open"],
      enabled: !!babyId,
      // Kept faster than the list refetch so a partner ending the session on
      // another device clears the in-progress tile quickly.
      refetchInterval: OPEN_SESSION_REFETCH_MS,
      queryFn: async () => {
        const data = await api<Row | undefined>(`/babies/${babyId}/${kind.segment}/open`);
        return data ?? null;
      },
    });
  }

  function useEnd() {
    const qc = useQueryClient();
    return useMutation({
      mutationFn: (vars: EndVars) => {
        const fromOpen = qc.getQueryData<Row | null>(kind.openKey(vars.babyId));
        const fromList = findCached<Row>(qc, prefixFor(vars.babyId, kind.segment), vars.id);
        const synthetic = d.endRow(vars, fromList ?? fromOpen ?? null);
        return apiQueued<Row>(`${kind.itemPath}/${vars.id}`, {
          method: "PATCH",
          body: d.endBody(vars),
          idempotencyKey: `${d.endKeyPrefix}${vars.id}`,
          synthesize: () => synthetic,
        });
      },
      onSuccess: (data, vars) => {
        // The in-progress tile should disappear immediately once we've
        // recorded an ended_at, so clear the open query and replace the row
        // in the list cache.
        qc.setQueryData(kind.openKey(vars.babyId), null);
        upsertList<Row>(qc, prefixFor(vars.babyId, kind.segment), data);
        qc.invalidateQueries({ queryKey: prefixFor(vars.babyId, kind.segment) });
      },
    });
  }

  return { useOpen, useEnd };
}
