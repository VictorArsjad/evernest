import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { expectToday, logBottle } from "./helpers";

// Journey 1: a brand-new caregiver registers, completes onboarding, logs a
// bottle feed and sees it on Today. UI only, no API setup.
test("first run: register, onboard, log a bottle feed, see it on Today", async ({ page }) => {
  const id = randomUUID().slice(0, 8);
  const email = `first-run-${id}@example.test`;
  const babyName = `Baby ${id}`;
  const note = `first feed ${id}`;

  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByLabel("Your name").fill("Pat Caregiver");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(`pw-${id}-secret`);
  await page.getByRole("button", { name: "Create account" }).click();

  await expect(page.getByRole("heading", { name: "Set things up" })).toBeVisible();
  await page.getByLabel("Baby name").fill(babyName);
  await page.getByRole("button", { name: "Continue" }).click();

  await expectToday(page, babyName);
  await expect(page.getByText("Nothing logged today yet.")).toBeVisible();

  await logBottle(page, { note });

  await expectToday(page, babyName);
  const row = page.getByRole("listitem").filter({ hasText: note });
  await expect(row).toBeVisible();
  await expect(row).toContainText("formula");
  await expect(row).toContainText("120");
  await expect(page.getByText("Nothing logged today yet.")).toBeHidden();
});
