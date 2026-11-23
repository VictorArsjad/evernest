// @vitest-environment jsdom
// Regression: during onboarding the babies GET fires concurrently with the
// create POST and can resolve with [] after the create has committed.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { qk, useBabies, useCreateBaby } from "./queries";
import { installQueryHarness, json, setup, stubFetch } from "../test/queryHarness";

installQueryHarness();

const HOUSEHOLD = "h1";
const CREATED = {
  id: "bb-1",
  household_id: HOUSEHOLD,
  name: "Ever",
  created_at: "2026-11-22T10:00:00Z",
};

describe("useCreateBaby", () => {
  it("keeps the created baby when a racing GET resolves with a stale []", async () => {
    // The GET answers [] and is held until after the POST has resolved.
    let releaseStaleGet: () => void = () => {};
    const stale = new Promise<void>((r) => (releaseStaleGet = r));
    let created = false;
    const calls = stubFetch((call) => {
      if (call.method === "POST") {
        created = true;
        return json(CREATED, 201);
      }
      // The first GET was served before the create committed.
      return json(created ? [CREATED] : []);
    });
    // Hold only the first GET's response (it already carries the stale []).
    const realFetch = globalThis.fetch;
    let first = true;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const res = await realFetch(...args);
      if (first && (args[1]?.method ?? "GET") === "GET") {
        first = false;
        await stale;
      }
      return res;
    }) as typeof fetch;

    const { qc, wrapper } = setup();
    const { result } = renderHook(
      () => ({ list: useBabies(HOUSEHOLD), create: useCreateBaby() }),
      { wrapper },
    );
    await waitFor(() => expect(calls.some((c) => c.method === "GET")).toBe(true));

    await act(async () => {
      await result.current.create.mutateAsync({ householdId: HOUSEHOLD, name: "Ever" });
    });
    // Right after the create resolves, the cache must already hold the baby.
    expect(qc.getQueryData(qk.babies(HOUSEHOLD))).toEqual([CREATED]);

    await act(async () => {
      releaseStaleGet();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(qc.getQueryData(qk.babies(HOUSEHOLD))).toEqual([CREATED]);
  });
});
