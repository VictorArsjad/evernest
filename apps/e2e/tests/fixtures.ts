import { randomUUID } from "node:crypto";
import { expect, test as base, type APIRequestContext } from "@playwright/test";

export interface Caregiver {
  email: string;
  password: string;
  householdId: string;
  babyId: string;
  babyName: string;
}

export interface CaregiverOptions {
  babyName?: string;
  householdName?: string;
}

/**
 * Creates a unique caregiver with a household and one baby via the public API.
 * Calls go through `request`; when that is a browser context's request client
 * (`context.request`), the refresh cookie from /v1/auth/register lands in that
 * context's cookie jar, so the app's boot refresh logs the page in.
 */
export async function createCaregiver(
  request: APIRequestContext,
  opts: CaregiverOptions = {},
): Promise<Caregiver> {
  const id = randomUUID();
  const email = `e2e-${id}@example.com`;
  const password = `pw-${id}`;
  const babyName = opts.babyName ?? `Baby ${id.slice(0, 8)}`;

  const reg = await request.post("/v1/auth/register", {
    data: { email, password, display_name: "E2E Caregiver" },
  });
  expect(reg.status(), "register").toBe(201);
  const { access_token } = await reg.json();
  const headers = { Authorization: `Bearer ${access_token}` };

  const hh = await request.post("/v1/households", {
    headers,
    data: { name: opts.householdName ?? `Household ${id.slice(0, 8)}` },
  });
  expect(hh.status(), "create household").toBe(201);
  const householdId = (await hh.json()).id as string;

  const baby = await request.post(`/v1/households/${householdId}/babies`, {
    headers,
    data: { name: babyName },
  });
  expect(baby.status(), "create baby").toBe(201);
  const babyId = (await baby.json()).id as string;

  return { email, password, householdId, babyId, babyName };
}

type Fixtures = {
  /** Fresh caregiver whose session cookie is already in `page`'s context. */
  caregiver: Caregiver;
};

export const test = base.extend<Fixtures>({
  caregiver: async ({ context }, use) => {
    await use(await createCaregiver(context.request));
  },
});

export { expect };
