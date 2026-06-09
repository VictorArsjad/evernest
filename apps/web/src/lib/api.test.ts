// apiQueued — verifies that the synthesized response is returned to
// the caller when a mutation fails with a network error or 5xx, and
// that 4xx errors stay throwing. The point of the synthesized response
// is that TanStack Query's onSuccess paths run as if the mutation
// succeeded, so the cache reflects the user's intent immediately even
// when offline. Without it, the offline write would surface to the
// user as a save failure even though we did successfully queue it.

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api, apiQueued, ApiError } from "./api";
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
  // the production code path. `expiresAt` is set well above the 60s
  // proactive-refresh buffer so the apiQueued tests below exercise only
  // the data path; the ensureFreshToken-specific tests further down
  // seed a near-expiry token explicitly.
  useAuthStore.setState({
    accessToken: "test-token",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
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

// --- ensureFreshToken (proactive refresh) ---
//
// The shared `beforeEach` above seeds the access token with `expiresAt`
// already 60s in the future, which is exactly the buffer boundary —
// individual tests below override expiresAt to land safely above or
// below the buffer.
describe("api — proactive token refresh near expiry", () => {
  function seedToken(opts: { accessToken: string; expiresAt: string; refreshToken: string }) {
    useAuthStore.setState({
      accessToken: opts.accessToken,
      expiresAt: opts.expiresAt,
      refreshToken: opts.refreshToken,
      status: "authenticated",
    });
  }

  function newTokenResponse(overrides?: Partial<{ access_token: string }>) {
    return {
      access_token: overrides?.access_token ?? "rotated-token",
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      refresh_token: "rotated-refresh",
      refresh_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      user: {
        id: "u1",
        email: "u@example.com",
        display_name: "U",
        created_at: new Date().toISOString(),
      },
    };
  }

  it("does NOT refresh when the token has plenty of life left", async () => {
    seedToken({
      accessToken: "fresh-token",
      // 10 minutes left — well above the 60s buffer.
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      refreshToken: "rt",
    });

    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      // The data request should be the ONLY fetch — no refresh round-trip.
      const url = String(input);
      expect(url.endsWith("/auth/refresh")).toBe(false);
      // Assert it carried the still-fresh access token.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer fresh-token");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const out = await api<{ ok: boolean }>("/babies/b1");
    expect(out.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes BEFORE the data request when the token is within the buffer", async () => {
    seedToken({
      accessToken: "stale-token",
      // 5s left — well inside the 60s buffer.
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      refreshToken: "rt",
    });

    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        calls.push("refresh");
        return new Response(JSON.stringify(newTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      calls.push("data");
      // Critically: the data request must carry the rotated token, not
      // the stale one — otherwise the refresh was wasted and the 401
      // reactive path would still fire.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer rotated-token");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    const out = await api<{ ok: boolean }>("/babies/b1");
    expect(out.ok).toBe(true);
    // Refresh first, then the data request.
    expect(calls).toEqual(["refresh", "data"]);
  });

  it("coalesces N concurrent near-expiry requests into a single refresh", async () => {
    seedToken({
      accessToken: "stale-token",
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
      refreshToken: "rt",
    });

    let refreshCalls = 0;
    let dataCalls = 0;
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        // Small async gap so concurrent api() callers all observe an
        // in-flight refreshInflight before it resolves; otherwise the
        // single-flight is trivially exercised by sequential awaits.
        await Promise.resolve();
        return new Response(JSON.stringify(newTokenResponse()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      dataCalls += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    // Fire 10 concurrent reads — mirrors the Today screen on warm focus.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => api<{ ok: boolean }>(`/babies/b1/path-${i}`)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(refreshCalls).toBe(1);
    expect(dataCalls).toBe(10);
  });

  it("skips the proactive refresh entirely when the request is to /auth/*", async () => {
    seedToken({
      accessToken: "stale-token",
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
      refreshToken: "rt",
    });

    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      // Login / logout / refresh themselves must not bootstrap a
      // proactive refresh — that would deadlock the refresh path.
      expect(url.endsWith("/auth/refresh")).toBe(true);
      return new Response(JSON.stringify(newTokenResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;

    await api<unknown>("/auth/refresh", { method: "POST", body: { refresh_token: "rt" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
