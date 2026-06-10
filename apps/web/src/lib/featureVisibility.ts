// Per-user "feature visibility" map. Lets the user hide event kinds
// (bottle / nursing / pumping / diaper / growth) from the Today banner
// stats, the action tile grid, and the Charts page WITHOUT touching the
// underlying data. Past entries remain in their tables; this helper only
// gates UI surfaces.
//
// Shape on the wire: a sparse map where a key only appears when the user
// explicitly hid that feature. Missing key ⇒ visible. The default value
// (no rows hidden) is `{}`. Mirrors the BE jsonb column added in
// migration 000009 + the allowlist in
// apps/api/internal/preferences/preferences.go.

export type FeatureKey =
  | "bottle"
  | "nursing"
  | "pumping"
  | "diaper"
  | "growth";

// Render order for the settings card. Matches the order of tiles on the
// Today screen left-to-right so the toggle list mirrors what users see.
export const FEATURE_KEYS: FeatureKey[] = [
  "bottle",
  "nursing",
  "pumping",
  "diaper",
  "growth",
];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  bottle: "Bottle",
  nursing: "Nursing",
  pumping: "Pumping",
  diaper: "Diaper",
  growth: "Growth",
};

export type FeatureVisibilityMap = Partial<Record<FeatureKey, boolean>>;

// isFeatureVisible: true iff the feature is not explicitly disabled. A
// missing key (or an explicit `true`) renders the feature; only an
// explicit `false` hides it. Centralized so the three call sites
// (Today, Charts, Settings) stay one-liners.
export function isFeatureVisible(
  map: FeatureVisibilityMap | undefined,
  key: FeatureKey,
): boolean {
  return map?.[key] !== false;
}

// setFeatureVisibility returns a new map with `key` set to the requested
// state. Visible features are stripped from the map (sparse storage —
// "missing" is the canonical "visible" representation), so a fully-default
// user always serializes back to `{}`. Pure function; safe to use inside a
// React state updater.
export function setFeatureVisibility(
  map: FeatureVisibilityMap | undefined,
  key: FeatureKey,
  visible: boolean,
): FeatureVisibilityMap {
  const next: FeatureVisibilityMap = { ...(map ?? {}) };
  if (visible) {
    delete next[key];
  } else {
    next[key] = false;
  }
  return next;
}
