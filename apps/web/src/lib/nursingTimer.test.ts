import { describe, expect, it } from "vitest";

import { formatElapsedHHMM } from "./nursingTimer";

describe("formatElapsedHHMM", () => {
  it("formats sub-hour deltas with zero-padded minutes", () => {
    const start = new Date("2026-05-22T08:00:00Z");
    expect(formatElapsedHHMM(start, new Date("2026-05-22T08:00:00Z"))).toBe("0:00");
    expect(formatElapsedHHMM(start, new Date("2026-05-22T08:05:00Z"))).toBe("0:05");
    expect(formatElapsedHHMM(start, new Date("2026-05-22T08:59:00Z"))).toBe("0:59");
  });

  it("formats multi-hour deltas with unpadded hours", () => {
    const start = new Date("2026-05-22T08:00:00Z");
    expect(formatElapsedHHMM(start, new Date("2026-05-22T09:00:00Z"))).toBe("1:00");
    expect(formatElapsedHHMM(start, new Date("2026-05-22T10:30:00Z"))).toBe("2:30");
    // The 21600s API ceiling is 6h, so anything beyond that means the user
    // forgot to end — render the elapsed time honestly rather than
    // capping, since this is a UX hint, not a constraint.
    expect(formatElapsedHHMM(start, new Date("2026-05-22T20:07:00Z"))).toBe("12:07");
  });

  it("floors to whole minutes (no second-precision flicker)", () => {
    const start = new Date("2026-05-22T08:00:00Z");
    // 5m 59s -> still "0:05"
    expect(formatElapsedHHMM(start, new Date("2026-05-22T08:05:59Z"))).toBe("0:05");
    // 6m 00s -> "0:06"
    expect(formatElapsedHHMM(start, new Date("2026-05-22T08:06:00Z"))).toBe("0:06");
  });

  it("accepts ISO strings (the shape the API returns) in either arg", () => {
    expect(formatElapsedHHMM("2026-05-22T08:00:00Z", "2026-05-22T08:42:00Z")).toBe("0:42");
    expect(formatElapsedHHMM("2026-05-22T08:00:00Z", new Date("2026-05-22T09:00:00Z"))).toBe("1:00");
  });

  it("clamps negative or invalid deltas to 0:00", () => {
    const start = new Date("2026-05-22T08:00:00Z");
    // started_at is in the future (clock skew between server and client)
    expect(formatElapsedHHMM(start, new Date("2026-05-22T07:59:00Z"))).toBe("0:00");
    // garbage in -> clamp, never render NaN
    expect(formatElapsedHHMM("not-a-date", new Date("2026-05-22T08:00:00Z"))).toBe("0:00");
    expect(formatElapsedHHMM(new Date("2026-05-22T08:00:00Z"), "still-not-a-date")).toBe("0:00");
  });
});
