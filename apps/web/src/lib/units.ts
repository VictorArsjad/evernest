// Pure unit-conversion + formatting helpers for the Settings + display
// surfaces. Canonical storage on the BE is ml / cm / grams / UTC ISO; this
// module is the only place those canonical values get translated for the
// user's chosen display unit.
//
// The formatters are framework-agnostic on purpose — no React, no hooks,
// no date-fns import in the value formatters — so they're trivially
// unit-tested (see units.test.ts) and cheap to call from any render path.
//
// Conversion factors (kept here as named constants so a future audit can
// trace where each came from):
//   1 fl oz (US)  = 29.5735 ml
//   1 inch         = 2.54 cm
//   1 kilogram     = 2.2046226218 lb
// We use US fluid ounces (the BabyPlus export is US-locale and the
// settings UI groups oz with lb — the imperial baby-tracking world is
// almost entirely US in practice).

export type UnitVolume = "ml" | "oz";
export type UnitLength = "cm" | "in";
// 'g' is the canonical storage unit for weight; the BE pref enum only
// allows 'kg' | 'lb' (see baby_settings CHECK constraint), but the
// formatter accepts 'g' too so the few places that want to render raw
// grams (e.g. preemie-range debugging) can do so without a second helper.
export type UnitWeight = "g" | "kg" | "lb";
export type TimeFormat = "24h" | "12h";

export const ML_PER_FL_OZ = 29.5735;
export const CM_PER_INCH = 2.54;
export const LB_PER_KG = 2.2046226218;

// --- volume ---

// formatVolume renders a canonical-ml value in the user's chosen unit.
// Non-finite inputs return "—" so a missing field doesn't crash the row.
// ml: rendered as a whole number (volumes below 1 ml are not meaningful
// in this app — bottle minimum is 1 ml).
// oz: 1 decimal up to 9.9 oz, then 1 decimal still (1 dp is enough — a
// bottle is rarely measured to 0.01 oz precision in real life).
export function formatVolume(ml: number, pref: UnitVolume): string {
  if (!Number.isFinite(ml)) return "—";
  if (pref === "oz") {
    const oz = ml / ML_PER_FL_OZ;
    return `${oz.toFixed(1)} oz`;
  }
  return `${Math.round(ml)} ml`;
}

// volumeUnitLabel returns the bare unit suffix for input fields.
export function volumeUnitLabel(pref: UnitVolume): string {
  return pref === "oz" ? "oz" : "ml";
}

// mlToDisplayVolume converts canonical ml into the user's chosen unit
// for binding to a numeric <input>. Rounds to 1 decimal for oz.
export function mlToDisplayVolume(ml: number, pref: UnitVolume): number {
  if (pref === "oz") {
    return Math.round((ml / ML_PER_FL_OZ) * 10) / 10;
  }
  return ml;
}

// displayVolumeToMl converts a user-entered numeric value back to
// canonical ml for submission. Round to 2 decimals to fit the BE's
// numeric(7,2) column without surprising the user with floating-point
// trailing digits.
export function displayVolumeToMl(value: number, pref: UnitVolume): number {
  if (!Number.isFinite(value)) return value;
  if (pref === "oz") {
    return Math.round(value * ML_PER_FL_OZ * 100) / 100;
  }
  return Math.round(value * 100) / 100;
}

// --- length ---

// formatLength renders a canonical-cm value in the user's unit.
// cm: 1 decimal (height/head circumference are routinely measured to
// 0.5 cm by pediatricians).
// in: 1 decimal (matches the cm precision after conversion).
export function formatLength(cm: number, pref: UnitLength): string {
  if (!Number.isFinite(cm)) return "—";
  if (pref === "in") {
    const inches = cm / CM_PER_INCH;
    return `${inches.toFixed(1)} in`;
  }
  // cm: drop trailing zeros so "62" doesn't render as "62.0"; keep 1 dp
  // when the value is fractional (e.g. 62.5).
  return `${trimDecimal(cm, 1)} cm`;
}

export function lengthUnitLabel(pref: UnitLength): string {
  return pref === "in" ? "in" : "cm";
}

export function cmToDisplayLength(cm: number, pref: UnitLength): number {
  if (pref === "in") {
    return Math.round((cm / CM_PER_INCH) * 10) / 10;
  }
  return cm;
}

export function displayLengthToCm(value: number, pref: UnitLength): number {
  if (!Number.isFinite(value)) return value;
  if (pref === "in") {
    return Math.round(value * CM_PER_INCH * 100) / 100;
  }
  return Math.round(value * 100) / 100;
}

// --- weight ---

// formatWeight renders a canonical-grams value in the user's unit. NaN /
// Infinity returns "—" so summary tiles don't show "NaN kg" while a
// query is loading.
//
// kg: 2 decimals below 10 kg (a 6.50 kg infant), 1 decimal at or above
// (a 14.2 kg toddler). This mirrors the existing _app.charts.tsx and
// _app.index.tsx formatters so swapping in the central helper doesn't
// silently change rendered values.
// lb: 1 decimal (15.2 lb is plenty of precision for a baby).
// g: integer; included so debug/preemie views can stay in grams without
// a second helper, even though the settings UI doesn't expose it.
export function formatWeight(g: number, pref: UnitWeight): string {
  if (!Number.isFinite(g)) return "—";
  if (pref === "lb") {
    const kg = g / 1000;
    return `${(kg * LB_PER_KG).toFixed(1)} lb`;
  }
  if (pref === "g") {
    return `${Math.round(g)} g`;
  }
  const kg = g / 1000;
  if (kg < 10) {
    return `${kg.toFixed(2)} kg`;
  }
  return `${kg.toFixed(1)} kg`;
}

export function weightUnitLabel(pref: UnitWeight): string {
  return pref;
}

// gToDisplayWeight returns a numeric value suitable for binding to an
// <input>. Display precision matches the formatter: 2 decimals for kg
// below 10kg, 1 decimal for lb, integer for g.
export function gToDisplayWeight(g: number, pref: UnitWeight): number {
  if (pref === "lb") {
    return Math.round((g / 1000) * LB_PER_KG * 10) / 10;
  }
  if (pref === "g") {
    return Math.round(g);
  }
  return Math.round((g / 1000) * 100) / 100;
}

// displayWeightToG converts a user-entered numeric value (in their
// chosen unit) back to canonical grams for submission to the BE. Rounds
// to 2 decimals to match the numeric(8,2) weight_g column.
export function displayWeightToG(value: number, pref: UnitWeight): number {
  if (!Number.isFinite(value)) return value;
  if (pref === "lb") {
    return Math.round((value / LB_PER_KG) * 1000 * 100) / 100;
  }
  if (pref === "g") {
    return Math.round(value * 100) / 100;
  }
  return Math.round(value * 1000 * 100) / 100;
}

// --- time ---

// formatTime renders an ISO timestamp as a wall-clock time in the
// caller's local timezone. 24h returns "HH:mm" (e.g. "14:05"); 12h
// returns "h:mm AM/PM" (e.g. "2:05 PM"). Matches what the existing
// `format(parseISO(at), "HH:mm")` calls produced — drop-in compatible.
export function formatTime(iso: string, pref: TimeFormat): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const h = d.getHours();
  const m = d.getMinutes();
  const pad = (n: number) => String(n).padStart(2, "0");
  if (pref === "12h") {
    const period = h >= 12 ? "PM" : "AM";
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return `${h12}:${pad(m)} ${period}`;
  }
  return `${pad(h)}:${pad(m)}`;
}

// --- internal ---

// trimDecimal returns a string with at most `digits` decimals, dropping
// trailing zeros so "62.0" becomes "62" and "62.50" becomes "62.5".
function trimDecimal(n: number, digits: number): string {
  const fixed = n.toFixed(digits);
  return fixed.replace(/\.?0+$/, "");
}
