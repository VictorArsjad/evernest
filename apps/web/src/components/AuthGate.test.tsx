// AuthGate render test. We deliberately don't pull in jsdom +
// @testing-library/react for one component — the rest of the suite
// stays node-pure (see useActiveBaby.test.ts header for the same
// rationale). renderToStaticMarkup is enough to assert the gate's
// only behaviour: splash on "initializing", children on
// "authenticated" / "anonymous".
//
// We mock useAuthStore at the module boundary because Zustand v5's
// useStore uses React.useSyncExternalStore, which calls
// getServerSnapshot during static rendering — Zustand wires
// getServerSnapshot to the *initial* state, so the hook would always
// return "initializing" no matter what setState we ran. Driving the
// selector directly via a tiny mock lets the test toggle status
// without dragging in jsdom + a full React 18 transitions stack.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { AuthStatus } from "./AuthGate.test-helpers";
import { setAuthStatusForTest } from "./AuthGate.test-helpers";

vi.mock("../lib/authStore", async () => {
  const helpers = await import("./AuthGate.test-helpers");
  return {
    useAuthStore: <T,>(selector: (s: { status: AuthStatus }) => T): T =>
      selector({ status: helpers.getAuthStatusForTest() }),
  };
});

import { AuthGate } from "./AuthGate";

const CHILD_MARKER = "child-marker-content";

function child() {
  return <div data-testid="child">{CHILD_MARKER}</div>;
}

describe("AuthGate", () => {
  it("renders the splash and hides children while status is 'initializing'", () => {
    setAuthStatusForTest("initializing");
    const html = renderToStaticMarkup(<AuthGate>{child()}</AuthGate>);
    expect(html).toContain("Evernest");
    expect(html).toContain('data-testid="auth-gate-splash"');
    expect(html).not.toContain(CHILD_MARKER);
  });

  it("renders children and no splash once status is 'authenticated'", () => {
    setAuthStatusForTest("authenticated");
    const html = renderToStaticMarkup(<AuthGate>{child()}</AuthGate>);
    expect(html).toContain(CHILD_MARKER);
    expect(html).not.toContain('data-testid="auth-gate-splash"');
  });

  it("renders children and no splash once status is 'anonymous'", () => {
    // _auth.tsx / _app.tsx route guards drive the actual redirect-to-login
    // off the same status, so as long as the gate gets out of the way the
    // user sees either /login or the routed app — never the splash.
    setAuthStatusForTest("anonymous");
    const html = renderToStaticMarkup(<AuthGate>{child()}</AuthGate>);
    expect(html).toContain(CHILD_MARKER);
    expect(html).not.toContain('data-testid="auth-gate-splash"');
  });

  it("renders a Retry affordance (not the app) on boot 'error'", () => {
    // Boot refresh was unreachable after retries — we don't know if the
    // session is valid, so the gate must hold with a Retry screen rather
    // than reveal the app or flash the splash.
    setAuthStatusForTest("error");
    const html = renderToStaticMarkup(<AuthGate>{child()}</AuthGate>);
    expect(html).toContain('data-testid="auth-gate-error"');
    expect(html).toContain("Retry");
    expect(html).not.toContain(CHILD_MARKER);
    expect(html).not.toContain('data-testid="auth-gate-splash"');
  });
});
