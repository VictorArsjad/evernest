// RecentRow render test for the sleep branch. Node-pure (renderToStaticMarkup,
// no jsdom / RTL) to match the rest of the suite — see AuthGate.test.tsx for
// the rationale. We mock the two module boundaries the row depends on:
//   - @tanstack/react-router's Link (no RouterProvider under static render),
//     reduced to a plain anchor with a data attribute so we can assert
//     whether the row rendered an edit link.
//   - the photo-url hooks from ../lib/queries (React Query has no provider
//     under static render).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => (
    <a data-testid="edit-link">{children}</a>
  ),
}));

vi.mock("../lib/queries", () => ({
  useDiaperPhotoUrl: () => null,
  useNotePhotoUrl: () => null,
}));

import { RecentRow } from "./RecentRow";
import type { RecentEvent } from "../lib/recentEvents";
import type { Sleep } from "../lib/types";
import type { CombinedPreferences } from "../lib/usePreferences";

const prefs = {
  time_format: "24h",
  unit_volume: "ml",
  unit_length: "cm",
  unit_weight: "kg",
} as CombinedPreferences;

function sleepEvent(overrides: Partial<Sleep>): RecentEvent {
  const data: Sleep = {
    id: "s1",
    baby_id: "b1",
    started_at: "2026-05-22T08:00:00Z",
    ended_at: "2026-05-22T09:25:00Z",
    sleep_type: null,
    location: null,
    notes: null,
    source: "manual",
    created_at: "2026-05-22T08:00:00Z",
    ...overrides,
  };
  return { kind: "sleep", at: data.started_at, data };
}

describe("RecentRow — sleep", () => {
  it("renders duration, type, and location for a closed row with an edit link", () => {
    const html = renderToStaticMarkup(
      <RecentRow
        ev={sleepEvent({ sleep_type: "nap", location: "crib" })}
        prefs={prefs}
      />,
    );
    expect(html).toContain("Slept 1h 25m");
    expect(html).toContain("nap");
    expect(html).toContain("crib");
    expect(html).toContain('data-testid="edit-link"');
  });

  it("renders an in-progress open row without an edit link", () => {
    const html = renderToStaticMarkup(
      <RecentRow ev={sleepEvent({ ended_at: null })} prefs={prefs} />,
    );
    expect(html).toContain("Sleeping");
    expect(html).toContain("in progress");
    expect(html).not.toContain('data-testid="edit-link"');
  });

  it("renders the notes line when present", () => {
    const html = renderToStaticMarkup(
      <RecentRow
        ev={sleepEvent({ notes: "fell asleep on the walk" })}
        prefs={prefs}
      />,
    );
    expect(html).toContain("fell asleep on the walk");
  });
});
