import { createCaregiver, expect, test } from "./fixtures";
import { seedEvents } from "./seed";

// Journey 5: seeded data renders on Charts, History, Growth and Settings.
test("seeded data renders on the review screens", async ({ page, context }) => {
  const dob = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const householdName = `Nest ${Date.now()}`;
  const caregiver = await createCaregiver(context.request, { dateOfBirth: dob, householdName });
  const seeded = await seedEvents(context.request, caregiver);

  const nav = page.getByRole("navigation", { name: "Primary" });
  const noError = async () => {
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/something went wrong|not found/i)).toHaveCount(0);
  };

  await page.goto("/");
  await expect(page.getByRole("heading", { name: caregiver.babyName })).toBeVisible();

  // Charts & History (History is folded into this screen).
  await nav.getByRole("link", { name: "History" }).click();
  await expect(page.getByRole("heading", { name: "Charts & History" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bottle" })).toBeVisible();
  await expect(page.getByText(/^[1-9][\d.,]* ?ml total$/).first()).toBeVisible();
  await expect(page.getByLabel("Daily bottle volume stacked bar chart")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /: [\d.,]+ ?ml breast, [\d.,]+ ?ml formula, [1-9][\d.,]* ?ml total/ }).first(),
  ).toBeAttached();
  await expect(page.getByRole("heading", { name: "Diapers" })).toBeVisible();
  await expect(page.getByText(`${seeded.diapers} total`, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "History", exact: true })).toBeVisible();
  await expect(page.getByText(seeded.latestNote)).toBeVisible();
  await noError();

  // Growth.
  await nav.getByRole("link", { name: "Growth" }).click();
  await expect(page.getByRole("heading", { name: "Growth", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /growth chart against WHO percentile curves/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^[A-Z][a-z]{2} \d{1,2}, \d{4}: / })).toHaveCount(
    seeded.growthWeightsG.length,
  );
  await noError();

  // Settings.
  await nav.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Household" })).toBeVisible();
  await expect(page.getByText(householdName)).toBeVisible();
  await noError();
});
