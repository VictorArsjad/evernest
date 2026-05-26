import { describe, expect, it } from "vitest";

import { getDailyTargets, monthsBetween } from "./recommendations";
import type { Baby } from "./types";

function baby(dob: string | null | undefined): Baby {
  return {
    id: "b1",
    household_id: "h1",
    name: "Test",
    date_of_birth: dob ?? null,
    sex: null,
    created_at: "2024-01-01T00:00:00Z",
  };
}

describe("monthsBetween", () => {
  it("returns 0 for same day", () => {
    expect(monthsBetween(new Date("2025-01-15"), new Date("2025-01-15"))).toBe(0);
  });

  it("returns 1 when one full month has elapsed", () => {
    expect(monthsBetween(new Date("2025-01-15"), new Date("2025-02-15"))).toBe(1);
  });

  it("does not count a partial final month (day-of-month rollover)", () => {
    // Jan 15 → Feb 14 is "not yet a full month".
    expect(monthsBetween(new Date("2025-01-15"), new Date("2025-02-14"))).toBe(0);
  });

  it("crosses years correctly", () => {
    expect(monthsBetween(new Date("2024-06-10"), new Date("2025-06-10"))).toBe(12);
    expect(monthsBetween(new Date("2024-06-10"), new Date("2025-06-09"))).toBe(11);
  });

  it("clamps negative durations to 0", () => {
    expect(monthsBetween(new Date("2025-06-10"), new Date("2024-06-10"))).toBe(0);
  });
});

describe("getDailyTargets", () => {
  const NOW = new Date("2025-06-15T12:00:00Z");

  it("returns null when baby is null", () => {
    expect(getDailyTargets(null, NOW)).toBeNull();
  });

  it("returns null when date_of_birth is missing", () => {
    expect(getDailyTargets(baby(null), NOW)).toBeNull();
    expect(getDailyTargets(baby(undefined), NOW)).toBeNull();
  });

  it("returns null when date_of_birth is unparseable", () => {
    expect(getDailyTargets(baby("not-a-date"), NOW)).toBeNull();
  });

  it("returns null when date_of_birth is in the future", () => {
    expect(getDailyTargets(baby("2030-01-01"), NOW)).toBeNull();
  });

  it("picks the 0-1mo bracket for a newborn", () => {
    const t = getDailyTargets(baby("2025-06-01"), NOW);
    expect(t).not.toBeNull();
    expect(t!.bottle_ml).toBe(480);
    expect(t!.diapers).toBe(8);
  });

  it("picks the 1-3mo bracket at 2 months", () => {
    const t = getDailyTargets(baby("2025-04-15"), NOW);
    expect(t!.bottle_ml).toBe(720);
    expect(t!.diapers).toBe(6);
  });

  it("picks the 3-6mo bracket at 4 months", () => {
    const t = getDailyTargets(baby("2025-02-15"), NOW);
    expect(t!.bottle_ml).toBe(900);
  });

  it("picks the 6-12mo bracket at 9 months", () => {
    const t = getDailyTargets(baby("2024-09-15"), NOW);
    expect(t!.bottle_ml).toBe(720);
    expect(t!.diapers).toBe(5);
  });

  it("picks the 12+ bracket for a toddler", () => {
    const t = getDailyTargets(baby("2023-01-15"), NOW);
    expect(t!.bottle_ml).toBe(480);
    expect(t!.diapers).toBe(4);
  });
});
