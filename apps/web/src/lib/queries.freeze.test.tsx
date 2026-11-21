// @vitest-environment jsdom
// Characterization ("freeze") tests for the per-kind hooks in queries.ts.
//
// These lock in CURRENT behavior ahead of a refactor that collapses the
// per-kind hooks into one module. Every expected value is a literal read
// from the current code or observed from a run; nothing is recomputed the
// way the hooks compute it. Assertions observe only: fetch calls, outbox
// records, hook return values, and QueryClient cache contents.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { peekQueue, sync } from "./outbox";
import {
  type ListHookOpts,
  qk,
  useBottleFeeds,
  useCreateBottleFeed,
  useCreateDiaper,
  useCreateGrowth,
  useCreateNote,
  useCreateNursing,
  useCreatePumping,
  useCreateSleep,
  useCreateSolidMeal,
  useDeleteBottleFeed,
  useDeleteDiaper,
  useDeleteGrowth,
  useDeleteNote,
  useDeleteNursing,
  useDeletePumping,
  useDeleteSleep,
  useDeleteSolidMeal,
  useDiapers,
  useEndNursing,
  useEndSleep,
  useGrowths,
  useNotes,
  useNursings,
  useOpenNursing,
  useOpenSleep,
  usePumpings,
  useSleeps,
  useSolidMeals,
  useUpdateBottleFeed,
  useUpdateDiaper,
  useUpdateGrowth,
  useUpdateNote,
  useUpdateNursing,
  useUpdatePumping,
  useUpdateSleep,
  useUpdateSolidMeal,
} from "./queries";
import {
  adapt,
  BABY,
  EXISTING_ID,
  installQueryHarness,
  json,
  noContent,
  NOW,
  OFFLINE,
  OTHER_ID,
  ROW_ID,
  setup,
  stubFetch,
} from "../test/queryHarness";

installQueryHarness();

type Row = Record<string, unknown>;

// Query string literal for { from, to, limit } as URLSearchParams encodes it.
const WINDOW_QS = "?from=2026-11-21T00%3A00%3A00Z&to=2026-11-22T00%3A00%3A00Z&limit=1000";
const WINDOW_FROM = "2026-11-21T00:00:00Z";
const WINDOW_TO = "2026-11-22T00:00:00Z";

interface Fixture {
  vars: Row;
  body: Row;
  row: Row;
}

interface KindSpec {
  kind: string;
  // Path segment under /babies/{id}/ for lists and creates.
  collection: string;
  // Base path for PATCH/DELETE, i.e. `${item}/${id}`.
  item: string;
  // Idempotency key prefix used by the delete hook.
  delKey: string;
  listKey: (babyId: string, from?: string, to?: string) => readonly unknown[];
  useList: (babyId: string | null, from?: string, to?: string, opts?: ListHookOpts) => { data: unknown };
  useCreate: () => (vars: unknown) => Promise<unknown>;
  useUpdate: () => (vars: unknown) => Promise<unknown>;
  useDelete: () => (vars: unknown) => Promise<unknown>;
  existing: Row;
  other: Row;
  create: Fixture & { serverRow: Row };
  update: Fixture;
}

const KINDS: KindSpec[] = [
  {
    kind: "bottle",
    collection: "bottle-feeds",
    item: "/bottle-feeds",
    delKey: "del-bottle-",
    listKey: qk.bottleFeeds,
    useList: useBottleFeeds,
    useCreate: adapt(useCreateBottleFeed),
    useUpdate: adapt(useUpdateBottleFeed),
    useDelete: adapt(useDeleteBottleFeed),
    existing: {
      id: EXISTING_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T08:00:00Z",
      milk_source: "breast",
      amount_ml: 90,
      notes: "old",
      source: "manual",
      created_at: "2026-11-22T08:00:05Z",
    },
    other: {
      id: OTHER_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T07:00:00Z",
      milk_source: "formula",
      amount_ml: 60,
      notes: null,
      source: "manual",
      created_at: "2026-11-22T07:00:05Z",
    },
    create: {
      vars: { babyId: BABY, occurred_at: "2026-11-22T09:30:00Z", milk_source: "formula", amount_ml: 120 },
      body: { id: ROW_ID, occurred_at: "2026-11-22T09:30:00Z", milk_source: "formula", amount_ml: 120 },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:30:00Z",
        milk_source: "formula",
        amount_ml: 120,
        notes: null,
        source: "manual",
        created_at: NOW,
      },
      serverRow: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:30:00Z",
        milk_source: "formula",
        amount_ml: 120,
        notes: null,
        source: "manual",
        created_at: "2026-11-22T10:00:01.000Z",
      },
    },
    update: {
      vars: { id: EXISTING_ID, babyId: BABY, amount_ml: 100, notes: "" },
      body: { amount_ml: 100, notes: "" },
      row: {
        id: EXISTING_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T08:00:00Z",
        milk_source: "breast",
        amount_ml: 100,
        notes: null,
        source: "manual",
        created_at: "2026-11-22T08:00:05Z",
      },
    },
  },
  {
    kind: "diaper",
    collection: "diapers",
    item: "/diapers",
    delKey: "del-diaper-",
    listKey: qk.diapers,
    useList: useDiapers,
    useCreate: adapt(useCreateDiaper),
    useUpdate: adapt(useUpdateDiaper),
    useDelete: adapt(useDeleteDiaper),
    existing: {
      id: EXISTING_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T08:00:00Z",
      type: "soiled",
      notes: null,
      has_photo: false,
      photo_mime: null,
      source: "manual",
      created_at: "2026-11-22T08:00:05Z",
    },
    other: {
      id: OTHER_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T07:00:00Z",
      type: "wet",
      notes: null,
      has_photo: false,
      photo_mime: null,
      source: "manual",
      created_at: "2026-11-22T07:00:05Z",
    },
    create: {
      vars: { babyId: BABY, occurred_at: "2026-11-22T09:40:00Z", type: "wet" },
      body: { id: ROW_ID, occurred_at: "2026-11-22T09:40:00Z", type: "wet" },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:40:00Z",
        type: "wet",
        notes: null,
        has_photo: false,
        photo_mime: null,
        source: "manual",
        created_at: NOW,
      },
      serverRow: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:40:00Z",
        type: "wet",
        notes: null,
        has_photo: false,
        photo_mime: null,
        source: "manual",
        created_at: "2026-11-22T10:00:01.000Z",
      },
    },
    update: {
      vars: { id: EXISTING_ID, babyId: BABY, type: "mixed" },
      body: { type: "mixed" },
      row: {
        id: EXISTING_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T08:00:00Z",
        type: "mixed",
        notes: null,
        has_photo: false,
        photo_mime: null,
        source: "manual",
        created_at: "2026-11-22T08:00:05Z",
      },
    },
  },
  {
    kind: "solids",
    collection: "solid-meals",
    item: "/solid-meals",
    delKey: "del-solid-meal-",
    listKey: qk.solidMeals,
    useList: useSolidMeals,
    useCreate: adapt(useCreateSolidMeal),
    useUpdate: adapt(useUpdateSolidMeal),
    useDelete: adapt(useDeleteSolidMeal),
    existing: {
      id: EXISTING_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T08:00:00Z",
      foods: ["rice"],
      reaction: "liked",
      amount_g: 20,
      notes: null,
      has_photo: false,
      photo_mime: null,
      source: "manual",
      created_at: "2026-11-22T08:00:05Z",
    },
    other: {
      id: OTHER_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T07:00:00Z",
      foods: ["pear"],
      reaction: null,
      amount_g: null,
      notes: null,
      has_photo: false,
      photo_mime: null,
      source: "manual",
      created_at: "2026-11-22T07:00:05Z",
    },
    create: {
      vars: {
        babyId: BABY,
        occurred_at: "2026-11-22T09:50:00Z",
        foods: ["banana", "oat"],
        reaction: "neutral",
        amount_g: 30,
      },
      body: {
        id: ROW_ID,
        occurred_at: "2026-11-22T09:50:00Z",
        foods: ["banana", "oat"],
        reaction: "neutral",
        amount_g: 30,
      },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:50:00Z",
        foods: ["banana", "oat"],
        reaction: "neutral",
        amount_g: 30,
        notes: null,
        has_photo: false,
        photo_mime: null,
        source: "manual",
        created_at: NOW,
      },
      serverRow: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:50:00Z",
        foods: ["banana", "oat"],
        reaction: "neutral",
        amount_g: 30,
        notes: null,
        has_photo: false,
        photo_mime: null,
        source: "manual",
        created_at: "2026-11-22T10:00:01.000Z",
      },
    },
    update: {
      // Null reaction clears to "" on the wire; clear_amount_g is sent as a flag.
      vars: { id: EXISTING_ID, babyId: BABY, reaction: null, clear_amount_g: true, notes: "ate well" },
      body: { reaction: "", clear_amount_g: true, notes: "ate well" },
      row: {
        id: EXISTING_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T08:00:00Z",
        foods: ["rice"],
        reaction: null,
        amount_g: null,
        notes: "ate well",
        has_photo: false,
        photo_mime: null,
        source: "manual",
        created_at: "2026-11-22T08:00:05Z",
      },
    },
  },
  {
    kind: "note",
    collection: "notes",
    item: "/notes",
    delKey: "del-note-",
    listKey: qk.notes,
    useList: useNotes,
    useCreate: adapt(useCreateNote),
    useUpdate: adapt(useUpdateNote),
    useDelete: adapt(useDeleteNote),
    existing: {
      id: EXISTING_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T08:00:00Z",
      body: "rolled over",
      has_photo: false,
      photo_mime: null,
      source: "manual",
      created_at: "2026-11-22T08:00:05Z",
    },
    other: {
      id: OTHER_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T07:00:00Z",
      body: "slept in car",
      has_photo: false,
      photo_mime: null,
      source: "manual",
      created_at: "2026-11-22T07:00:05Z",
    },
    create: {
      vars: { babyId: BABY, occurred_at: "2026-11-22T09:55:00Z", body: "first smile" },
      body: { id: ROW_ID, occurred_at: "2026-11-22T09:55:00Z", body: "first smile" },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:55:00Z",
        body: "first smile",
        has_photo: false,
        photo_mime: null,
        source: "manual",
        created_at: NOW,
      },
      serverRow: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:55:00Z",
        body: "first smile",
        has_photo: false,
        photo_mime: null,
        source: "manual",
        created_at: "2026-11-22T10:00:01.000Z",
      },
    },
    update: {
      vars: { id: EXISTING_ID, babyId: BABY, body: "rolled over twice" },
      body: { body: "rolled over twice" },
      row: {
        id: EXISTING_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T08:00:00Z",
        body: "rolled over twice",
        has_photo: false,
        photo_mime: null,
        source: "manual",
        created_at: "2026-11-22T08:00:05Z",
      },
    },
  },
  {
    kind: "pumping",
    collection: "pumpings",
    item: "/pumpings",
    delKey: "del-pumping-",
    listKey: qk.pumpings,
    useList: usePumpings,
    useCreate: adapt(useCreatePumping),
    useUpdate: adapt(useUpdatePumping),
    useDelete: adapt(useDeletePumping),
    existing: {
      id: EXISTING_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T08:00:00Z",
      amount_ml: 80,
      duration_seconds: 900,
      notes: null,
      source: "manual",
      created_at: "2026-11-22T08:00:05Z",
    },
    other: {
      id: OTHER_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T07:00:00Z",
      amount_ml: 60,
      duration_seconds: null,
      notes: null,
      source: "manual",
      created_at: "2026-11-22T07:00:05Z",
    },
    create: {
      vars: { babyId: BABY, occurred_at: "2026-11-22T09:20:00Z", amount_ml: 90, duration_seconds: 600 },
      body: { id: ROW_ID, occurred_at: "2026-11-22T09:20:00Z", amount_ml: 90, duration_seconds: 600 },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:20:00Z",
        amount_ml: 90,
        duration_seconds: 600,
        notes: null,
        source: "manual",
        created_at: NOW,
      },
      serverRow: {
        id: ROW_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T09:20:00Z",
        amount_ml: 90,
        duration_seconds: 600,
        notes: null,
        source: "manual",
        created_at: "2026-11-22T10:00:01.000Z",
      },
    },
    update: {
      vars: { id: EXISTING_ID, babyId: BABY, amount_ml: 85 },
      body: { amount_ml: 85 },
      row: {
        id: EXISTING_ID,
        baby_id: BABY,
        occurred_at: "2026-11-22T08:00:00Z",
        amount_ml: 85,
        duration_seconds: 900,
        notes: null,
        source: "manual",
        created_at: "2026-11-22T08:00:05Z",
      },
    },
  },
  {
    kind: "nursing",
    collection: "nursing-sessions",
    item: "/nursing-sessions",
    delKey: "del-nursing-",
    listKey: qk.nursings,
    useList: useNursings,
    useCreate: adapt(useCreateNursing),
    useUpdate: adapt(useUpdateNursing),
    useDelete: adapt(useDeleteNursing),
    existing: {
      id: EXISTING_ID,
      baby_id: BABY,
      started_at: "2026-11-22T08:00:00Z",
      ended_at: "2026-11-22T08:10:00Z",
      starting_breast: "left",
      nursing_side: "both",
      left_duration_s: 300,
      right_duration_s: 300,
      notes: null,
      source: "manual",
      created_at: "2026-11-22T08:10:01Z",
    },
    other: {
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
    create: {
      vars: {
        babyId: BABY,
        started_at: "2026-11-22T09:00:00Z",
        ended_at: "2026-11-22T09:12:00Z",
        starting_breast: "right",
        nursing_side: "both",
        left_duration_s: 360,
        right_duration_s: 360,
      },
      body: {
        id: ROW_ID,
        started_at: "2026-11-22T09:00:00Z",
        ended_at: "2026-11-22T09:12:00Z",
        starting_breast: "right",
        nursing_side: "both",
        left_duration_s: 360,
        right_duration_s: 360,
      },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        started_at: "2026-11-22T09:00:00Z",
        ended_at: "2026-11-22T09:12:00Z",
        starting_breast: "right",
        nursing_side: "both",
        left_duration_s: 360,
        right_duration_s: 360,
        notes: null,
        source: "manual",
        created_at: NOW,
      },
      serverRow: {
        id: ROW_ID,
        baby_id: BABY,
        started_at: "2026-11-22T09:00:00Z",
        ended_at: "2026-11-22T09:12:00Z",
        starting_breast: "right",
        nursing_side: "both",
        left_duration_s: 360,
        right_duration_s: 360,
        notes: null,
        source: "manual",
        created_at: "2026-11-22T10:00:01.000Z",
      },
    },
    update: {
      vars: { id: EXISTING_ID, babyId: BABY, clear_starting_breast: true, left_duration_s: 240 },
      body: { left_duration_s: 240, clear_starting_breast: true },
      row: {
        id: EXISTING_ID,
        baby_id: BABY,
        started_at: "2026-11-22T08:00:00Z",
        ended_at: "2026-11-22T08:10:00Z",
        starting_breast: null,
        nursing_side: "both",
        left_duration_s: 240,
        right_duration_s: 300,
        notes: null,
        source: "manual",
        created_at: "2026-11-22T08:10:01Z",
      },
    },
  },
  {
    kind: "sleep",
    collection: "sleeps",
    item: "/sleeps",
    delKey: "del-sleep-",
    listKey: qk.sleeps,
    useList: useSleeps,
    useCreate: adapt(useCreateSleep),
    useUpdate: adapt(useUpdateSleep),
    useDelete: adapt(useDeleteSleep),
    existing: {
      id: EXISTING_ID,
      baby_id: BABY,
      started_at: "2026-11-22T13:00:00Z",
      ended_at: "2026-11-22T14:00:00Z",
      sleep_type: "nap",
      location: "crib",
      notes: null,
      source: "manual",
      created_at: "2026-11-22T14:00:01Z",
    },
    other: {
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
    create: {
      vars: {
        babyId: BABY,
        started_at: "2026-11-22T09:00:00Z",
        ended_at: "2026-11-22T09:30:00Z",
        sleep_type: "nap",
        location: "stroller",
      },
      body: {
        id: ROW_ID,
        started_at: "2026-11-22T09:00:00Z",
        ended_at: "2026-11-22T09:30:00Z",
        sleep_type: "nap",
        location: "stroller",
      },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        started_at: "2026-11-22T09:00:00Z",
        ended_at: "2026-11-22T09:30:00Z",
        sleep_type: "nap",
        location: "stroller",
        notes: null,
        source: "manual",
        created_at: NOW,
      },
      serverRow: {
        id: ROW_ID,
        baby_id: BABY,
        started_at: "2026-11-22T09:00:00Z",
        ended_at: "2026-11-22T09:30:00Z",
        sleep_type: "nap",
        location: "stroller",
        notes: null,
        source: "manual",
        created_at: "2026-11-22T10:00:01.000Z",
      },
    },
    update: {
      // Empty-string location clears to null on the cached row.
      vars: { id: EXISTING_ID, babyId: BABY, location: "", sleep_type: "night" },
      body: { sleep_type: "night", location: "" },
      row: {
        id: EXISTING_ID,
        baby_id: BABY,
        started_at: "2026-11-22T13:00:00Z",
        ended_at: "2026-11-22T14:00:00Z",
        sleep_type: "night",
        location: null,
        notes: null,
        source: "manual",
        created_at: "2026-11-22T14:00:01Z",
      },
    },
  },
  {
    kind: "growth",
    collection: "growths",
    item: "/growths",
    delKey: "del-growth-",
    listKey: qk.growths,
    useList: useGrowths,
    useCreate: adapt(useCreateGrowth),
    useUpdate: adapt(useUpdateGrowth),
    useDelete: adapt(useDeleteGrowth),
    existing: {
      id: EXISTING_ID,
      baby_id: BABY,
      measured_at: "2026-11-20T09:00:00Z",
      weight_g: 4100,
      height_cm: 54,
      head_circumference_cm: 37,
      notes: null,
      source: "manual",
      created_at: "2026-11-20T09:00:01Z",
    },
    other: {
      id: OTHER_ID,
      baby_id: BABY,
      measured_at: "2026-11-01T09:00:00Z",
      weight_g: 3900,
      height_cm: null,
      head_circumference_cm: null,
      notes: null,
      source: "manual",
      created_at: "2026-11-01T09:00:01Z",
    },
    create: {
      vars: { babyId: BABY, measured_at: "2026-11-22T09:00:00Z", weight_g: 4200, height_cm: 55 },
      body: { id: ROW_ID, measured_at: "2026-11-22T09:00:00Z", weight_g: 4200, height_cm: 55 },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        measured_at: "2026-11-22T09:00:00Z",
        weight_g: 4200,
        height_cm: 55,
        head_circumference_cm: null,
        notes: null,
        source: "manual",
        created_at: NOW,
      },
      serverRow: {
        id: ROW_ID,
        baby_id: BABY,
        measured_at: "2026-11-22T09:00:00Z",
        weight_g: 4200,
        height_cm: 55,
        head_circumference_cm: null,
        notes: null,
        source: "manual",
        created_at: "2026-11-22T10:00:01.000Z",
      },
    },
    update: {
      vars: { id: EXISTING_ID, babyId: BABY, clear_weight_g: true, height_cm: 60 },
      body: { clear_weight_g: true, height_cm: 60 },
      row: {
        id: EXISTING_ID,
        baby_id: BABY,
        measured_at: "2026-11-20T09:00:00Z",
        weight_g: null,
        height_cm: 60,
        head_circumference_cm: 37,
        notes: null,
        source: "manual",
        created_at: "2026-11-20T09:00:01Z",
      },
    },
  },
];

describe.each(KINDS)("$kind: per-kind hooks", (k) => {
  it("list: GET with from/to/limit; returned array is cached under the list key", async () => {
    const calls = stubFetch(() => json([k.existing]));
    const { qc, wrapper } = setup();
    const { result } = renderHook(
      () => k.useList(BABY, WINDOW_FROM, WINDOW_TO, { limit: 1000, refetchInterval: false }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toEqual([k.existing]));
    expect(calls).toEqual([
      { method: "GET", url: `/v1/babies/${BABY}/${k.collection}${WINDOW_QS}`, body: undefined },
    ]);
    expect(qc.getQueryData(k.listKey(BABY, WINDOW_FROM, WINDOW_TO))).toEqual([k.existing]);
  });

  it("list without a window: bare path, no query string", async () => {
    const calls = stubFetch(() => json([]));
    const { wrapper } = setup();
    const { result } = renderHook(() => k.useList(BABY), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(calls).toEqual([{ method: "GET", url: `/v1/babies/${BABY}/${k.collection}`, body: undefined }]);
  });

  it("create online: POST carries the client id; the server row is prepended to the cached list", async () => {
    const calls = stubFetch(() => json(k.create.serverRow, 201));
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [k.other]);
    const { result } = renderHook(k.useCreate, { wrapper });
    let out: unknown;
    await act(async () => {
      out = await result.current(k.create.vars);
    });
    expect(calls).toEqual([
      { method: "POST", url: `/v1/babies/${BABY}/${k.collection}`, body: k.create.body },
    ]);
    // Online success never touches the outbox.
    expect(await peekQueue()).toEqual([]);
    expect(out).toEqual(k.create.serverRow);
    expect(qc.getQueryData(k.listKey(BABY))).toEqual([k.create.serverRow, k.other]);
  });

  it("create offline: enqueues POST keyed by the row id; synthesized row is prepended to the cached list", async () => {
    const calls = stubFetch(OFFLINE);
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [k.other]);
    const { result } = renderHook(k.useCreate, { wrapper });
    let out: unknown;
    await act(async () => {
      out = await result.current(k.create.vars);
    });
    await sync();
    const post = { method: "POST", url: `/v1/babies/${BABY}/${k.collection}`, body: k.create.body };
    // The direct attempt, then one immediate outbox retry before any backoff.
    expect(calls).toEqual([post, post]);
    const q = await peekQueue();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      method: "POST",
      path: `/babies/${BABY}/${k.collection}`,
      idempotencyKey: ROW_ID,
      status: "failed",
      attempts: 1,
    });
    expect(q[0].body).toEqual(k.create.body);
    expect(out).toEqual(k.create.row);
    expect(qc.getQueryData(k.listKey(BABY))).toEqual([k.create.row, k.other]);
  });

  it("update online: PATCH carries only the changed fields; the row is replaced in place", async () => {
    const calls = stubFetch(() => json(k.update.row));
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [k.other, k.existing]);
    const { result } = renderHook(k.useUpdate, { wrapper });
    let out: unknown;
    await act(async () => {
      out = await result.current(k.update.vars);
    });
    expect(calls).toEqual([
      { method: "PATCH", url: `/v1${k.item}/${EXISTING_ID}`, body: k.update.body },
    ]);
    expect(await peekQueue()).toEqual([]);
    expect(out).toEqual(k.update.row);
    expect(qc.getQueryData(k.listKey(BABY))).toEqual([k.other, k.update.row]);
  });

  it("update offline: enqueues PATCH keyed by the row id; synthesized row replaces the cached row in place", async () => {
    const calls = stubFetch(OFFLINE);
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [k.other, k.existing]);
    const { result } = renderHook(k.useUpdate, { wrapper });
    let out: unknown;
    await act(async () => {
      out = await result.current(k.update.vars);
    });
    await sync();
    const patch = { method: "PATCH", url: `/v1${k.item}/${EXISTING_ID}`, body: k.update.body };
    expect(calls).toEqual([patch, patch]);
    const q = await peekQueue();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      method: "PATCH",
      path: `${k.item}/${EXISTING_ID}`,
      idempotencyKey: EXISTING_ID,
    });
    expect(q[0].body).toEqual(k.update.body);
    expect(out).toEqual(k.update.row);
    expect(qc.getQueryData(k.listKey(BABY))).toEqual([k.other, k.update.row]);
  });

  it("delete online: DELETE; the row is removed from the cached list", async () => {
    const calls = stubFetch(() => noContent());
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [k.other, k.existing]);
    const { result } = renderHook(k.useDelete, { wrapper });
    await act(async () => {
      await result.current({ id: EXISTING_ID, babyId: BABY });
    });
    expect(calls).toEqual([{ method: "DELETE", url: `/v1${k.item}/${EXISTING_ID}`, body: undefined }]);
    expect(await peekQueue()).toEqual([]);
    expect(qc.getQueryData(k.listKey(BABY))).toEqual([k.other]);
  });

  it("delete offline: enqueues DELETE with the del-<kind>-<id> key; the row is still removed from the cache", async () => {
    const calls = stubFetch(OFFLINE);
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [k.other, k.existing]);
    const { result } = renderHook(k.useDelete, { wrapper });
    await act(async () => {
      await result.current({ id: EXISTING_ID, babyId: BABY });
    });
    await sync();
    const del = { method: "DELETE", url: `/v1${k.item}/${EXISTING_ID}`, body: undefined };
    expect(calls).toEqual([del, del]);
    const q = await peekQueue();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      method: "DELETE",
      path: `${k.item}/${EXISTING_ID}`,
      idempotencyKey: `${k.delKey}${EXISTING_ID}`,
    });
    expect(q[0].body).toBeUndefined();
    expect(qc.getQueryData(k.listKey(BABY))).toEqual([k.other]);
  });
});

// Fixed: offline edit while create queued is enqueued, not dropped
// The create is queued under key ROW_ID. The later PATCH gets its own key
// (`<id>:patch:<uuid>`) so enqueueMutation no longer coalesces it into the
// pending create. Both records replay.
it("offline edit while create queued is enqueued alongside the create", async () => {
  const calls = stubFetch(OFFLINE);
  const { qc, wrapper } = setup();
  qc.setQueryData(qk.bottleFeeds(BABY), []);
  const { result } = renderHook(
    () => ({ create: useCreateBottleFeed(), update: useUpdateBottleFeed() }),
    { wrapper },
  );

  await act(async () => {
    await result.current.create.mutateAsync({
      babyId: BABY,
      occurred_at: "2026-11-22T09:30:00Z",
      milk_source: "formula",
      amount_ml: 120,
    });
  });
  // Let the create's outbox drain settle before the edit, so the call order is fixed.
  await sync();

  await act(async () => {
    await result.current.update.mutateAsync({ id: ROW_ID, babyId: BABY, amount_ml: 150 });
  });
  await sync();

  const q = await peekQueue();
  expect(q).toHaveLength(2);
  expect(q[0]).toMatchObject({ method: "POST", path: `/babies/${BABY}/bottle-feeds`, idempotencyKey: ROW_ID });
  expect(q[0].body).toEqual({
    id: ROW_ID,
    occurred_at: "2026-11-22T09:30:00Z",
    milk_source: "formula",
    amount_ml: 120,
  });
  // randomUUID is stubbed to ROW_ID, so the minted suffix is ROW_ID too.
  expect(q[1]).toMatchObject({
    method: "PATCH",
    path: `/bottle-feeds/${ROW_ID}`,
    idempotencyKey: `${ROW_ID}:patch:${ROW_ID}`,
  });
  expect(q[1].body).toEqual({ amount_ml: 150 });
  // Direct POST + one immediate outbox retry, then the direct PATCH + its
  // outbox retry. The retried PATCH runs while the create is still parked in
  // backoff (pickNextReady skips backed-off records), i.e. replay is FIFO only
  // among ready records.
  const post = {
    method: "POST",
    url: "/v1/babies/b1/bottle-feeds",
    body: { id: ROW_ID, occurred_at: "2026-11-22T09:30:00Z", milk_source: "formula", amount_ml: 120 },
  };
  const patch = { method: "PATCH", url: `/v1/bottle-feeds/${ROW_ID}`, body: { amount_ml: 150 } };
  expect(calls).toEqual([post, post, patch, patch]);
  // The local cache shows the edit.
  expect(qc.getQueryData(qk.bottleFeeds(BABY))).toEqual([
    {
      id: ROW_ID,
      baby_id: BABY,
      occurred_at: "2026-11-22T09:30:00Z",
      milk_source: "formula",
      amount_ml: 150,
      notes: null,
      source: "manual",
      created_at: NOW,
    },
  ]);
});

it("update offline with no cached row: synthesizes defaults (formula, 0 ml, now) and queues only the sent fields", async () => {
  const calls = stubFetch(OFFLINE);
  const { wrapper } = setup();
  const { result } = renderHook(() => useUpdateBottleFeed(), { wrapper });
  let out: unknown;
  await act(async () => {
    out = await result.current.mutateAsync({ id: EXISTING_ID, babyId: BABY, notes: "late feed" });
  });
  await sync();
  expect(out).toEqual({
    id: EXISTING_ID,
    baby_id: BABY,
    occurred_at: NOW,
    milk_source: "formula",
    amount_ml: 0,
    notes: "late feed",
    source: "manual",
    created_at: NOW,
  });
  const q = await peekQueue();
  expect(q).toHaveLength(1);
  expect(q[0].body).toEqual({ notes: "late feed" });
  expect(calls).toHaveLength(2);
});

// --- nursing + sleep: in-progress open session, end, and open-session cache ---

interface SessionSpec {
  kind: string;
  collection: string;
  item: string;
  listKey: (babyId: string, from?: string, to?: string) => readonly unknown[];
  openKey: (babyId: string) => readonly unknown[];
  openPath: string;
  endKeyPrefix: string;
  useOpen: (babyId: string | null) => { data: unknown; isSuccess: boolean };
  useEnd: () => (vars: unknown) => Promise<unknown>;
  useCreate: () => (vars: unknown) => Promise<unknown>;
  useDelete: () => (vars: unknown) => Promise<unknown>;
  openRow: Row;
  other: Row;
  endVars: Row;
  endBody: Row;
  endedRow: Row;
  endedNoCacheRow: Row;
  inProgress: Fixture;
}

const SESSIONS: SessionSpec[] = [
  {
    kind: "nursing",
    collection: "nursing-sessions",
    item: "/nursing-sessions",
    listKey: qk.nursings,
    openKey: qk.openNursing,
    openPath: `/babies/${BABY}/nursing-sessions/open`,
    endKeyPrefix: "end-nursing-",
    useOpen: useOpenNursing,
    useEnd: adapt(useEndNursing),
    useCreate: adapt(useCreateNursing),
    useDelete: adapt(useDeleteNursing),
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
    other: {
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
    endVars: { id: EXISTING_ID, babyId: BABY, ended_at: "2026-11-22T10:00:00Z", left_duration_s: 420, right_duration_s: 0 },
    endBody: { ended_at: "2026-11-22T10:00:00Z", left_duration_s: 420, right_duration_s: 0 },
    endedRow: {
      id: EXISTING_ID,
      baby_id: BABY,
      started_at: "2026-11-22T09:50:00Z",
      ended_at: "2026-11-22T10:00:00Z",
      starting_breast: "left",
      nursing_side: "left",
      left_duration_s: 420,
      right_duration_s: 0,
      notes: null,
      source: "manual",
      created_at: "2026-11-22T09:50:01Z",
    },
    // With no cached row, the synthesized start is "now" and the side is "both".
    endedNoCacheRow: {
      id: EXISTING_ID,
      baby_id: BABY,
      started_at: NOW,
      ended_at: "2026-11-22T10:00:00Z",
      starting_breast: null,
      nursing_side: "both",
      left_duration_s: 420,
      right_duration_s: 0,
      notes: null,
      source: "manual",
      created_at: NOW,
    },
    inProgress: {
      vars: { babyId: BABY, started_at: "2026-11-22T09:50:00Z", nursing_side: "left", starting_breast: "left" },
      body: { id: ROW_ID, started_at: "2026-11-22T09:50:00Z", nursing_side: "left", starting_breast: "left" },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        started_at: "2026-11-22T09:50:00Z",
        ended_at: null,
        starting_breast: "left",
        nursing_side: "left",
        left_duration_s: 0,
        right_duration_s: 0,
        notes: null,
        source: "manual",
        created_at: NOW,
      },
    },
  },
  {
    kind: "sleep",
    collection: "sleeps",
    item: "/sleeps",
    listKey: qk.sleeps,
    openKey: qk.openSleep,
    openPath: `/babies/${BABY}/sleeps/open`,
    endKeyPrefix: "end-sleep-",
    useOpen: useOpenSleep,
    useEnd: adapt(useEndSleep),
    useCreate: adapt(useCreateSleep),
    useDelete: adapt(useDeleteSleep),
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
    other: {
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
    endVars: { id: EXISTING_ID, babyId: BABY, ended_at: "2026-11-22T10:00:00Z" },
    endBody: { ended_at: "2026-11-22T10:00:00Z" },
    endedRow: {
      id: EXISTING_ID,
      baby_id: BABY,
      started_at: "2026-11-22T09:00:00Z",
      ended_at: "2026-11-22T10:00:00Z",
      sleep_type: "nap",
      location: "crib",
      notes: null,
      source: "manual",
      created_at: "2026-11-22T09:00:01Z",
    },
    endedNoCacheRow: {
      id: EXISTING_ID,
      baby_id: BABY,
      started_at: NOW,
      ended_at: "2026-11-22T10:00:00Z",
      sleep_type: null,
      location: null,
      notes: null,
      source: "manual",
      created_at: NOW,
    },
    inProgress: {
      vars: { babyId: BABY, started_at: "2026-11-22T09:50:00Z", sleep_type: "nap", location: "crib" },
      body: { id: ROW_ID, started_at: "2026-11-22T09:50:00Z", sleep_type: "nap", location: "crib" },
      row: {
        id: ROW_ID,
        baby_id: BABY,
        started_at: "2026-11-22T09:50:00Z",
        ended_at: null,
        sleep_type: "nap",
        location: "crib",
        notes: null,
        source: "manual",
        created_at: NOW,
      },
    },
  },
];

describe.each(SESSIONS)("$kind: open session + end", (s) => {
  it("open: GET /open; a 204 normalizes to null", async () => {
    const calls = stubFetch(() => noContent());
    const { wrapper } = setup();
    const { result } = renderHook(() => s.useOpen(BABY), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(calls).toEqual([{ method: "GET", url: `/v1${s.openPath}`, body: undefined }]);
  });

  it("open: returns the in-progress row", async () => {
    stubFetch(() => json(s.openRow));
    const { wrapper } = setup();
    const { result } = renderHook(() => s.useOpen(BABY), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual(s.openRow));
  });

  it("in-progress create (online): POST omits ended_at; the server row primes the open cache", async () => {
    const calls = stubFetch(() => json(s.inProgress.row, 201));
    const { qc, wrapper } = setup();
    qc.setQueryData(s.listKey(BABY), [s.other]);
    const { result } = renderHook(s.useCreate, { wrapper });
    await act(async () => {
      await result.current(s.inProgress.vars);
    });
    expect(calls).toEqual([{ method: "POST", url: `/v1/babies/${BABY}/${s.collection}`, body: s.inProgress.body }]);
    expect(qc.getQueryData(s.openKey(BABY))).toEqual(s.inProgress.row);
    expect(qc.getQueryData(s.listKey(BABY))).toEqual([s.inProgress.row, s.other]);
  });

  it("in-progress create (offline): the synthesized row primes the open cache", async () => {
    const calls = stubFetch(OFFLINE);
    const { qc, wrapper } = setup();
    const { result } = renderHook(s.useCreate, { wrapper });
    await act(async () => {
      await result.current(s.inProgress.vars);
    });
    await sync();
    const post = { method: "POST", url: `/v1/babies/${BABY}/${s.collection}`, body: s.inProgress.body };
    expect(calls).toEqual([post, post]);
    const q = await peekQueue();
    expect(q).toHaveLength(1);
    expect(q[0].body).toEqual(s.inProgress.body);
    expect(qc.getQueryData(s.openKey(BABY))).toEqual(s.inProgress.row);
  });

  it("end online: PATCH carries only the close fields; open is cleared; the list row is replaced in place", async () => {
    const calls = stubFetch(() => json(s.endedRow));
    const { qc, wrapper } = setup();
    qc.setQueryData(s.openKey(BABY), s.openRow);
    qc.setQueryData(s.listKey(BABY), [s.other, s.openRow]);
    const { result } = renderHook(s.useEnd, { wrapper });
    await act(async () => {
      await result.current(s.endVars);
    });
    expect(calls).toEqual([{ method: "PATCH", url: `/v1${s.item}/${EXISTING_ID}`, body: s.endBody }]);
    expect(await peekQueue()).toEqual([]);
    expect(qc.getQueryData(s.openKey(BABY))).toBeNull();
    expect(qc.getQueryData(s.listKey(BABY))).toEqual([s.other, s.endedRow]);
  });

  it("end offline: enqueues PATCH keyed end-<kind>-<id>; the row is synthesized from the cached list", async () => {
    const calls = stubFetch(OFFLINE);
    const { qc, wrapper } = setup();
    qc.setQueryData(s.openKey(BABY), s.openRow);
    qc.setQueryData(s.listKey(BABY), [s.other, s.openRow]);
    const { result } = renderHook(s.useEnd, { wrapper });
    let out: unknown;
    await act(async () => {
      out = await result.current(s.endVars);
    });
    await sync();
    const patch = { method: "PATCH", url: `/v1${s.item}/${EXISTING_ID}`, body: s.endBody };
    expect(calls).toEqual([patch, patch]);
    const q = await peekQueue();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      method: "PATCH",
      path: `${s.item}/${EXISTING_ID}`,
      idempotencyKey: `${s.endKeyPrefix}${EXISTING_ID}`,
    });
    expect(q[0].body).toEqual(s.endBody);
    expect(out).toEqual(s.endedRow);
    expect(qc.getQueryData(s.openKey(BABY))).toBeNull();
    expect(qc.getQueryData(s.listKey(BABY))).toEqual([s.other, s.endedRow]);
  });

  it("end offline with nothing cached: fabricates the start as now; no list cache is created", async () => {
    stubFetch(OFFLINE);
    const { qc, wrapper } = setup();
    const { result } = renderHook(s.useEnd, { wrapper });
    let out: unknown;
    await act(async () => {
      out = await result.current(s.endVars);
    });
    await sync();
    expect(out).toEqual(s.endedNoCacheRow);
    expect(qc.getQueryData(s.openKey(BABY))).toBeNull();
    // setQueriesData is a no-op when no list query exists, so none appears.
    expect(qc.getQueryData(s.listKey(BABY))).toBeUndefined();
  });

  // CURRENT BEHAVIOR (surprising): the open-session key is nested under the
  // list prefix, so removeFromList's setQueriesData also hits the open entry
  // (an object, not an array) and `.filter` throws inside onSuccess. The
  // open-clear step never runs, so the open session stays cached.
  it("KNOWN BUG (approved fix): delete with a cached open session throws in onSuccess and leaves it cached", async () => {
    stubFetch(() => noContent());
    const { qc, wrapper } = setup();
    qc.setQueryData(s.openKey(BABY), s.openRow);
    const { result } = renderHook(s.useDelete, { wrapper });
    await act(async () => {
      await expect(result.current({ id: EXISTING_ID, babyId: BABY })).rejects.toThrow(
        /filter is not a function/,
      );
    });
    expect(qc.getQueryData(s.openKey(BABY))).toEqual(s.openRow);
  });
});

// --- photo diff synthesis (diaper, solids, note only) ---

const PHOTO_B64 = "UEhPVE8=";
const PHOTO_KINDS = KINDS.filter((k) => ["diaper", "solids", "note"].includes(k.kind));

describe.each(PHOTO_KINDS)("$kind: photo", (k) => {
  it("create online with a photo: POST body carries photo and photo_mime; server row is cached", async () => {
    const calls = stubFetch(() => json(k.create.serverRow, 201));
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [k.other]);
    const { result } = renderHook(k.useCreate, { wrapper });
    await act(async () => {
      await result.current({ ...k.create.vars, photoBase64: PHOTO_B64, photoMime: "image/jpeg" });
    });
    expect(calls).toEqual([
      {
        method: "POST",
        url: `/v1/babies/${BABY}/${k.collection}`,
        body: { ...k.create.body, photo: PHOTO_B64, photo_mime: "image/jpeg" },
      },
    ]);
    expect(qc.getQueryData(k.listKey(BABY))).toEqual([k.create.serverRow, k.other]);
  });

  it("create offline with a photo: synthesized row has has_photo true and the mime", async () => {
    stubFetch(OFFLINE);
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [k.other]);
    const { result } = renderHook(k.useCreate, { wrapper });
    await act(async () => {
      await result.current({ ...k.create.vars, photoBase64: PHOTO_B64, photoMime: "image/jpeg" });
    });
    await sync();
    const first = (qc.getQueryData(k.listKey(BABY)) as Row[])[0];
    expect(first).toMatchObject({ id: ROW_ID, has_photo: true, photo_mime: "image/jpeg" });
  });

  it("update with a new photo: PATCH carries photo and photo_mime", async () => {
    const calls = stubFetch(() => json(k.existing, 200));
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [k.existing]);
    const { result } = renderHook(k.useUpdate, { wrapper });
    await act(async () => {
      await result.current({ id: EXISTING_ID, babyId: BABY, photoBase64: PHOTO_B64, photoMime: "image/png" });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      url: `/v1${k.item}/${EXISTING_ID}`,
      body: { photo: PHOTO_B64, photo_mime: "image/png" },
    });
  });

  it("update with an empty photo string clears: PATCH sends photo \"\" with no photo_mime; cached row is synthesized without a photo", async () => {
    const calls = stubFetch(OFFLINE);
    const { qc, wrapper } = setup();
    qc.setQueryData(k.listKey(BABY), [{ ...k.existing, has_photo: true, photo_mime: "image/jpeg" }]);
    const { result } = renderHook(k.useUpdate, { wrapper });
    await act(async () => {
      await result.current({ id: EXISTING_ID, babyId: BABY, photoBase64: "" });
    });
    await sync();
    expect(calls[0].body).toEqual({ photo: "" });
    const first = (qc.getQueryData(k.listKey(BABY)) as Row[])[0];
    expect(first).toMatchObject({ id: EXISTING_ID, has_photo: false, photo_mime: null });
  });
});
