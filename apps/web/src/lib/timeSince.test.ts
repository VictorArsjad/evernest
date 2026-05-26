import { describe, expect, it } from "vitest";

import { formatTimeSince, lastEventAt } from "./timeSince";

const NOW = new Date("2025-06-15T12:00:00Z");

describe("formatTimeSince", () => {
  it("returns em-dash for null/undefined/invalid", () => {
    expect(formatTimeSince(null, NOW)).toBe("—");
    expect(formatTimeSince(undefined, NOW)).toBe("—");
    expect(formatTimeSince("not-a-date", NOW)).toBe("—");
  });

  it("treats future timestamps as 'just now' (clock drift / optimistic)", () => {
    expect(formatTimeSince("2025-06-15T12:05:00Z", NOW)).toBe("just now");
  });

  it("returns 'just now' under 30s", () => {
    expect(formatTimeSince("2025-06-15T11:59:45Z", NOW)).toBe("just now");
  });

  it("renders whole minutes under 1h", () => {
    expect(formatTimeSince("2025-06-15T11:55:00Z", NOW)).toBe("5m ago");
    expect(formatTimeSince("2025-06-15T11:01:00Z", NOW)).toBe("59m ago");
  });

  it("renders hours-only when minutes are 0", () => {
    expect(formatTimeSince("2025-06-15T11:00:00Z", NOW)).toBe("1h ago");
  });

  it("renders hours + minutes under 24h", () => {
    expect(formatTimeSince("2025-06-15T10:37:00Z", NOW)).toBe("1h 23m ago");
  });

  it("renders whole days under 30d", () => {
    expect(formatTimeSince("2025-06-12T12:00:00Z", NOW)).toBe("3d ago");
  });

  it("returns em-dash beyond 30d (banner falls back to no-event copy)", () => {
    expect(formatTimeSince("2025-04-01T12:00:00Z", NOW)).toBe("—");
  });
});

describe("lastEventAt", () => {
  it("returns null for null/empty", () => {
    expect(lastEventAt(null)).toBeNull();
    expect(lastEventAt(undefined)).toBeNull();
    expect(lastEventAt([])).toBeNull();
  });

  it("returns the largest occurred_at", () => {
    expect(
      lastEventAt([
        { occurred_at: "2025-06-15T08:00:00Z" },
        { occurred_at: "2025-06-15T11:00:00Z" },
        { occurred_at: "2025-06-15T09:00:00Z" },
      ]),
    ).toBe("2025-06-15T11:00:00Z");
  });

  it("falls back to started_at when occurred_at is missing", () => {
    expect(
      lastEventAt([
        { occurred_at: "2025-06-15T08:00:00Z" },
        { started_at: "2025-06-15T11:00:00Z" },
      ]),
    ).toBe("2025-06-15T11:00:00Z");
  });

  it("falls back to measured_at as last resort", () => {
    expect(
      lastEventAt([{ measured_at: "2025-06-15T08:00:00Z" }]),
    ).toBe("2025-06-15T08:00:00Z");
  });

  it("skips entries with no usable timestamp", () => {
    expect(
      lastEventAt([{}, { occurred_at: null }, { occurred_at: "2025-06-15T10:00:00Z" }]),
    ).toBe("2025-06-15T10:00:00Z");
  });

  it("skips entries with unparseable timestamps", () => {
    expect(
      lastEventAt([
        { occurred_at: "garbage" },
        { occurred_at: "2025-06-15T10:00:00Z" },
      ]),
    ).toBe("2025-06-15T10:00:00Z");
  });
});
