import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { findCachedRow, logSearchSchema } from "./logForm";

const UUID = "55555555-5555-4555-8555-555555555555";

describe("logSearchSchema", () => {
  it("accepts an empty search", () => {
    expect(logSearchSchema.parse({})).toEqual({});
  });

  it("accepts uuid babyId and edit", () => {
    expect(logSearchSchema.parse({ babyId: UUID, edit: UUID })).toEqual({ babyId: UUID, edit: UUID });
  });

  it("rejects a non-uuid babyId or edit", () => {
    expect(logSearchSchema.safeParse({ babyId: "nope" }).success).toBe(false);
    expect(logSearchSchema.safeParse({ edit: "nope" }).success).toBe(false);
  });
});

describe("findCachedRow", () => {
  const seed = () => {
    const qc = new QueryClient();
    qc.setQueryData(["babies", "b1", "diapers", "a", "b"], [{ id: "r1" }, { id: "r2" }]);
    qc.setQueryData(["babies", "b1", "diapers", "c", "d"], undefined);
    qc.setQueryData(["babies", "b1", "notes", "a", "b"], [{ id: "n1" }]);
    qc.setQueryData(["babies", "b2", "diapers", "a", "b"], [{ id: "r9" }]);
    return qc;
  };

  it("finds the row in any cached list of the segment for that baby", () => {
    expect(findCachedRow(seed(), "diapers", "b1", "r2")).toEqual({ id: "r2" });
  });

  it("ignores other segments and other babies", () => {
    const qc = seed();
    expect(findCachedRow(qc, "diapers", "b1", "n1")).toBeNull();
    expect(findCachedRow(qc, "diapers", "b1", "r9")).toBeNull();
  });

  it("returns null without an edit id or baby id (no lookup)", () => {
    const qc = seed();
    expect(findCachedRow(qc, "diapers", "b1", undefined)).toBeNull();
    expect(findCachedRow(qc, "diapers", null, "r1")).toBeNull();
  });
});
