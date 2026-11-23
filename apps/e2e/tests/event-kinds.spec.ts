import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

// The catalog module imports only types, so Playwright's TS transform can load
// it straight from the web app: the kind list is the app's own, not a copy.
import { EVENT_KIND_ROWS, EVENT_KINDS, type EventKindName } from "../../web/src/lib/eventKinds";
import { expect, test } from "./fixtures";
import { expectToday, fillBottleForm, localInput } from "./helpers";

// One test per catalog kind. To cover a new kind, add a driver: the Record
// type makes a missing one a type error.
interface Driver {
  /** Fill the log form and submit it. `token` is unique to this test run. */
  log: (page: Page, token: string) => Promise<void>;
  /** Text that must appear in the entry's row on Today (besides the token). */
  expectedRowText?: string[];
}

const save = (page: Page) => page.getByRole("button", { name: "Save", exact: true }).click();
const notes = (page: Page, token: string) =>
  page.getByLabel("Notes (optional)").fill(token);

const DRIVERS: Record<EventKindName, Driver> = {
  bottle: {
    log: async (page, token) => {
      await fillBottleForm(page, { note: token });
    },
    expectedRowText: ["formula", "120"],
  },
  nursing: {
    // Side defaults to both; the first input is the left breast.
    log: async (page, token) => {
      await page.getByPlaceholder("10").first().fill("7");
      await notes(page, token);
      await save(page);
    },
    expectedRowText: ["Nursed 7 min"],
  },
  pumping: {
    log: async (page, token) => {
      await page.getByPlaceholder(/^(80|3)$/).fill("90");
      await notes(page, token);
      await save(page);
    },
    expectedRowText: ["pumped"],
  },
  diaper: {
    log: async (page, token) => {
      await page.getByRole("button", { name: "Wet", exact: true }).click();
      await notes(page, token);
      await save(page);
    },
    expectedRowText: ["wet diaper"],
  },
  solids: {
    log: async (page, token) => {
      await page.getByPlaceholder("avocado, banana…").fill(`avocado ${token}`);
      await page.getByPlaceholder("avocado, banana…").press("Enter");
      await save(page);
    },
  },
  growth: {
    log: async (page, token) => {
      await page.getByPlaceholder(/^(6\.5|14)$/).fill("6.5");
      await notes(page, token);
      await save(page);
    },
    expectedRowText: ["6.5"],
  },
  sleep: {
    log: async (page, token) => {
      await page.getByLabel("Fell asleep").fill(localInput(20));
      await page.getByLabel(/^Woke up/).fill(localInput(10));
      await notes(page, token);
      await save(page);
    },
    expectedRowText: ["Slept 10m"],
  },
  note: {
    log: async (page, token) => {
      await page.getByLabel("Notes", { exact: true }).fill(token);
      await save(page);
    },
  },
};

test.describe("every event kind logs and persists", () => {
  for (const kind of EVENT_KINDS) {
    const { label, icon } = EVENT_KIND_ROWS[kind];

    test(`${kind}: form → Today → reload`, async ({ page, caregiver }) => {
      const driver = DRIVERS[kind];
      if (!driver) {
        throw new Error(
          `Event kind "${kind}" is in the catalog but has no driver in event-kinds.spec.ts; add one.`,
        );
      }
      const token = `e2e-${kind}-${randomUUID().slice(0, 8)}`;

      await page.goto("/");
      await expectToday(page, caregiver.babyName);

      await page.getByRole("link", { name: `${icon} ${label}`, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await driver.log(page, token);

      const row = page.getByRole("listitem").filter({ hasText: token });
      const check = async () => {
        await expectToday(page, caregiver.babyName);
        await expect(row).toBeVisible();
        for (const text of driver.expectedRowText ?? []) await expect(row).toContainText(text);
      };

      await check();
      await page.reload();
      await check();
    });
  }
});
