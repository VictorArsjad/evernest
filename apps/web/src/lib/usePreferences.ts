// usePreferences merges the per-user prefs row (`/me/preferences`) and
// the per-baby unit prefs (`/babies/{id}/settings`) into the single shape
// every display surface actually wants. The split exists at the BE/storage
// layer (units are tracked per-baby so siblings can be in different units)
// but every screen renders one baby at a time, so callers just want one
// pref bag.
//
// The hook returns sensible defaults during loading so the Today / Charts
// views can render with placeholder values rather than blocking on the
// preference fetch — a brief flash of canonical units is far better than
// a brief flash of "Loading…" on the most visited screen in the app.
import { DEFAULT_PALETTE, type ChartPalette } from "./palette";
import { useBabySettings, useMyPreferences } from "./queries";

export interface CombinedPreferences {
  time_format: "24h" | "12h";
  unit_volume: "ml" | "oz";
  unit_length: "cm" | "in";
  unit_weight: "kg" | "lb";
  // Display flag for the Today banner's per-metric progress bars; lives
  // on user_preferences server-side. Default true.
  show_recommended_targets: boolean;
  // chart_palette is the unresolved (preset, overrides) palette — the
  // Charts route runs it through `resolve()` to get concrete colors per
  // series. Falls back to DEFAULT_PALETTE during loading and against an
  // older BE that doesn't return the field yet.
  chart_palette: ChartPalette;
}

export const DEFAULT_PREFERENCES: CombinedPreferences = {
  time_format: "24h",
  unit_volume: "ml",
  unit_length: "cm",
  unit_weight: "kg",
  show_recommended_targets: true,
  chart_palette: DEFAULT_PALETTE,
};

// usePreferences accepts a nullable babyId so callers don't need to gate
// it themselves (the Today route mounts before babies resolve). When
// babyId is null the unit fields fall back to defaults.
export function usePreferences(babyId: string | null): {
  prefs: CombinedPreferences;
  isLoading: boolean;
} {
  const me = useMyPreferences();
  const baby = useBabySettings(babyId);

  const prefs: CombinedPreferences = {
    time_format: me.data?.time_format ?? DEFAULT_PREFERENCES.time_format,
    unit_volume: baby.data?.unit_volume ?? DEFAULT_PREFERENCES.unit_volume,
    unit_length: baby.data?.unit_length ?? DEFAULT_PREFERENCES.unit_length,
    unit_weight: baby.data?.unit_weight ?? DEFAULT_PREFERENCES.unit_weight,
    show_recommended_targets:
      me.data?.show_recommended_targets ?? DEFAULT_PREFERENCES.show_recommended_targets,
    chart_palette: me.data?.chart_palette ?? DEFAULT_PREFERENCES.chart_palette,
  };

  // isLoading is true only on first paint; subsequent baby changes use
  // cached values until the new baby's settings hydrate, so the UI
  // doesn't flash defaults when switching babies in a future multi-baby
  // selector.
  const isLoading =
    me.isLoading || (babyId != null && baby.isLoading);

  return { prefs, isLoading };
}
