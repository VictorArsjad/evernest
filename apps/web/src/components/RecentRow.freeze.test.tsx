// Characterization ("freeze") tests for RecentRow across all eight kinds.
// These pin the rendered icon, body text, edit-link target, photo indicator,
// syncing hint, and open-session behavior ahead of a refactor that replaces
// the per-kind ternary chains with one EVENT_KINDS catalog.
//
// Node-pure (renderToStaticMarkup), like RecentRow.test.tsx. The router Link
// is reduced to an anchor that exposes `href` and the search params as
// attributes, so assertions see exactly what RecentRow passes in.
//
// Timestamps are built with local-time constructors because formatTime and
// the "MMM d" date line read the local clock. "Today" is pinned via a faked
// Date so the date line is deterministic.
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    className,
  }: {
    to: string;
    search: { babyId: string; edit: string };
    children: React.ReactNode;
    className?: string;
  }) => (
    <a
      data-testid="edit-link"
      href={to}
      data-baby-id={search.babyId}
      data-edit-id={search.edit}
      className={className}
    >
      {children}
    </a>
  ),
}));

vi.mock("../lib/queries", () => ({
  useDiaperPhotoUrl: () => null,
  useNotePhotoUrl: () => null,
  useSolidMealPhotoUrl: () => null,
}));

import { RecentRow } from "./RecentRow";
import type { RecentEvent } from "../lib/recentEvents";
import type {
  BottleFeed,
  Diaper,
  Growth,
  Note,
  Nursing,
  Pumping,
  Sleep,
  SolidMeal,
} from "../lib/types";
import { DEFAULT_PREFERENCES, type CombinedPreferences } from "../lib/usePreferences";

// Local wall-clock ISO so "08:00" is 08:00 regardless of the runner's TZ.
function local(y: number, mo: number, d: number, h: number, mi: number): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

const TODAY_8AM = local(2026, 11, 22, 8, 0);
const TODAY_9_25 = local(2026, 11, 22, 9, 25);
const MAY_22_8AM = local(2026, 5, 22, 8, 0);
const CREATED = local(2026, 11, 22, 7, 0);

const prefs: CombinedPreferences = DEFAULT_PREFERENCES;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 22, 12, 0));
});

afterAll(() => {
  vi.useRealTimers();
});

// Strip tags to spaces, collapse whitespace: "🍼 08:00 240 ml formula".
function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function editLinkOf(html: string): { href: string; babyId: string; editId: string } | null {
  const m = html.match(
    /<a data-testid="edit-link" href="([^"]*)" data-baby-id="([^"]*)" data-edit-id="([^"]*)"/,
  );
  if (!m) return null;
  return { href: m[1], babyId: m[2], editId: m[3] };
}

function render(ev: RecentEvent, extra: { syncing?: boolean; highlight?: boolean } = {}) {
  return renderToStaticMarkup(<RecentRow ev={ev} prefs={prefs} {...extra} />);
}

function bottleEv(over: Partial<BottleFeed> = {}, at = TODAY_8AM): RecentEvent {
  const data: BottleFeed = {
    id: "bottle-1",
    baby_id: "baby-1",
    occurred_at: at,
    milk_source: "formula",
    amount_ml: 240,
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
  return { kind: "bottle", at, data };
}

function diaperEv(over: Partial<Diaper> = {}): RecentEvent {
  const data: Diaper = {
    id: "diaper-1",
    baby_id: "baby-1",
    occurred_at: TODAY_8AM,
    type: "wet",
    notes: null,
    has_photo: false,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
  return { kind: "diaper", at: TODAY_8AM, data };
}

function pumpingEv(over: Partial<Pumping> = {}): RecentEvent {
  const data: Pumping = {
    id: "pump-1",
    baby_id: "baby-1",
    occurred_at: TODAY_8AM,
    amount_ml: 90,
    duration_seconds: 1200,
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
  return { kind: "pumping", at: TODAY_8AM, data };
}

function nursingEv(over: Partial<Nursing> = {}): RecentEvent {
  const data: Nursing = {
    id: "nurse-1",
    baby_id: "baby-1",
    started_at: TODAY_8AM,
    ended_at: local(2026, 11, 22, 8, 20),
    starting_breast: "left",
    nursing_side: "both",
    left_duration_s: 300,
    right_duration_s: 180,
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
  return { kind: "nursing", at: data.started_at, data };
}

function growthEv(over: Partial<Growth> = {}): RecentEvent {
  const data: Growth = {
    id: "growth-1",
    baby_id: "baby-1",
    measured_at: TODAY_8AM,
    weight_g: 5200,
    height_cm: 58.5,
    head_circumference_cm: 38,
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
  return { kind: "growth", at: TODAY_8AM, data };
}

function sleepEv(over: Partial<Sleep> = {}): RecentEvent {
  const data: Sleep = {
    id: "sleep-1",
    baby_id: "baby-1",
    started_at: TODAY_8AM,
    ended_at: TODAY_9_25,
    sleep_type: "nap",
    location: "crib",
    notes: null,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
  return { kind: "sleep", at: data.started_at, data };
}

function noteEv(over: Partial<Note> = {}): RecentEvent {
  const data: Note = {
    id: "note-1",
    baby_id: "baby-1",
    occurred_at: TODAY_8AM,
    body: "Small rash on hand",
    has_photo: false,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
  return { kind: "note", at: TODAY_8AM, data };
}

function solidsEv(over: Partial<SolidMeal> = {}): RecentEvent {
  const data: SolidMeal = {
    id: "solids-1",
    baby_id: "baby-1",
    occurred_at: TODAY_8AM,
    foods: ["banana", "oat"],
    reaction: "liked",
    amount_g: 30,
    notes: null,
    has_photo: false,
    source: "manual",
    created_at: CREATED,
    ...over,
  };
  return { kind: "solids", at: TODAY_8AM, data };
}

describe("RecentRow per-kind icon, edit link (freeze)", () => {
  // One literal row per kind: icon, route, and whether the body is a Link.
  const table: Array<[string, () => RecentEvent, string, string, string]> = [
    ["bottle", () => bottleEv(), "🍼", "/log/bottle", "bottle-1"],
    ["diaper", () => diaperEv(), "🧷", "/log/diaper", "diaper-1"],
    ["solids", () => solidsEv(), "🥣", "/log/solids", "solids-1"],
    ["note", () => noteEv(), "📝", "/log/note", "note-1"],
    ["pumping", () => pumpingEv(), "💧", "/log/pumping", "pump-1"],
    ["nursing", () => nursingEv(), "👶", "/log/nursing", "nurse-1"],
    ["growth", () => growthEv(), "📏", "/log/growth", "growth-1"],
    ["sleep", () => sleepEv(), "😴", "/log/sleep", "sleep-1"],
  ];

  for (const [kind, build, icon, href, editId] of table) {
    it(`${kind}: icon ${icon}, edit link to ${href} with babyId and edit id`, () => {
      const html = render(build());
      expect(textOf(html).split(" ")[0]).toBe(icon);
      expect(editLinkOf(html)).toEqual({ href, babyId: "baby-1", editId });
    });
  }

  it("sends the time chip as HH:mm under the 24h preference", () => {
    expect(textOf(render(bottleEv()))).toBe("🍼 08:00 240 ml formula");
  });
});

describe("RecentRow body text per kind (freeze)", () => {
  it("bottle: formula source shows 'formula'", () => {
    expect(textOf(render(bottleEv()))).toBe("🍼 08:00 240 ml formula");
  });

  it("bottle: breast source shows 'expressed' and the notes line", () => {
    expect(
      textOf(render(bottleEv({ milk_source: "breast", amount_ml: 120, notes: "left first" }))),
    ).toBe("🍼 08:00 120 ml expressed left first");
  });

  it("diaper: 'wet diaper'", () => {
    expect(textOf(render(diaperEv()))).toBe("🧷 08:00 wet diaper");
  });

  it("diaper: notes line appears under the body", () => {
    expect(textOf(render(diaperEv({ type: "soiled", notes: "rash cream" })))).toBe(
      "🧷 08:00 soiled diaper rash cream",
    );
  });

  it("pumping: volume, 'pumped', and duration rounded to whole minutes", () => {
    expect(textOf(render(pumpingEv()))).toBe("💧 08:00 90 ml pumped · 20 min");
  });

  it("pumping: duration omitted when null", () => {
    expect(textOf(render(pumpingEv({ duration_seconds: null })))).toBe(
      "💧 08:00 90 ml pumped",
    );
  });

  it("nursing (closed): total minutes across both sides and the side", () => {
    expect(textOf(render(nursingEv()))).toBe("👶 08:00 Nursed 8 min · both");
  });

  it("growth: weight in kg, height in cm, head circumference labelled", () => {
    expect(textOf(render(growthEv()))).toBe("📏 08:00 5.20 kg · 58.5 cm · 38 cm head");
  });

  it("growth: no measurements falls back to 'Measurement'", () => {
    expect(
      textOf(
        render(
          growthEv({ weight_g: null, height_cm: null, head_circumference_cm: null }),
        ),
      ),
    ).toBe("📏 08:00 Measurement");
  });

  it("sleep (closed): duration, type, and location", () => {
    expect(textOf(render(sleepEv()))).toBe("😴 08:00 Slept 1h 25m · nap · crib");
  });

  it("note: body text only", () => {
    expect(textOf(render(noteEv()))).toBe("📝 08:00 Small rash on hand");
  });

  it("solids: foods joined, reaction, and amount in kg", () => {
    expect(textOf(render(solidsEv()))).toBe("🥣 08:00 banana, oat · liked · 0.03 kg");
  });

  it("solids: no reaction and no amount leaves only the foods", () => {
    expect(
      textOf(render(solidsEv({ foods: ["pear"], reaction: null, amount_g: null }))),
    ).toBe("🥣 08:00 pear");
  });
});

describe("RecentRow date line (freeze)", () => {
  it("omits the date line for today's rows", () => {
    expect(textOf(render(bottleEv()))).not.toContain("Nov");
  });

  it("shows 'MMM d' for rows that are not today", () => {
    expect(textOf(render(bottleEv({ occurred_at: MAY_22_8AM }, MAY_22_8AM)))).toBe(
      "🍼 08:00 240 ml formula May 22",
    );
  });
});

describe("RecentRow open sessions (freeze)", () => {
  it("open nursing: no edit link, 'Nursed N min' and side, then the in-progress marker like sleep", () => {
    const html = render(
      nursingEv({ ended_at: null, left_duration_s: 120, right_duration_s: 0, nursing_side: "left" }),
    );
    expect(editLinkOf(html)).toBeNull();
    expect(textOf(html)).toBe("👶 08:00 Nursed 2 min · left · in progress");
  });

  it("open sleep: no edit link and 'Sleeping · in progress'", () => {
    const html = render(sleepEv({ ended_at: null, sleep_type: null, location: null }));
    expect(editLinkOf(html)).toBeNull();
    expect(textOf(html)).toBe("😴 08:00 Sleeping · in progress");
  });

  it("open sleep with type and location still lists them after 'in progress'", () => {
    expect(textOf(render(sleepEv({ ended_at: null, sleep_type: "night", location: "bassinet" })))).toBe(
      "😴 08:00 Sleeping · night · bassinet · in progress",
    );
  });

  it("open sessions render an unlinked body div", () => {
    const html = render(sleepEv({ ended_at: null }));
    expect(html).toContain('<div class="min-w-0 flex-1">');
  });
});

// APPROVED CHANGE (foods-guard): legacy rows may lack `foods`.
describe("RecentRow solids without foods", () => {
  it("does not crash and renders an empty foods list", () => {
    const ev = solidsEv();
    delete (ev.data as Partial<SolidMeal>).foods;
    expect(textOf(render(ev))).toBe("🥣 08:00 · liked · 0.03 kg");
  });
});

describe("RecentRow photo indicator (freeze)", () => {
  it("diaper with has_photo shows the collapsed photo button before the body", () => {
    const html = render(diaperEv({ has_photo: true }));
    expect(textOf(html)).toBe("🧷 08:00 📷 wet diaper");
    expect(html).toContain('aria-label="Show photo"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("note with has_photo shows the photo button", () => {
    expect(textOf(render(noteEv({ has_photo: true })))).toBe("📝 08:00 📷 Small rash on hand");
  });

  it("solids with has_photo shows the photo button", () => {
    expect(textOf(render(solidsEv({ has_photo: true })))).toBe(
      "🥣 08:00 📷 banana, oat · liked · 0.03 kg",
    );
  });

  it("kinds without photo support never render the photo button", () => {
    for (const ev of [bottleEv(), pumpingEv(), nursingEv(), growthEv(), sleepEv()]) {
      expect(render(ev)).not.toContain("Show photo");
    }
  });

  it("diaper without has_photo has no photo button", () => {
    expect(render(diaperEv())).not.toContain("Show photo");
  });
});

describe("RecentRow syncing and highlight (freeze)", () => {
  it("syncing adds the '⏳ syncing' chip with its accessible label", () => {
    const html = render(bottleEv(), { syncing: true });
    expect(textOf(html)).toBe("🍼 08:00 ⏳ syncing 240 ml formula");
    expect(html).toContain('aria-label="Waiting for network sync"');
  });

  it("syncing rows stay tappable (edit link still rendered)", () => {
    expect(editLinkOf(render(bottleEv(), { syncing: true }))).not.toBeNull();
  });

  it("highlight adds the history-glow animation class to the list item", () => {
    const html = render(bottleEv(), { highlight: true });
    expect(html).toContain("animate-history-glow motion-reduce:animate-none");
  });

  it("default list item classes are exact", () => {
    expect(render(bottleEv())).toMatch(/^<li class="card flex flex-col gap-2 p-3">/);
  });
});
