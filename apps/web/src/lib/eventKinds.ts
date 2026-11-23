// The one catalog of per-baby event kinds. Adding a kind starts here: add a
// row to EVENT_KIND_ROWS (TypeScript then flags every Record<EventKindName, …>
// that's missing the new kind) and, if it has a data row type, to EventKindRows.
//
// Consumers derive from this instead of keeping their own kind lists:
//   - featureVisibility.ts: FeatureKey / FEATURE_KEYS / FEATURE_LABELS
//   - recentEvents.ts:      RecentEvent union (via EventKindRows)
//   - palette.ts:           SeriesKey (via `series`)
//   - components/RecentRow: icon, photo alt text, editability
//
// Per-kind query hooks stay in queries.ts (one `defineEventKind` descriptor
// per kind); this catalog is the UI-facing metadata, so it imports only types.
import type {
  BottleFeed,
  Diaper,
  Growth,
  Note,
  Nursing,
  Pumping,
  Sleep,
  SolidMeal,
} from "./types";

// Row type per kind — the payload of a RecentEvent.
export interface EventKindRows {
  bottle: BottleFeed;
  nursing: Nursing;
  pumping: Pumping;
  diaper: Diaper;
  solids: SolidMeal;
  growth: Growth;
  sleep: Sleep;
  note: Note;
}

export type EventKindName = keyof EventKindRows;

export interface EventKindMeta {
  // Display label (Settings feature toggles).
  readonly label: string;
  // Emoji shown on the Recent row.
  readonly icon: string;
  // Alt text of the lazily-loaded photo; null ⇒ the kind has no photo.
  readonly photoAlt: string | null;
  // In-progress state (rows with a null ended_at are open sessions). Open
  // sessions aren't editable from the Recent row — they close via the
  // in-progress tile.
  readonly openSession: boolean;
  // Chart palette series keys this kind owns (none for solids / note).
  readonly series: readonly string[];
}

// Row order = Today-grid order (drives the Settings feature list).
export const EVENT_KIND_ROWS = {
  bottle: {
    label: "Bottle",
    icon: "🍼",
    photoAlt: null,
    openSession: false,
    series: ["bottle_breast", "bottle_formula"],
  },
  nursing: {
    label: "Nursing",
    // Nursing has no dedicated glyph; it shares the generic baby icon.
    icon: "👶",
    photoAlt: null,
    openSession: true,
    series: ["nursing"],
  },
  pumping: {
    label: "Pumping",
    icon: "💧",
    photoAlt: null,
    openSession: false,
    series: ["pumping"],
  },
  diaper: {
    label: "Diaper",
    icon: "🧷",
    photoAlt: "Diaper photo",
    openSession: false,
    series: ["diaper_wet", "diaper_soiled", "diaper_mixed"],
  },
  solids: {
    label: "Solids",
    icon: "🥣",
    photoAlt: "Solids photo",
    openSession: false,
    series: [],
  },
  growth: {
    label: "Growth",
    icon: "📏",
    photoAlt: null,
    openSession: false,
    series: ["weight"],
  },
  sleep: {
    label: "Sleep",
    icon: "😴",
    photoAlt: null,
    openSession: true,
    series: ["sleep_night", "sleep_nap"],
  },
  note: {
    label: "Note",
    icon: "📝",
    photoAlt: "Note photo",
    openSession: false,
    series: [],
  },
} as const satisfies Record<EventKindName, EventKindMeta>;

export const EVENT_KINDS = Object.keys(EVENT_KIND_ROWS) as EventKindName[];

export function eventKindMeta<K extends EventKindName>(kind: K): (typeof EVENT_KIND_ROWS)[K] {
  return EVENT_KIND_ROWS[kind];
}

// Union of every series key the catalog declares.
export type CatalogSeriesKey =
  (typeof EVENT_KIND_ROWS)[EventKindName]["series"][number];
