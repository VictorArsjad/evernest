// @vitest-environment jsdom
// Extension of queries.freeze.test.tsx: photo blob-URL hooks and the
// open-session-under-list-prefix bug for update. Same rules as the first file:
// literal expectations, observed through fetch calls and cache contents only.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  qk,
  useDiaperPhotoUrl,
  useNotePhotoUrl,
  useSolidMealPhotoUrl,
  useUpdateNursing,
  useUpdateSleep,
} from "./queries";
import { peekQueue } from "./outbox";
import {
  adapt,
  BABY,
  EXISTING_ID,
  installQueryHarness,
  json,
  OTHER_ID,
  setup,
  stubFetch,
} from "../test/queryHarness";

installQueryHarness();

// --- photo blob-URL hooks ---

const PHOTO_KINDS = [
  { kind: "diaper", usePhotoUrl: useDiaperPhotoUrl, path: "/diapers", cacheRoot: "diapers" },
  { kind: "solids", usePhotoUrl: useSolidMealPhotoUrl, path: "/solid-meals", cacheRoot: "solid-meals" },
  { kind: "note", usePhotoUrl: useNotePhotoUrl, path: "/notes", cacheRoot: "notes" },
];

describe.each(PHOTO_KINDS)("$kind: photo url hook", (p) => {
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  let create: ReturnType<typeof vi.fn>;
  let revoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let n = 0;
    create = vi.fn(() => `blob:test-${++n}`);
    revoke = vi.fn();
    URL.createObjectURL = create as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    // Unmount first: the hook revokes its URL in an effect cleanup, which must
    // still see the stub.
    cleanup();
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  });

  function photoResponse(): Response {
    return new Response("PHOTO-BYTES", { status: 200, headers: { "content-type": "image/jpeg" } });
  }

  it("fetches the bytes, caches the blob under its key and returns a blob URL", async () => {
    const calls = stubFetch(() => photoResponse());
    const { qc, wrapper } = setup();
    const { result } = renderHook(() => p.usePhotoUrl(EXISTING_ID, true), { wrapper });
    await waitFor(() => expect(result.current).toBe("blob:test-1"));
    expect(calls).toEqual([{ method: "GET", url: `/v1${p.path}/${EXISTING_ID}/photo`, body: undefined }]);
    expect(qc.getQueryData([p.cacheRoot, EXISTING_ID, "photo"])).toBeInstanceOf(Blob);
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes the blob URL on unmount", async () => {
    stubFetch(() => photoResponse());
    const { wrapper } = setup();
    const { result, unmount } = renderHook(() => p.usePhotoUrl(EXISTING_ID, true), { wrapper });
    await waitFor(() => expect(result.current).toBe("blob:test-1"));
    unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test-1");
  });

  it("does not fetch and returns null when hasPhoto is false", async () => {
    const calls = stubFetch(() => photoResponse());
    const { wrapper } = setup();
    const { result } = renderHook(() => p.usePhotoUrl(EXISTING_ID, false), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(calls).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("does not fetch and returns null when hasPhoto is undefined", async () => {
    const calls = stubFetch(() => photoResponse());
    const { wrapper } = setup();
    const { result } = renderHook(() => p.usePhotoUrl(EXISTING_ID, undefined), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(calls).toEqual([]);
  });

  it("does not fetch and returns null when the id is null", async () => {
    const calls = stubFetch(() => photoResponse());
    const { wrapper } = setup();
    const { result } = renderHook(() => p.usePhotoUrl(null, true), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(calls).toEqual([]);
  });
});

// --- update of a closed row while an open session is cached ---

type Row = Record<string, unknown>;

interface UpdateSpec {
  kind: string;
  item: string;
  listKey: (babyId: string, from?: string, to?: string) => readonly unknown[];
  openKey: (babyId: string) => readonly unknown[];
  useUpdate: () => (vars: unknown) => Promise<unknown>;
  openRow: Row;
  closedRow: Row;
  vars: Row;
  body: Row;
  serverRow: Row;
}

const UPDATE_SPECS: UpdateSpec[] = [
  {
    kind: "nursing",
    item: "/nursing-sessions",
    listKey: qk.nursings,
    openKey: qk.openNursing,
    useUpdate: adapt(useUpdateNursing),
    openRow: {
      id: EXISTING_ID,
      baby_id: BABY,
      started_at: "2026-11-22T09:50:00Z",
      ended_at: null,
      starting_breast: "left",
      nursing_side: "left",
      left_duration_s: 0,
      right_duration_s: 0,
      notes: null,
      source: "manual",
      created_at: "2026-11-22T09:50:01Z",
    },
    closedRow: {
      id: OTHER_ID,
      baby_id: BABY,
      started_at: "2026-11-22T07:00:00Z",
      ended_at: "2026-11-22T07:08:00Z",
      starting_breast: null,
      nursing_side: "left",
      left_duration_s: 480,
      right_duration_s: 0,
      notes: null,
      source: "manual",
      created_at: "2026-11-22T07:08:01Z",
    },
    vars: { id: OTHER_ID, babyId: BABY, left_duration_s: 500 },
    body: { left_duration_s: 500 },
    serverRow: {
      id: OTHER_ID,
      baby_id: BABY,
      started_at: "2026-11-22T07:00:00Z",
      ended_at: "2026-11-22T07:08:00Z",
      starting_breast: null,
      nursing_side: "left",
      left_duration_s: 500,
      right_duration_s: 0,
      notes: null,
      source: "manual",
      created_at: "2026-11-22T07:08:01Z",
    },
  },
  {
    kind: "sleep",
    item: "/sleeps",
    listKey: qk.sleeps,
    openKey: qk.openSleep,
    useUpdate: adapt(useUpdateSleep),
    openRow: {
      id: EXISTING_ID,
      baby_id: BABY,
      started_at: "2026-11-22T09:00:00Z",
      ended_at: null,
      sleep_type: "nap",
      location: "crib",
      notes: null,
      source: "manual",
      created_at: "2026-11-22T09:00:01Z",
    },
    closedRow: {
      id: OTHER_ID,
      baby_id: BABY,
      started_at: "2026-11-21T20:00:00Z",
      ended_at: "2026-11-22T06:00:00Z",
      sleep_type: "night",
      location: null,
      notes: null,
      source: "manual",
      created_at: "2026-11-22T06:00:01Z",
    },
    vars: { id: OTHER_ID, babyId: BABY, notes: "restless" },
    body: { notes: "restless" },
    serverRow: {
      id: OTHER_ID,
      baby_id: BABY,
      started_at: "2026-11-21T20:00:00Z",
      ended_at: "2026-11-22T06:00:00Z",
      sleep_type: "night",
      location: null,
      notes: "restless",
      source: "manual",
      created_at: "2026-11-22T06:00:01Z",
    },
  },
];

describe.each(UPDATE_SPECS)("$kind: update with an open session cached", (s) => {
  // CURRENT BEHAVIOR (surprising): the open-session key is nested under the
  // list prefix, so upsertList's setQueriesData also hits the open entry (an
  // object, not an array) and `.findIndex` throws inside onSuccess. The PATCH
  // itself succeeded server-side, but the mutation ends in error and the list
  // cache is never updated.
  it(`KNOWN BUG (approved fix): updating a closed ${s.kind} while an open ${s.kind} is cached errors`, async () => {
    const calls = stubFetch(() => json(s.serverRow));
    const { qc, wrapper } = setup();
    qc.setQueryData(s.openKey(BABY), s.openRow);
    qc.setQueryData(s.listKey(BABY), [s.closedRow]);
    const { result } = renderHook(s.useUpdate, { wrapper });
    await act(async () => {
      await expect(result.current(s.vars)).rejects.toThrow(/findIndex is not a function/);
    });
    // The server call went through.
    expect(calls).toEqual([{ method: "PATCH", url: `/v1${s.item}/${OTHER_ID}`, body: s.body }]);
    expect(await peekQueue()).toEqual([]);
    // The list cache still holds the stale row; the open session is untouched.
    expect(qc.getQueryData(s.listKey(BABY))).toEqual([s.closedRow]);
    expect(qc.getQueryData(s.openKey(BABY))).toEqual(s.openRow);
  });
});
