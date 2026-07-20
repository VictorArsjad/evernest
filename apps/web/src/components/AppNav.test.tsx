// AppNav render test. Kept node-pure (renderToStaticMarkup, no jsdom /
// RTL) to match the rest of the suite — see AuthGate.test.tsx for the
// rationale. We mock the two module boundaries the bar depends on:
//   - @tanstack/react-router's Link (no RouterProvider under static
//     render), reduced to a plain anchor that preserves aria-label so
//     we can assert which tabs render.
//   - useMyPreferences, to drive the Growth tab's feature gate.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { FeatureVisibilityMap } from "../lib/featureVisibility";

let featureVisibility: FeatureVisibilityMap = {};

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    ...rest
  }: {
    children: React.ReactNode;
    ["aria-label"]?: string;
  }) => <a aria-label={rest["aria-label"]}>{children}</a>,
}));

vi.mock("../lib/queries", () => ({
  useMyPreferences: () => ({ data: { feature_visibility: featureVisibility } }),
}));

import { AppNav } from "./AppNav";

describe("AppNav", () => {
  it("renders the four primary tabs when Growth is visible", () => {
    featureVisibility = {};
    const html = renderToStaticMarkup(<AppNav />);
    expect(html).toContain('data-testid="app-nav"');
    expect(html).toContain('aria-label="Today"');
    expect(html).toContain('aria-label="Growth"');
    expect(html).toContain('aria-label="History"');
    expect(html).toContain('aria-label="Settings"');
  });

  it("hides the Growth tab when the growth feature is turned off", () => {
    featureVisibility = { growth: false };
    const html = renderToStaticMarkup(<AppNav />);
    expect(html).not.toContain('aria-label="Growth"');
    // The other tabs are unaffected.
    expect(html).toContain('aria-label="Today"');
    expect(html).toContain('aria-label="History"');
    expect(html).toContain('aria-label="Settings"');
  });
});
