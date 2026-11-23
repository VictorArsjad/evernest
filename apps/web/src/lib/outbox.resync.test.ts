// Regression: a sync() that arrives while a drain is in its tail (after
// the final pickNextReady) used to be dropped, because sync() returns
// the in-flight drain promise. The queue then sat idle until another
// trigger. These tests force that interleaving deterministically by
// stalling the Nth IDB getAll() (the drain's post-wake / drained-check
// reads) until the "late" trigger has fired.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetForTests,
  _resetTestConfig,
  _setTestConfig,
  type DispatchResult,
  enqueueMutation,
  peekQueue,
  setDispatcher,
} from "./outbox";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await wait(5);
  }
  throw new Error("waitFor: predicate never held");
}

// Stall the `nth` (1-based, counted from install) getAll() until the
// returned `release` is called. `stalled` resolves when it is reached.
function stallNthGetAll(nth: number) {
  const proto = IDBObjectStore.prototype as unknown as {
    getAll: (...a: unknown[]) => IDBRequest;
  };
  const orig = proto.getAll;
  let calls = 0;
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const stalled = new Promise<void>((r) => (reached = r));
  proto.getAll = function (this: unknown, ...args: unknown[]) {
    const req = orig.apply(this, args);
    calls += 1;
    if (calls !== nth) return req;
    reached();
    return new Promise((resolve, reject) => {
      req.addEventListener("success", () => void gate.then(() => resolve(req.result)));
      req.addEventListener("error", () => reject(req.error));
    }) as unknown as IDBRequest;
  };
  return { stalled, release, restore: () => (proto.getAll = orig) };
}

let restore: (() => void) | null = null;

beforeEach(async () => {
  await _resetForTests();
  _resetTestConfig();
  _setTestConfig({ backoffBaseMs: 1, backoffCeilingMs: 10, attemptCap: 8 });
  setDispatcher(null);
});

afterEach(() => {
  restore?.();
  restore = null;
  setDispatcher(null);
});

describe("outbox sync during drain tail", () => {
  it("retry timer firing mid-drain still re-drains the failed record", async () => {
    const sent: string[] = [];
    let first = true;
    setDispatcher(async (rec): Promise<DispatchResult> => {
      sent.push(rec.path);
      if (first) {
        first = false;
        return { kind: "transient", status: 503, message: "boom" };
      }
      return { kind: "ok", status: 200, data: null };
    });
    // Backoff must outlast the drain's own IDB reads so the final
    // pickNextReady deterministically sees the record as "not ready".
    _setTestConfig({ backoffBaseMs: 50, backoffCeilingMs: 50 });
    // getAll calls in the drain: 1 start, 2 pick(A), [dispatch fails],
    // 3 pick(null), 4 schedulePendingWake (arms 50ms timer), 5 drained check.
    const s = stallNthGetAll(5);
    restore = s.restore;
    void enqueueMutation({ method: "POST", path: "/a", idempotencyKey: "a" });
    await s.stalled;
    await wait(150); // retry timer fires and calls sync() mid-drain
    s.release();
    await waitFor(async () => (await peekQueue()).length === 0);
    expect(sent).toEqual(["/a", "/a"]);
  });

  it("enqueue-triggered sync() during the drain tail gets its record sent", async () => {
    const sent: string[] = [];
    setDispatcher(async (rec): Promise<DispatchResult> => {
      sent.push(rec.path);
      return { kind: "ok", status: 200, data: null };
    });
    // 1 start, 2 pick(A), 3 pick(null), 4 schedulePendingWake -> stall here.
    const s = stallNthGetAll(4);
    restore = s.restore;
    void enqueueMutation({ method: "POST", path: "/a", idempotencyKey: "a" });
    await s.stalled;
    await enqueueMutation({ method: "POST", path: "/b", idempotencyKey: "b" });
    s.release();
    await waitFor(async () => (await peekQueue()).length === 0);
    expect(sent).toEqual(["/a", "/b"]);
  });
});
