// Chart palette module — owns the canonical list of presets, the resolve()
// helper that flattens (preset, overrides) into a concrete color per series,
// and the labels the Settings UI surfaces.
//
// The `default` preset matches today's hard-coded chart colors verbatim so
// existing users who never open Settings see zero visual change after the
// M3 ship. Other presets are sensibly curated (warm / pastel / high-contrast
// / Wong-Okabe-Ito colorblind) to give the user a quick "vibe shift" without
// having to think per series.
//
// The BE validates the same set of preset names + the closed series-key
// allowlist + the strict `#rrggbb` regex, so this file MUST stay in lockstep
// with apps/api/internal/preferences/preferences.go's allowedSeriesKeys and
// the `oneof` tag on ChartPalette.Preset.

export type SeriesKey =
  | "bottle_breast"
  | "bottle_formula"
  | "nursing"
  | "pumping"
  | "diaper_wet"
  | "diaper_soiled"
  | "diaper_mixed"
  | "weight";

export type PresetName =
  | "default"
  | "warm"
  | "pastel"
  | "high_contrast"
  | "colorblind";

// ChartPalette mirrors the BE's `chart_palette` JSONB column. `preset`
// picks a baseline and `overrides` is a sparse per-series override map
// that wins over the preset value at resolve time.
export interface ChartPalette {
  preset: PresetName;
  overrides: Partial<Record<SeriesKey, string>>;
}

export const DEFAULT_PALETTE: ChartPalette = {
  preset: "default",
  overrides: {},
};

export const PRESET_NAMES: PresetName[] = [
  "default",
  "warm",
  "pastel",
  "high_contrast",
  "colorblind",
];

export const PRESET_LABELS: Record<PresetName, string> = {
  default: "Default",
  warm: "Warm",
  pastel: "Pastel",
  high_contrast: "High contrast",
  colorblind: "Colorblind safe",
};

// SERIES_LABELS is iterated in insertion order to drive the "Advanced —
// customize per series" disclosure rows. Order is grouped by metric
// (bottle / nursing / pumping / diapers / weight) so the rendered list
// reads top-to-bottom like the charts screen itself.
export const SERIES_LABELS: Record<SeriesKey, string> = {
  bottle_breast: "Bottle (breast)",
  bottle_formula: "Bottle (formula)",
  nursing: "Nursing",
  pumping: "Pumping",
  diaper_wet: "Diapers — wet",
  diaper_soiled: "Diapers — soiled",
  diaper_mixed: "Diapers — mixed",
  weight: "Weight",
};

// PRESETS owns every named palette as a fully-specified map. Hex values
// for `default` are the CSS-color equivalents of the `rgb(...)` literals
// previously hard-coded inside `_app.charts.tsx`; identity here is what
// guarantees no visible diff for users on the default preset.
export const PRESETS: Record<PresetName, Record<SeriesKey, string>> = {
  // Verbatim match of today's hard-coded fills. DO NOT change these
  // without also confirming the rgb() literals they replaced are gone
  // from _app.charts.tsx.
  default: {
    bottle_breast: "#f472b6", // rgb(244 114 182) — pink-rose
    bottle_formula: "#fdba74", // rgb(253 186 116) — soft orange
    nursing: "#6ee7b7", // rgb(110 231 183) — emerald-300
    pumping: "#7dd3fc", // rgb(125 211 252) — sky-300
    diaper_wet: "#fde047", // rgb(253 224 71)  — yellow-300
    diaper_soiled: "#d97706", // rgb(217 119 6)   — amber-600
    diaper_mixed: "#b45309", // rgb(180 83 9)    — amber-700
    weight: "#c4b5fd", // rgb(196 181 253) — violet-300
  },
  // Sunset-y reds / oranges; bottle-breast leans pink-rose so it still
  // reads "breast" against the warmer formula amber.
  warm: {
    bottle_breast: "#fb7185",
    bottle_formula: "#fbbf24",
    nursing: "#f97316",
    pumping: "#f43f5e",
    diaper_wet: "#fde68a",
    diaper_soiled: "#b45309",
    diaper_mixed: "#7c2d12",
    weight: "#fb923c",
  },
  // Soft / desaturated for users who find the default too neon. Keep
  // the same hue families as `default` so it still reads as "the
  // bottle/diaper colors, but quieter."
  pastel: {
    bottle_breast: "#fbcfe8",
    bottle_formula: "#fed7aa",
    nursing: "#bbf7d0",
    pumping: "#bae6fd",
    diaper_wet: "#fef08a",
    diaper_soiled: "#fdba74",
    diaper_mixed: "#fcd34d",
    weight: "#ddd6fe",
  },
  // Pure / saturated, dark-bg safe. For low-vision users; weight is
  // pure white so it pops against the dark canvas.
  high_contrast: {
    bottle_breast: "#ff00aa",
    bottle_formula: "#ffaa00",
    nursing: "#00ff88",
    pumping: "#00aaff",
    diaper_wet: "#ffff00",
    diaper_soiled: "#ff5500",
    diaper_mixed: "#aa00ff",
    weight: "#ffffff",
  },
  // Wong/Okabe-Ito-inspired — distinguishable for protanopia,
  // deuteranopia, and tritanopia. Diaper mixed is a deeper amber to
  // keep the wet/soiled/mixed triple visually ordered.
  colorblind: {
    bottle_breast: "#cc79a7",
    bottle_formula: "#e69f00",
    nursing: "#009e73",
    pumping: "#56b4e9",
    diaper_wet: "#f0e442",
    diaper_soiled: "#d55e00",
    diaper_mixed: "#b06000",
    weight: "#0072b2",
  },
};

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// SERIES_KEY_SET is the runtime guard for unknown override keys. The BE
// validates the same allowlist, but a stale FE bundle reading a row
// written by a newer client should not crash; we just drop the unknown
// key and fall back to the preset for that slot.
const SERIES_KEY_SET: ReadonlySet<string> = new Set<SeriesKey>([
  "bottle_breast",
  "bottle_formula",
  "nursing",
  "pumping",
  "diaper_wet",
  "diaper_soiled",
  "diaper_mixed",
  "weight",
]);

// resolve flattens a (preset, overrides) palette to a concrete color per
// series. Overrides win over the preset for that one key; other keys
// stay on the preset. `null` / `undefined` palettes fall through to the
// default preset so the chart screen renders sanely while preferences
// are still loading or during a mid-deploy window where the BE hasn't
// shipped chart_palette yet.
//
// Unknown override keys and non-#rrggbb override values are dropped
// defensively — the BE validates both, but the FE shouldn't crash when
// reading data written by a future, looser, or buggier client.
export function resolve(
  p: ChartPalette | null | undefined,
): Record<SeriesKey, string> {
  const safe: ChartPalette = p ?? DEFAULT_PALETTE;
  const preset = PRESETS[safe.preset] ?? PRESETS.default;
  const out: Record<SeriesKey, string> = { ...preset };
  const overrides = safe.overrides ?? {};
  for (const key of Object.keys(overrides)) {
    if (!SERIES_KEY_SET.has(key)) continue;
    const value = overrides[key as SeriesKey];
    if (typeof value !== "string" || !HEX_COLOR_RE.test(value)) continue;
    out[key as SeriesKey] = value;
  }
  return out;
}
