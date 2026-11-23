import { request as playwrightRequest } from "@playwright/test";
import { createCaregiver, expect, test } from "./fixtures";

test("caregiver fixture lands on Today already logged in", async ({ page, caregiver }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: caregiver.babyName })).toBeVisible();
});

test("session survives a reload and a new tab", async ({ page, context, baseURL }) => {
  // Separate request context: its cookie jar is not the page's, so the page
  // starts logged out and must sign in through the real login screen.
  const api = await playwrightRequest.newContext({ baseURL });
  const caregiver = await createCaregiver(api);
  await api.dispose();

  await page.goto("/");
  await page.getByLabel("Email").fill(caregiver.email);
  await page.getByLabel("Password").fill(caregiver.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: caregiver.babyName })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: caregiver.babyName })).toBeVisible();

  const second = await context.newPage();
  await second.goto("/");
  await expect(second.getByRole("heading", { name: caregiver.babyName })).toBeVisible();
});
