// apiQueued — verifies that the synthesized response is returned to
// the caller when a mutation fails with a network error or 5xx, and
// that 4xx errors stay throwing. The point of the synthesized response
// is that TanStack Query's onSuccess paths run as if the mutation
// succeeded, so the cache reflects the user's intent immediately even
// when offline. Without it, the offline write would surface to the
// user as a save failure even though we did successfully queue it.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiQueued, ApiError } from "./api";
import { useAuthStore } from "./authStore";
import {
  _resetForTests,
  _resetTestConfig,
  peekQueue,
} from "./outbox";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(async () => {
  await _resetForTests();
  _resetTestConfig();
  // Seed an access token so api() attaches an Authorization header.
  // Skipping this would let api() send the request anyway (skipAuth is
  // false but the token is just null) — we set it explicitly to mirror
  // the production code path.
  useAuthStore.setState({
    accessToken: "test-token",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    user: {
      id: "u1",
      email: "u@example.com",
      display_name: "U",
      created_at: new Date().toISOString(),
    },
    status: "authenticated",
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("apiQueued — pass-through on success", () => {
  it("returns the real server response when the request succeeds", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: "server", amount_ml: 60 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;

    const synthCalls = vi.fn(() => ({ id: "client", amount_ml: 0 }));
    const out = await apiQueued<{ id: string; amount_ml: number }>(
      "/babies/b1/bottle-feeds",
      {
        method: "POST",
        body: { id: "client", amount_ml: 60 },
        idempotencyKey: "client",
        synthesize: synthCalls,
      },
    );
    expect(out.id).toBe("server");
    expect(synthCalls).not.toHaveBeenCalled();
    // Nothing should have been enqueued.
    expect(await peekQueue()).toHaveLength(0);
  });
});

describe("apiQueued — enqueue + synthesize on transient", () => {
  it("on TypeError (network) returns the synthetic and enqueues", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const synthetic = { id: "client", amount_ml: 60 };
    const out = await apiQueued<typeof synthetic>("/babies/b1/bottle-feeds", {
      method: "POST",
      body: { id: "client", amount_ml: 60 },
      idempotencyKey: "client",
      synthesize: () => synthetic,
    });
    expect(out).toEqual(synthetic);
    const q = await peekQueue();
    expect(q).toHaveLength(1);
    expect(q[0].method).toBe("POST");
    expect(q[0].path).toBe("/babies/b1/bottle-feeds");
    expect(q[0].idempotencyKey).toBe("client");
  });

  it("on 503 returns the synthetic and enqueues", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: "unavailable", message: "down" } }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    const synthetic = { id: "client", type: "wet" };
    const out = await apiQueued<typeof synthetic>("/babies/b1/diapers", {
      method: "POST",
      body: { id: "client", type: "wet" },
      idempotencyKey: "client",
      synthesize: () => synthetic,
    });
    expect(out).toEqual(synthetic);
    expect(await peekQueue()).toHaveLength(1);
  });
});

describe("apiQueued — 4xx surfaces, does NOT enqueue", () => {
  it("throws ApiError on 422 and leaves the queue empty", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: { code: "validation_failed", message: "amount_ml must be > 0" },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    ) as typeof fetch;

    const synth = vi.fn(() => ({ id: "client" }));
    await expect(
      apiQueued("/babies/b1/bottle-feeds", {
        method: "POST",
        body: { amount_ml: -1 },
        idempotencyKey: "bad",
        synthesize: synth,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(synth).not.toHaveBeenCalled();
    expect(await peekQueue()).toHaveLength(0);
  });
});

describe("apiQueued — 401 after failed refresh queues", () => {
  it("queues when the refresh + retry both end up 401", async () => {
    // First call: 401 to the create path.
    // Second call: 401 to the refresh endpoint (refresh cookie expired).
    // No further call — the original 401 propagates as an ApiError.
    let calls = 0;
    globalThis.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls += 1;
      if (url.endsWith("/auth/refresh")) {
        return new Response(null, { status: 401 });
      }
      return new Response(
        JSON.stringify({ error: { code: "unauthenticated", message: "no" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const synthetic = { id: "client" };
    const out = await apiQueued<typeof synthetic>("/babies/b1/diapers", {
      method: "POST",
      body: { id: "client" },
      idempotencyKey: "client",
      synthesize: () => synthetic,
    });
    expect(out).toEqual(synthetic);
    expect(calls).toBeGreaterThanOrEqual(2); // initial + refresh attempt
    expect(await peekQueue()).toHaveLength(1);
  });
});

describe("apiQueued — ApiError type is preserved on rethrow", () => {
  it("rethrown 4xx errors are still ApiError instances", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "x", message: "y" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    ) as typeof fetch;
    try {
      await apiQueued("/anything", {
        method: "POST",
        body: {},
        idempotencyKey: "k",
        synthesize: () => ({}),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(400);
    }
  });
});
