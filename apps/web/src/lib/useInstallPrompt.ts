// useInstallPrompt — wires the cross-browser pieces needed to show an
// "Install Evernest" affordance on the Today hub.
//
// Two install flows we have to bridge:
//
//   1. Chromium / Android — fires the (non-standard but widely-shipped)
//      `beforeinstallprompt` event when the page meets installability
//      heuristics. We `preventDefault()` so Chrome's mini-banner stays
//      out of the way, stash the event, and re-fire it from our own UI
//      via `prompt()` when the user taps "Install".
//
//   2. iOS Safari — does NOT fire `beforeinstallprompt`. The only way
//      to install is via the Share → "Add to Home Screen" sheet. We
//      detect iOS Safari + non-installed state and show a custom hint
//      pointing the user at the Share button.
//
// Dismissal is sticky for 30 days (localStorage) so the banner doesn't
// nag on every page load. The banner component reads `isDismissed` and
// hides itself; calling `dismiss()` writes the current epoch so we can
// expire the snooze. Cleared if `clearDismissal()` is called from a
// future debug surface.
//
// TODO(CP6b): offline mutation outbox via IndexedDB lands in a separate
// PR (CP6b) once CP5 stabilizes the mutation surface. See
// `apps/web/src/lib/offline-outbox.todo.md` for the deferred scope.

import { useCallback, useEffect, useState } from "react";

// Chromium's BeforeInstallPromptEvent is non-standard so it isn't in
// lib.dom yet — declare the minimum surface we use. `userChoice` is the
// promise that resolves after the user picks accepted/dismissed.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

export const DISMISSAL_KEY = "evernest:installPromptDismissed";
// 30 days in ms — matches the "don't nag" window we tell the user about.
// Long enough that a determined "not now" tap means business; short
// enough that we recover gracefully if they change their mind a month
// later (e.g. swap a phone).
export const DISMISSAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// --- pure helpers (unit-tested in useInstallPrompt.test.ts) ---

// iOS detection — UA-sniffing is brittle in general, but for "should we
// show the Add-to-Home-Screen hint?" it's the only signal that works.
// We pair it with `isStandalone` so the hint disappears the moment the
// user actually installs (display-mode flips to standalone).
export function detectIsIOS(userAgent: string, isStandalone: boolean): boolean {
  if (isStandalone) return false;
  return /iPad|iPhone|iPod/.test(userAgent);
}

// True iff the page is running as an installed PWA. We accept both
// inputs (CSS display-mode + iOS's `navigator.standalone` proprietary
// flag) because each platform reports it via a different surface.
export function detectIsInstalled(args: {
  displayModeStandalone: boolean;
  navigatorStandalone: boolean;
}): boolean {
  return args.displayModeStandalone || args.navigatorStandalone;
}

// Is the stored dismissal timestamp still within its expiry window?
// Stored shape is a stringified epoch-ms; we treat anything unparseable
// as "no dismissal" so corrupt localStorage doesn't permanently silence
// the banner.
export function isDismissalFresh(
  raw: string | null,
  nowMs: number,
  windowMs: number = DISMISSAL_WINDOW_MS,
): boolean {
  if (!raw) return false;
  const t = Number.parseInt(raw, 10);
  if (!Number.isFinite(t)) return false;
  if (t > nowMs) return false; // future timestamp = clock-skewed write; ignore
  return nowMs - t < windowMs;
}

// --- React hook ---

export interface UseInstallPrompt {
  // Chromium captured a beforeinstallprompt event we can re-fire.
  canPrompt: boolean;
  // Fire the native install prompt. No-op on iOS (Safari has no API).
  promptInstall: () => Promise<void>;
  // iOS Safari, not installed — show the Add-to-Home-Screen hint.
  isIOS: boolean;
  // Already running as the installed standalone app.
  isInstalled: boolean;
  // User chose "not now" within the last DISMISSAL_WINDOW_MS.
  isDismissed: boolean;
  // Persist a fresh dismissal and flip isDismissed=true.
  dismiss: () => void;
}

export function useInstallPrompt(): UseInstallPrompt {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState<boolean>(() => readInstalled());
  const [isDismissed, setIsDismissed] = useState<boolean>(() => readDismissed());
  // UA + display-mode don't change without a navigation, so iOS detection
  // is computed once on mount and treated as static for the hook's
  // lifetime.
  const [isIOS] = useState<boolean>(() =>
    typeof window === "undefined"
      ? false
      : detectIsIOS(window.navigator.userAgent, isStandaloneNow()),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onBeforeInstall = (e: Event) => {
      // Suppress the browser's native mini-banner so we can render our
      // own in-place affordance instead. The captured event remains
      // dispatchable later via prompt().
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const onAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppInstalled);

    // Some browsers flip display-mode without a reload (e.g. installing
    // via the menu while the tab stays open). Listen for the change so
    // the banner self-dismisses.
    const mql = window.matchMedia("(display-mode: standalone)");
    const onModeChange = (ev: MediaQueryListEvent) => {
      if (ev.matches) setIsInstalled(true);
    };
    mql.addEventListener?.("change", onModeChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppInstalled);
      mql.removeEventListener?.("change", onModeChange);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        // Browser fires `appinstalled` shortly after; we still clear
        // the deferred event so we don't double-prompt if the user
        // taps again before that event lands.
        setDeferredPrompt(null);
      } else {
        // Treat in-prompt "Cancel" the same as the user tapping our
        // own dismiss button — they explicitly said no.
        persistDismissal();
        setIsDismissed(true);
      }
    } catch {
      // prompt() can throw if it's been called twice; swallow and reset
      // the deferred event so the UI can recover gracefully on the
      // next beforeinstallprompt cycle.
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  const dismiss = useCallback(() => {
    persistDismissal();
    setIsDismissed(true);
  }, []);

  return {
    canPrompt: deferredPrompt !== null,
    promptInstall,
    isIOS,
    isInstalled,
    isDismissed,
    dismiss,
  };
}

// --- internal SSR-safe IO helpers ---

function isStandaloneNow(): boolean {
  if (typeof window === "undefined") return false;
  const displayModeStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
  // Cast: `navigator.standalone` is Safari-only and not on the lib.dom type.
  const navStandalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  return detectIsInstalled({
    displayModeStandalone,
    navigatorStandalone: navStandalone,
  });
}

function readInstalled(): boolean {
  return isStandaloneNow();
}

function readDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return isDismissalFresh(window.localStorage.getItem(DISMISSAL_KEY), Date.now());
  } catch {
    return false;
  }
}

function persistDismissal(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISSAL_KEY, String(Date.now()));
  } catch {
    // localStorage can throw in private mode or when quota-exceeded.
    // Swallow — we just lose the snooze for this session, which is the
    // safer fail-open behavior than crashing the Today hub.
  }
}
