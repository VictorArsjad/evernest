// Unit tests for the pure helpers behind useActiveBaby. The hook itself
// is glue; the interesting logic is the resolution decision + the
// storage-key namespacing, both of which are framework-agnostic.
//
// Vitest runs in the `node` environment for the rest of the suite
// (see vitest.config.ts) and we deliberately don't pull in jsdom +
// testing-library just for this one hook — keeping the test surface
// pure-function-only matches the existing pattern in
// `recentEvents.test.ts`, `units.test.ts`, etc.
import { beforeEach, describe, expect, it } from "vitest";

import type { Baby } from "./types";
import { resolveActiveBaby, storageKeyForHousehold } from "./useActiveBaby";

function baby(id: string, name: string, household_id = "hh-1"): Baby {
  return {
    id,
    household_id,
    name,
    created_at: "2026-04-01T00:00:00Z",
  };
}

describe("storageKeyForHousehold", () => {
  it("prefixes with evernest:activeBaby: and includes the household id", () => {
    expect(storageKeyForHousehold("hh-1")).toBe("evernest:activeBaby:hh-1");
  });

  it("namespaces selections per household so two ids do not collide", () => {
    const a = storageKeyForHousehold("hh-A");
    const b = storageKeyForHousehold("hh-B");
    expect(a).not.toBe(b);
    expect(a).toContain("hh-A");
    expect(b).toContain("hh-B");
  });
});

describe("resolveActiveBaby", () => {
  it("returns null when householdId is null", () => {
    expect(resolveActiveBaby(null, [baby("b1", "Alex")], null)).toBeNull();
  });

  it("returns null when the babies list is empty", () => {
    expect(resolveActiveBaby("hh-1", [], "b1")).toBeNull();
  });

  it("falls back to the first baby when there is no stored selection", () => {
    const babies = [baby("b1", "Alex"), baby("b2", "Mia")];
    expect(resolveActiveBaby("hh-1", babies, null)?.id).toBe("b1");
  });

  it("returns the stored baby when it matches an existing id", () => {
    const babies = [baby("b1", "Alex"), baby("b2", "Mia")];
    expect(resolveActiveBaby("hh-1", babies, "b2")?.id).toBe("b2");
  });

  it("falls back to the first baby when the stored id is stale (no longer in the list)", () => {
    // Persisted selection survives a logout/relogin; if the baby was
    // removed (or doesn't belong to this household), we must not crash
    // — quietly degrade to the first baby instead.
    const babies = [baby("b1", "Alex"), baby("b2", "Mia")];
    expect(resolveActiveBaby("hh-1", babies, "b-removed")?.id).toBe("b1");
  });

  it("treats an empty-string stored id as 'no selection'", () => {
    const babies = [baby("b1", "Alex"), baby("b2", "Mia")];
    expect(resolveActiveBaby("hh-1", babies, "")?.id).toBe("b1");
  });
});

describe("localStorage round-trip (smoke)", () => {
  // We don't pull in jsdom for the hook test (see file header), but we
  // CAN exercise the storage-key contract by writing/reading directly on
  // a minimal localStorage shim. This catches any future drift in the
  // storage-prefix shape without needing a full DOM.
  type LocalStorageShim = {
    store: Record<string, string>;
    get: (k: string) => string | null;
    set: (k: string, v: string) => void;
  };

  let storage: LocalStorageShim;
  beforeEach(() => {
    storage = {
      store: {},
      get: (k: string) => storage.store[k] ?? null,
      set: (k: string, v: string) => {
        storage.store[k] = v;
      },
    };
  });

  it("a write under one household does not affect another household's slot", () => {
    storage.set(storageKeyForHousehold("hh-A"), "b2");
    expect(storage.get(storageKeyForHousehold("hh-A"))).toBe("b2");
    expect(storage.get(storageKeyForHousehold("hh-B"))).toBeNull();
  });

  it("storing a stale id is safe: resolve falls back gracefully", () => {
    storage.set(storageKeyForHousehold("hh-1"), "b-removed");
    const babies = [baby("b1", "Alex")];
    const stored = storage.get(storageKeyForHousehold("hh-1"));
    expect(resolveActiveBaby("hh-1", babies, stored)?.id).toBe("b1");
  });
});
