import { describe, expect, it } from "vitest";

import { qk } from "./queries";

describe("qk list keys include limit", () => {
  // Regression: Charts' 30d sleep-rhythm fetch and Today's
  // latestSleeps share the same from/to window but differ on limit
  // (1000 vs 10). When limit was omitted from the key, TanStack reused
  // the 10-row cache under staleTime and the sleep charts only painted
  // ~3 days of a 30-day window.
  it("differentiates same from/to at different limits", () => {
    const from = "2026-09-27T17:00:00.000Z";
    const to = "2026-10-28T16:59:59.999Z";
    const babyId = "baby-1";
    expect(qk.sleeps(babyId, from, to, 10)).not.toEqual(qk.sleeps(babyId, from, to, 1000));
    expect(qk.bottleFeeds(babyId, from, to, 1)).not.toEqual(
      qk.bottleFeeds(babyId, from, to, 1000),
    );
  });

  it("keeps identical callers on the same key", () => {
    const from = "2026-09-27T17:00:00.000Z";
    const to = "2026-10-28T16:59:59.999Z";
    expect(qk.sleeps("b", from, to, 1000)).toEqual(qk.sleeps("b", from, to, 1000));
    expect(qk.sleeps("b", from, to)).toEqual(qk.sleeps("b", from, to));
  });

  it("treats omitted limit as distinct from an explicit default", () => {
    // BE default is 200 when the param is absent; an explicit 200 must
    // not collide with "no limit param" so a future caller that pins
    // 200 doesn't share cache with the unset case.
    expect(qk.sleeps("b", "a", "z")).not.toEqual(qk.sleeps("b", "a", "z", 200));
  });
});

describe("30d sleep rhythm window vs Today latestSleeps lookback", () => {
  // Mirrors the window math in _app.charts.tsx (rhythmWindow) and
  // _app.index.tsx (sinceStart/todayEnd). Kept as a pure assertion so
  // a future refactor that changes either side without updating the
  // other can't silently reintroduce a same-key/different-limit pair
  // without someone noticing the windows still collide.
  it("shares from/to ISO strings at range=30 / offset=0", () => {
    const endDate = new Date();
    endDate.setHours(0, 0, 0, 0);
    const range = 30;

    const rhythmFrom = new Date(endDate);
    rhythmFrom.setDate(rhythmFrom.getDate() - range);
    const rhythmTo = new Date(endDate);
    rhythmTo.setHours(23, 59, 59, 999);

    const sinceStart = new Date();
    sinceStart.setDate(sinceStart.getDate() - 30);
    sinceStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    expect(rhythmFrom.toISOString()).toBe(sinceStart.toISOString());
    expect(rhythmTo.toISOString()).toBe(todayEnd.toISOString());
  });
});
