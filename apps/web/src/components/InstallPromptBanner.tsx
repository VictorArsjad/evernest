// InstallPromptBanner — bottom-of-Today card that nudges the user to
// install the PWA. Two render variants gated by the platform:
//
//   - Chromium / Android: a prominent "Install" button that fires the
//     captured `beforeinstallprompt` event (single tap → OS dialog).
//   - iOS Safari: a static hint pointing at the Share → "Add to Home
//     Screen" sheet. iOS has no install API; this is the best UX.
//
// Auto-hides when:
//   - the app is already installed (display-mode: standalone OR Safari
//     `navigator.standalone`),
//   - the user dismissed within the last 30 days (DISMISSAL_WINDOW_MS),
//   - or neither install path applies (e.g. desktop Firefox).
//
// Mounted once on the Today hub (single mount point). Strictly below
// the existing content so a future header change (e.g. CP5's baby
// switcher) merges cleanly without conflicting with this card.

import { useInstallPrompt } from "../lib/useInstallPrompt";

export function InstallPromptBanner() {
  const { canPrompt, promptInstall, isIOS, isInstalled, isDismissed, dismiss } =
    useInstallPrompt();

  if (isInstalled || isDismissed) return null;
  // Only render if we have something actionable for the user: a captured
  // native prompt (Chromium) or an iOS Add-to-Home-Screen path. Browsers
  // that satisfy neither (e.g. desktop Firefox) get silence rather than
  // a useless card.
  if (!canPrompt && !isIOS) return null;

  return (
    <section
      aria-label="Install Evernest"
      className="card flex items-start gap-3 border border-accent/30 bg-accent/5 p-4"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent/20 text-xl">
        {/* Decorative — the icon is purely aesthetic; the section's
            aria-label communicates the intent to screen readers. */}
        <span aria-hidden="true">🌙</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-white">Install Evernest</h2>
          <button
            type="button"
            onClick={dismiss}
            className="-mr-1 -mt-1 rounded-full px-2 py-0.5 text-xs text-white/50 transition hover:text-white"
            aria-label="Dismiss install prompt"
          >
            Not now
          </button>
        </div>
        {canPrompt ? (
          <>
            <p className="mt-1 text-xs text-white/60">
              Add it to your home screen for a one-tap launch and a fullscreen
              experience.
            </p>
            <button
              type="button"
              onClick={() => {
                void promptInstall();
              }}
              className="btn-primary mt-3 px-4 py-2 text-sm"
            >
              Install
            </button>
          </>
        ) : (
          // iOS variant: no JS install path, walk the user through the
          // Share → Add to Home Screen sheet instead.
          <p className="mt-1 text-xs text-white/70">
            Tap{" "}
            <span
              aria-label="Share"
              className="mx-0.5 inline-flex h-5 w-5 items-center justify-center rounded-md border border-white/20 text-[10px]"
            >
              {/* Minimal up-arrow + box glyph, evokes the iOS Share icon
                  without depending on the SF Symbols font. */}
              <span aria-hidden="true">↑</span>
            </span>{" "}
            in Safari, then choose{" "}
            <span className="font-medium text-white">Add to Home Screen</span> to
            install Evernest.
          </p>
        )}
      </div>
    </section>
  );
}
