// AuthGate — renders a centered splash while the auth store is in its
// "initializing" state (the brief window between the first paint and
// bootstrapAuth() resolving), then hands the screen over to the routed
// content. This is the difference between a phone-PWA cold start on a
// slow tailnet showing a styled splash for a few seconds versus a
// blank dark shell that looks like the app crashed.
//
// The splash deliberately matches the wordmark used on _auth.tsx so the
// transition into the login screen (when bootstrap lands "anonymous") is
// visually continuous. The route guards in _app.tsx / _auth.tsx already
// tolerate "initializing" by no-oping, so we never trigger a redirect
// flash before the gate lifts.
import type { ReactNode } from "react";

import { useAuthStore } from "../lib/authStore";

interface AuthGateProps {
  children: ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const status = useAuthStore((s) => s.status);

  if (status === "initializing") {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        aria-label="Loading Evernest"
        data-testid="auth-gate-splash"
        className="flex flex-1 flex-col items-center justify-center gap-6 bg-bg-base px-6 text-white"
      >
        <h1 className="text-4xl font-semibold tracking-tight">Evernest</h1>
        <span
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80"
        />
      </div>
    );
  }

  return <>{children}</>;
}
