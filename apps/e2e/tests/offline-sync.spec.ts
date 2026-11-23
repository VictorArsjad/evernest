import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";

// Journey 2: a caregiver with no signal logs entries; they sync on reconnect.
// Outbox state is asserted only through the sync status UI.
test("offline: entries log while offline, show pending, sync on reconnect", async ({
  page,
  context,
  caregiver,
}) => {
  const id = randomUUID().slice(0, 8);
  const notes = [`offline one ${id}`, `offline two ${id}`];

  await page.goto("/");
  await expect(page.getByRole("heading", { name: caregiver.babyName })).toBeVisible();
  await expect(page.getByText("Nothing logged today yet.")).toBeVisible();
  // Real service worker must control the page before the network goes away.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  await context.setOffline(true);

  for (const [i, note] of notes.entries()) {
    await page.getByRole("link", { name: /Bottle/ }).click();
    await expect(page.getByRole("heading", { name: "Log bottle feed" })).toBeVisible();
    await page.getByPlaceholder("60").fill(String(100 + i * 10));
    await page.getByRole("button", { name: /Formula/ }).click();
    await page.getByLabel("Notes (optional)").fill(note);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name: caregiver.babyName })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: note })).toBeVisible();
  }

  const badge = page.getByRole("button", { name: "2 items pending sync" });
  await expect(badge).toBeVisible();
  await badge.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Nothing queued. All caught up.")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await context.setOffline(false);

  await expect(page.getByRole("button", { name: /pending sync|failed to sync/ })).toBeHidden();

  await page.reload();
  await expect(page.getByRole("heading", { name: caregiver.babyName })).toBeVisible();
  for (const note of notes) {
    await expect(page.getByRole("listitem").filter({ hasText: note })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /pending sync|failed to sync/ })).toBeHidden();
});
