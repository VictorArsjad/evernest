import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";
import { expectSynced, expectToday, logBottle } from "./helpers";

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
  await expectToday(page, caregiver.babyName);
  await expect(page.getByText("Nothing logged today yet.")).toBeVisible();
  // First load has no controller yet; offline navigations need one.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
    await page.reload();
    await expectToday(page, caregiver.babyName);
  }
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
    .toBe(true);

  await context.setOffline(true);

  for (const [i, note] of notes.entries()) {
    await logBottle(page, { ml: 100 + i * 10, note });
    await expectToday(page, caregiver.babyName);
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

  await expectSynced(page);

  await page.reload();
  await expectToday(page, caregiver.babyName);
  for (const note of notes) {
    await expect(page.getByRole("listitem").filter({ hasText: note })).toBeVisible();
  }
  await expectSynced(page);
});
