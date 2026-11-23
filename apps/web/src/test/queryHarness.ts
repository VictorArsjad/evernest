// Shared scaffolding for the characterization ("freeze") tests of the
// per-kind hooks in lib/queries.ts.
//
// Seam: the hooks run against the REAL api.ts, REAL outbox.ts (IndexedDB via
// fake-indexeddb) and a real QueryClient. Only the platform edges are stubbed:
// global fetch, crypto.randomUUID (so row ids are literal), the clock (Date
// only, so created_at is literal) and URL.createObjectURL (absent in jsdom).
//
// Importing this file registers the beforeEach/afterEach hooks, so each test
// file calls installQueryHarness() once at module level.
import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type UseMutationResult } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, vi } from "vitest";

import { useAuthStore } from "../lib/authStore";
import { _resetForTests, _resetTestConfig, _setTestConfig } from "../lib/outbox";

export const BABY = "b1";
export const NOW = "2026-11-22T10:00:00.000Z";
// The id every hook generates via makeId() while the harness is installed.
export const ROW_ID = "11111111-1111-4111-8111-111111111111";
export const EXISTING_ID = "22222222-2222-4222-8222-222222222222";
export const OTHER_ID = "33333333-3333-4333-8333-333333333333";

export interface FetchCall {
  method: string;
  url: string;
  body: unknown;
}

type Responder = (call: FetchCall) => Response;

// Simulates a network failure: fetch rejects with the TypeError the browser
// throws, which apiQueued classifies as "enqueue".
export const OFFLINE: Responder = () => {
  throw new TypeError("Failed to fetch");
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

const ORIGINAL_FETCH = globalThis.fetch;
const qclients: QueryClient[] = [];

// Replaces global fetch and returns the live log of calls made through it.
export function stubFetch(respond: Responder): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

export function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  qclients.push(qc);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return { qc, wrapper };
}

// Adapts a typed mutation hook to a hook that returns `(vars) => Promise`, so
// a table of kinds can drive hooks whose variable types differ. The variables
// are passed through unchanged; each table entry supplies the literal shape.
export function adapt<TData, TVars>(
  useMutationHook: () => UseMutationResult<TData, Error, TVars>,
): () => (vars: unknown) => Promise<unknown> {
  return function useAdapted() {
    const m = useMutationHook();
    return (vars: unknown) => m.mutateAsync(vars as TVars);
  };
}

export function installQueryHarness(): void {
  beforeEach(async () => {
    await _resetForTests();
    _resetTestConfig();
    // A failed replay parks for an hour, so no retry timer fires mid-test.
    // Kept under 2^31 ms so setTimeout does not clamp it to 1 ms.
    _setTestConfig({ backoffBaseMs: 3_600_000, backoffCeilingMs: 3_600_000 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(crypto, "randomUUID").mockReturnValue(ROW_ID);
    useAuthStore.setState({
      accessToken: "test-token",
      // Far enough out that api() never takes the proactive-refresh path.
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    cleanup();
    for (const qc of qclients.splice(0)) qc.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = ORIGINAL_FETCH;
    await _resetForTests();
  });
}
