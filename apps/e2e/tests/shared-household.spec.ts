import { randomUUID } from "node:crypto";

import { expect, test } from "./fixtures";
import { expectSynced, logBottle } from "./helpers";

// Journey 3: two caregivers share a household. A creates an invite link in
// Settings; B, in an independent browser context, registers via the link,
// accepts, logs an entry, and A sees it on Today.
test("two caregivers share a household via an invite link", async ({
  page,
  browser,
  caregiver,
}, testInfo) => {
  test.setTimeout(60_000);
  const id = randomUUID().slice(0, 8);
  const note = `from B ${id}`;

  await page.goto("/settings");
  await page.getByRole("button", { name: "Generate link" }).click();
  const link = page.locator("code").filter({ hasText: "/invite/" });
  await expect(link).toBeVisible();
  const inviteUrl = (await link.innerText()).trim();

  const contextB = await browser.newContext({ ...testInfo.project.use });
  try {
    const pageB = await contextB.newPage();
    await pageB.goto(inviteUrl);
    await expect(pageB.getByRole("heading", { name: /^Join / })).toBeVisible();
    await pageB.getByRole("link", { name: "Create an account" }).click();

    await pageB.getByLabel("Your name").fill("Sam Second");
    await pageB.getByLabel("Email").fill(`second-${id}@example.test`);
    await pageB.getByLabel("Password").fill(`pw-${id}-secret`);
    await pageB.getByRole("button", { name: "Create account" }).click();

    await expect(pageB.getByRole("heading", { name: caregiver.babyName })).toBeVisible();

    await logBottle(pageB, { ml: 90, note });
    await expect(pageB.getByRole("listitem").filter({ hasText: note })).toBeVisible();
    // Entries are written through the offline outbox; wait until B's has synced.
    await expectSynced(pageB);

    // Today polls while visible; no reload needed.
    await page.goto("/");
    await expect(page.getByRole("listitem").filter({ hasText: note })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await contextB.close();
  }
});
