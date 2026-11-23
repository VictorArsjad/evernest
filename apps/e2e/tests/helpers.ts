import { expect, type Page } from "@playwright/test";

/**
 * Fixed-offset zone where it is currently about local noon. Every test runs in
 * it (playwright.config.ts), so "today" has hours of room on both sides and
 * nothing crosses a local midnight, whatever the wall clock says.
 */
export function noonTimezone(now: Date = new Date()): string {
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const offset = Math.round(12 - utcHour); // -12..12
  if (offset === 0) return "UTC";
  // Etc/GMT zones have inverted signs: Etc/GMT-3 is UTC+3.
  return offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

/** `datetime-local` value `minutesAgo` before now, in the test timezone. */
export function localInput(minutesAgo: number): string {
  const d = new Date(Date.now() - minutesAgo * 60_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: noonTimezone(),
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const p = (t: string) => parts.find((x) => x.type === t)!.value;
  return `${p("year")}-${p("month")}-${p("day")}T${p("hour")}:${p("minute")}`;
}

/** Offline-outbox status button, in any non-synced state. */
export const UNSYNCED = /pending sync|failed to sync/;

export async function expectToday(page: Page, babyName: string) {
  await expect(page.getByRole("heading", { name: babyName })).toBeVisible();
}

export async function expectSynced(page: Page) {
  await expect(page.getByRole("button", { name: UNSYNCED })).toBeHidden();
}

/** Fill and submit the bottle form (already open). */
export async function fillBottleForm(page: Page, { ml = 120, note }: { ml?: number; note: string }) {
  await page.getByPlaceholder("60").fill(String(ml));
  await page.getByRole("button", { name: /Formula/ }).click();
  await page.getByLabel("Notes (optional)").fill(note);
  await page.getByRole("button", { name: "Save", exact: true }).click();
}

/** From Today: open the bottle form, log a formula feed, land back on Today. */
export async function logBottle(page: Page, opts: { ml?: number; note: string }) {
  await page.getByRole("link", { name: /Bottle/ }).click();
  await expect(page.getByRole("heading", { name: "Log bottle feed" })).toBeVisible();
  await fillBottleForm(page, opts);
}
