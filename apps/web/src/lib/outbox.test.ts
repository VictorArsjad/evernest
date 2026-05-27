// fake-indexeddb/auto monkeypatches `indexedDB` + `IDBKeyRange` etc.
// into globalThis so the existing node-env vitest config can drive
// IDB-backed code under test without adding jsdom.
//
// We deliberately avoid `vi.useFakeTimers()` here: fake-indexeddb uses
// setTimeout under the hood for async dispatch, and mixing the two
// freezes IDB ops mid-flight. Instead we configure the outbox with
// millisecond-scale backoffs (1ms base / 10ms ceiling) so a "wait for
// the retry to schedule" sleep is < 50ms and the suite still runs in
// well under a second total.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetForTests,
  _resetTestConfig,
  _setTestConfig,
  backoffDelayFor,
  type DispatchResult,
  discardDead,
  enqueueMutation,
  getDead,
  getPending,
  kickAfterReauth,
  onChange,
  onDrained,
  peekQueue,
  retryDead,
  setDispatcher,
  sync,
} from "./outbox";

// Small awaitable sleep for real-timer tests.
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Helper: poll the queue until the predicate holds or we time out.
// Used in retry-loop tests where we don't know exactly when the next
// drain tick lands but we do know the eventual end state.
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 2000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(intervalMs);
  }
  throw new Error("waitFor: predicate never held");
}

beforeEach(async () => {
  await _resetForTests();
  _resetTestConfig();
  // Aggressive backoffs keep the tests fast. Production values are
  // restored by _resetTestConfig() / between-test cleanup.
  _setTestConfig({ backoffBaseMs: 1, backoffCeilingMs: 10, attemptCap: 8 });
  setDispatcher(null);
});

afterEach(() => {
  setDispatcher(null);
});

describe("backoffDelayFor", () => {
  it("matches the documented schedule with the production 1s base / 60s ceiling", () => {
    // The test-config backoff is reset here so the schedule reflects
    // what production users actually experience.
    _resetTestConfig();
    expect(backoffDelayFor(1)).toBe(1000);
    expect(backoffDelayFor(2)).toBe(2000);
    expect(backoffDelayFor(3)).toBe(4000);
    expect(backoffDelayFor(4)).toBe(8000);
    expect(backoffDelayFor(5)).toBe(16_000);
    expect(backoffDelayFor(6)).toBe(32_000);
    // 64s exceeds the 60s ceiling -> clamped.
    expect(backoffDelayFor(7)).toBe(60_000);
    expect(backoffDelayFor(8)).toBe(60_000);
    expect(backoffDelayFor(20)).toBe(60_000);
  });

  it("respects overridden base/ceiling for fast tests", () => {
    _setTestConfig({ backoffBaseMs: 10, backoffCeilingMs: 200 });
    expect(backoffDelayFor(1)).toBe(10);
    expect(backoffDelayFor(5)).toBe(160);
    expect(backoffDelayFor(10)).toBe(200);
  });
});

describe("enqueueMutation + sync — happy path", () => {
  it("drains a record on 2xx and clears the queue", async () => {
    const dispatcher = vi.fn(async () => ({
      kind: "ok",
      status: 201,
      data: { id: "x" },
    } satisfies DispatchResult));
    setDispatcher(dispatcher);
    const r = await enqueueMutation({
      method: "POST",
      path: "/babies/b1/bottle-feeds",
      body: { id: "k1", amount_ml: 60 },
      idempotencyKey: "k1",
    });
    expect(r.status).toBe("pending");
    await sync();
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(await peekQueue()).toHaveLength(0);
  });

  it("processes records sequentially in FIFO order (concurrency 1)", async () => {
    // We track in-flight count: at any moment exactly one dispatcher
    // call is allowed to be running. The assertion catches any
    // accidental parallelism in the drain loop.
    let inflight = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    setDispatcher(async (rec) => {
      inflight += 1;
      maxConcurrent = Math.max(maxConcurrent, inflight);
      order.push(rec.path);
      await wait(5);
      inflight -= 1;
      return { kind: "ok", status: 200, data: {} };
    });

    await enqueueMutation({ method: "POST", path: "/a", idempotencyKey: "a" });
    await enqueueMutation({ method: "POST", path: "/b", idempotencyKey: "b" });
    await enqueueMutation({ method: "POST", path: "/c", idempotencyKey: "c" });
    await sync();
    expect(order).toEqual(["/a", "/b", "/c"]);
    expect(maxConcurrent).toBe(1);
  });
});

describe("dedup by idempotencyKey", () => {
  it("collapses a re-submission of the same key into one queued record", async () => {
    // Use a never-resolving dispatcher so the first record stays
    // pending; the second enqueue with the same key should not add a
    // new row.
    setDispatcher(() => new Promise<DispatchResult>(() => {}));
    const r1 = await enqueueMutation({
      method: "POST",
      path: "/x",
      idempotencyKey: "same",
    });
    const r2 = await enqueueMutation({
      method: "POST",
      path: "/x",
      idempotencyKey: "same",
    });
    expect(r1.id).toBe(r2.id);
    expect(await peekQueue()).toHaveLength(1);
  });
});

describe("transient (5xx / network) retries", () => {
  it("backs off, retries, and drains on eventual 2xx", async () => {
    const script: DispatchResult[] = [
      { kind: "transient", status: 503, message: "service unavailable" },
      { kind: "transient", status: 503, message: "still down" },
      { kind: "ok", status: 200, data: { id: "k" } },
    ];
    const dispatcher = vi.fn(async () => script.shift()!);
    setDispatcher(dispatcher);

    await enqueueMutation({
      method: "POST",
      path: "/x",
      idempotencyKey: "k",
    });
    // Drain happens via the backoff timer chain in the background.
    // Poll until the queue is empty (eventual success on the 3rd try).
    await waitFor(async () => (await peekQueue()).length === 0, { timeoutMs: 500 });
    expect(dispatcher).toHaveBeenCalledTimes(3);
  });

  it("escalates to dead after attemptCap repeated 5xx", async () => {
    _setTestConfig({ attemptCap: 3, backoffBaseMs: 1, backoffCeilingMs: 5 });
    setDispatcher(async () => ({
      kind: "transient",
      status: 503,
      message: "down",
    }));
    await enqueueMutation({ method: "POST", path: "/x", idempotencyKey: "k" });
    await waitFor(async () => (await getDead()).length === 1, { timeoutMs: 500 });
    const dead = await getDead();
    expect(dead[0].attempts).toBe(3);
    expect(dead[0].status).toBe("dead");
  });
});

describe("client errors (4xx, non-401)", () => {
  it("marks the record dead immediately, no retries", async () => {
    const dispatcher = vi.fn(async () => ({
      kind: "client_error",
      status: 422,
      message: "amount_ml must be > 0",
    } satisfies DispatchResult));
    setDispatcher(dispatcher);
    await enqueueMutation({
      method: "POST",
      path: "/babies/b1/bottle-feeds",
      body: { amount_ml: -1 },
      idempotencyKey: "bad",
    });
    await sync();
    const dead = await getDead();
    expect(dead).toHaveLength(1);
    expect(dead[0].status).toBe("dead");
    expect(dead[0].lastError).toContain("422");
    expect(dispatcher).toHaveBeenCalledTimes(1);
  });
});

describe("auth errors (401)", () => {
  it("stays pending after a 401 and does NOT increment attempts", async () => {
    setDispatcher(async () => ({ kind: "auth_error", status: 401 }));
    await enqueueMutation({ method: "POST", path: "/x", idempotencyKey: "k" });
    await sync();
    const pending = await getPending();
    expect(pending).toHaveLength(1);
    // Auth errors are not user-error and not transient — the record
    // stays pending with attempts still 0 so it doesn't burn the
    // retry budget while waiting for the user to re-auth.
    expect(pending[0].status).toBe("pending");
    expect(pending[0].attempts).toBe(0);
    expect(pending[0].nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it("drains after re-auth → 200", async () => {
    let serverHas401 = true;
    setDispatcher(async () => {
      if (serverHas401) return { kind: "auth_error", status: 401 };
      return { kind: "ok", status: 200, data: { id: "k" } };
    });
    await enqueueMutation({ method: "POST", path: "/x", idempotencyKey: "k" });
    await sync();
    expect((await getPending())).toHaveLength(1);

    serverHas401 = false;
    await kickAfterReauth();
    await waitFor(async () => (await peekQueue()).length === 0, { timeoutMs: 500 });
  });
});

describe("manual interventions", () => {
  it("retryDead resets attempts and re-enqueues", async () => {
    _setTestConfig({ attemptCap: 2, backoffBaseMs: 1, backoffCeilingMs: 2 });
    // First two attempts fail → record goes dead.
    let failingCalls = 0;
    setDispatcher(async () => {
      failingCalls += 1;
      if (failingCalls <= 2) {
        return { kind: "transient", status: 500, message: "x" };
      }
      return { kind: "ok", status: 200, data: {} };
    });
    await enqueueMutation({ method: "POST", path: "/x", idempotencyKey: "k" });
    await waitFor(async () => (await getDead()).length === 1, { timeoutMs: 500 });

    await retryDead();
    // After retryDead, the record is pending again with attempts=0;
    // the next dispatch (3rd overall) returns ok and drains.
    await waitFor(async () => (await peekQueue()).length === 0, { timeoutMs: 500 });
    expect(failingCalls).toBe(3);
  });

  it("discardDead removes the record from the queue", async () => {
    setDispatcher(async () => ({
      kind: "client_error",
      status: 422,
      message: "no good",
    }));
    await enqueueMutation({ method: "POST", path: "/x", idempotencyKey: "k" });
    await sync();
    const dead = await getDead();
    expect(dead).toHaveLength(1);
    await discardDead(dead[0].id);
    expect(await peekQueue()).toHaveLength(0);
  });
});

describe("change + drain notifications", () => {
  it("fires onChange after enqueue + after drain", async () => {
    const changes = vi.fn();
    const unsub = onChange(changes);
    setDispatcher(async () => ({ kind: "ok", status: 200, data: {} }));
    await enqueueMutation({ method: "POST", path: "/x", idempotencyKey: "k" });
    await sync();
    unsub();
    // At minimum: one for the initial enqueue write, one for the
    // post-dispatch store mutation. Allow >=2 to keep the test
    // resilient against future internal writes that pub-sub.
    expect(changes.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("fires onDrained exactly once per N>0→0 transition", async () => {
    const drained = vi.fn();
    const unsub = onDrained(drained);
    setDispatcher(async () => ({ kind: "ok", status: 200, data: {} }));
    await enqueueMutation({ method: "POST", path: "/x", idempotencyKey: "a" });
    await enqueueMutation({ method: "POST", path: "/x", idempotencyKey: "b" });
    await sync();
    unsub();
    expect(drained).toHaveBeenCalledTimes(1);

    // Subsequent sync() with empty queue does not re-fire.
    const drained2 = vi.fn();
    const unsub2 = onDrained(drained2);
    await sync();
    unsub2();
    expect(drained2).not.toHaveBeenCalled();
  });
});

describe("integration: badge state via dispatcher transitions", () => {
  it("transitions queue→empty as a transient outage recovers", async () => {
    // Simulate the offline → online recovery the dev expects: the
    // first dispatch fails (network), then the second succeeds.
    let callCount = 0;
    setDispatcher(async () => {
      callCount += 1;
      if (callCount === 1) {
        return { kind: "transient", status: 0, message: "fetch failed" };
      }
      return { kind: "ok", status: 200, data: { id: "k" } };
    });

    await enqueueMutation({
      method: "POST",
      path: "/babies/b1/bottle-feeds",
      body: { amount_ml: 60 },
      idempotencyKey: "k",
    });
    await waitFor(async () => (await peekQueue()).length === 0, { timeoutMs: 500 });
    expect(callCount).toBe(2);
  });
});
