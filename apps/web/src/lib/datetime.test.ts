import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "./datetime";

// Pinned so the local<->UTC offset is deterministic (Jakarta is UTC+7, no DST).
const ORIGINAL_TZ = process.env.TZ;
beforeEach(() => {
  process.env.TZ = "Asia/Jakarta";
});
afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("nowLocalDatetimeInput", () => {
  it("formats the current local time as YYYY-MM-DDTHH:mm", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-22T10:00:45.000Z"));
    expect(nowLocalDatetimeInput()).toBe("2026-11-22T17:00");
  });

  it("zero-pads single-digit month, day, hour and minute", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T00:05:00.000Z")); // 07:05 local
    expect(nowLocalDatetimeInput()).toBe("2026-01-02T07:05");
  });
});

describe("isoToLocalDatetimeInput", () => {
  it("converts a UTC instant to local wall-clock time", () => {
    expect(isoToLocalDatetimeInput("2026-11-22T10:00:00.000Z")).toBe("2026-11-22T17:00");
  });

  it("rolls the date over when the offset crosses midnight", () => {
    expect(isoToLocalDatetimeInput("2026-11-22T20:30:00Z")).toBe("2026-11-23T03:30");
  });

  it("drops seconds and milliseconds", () => {
    expect(isoToLocalDatetimeInput("2026-11-22T10:00:59.999Z")).toBe("2026-11-22T17:00");
  });
});

describe("localToISO", () => {
  it("interprets the input as local time and returns UTC", () => {
    expect(localToISO("2026-11-22T17:00")).toBe("2026-11-22T10:00:00.000Z");
  });

  it("round-trips with isoToLocalDatetimeInput", () => {
    const local = "2026-03-09T00:15";
    expect(isoToLocalDatetimeInput(localToISO(local))).toBe(local);
  });

  it("throws RangeError on an unparseable value (as the inline copies did)", () => {
    expect(() => localToISO("")).toThrow(RangeError);
  });
});
