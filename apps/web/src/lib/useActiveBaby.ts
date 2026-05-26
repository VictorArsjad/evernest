// Active-baby resolver hook. Reads the list of babies for the given
// household, persists the user's selection in localStorage keyed by
// household id, and falls back to the first baby when no selection has
// been made (or the saved id no longer points at a valid baby — e.g. the
// baby was removed in a different session).
//
// Storage key shape: `evernest:activeBaby:{householdId}` — namespacing by
// household so two households' selections don't collide on the same
// device. We avoid localStorage on SSR / non-window environments so this
// hook is safe to import from server-rendered surfaces if we ever add
// any.
//
// The hook intentionally does NOT fetch babies itself; the caller passes
// the resolved list from `useBabies(householdId)`. Keeping the data
// dependency external means we never duplicate the TanStack Query cache
// and the hook stays trivially unit-testable with a plain array input.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Baby } from "./types";

export interface UseActiveBabyResult {
  /** The currently-active baby, or null while the babies list is still
   *  resolving (or empty). */
  baby: Baby | null;
  /** Setter — also persists to localStorage. No-op if the babyId isn't
   *  in the supplied list. */
  setActiveBabyId: (babyId: string) => void;
  /** All babies for the household, returned as-is. Avoids the caller
   *  threading both `babies` and `useActiveBaby(...)` separately. */
  all: Baby[];
}

const STORAGE_PREFIX = "evernest:activeBaby:";

/** Test seam — read/write isolated from any actual `window.localStorage`. */
export function storageKeyForHousehold(householdId: string): string {
  return `${STORAGE_PREFIX}${householdId}`;
}

function readStored(householdId: string): string | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    return window.localStorage.getItem(storageKeyForHousehold(householdId));
  } catch {
    return null;
  }
}

function writeStored(householdId: string, babyId: string): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(storageKeyForHousehold(householdId), babyId);
  } catch {
    // Quota errors or Safari private-mode — silently ignore; falling back
    // to "first baby" is acceptable behavior.
  }
}

/** resolveActiveBaby is the pure decision function: given the household
 *  id, the resolved baby list, and a stored selection, pick the active
 *  baby. Exported for the unit tests so they don't have to mount a hook. */
export function resolveActiveBaby(
  householdId: string | null,
  babies: Baby[],
  storedId: string | null,
): Baby | null {
  if (!householdId) return null;
  if (babies.length === 0) return null;
  if (storedId) {
    const match = babies.find((b) => b.id === storedId);
    if (match) return match;
  }
  return babies[0];
}

export function useActiveBaby(
  householdId: string | null,
  babies: Baby[] | undefined,
): UseActiveBabyResult {
  const resolvedBabies = useMemo(() => babies ?? [], [babies]);

  // The selected id mirrors localStorage. We don't read it lazily on
  // every render because that'd make the resolved baby flicker between
  // initial render (no localStorage on SSR) and post-hydration.
  const [storedId, setStoredId] = useState<string | null>(() =>
    householdId ? readStored(householdId) : null,
  );

  // Reset when the household changes — the persisted selection is
  // household-scoped, so switching households should not carry the
  // previous selection over.
  useEffect(() => {
    setStoredId(householdId ? readStored(householdId) : null);
  }, [householdId]);

  const baby = useMemo(
    () => resolveActiveBaby(householdId, resolvedBabies, storedId),
    [householdId, resolvedBabies, storedId],
  );

  const setActiveBabyId = useCallback(
    (babyId: string) => {
      if (!householdId) return;
      if (!resolvedBabies.some((b) => b.id === babyId)) return;
      writeStored(householdId, babyId);
      setStoredId(babyId);
    },
    [householdId, resolvedBabies],
  );

  return { baby, setActiveBabyId, all: resolvedBabies };
}
