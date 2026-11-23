import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";

import {
  _resetForTests,
  enqueueMutation,
  getPending,
  setDispatcher,
  sync,
} from "./outbox";

describe("_resetForTests isolation", () => {
  it("does not let a drain from before the reset dispatch records enqueued after it", async () => {
    await _resetForTests();
    // A drain that is still mid-dispatch when the reset happens.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setDispatcher(async () => {
      await gate;
      return { kind: "ok", status: 200, data: {} };
    });
    await enqueueMutation({
      method: "POST",
      path: "/old",
      idempotencyKey: "old",
    });
    const resetDone = _resetForTests();
    release();
    await resetDone;

    const calls: string[] = [];
    setDispatcher(async (rec) => {
      calls.push(rec.path);
      return { kind: "ok", status: 200, data: {} };
    });
    await enqueueMutation({
      method: "POST",
      path: "/new",
      idempotencyKey: "new",
    });
    await sync();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(["/new"]);
    expect(await getPending()).toHaveLength(0);
    setDispatcher(null);
  });
});
