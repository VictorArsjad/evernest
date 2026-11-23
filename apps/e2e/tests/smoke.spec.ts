import { expect, test } from "@playwright/test";

test("app loads and shows the login screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("deliberate failure (report-upload check, do not merge)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "This heading does not exist" })).toBeVisible({ timeout: 2000 });
});
