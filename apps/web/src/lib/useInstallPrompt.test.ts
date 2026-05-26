import { describe, expect, it } from "vitest";

import {
  DISMISSAL_WINDOW_MS,
  detectIsIOS,
  detectIsInstalled,
  isDismissalFresh,
} from "./useInstallPrompt";

describe("detectIsIOS", () => {
  // Coverage focuses on the three signals we actually act on: the iOS
  // UA family, anything else (no hint), and the "already installed"
  // escape hatch that should always win.
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const IPAD =
    "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const IPOD =
    "Mozilla/5.0 (iPod touch; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15";
  const ANDROID_CHROME =
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
  const MAC_SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

  it("returns true for iPhone/iPad/iPod when not already installed", () => {
    expect(detectIsIOS(IPHONE, false)).toBe(true);
    expect(detectIsIOS(IPAD, false)).toBe(true);
    expect(detectIsIOS(IPOD, false)).toBe(true);
  });

  it("returns false on non-iOS user agents", () => {
    expect(detectIsIOS(ANDROID_CHROME, false)).toBe(false);
    // macOS Safari shares the WebKit family but isn't an iOS device —
    // the install flow is desktop Safari's "Add to Dock" which we don't
    // surface in the banner. Negative on purpose.
    expect(detectIsIOS(MAC_SAFARI, false)).toBe(false);
  });

  it("returns false on iOS once standalone (installed) to suppress the hint", () => {
    expect(detectIsIOS(IPHONE, true)).toBe(false);
    expect(detectIsIOS(IPAD, true)).toBe(false);
  });

  it("treats an empty UA as not-iOS rather than throwing", () => {
    expect(detectIsIOS("", false)).toBe(false);
  });
});

describe("detectIsInstalled", () => {
  it("is true when either signal is true", () => {
    // CSS display-mode is the Chromium/Android source of truth.
    expect(
      detectIsInstalled({ displayModeStandalone: true, navigatorStandalone: false }),
    ).toBe(true);
    // navigator.standalone is Safari's proprietary signal.
    expect(
      detectIsInstalled({ displayModeStandalone: false, navigatorStandalone: true }),
    ).toBe(true);
  });

  it("is false only when both signals are false", () => {
    expect(
      detectIsInstalled({ displayModeStandalone: false, navigatorStandalone: false }),
    ).toBe(false);
  });
});

describe("isDismissalFresh", () => {
  // The dismissal window is a tunable; tests pass it explicitly so a
  // future bump (e.g. 60 days) doesn't require sweeping the assertions.
  const NOW = 1_750_000_000_000; // Jun 2025-ish — picked to leave headroom for math
  const WINDOW = DISMISSAL_WINDOW_MS;

  it("returns false when no value is stored", () => {
    expect(isDismissalFresh(null, NOW, WINDOW)).toBe(false);
    expect(isDismissalFresh("", NOW, WINDOW)).toBe(false);
  });

  it("returns false when the value is unparseable", () => {
    // We never want corrupt localStorage to silently silence the banner —
    // garbage in, banner shows.
    expect(isDismissalFresh("not-a-number", NOW, WINDOW)).toBe(false);
    expect(isDismissalFresh("NaN", NOW, WINDOW)).toBe(false);
  });

  it("returns true when the dismissal is within the window", () => {
    expect(isDismissalFresh(String(NOW - 1000), NOW, WINDOW)).toBe(true);
    // One hour ago — comfortably fresh.
    expect(isDismissalFresh(String(NOW - 60 * 60 * 1000), NOW, WINDOW)).toBe(true);
    // 29 days ago — still inside the 30-day window.
    expect(isDismissalFresh(String(NOW - 29 * 24 * 60 * 60 * 1000), NOW, WINDOW)).toBe(true);
  });

  it("returns false once the dismissal has expired", () => {
    // 31 days ago — past the window.
    expect(isDismissalFresh(String(NOW - 31 * 24 * 60 * 60 * 1000), NOW, WINDOW)).toBe(false);
    // Exactly at the boundary — strictly-less-than, so equal = expired.
    expect(isDismissalFresh(String(NOW - WINDOW), NOW, WINDOW)).toBe(false);
  });

  it("rejects future timestamps (clock-skewed writes)", () => {
    // A timestamp in the future would otherwise read as "freshly
    // dismissed forever". Be defensive and ignore it.
    expect(isDismissalFresh(String(NOW + 10_000), NOW, WINDOW)).toBe(false);
  });

  it("defaults the window to DISMISSAL_WINDOW_MS when not passed", () => {
    expect(isDismissalFresh(String(NOW - 60_000), NOW)).toBe(true);
    expect(isDismissalFresh(String(NOW - DISMISSAL_WINDOW_MS - 1), NOW)).toBe(false);
  });
});
