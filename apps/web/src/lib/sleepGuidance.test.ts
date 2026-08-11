import { describe, expect, it } from "vitest";

import { getDailySleepRange, getWakeWindow } from "./sleepGuidance";

// Fixed "now" so the whole suite is deterministic.
const NOW = new Date("2026-08-11T12:00:00Z");

function babyAgedMonths(months: number) {
  const dob = new Date(NOW);
  dob.setMonth(dob.getMonth() - months);
  return { date_of_birth: dob.toISOString() };
}

describe("getWakeWindow", () => {
  it("returns the newborn window for a fresh baby", () => {
    expect(getWakeWindow(babyAgedMonths(1), NOW)).toEqual({ minMin: 45, maxMin: 90 });
  });

  it("uses inclusive bracket upper bounds (3mo is still the first bracket)", () => {
    expect(getWakeWindow(babyAgedMonths(3), NOW)).toEqual({ minMin: 45, maxMin: 90 });
    expect(getWakeWindow(babyAgedMonths(4), NOW)).toEqual({ minMin: 90, maxMin: 150 });
  });

  it("resolves the open-ended bracket for toddlers and beyond", () => {
    expect(getWakeWindow(babyAgedMonths(36), NOW)).toEqual({ minMin: 240, maxMin: 360 });
  });

  it("returns null without a valid DoB", () => {
    expect(getWakeWindow(null, NOW)).toBeNull();
    expect(getWakeWindow({ date_of_birth: "" }, NOW)).toBeNull();
    expect(getWakeWindow({ date_of_birth: "nope" }, NOW)).toBeNull();
    // A future DoB (clock skew / typo) hides the card rather than
    // rendering bracket-0 numbers.
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    expect(getWakeWindow({ date_of_birth: future }, NOW)).toBeNull();
  });
});

describe("getDailySleepRange", () => {
  it("follows the AAP ranges across brackets", () => {
    expect(getDailySleepRange(babyAgedMonths(1), NOW)).toEqual({ minH: 14, maxH: 17 });
    expect(getDailySleepRange(babyAgedMonths(6), NOW)).toEqual({ minH: 12, maxH: 16 });
    expect(getDailySleepRange(babyAgedMonths(18), NOW)).toEqual({ minH: 11, maxH: 14 });
    expect(getDailySleepRange(babyAgedMonths(30), NOW)).toEqual({ minH: 10, maxH: 13 });
  });

  it("returns null without a valid DoB", () => {
    expect(getDailySleepRange(null, NOW)).toBeNull();
  });
});
