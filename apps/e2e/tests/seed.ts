import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import type { Caregiver } from "./fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface SeededEvents {
  /** Note on the most recent event; it is in the newest History day group. */
  latestNote: string;
  /** Canonical units, as sent to the API. */
  bottleMl: number;
  diapers: number;
  growthWeightsG: number[];
}

/**
 * Seeds a spread of entries (bottle, diaper, sleep, nursing, growth) over the
 * last few days through the public API. `request` should be the same request
 * context used for `createCaregiver`. Logs in with the caregiver's credentials
 * to get a bearer token. Ids are client-generated UUIDs; units are canonical
 * (ml, cm, g); timestamps are UTC ISO strings relative to `now`.
 */
export async function seedEvents(
  request: APIRequestContext,
  cg: Caregiver,
  now: Date = new Date(),
): Promise<SeededEvents> {
  const login = await request.post("/v1/auth/login", {
    data: { email: cg.email, password: cg.password },
  });
  expect(login.status(), "login").toBe(200);
  const headers = { Authorization: `Bearer ${(await login.json()).access_token}` };
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const post = async (path: string, data: object) => {
    const res = await request.post(`/v1/babies/${cg.babyId}/${path}`, {
      headers,
      data: { id: randomUUID(), ...data },
    });
    expect(res.status(), `seed ${path}: ${await res.text()}`).toBe(201);
  };

  const latestNote = `Seeded note ${randomUUID().slice(0, 8)}`;
  const bottles = [
    { ago: 10 * 60_000, ml: 150, src: "formula", notes: latestNote },
    { ago: 1 * DAY + 2 * HOUR, ml: 120, src: "breast" },
    { ago: 2 * DAY + 3 * HOUR, ml: 90, src: "formula" },
    { ago: 3 * DAY + 4 * HOUR, ml: 110, src: "breast" },
  ];
  for (const b of bottles) {
    await post("bottle-feeds", {
      occurred_at: at(b.ago),
      milk_source: b.src,
      amount_ml: b.ml,
      ...(b.notes && { notes: b.notes }),
    });
  }

  const diaperTypes = ["wet", "soiled", "mixed", "wet"] as const;
  for (const [i, type] of diaperTypes.entries()) {
    await post("diapers", { occurred_at: at(i * DAY + 5 * HOUR), type });
  }

  for (let i = 1; i <= 3; i++) {
    await post("sleeps", {
      started_at: at(i * DAY + 8 * HOUR),
      ended_at: at(i * DAY + 6 * HOUR),
      sleep_type: "nap",
    });
  }

  for (let i = 1; i <= 3; i++) {
    await post("nursing-sessions", {
      started_at: at(i * DAY + 12 * HOUR),
      ended_at: at(i * DAY + 12 * HOUR - 20 * 60_000),
      nursing_side: "both",
      left_duration_s: 600,
      right_duration_s: 600,
    });
  }

  const growths = [
    { ago: 21 * DAY, weight_g: 5200, height_cm: 58, head_circumference_cm: 38.5 },
    { ago: 7 * DAY, weight_g: 5600, height_cm: 60, head_circumference_cm: 39.5 },
  ];
  for (const g of growths) {
    const { ago, ...m } = g;
    await post("growths", { measured_at: at(ago), ...m });
  }

  return {
    latestNote,
    bottleMl: bottles.reduce((n, b) => n + b.ml, 0),
    diapers: diaperTypes.length,
    growthWeightsG: growths.map((g) => g.weight_g),
  };
}
