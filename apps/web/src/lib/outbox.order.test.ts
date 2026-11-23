import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetForTests,
  _resetTestConfig,
  _setTestConfig,
  enqueueMutation,
  getDead,
  getPending,
  setDispatcher,
  sync,
  type DispatchResult,
} from "./outbox";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await wait(5);
  }
  throw new Error("waitFor: predicate never held");
}

beforeEach(async () => {
  await _resetForTests();
  _resetTestConfig();
  _setTestConfig({ backoffBaseMs: 30, backoffCeilingMs: 30, attemptCap: 8 });
  setDispatcher(null);
});

afterEach(() => {
  setDispatcher(null);
});

const ok: DispatchResult = { kind: "ok", status: 200, data: {} };

describe("outbox ordering per entityId", () => {
  it("holds a later PATCH while the earlier create for the row is in backoff", async () => {
    const calls: string[] = [];
    let createFails = 1;
    setDispatcher(async (rec) => {
      calls.push(`${rec.method} ${rec.path}`);
      if (rec.method === "POST" && createFails-- > 0) {
        return { kind: "transient", status: 503, message: "down" };
      }
      return ok;
    });
    await enqueueMutation({ method: "POST", path: "/e", idempotencyKey: "r1", entityId: "r1" });
    await sync(); // create fails -> backoff
    await enqueueMutation({
      method: "PATCH",
      path: "/e/r1",
      idempotencyKey: "r1:patch:x",
      entityId: "r1",
    });
    await sync();
    // PATCH must not have gone ahead of the backed-off create.
    expect(calls).toEqual(["POST /e"]);
    await waitFor(async () => (await getPending()).length === 0);
    expect(calls).toEqual(["POST /e", "POST /e", "PATCH /e/r1"]);
  });

  it("does not let a dead create block later records for the row", async () => {
    const calls: string[] = [];
    setDispatcher(async (rec) => {
      calls.push(rec.method);
      if (rec.method === "POST") return { kind: "client_error", status: 400, message: "bad" };
      return ok;
    });
    await enqueueMutation({ method: "POST", path: "/e", idempotencyKey: "r1", entityId: "r1" });
    await sync();
    expect(await getDead()).toHaveLength(1);
    await enqueueMutation({
      method: "PATCH",
      path: "/e/r1",
      idempotencyKey: "r1:patch:x",
      entityId: "r1",
    });
    await sync();
    expect(calls).toEqual(["POST", "PATCH"]);
    expect(await getPending()).toHaveLength(0);
  });

  it("does not block unrelated rows or records without entityId", async () => {
    const calls: string[] = [];
    setDispatcher(async (rec) => {
      calls.push(rec.path);
      if (rec.path === "/e") return { kind: "transient", status: 503, message: "down" };
      return ok;
    });
    await enqueueMutation({ method: "POST", path: "/e", idempotencyKey: "r1", entityId: "r1" });
    await sync();
    await enqueueMutation({
      method: "PATCH",
      path: "/e/r2",
      idempotencyKey: "r2",
      entityId: "r2",
    });
    await enqueueMutation({ method: "POST", path: "/legacy", idempotencyKey: "legacy" });
    await sync();
    expect(calls).toContain("/e/r2");
    expect(calls).toContain("/legacy");
  });
});
