// Persistent bottom tab bar for the authenticated app. Rendered once by
// the _app layout (only on the primary destinations — see _app.tsx), it
// is the single source of navigation between Today / Growth / History /
// Settings, replacing the old per-page header link clusters.
//
// Phone-first: fixed to the bottom, constrained to the same max-w-md
// centered column as __root.tsx, with thumb-sized (>=44px) targets that
// clear the iOS home indicator via safe-area padding.
//
// Icons are hand-rolled inline SVG line icons — the app ships no icon
// library, and a handful of stroke paths keeps it dependency-free while
// looking more native than emoji.
import { Link } from "@tanstack/react-router";

import { isFeatureVisible } from "../lib/featureVisibility";
import { useMyPreferences } from "../lib/queries";

// Active/inactive colors are split across activeProps / inactiveProps so
// exactly one color utility is ever applied — keeping the color out of
// the shared base class avoids the Tailwind gotcha where two color
// utilities collide and stylesheet order (not class order) decides the
// winner. Today uses exact matching so `/` isn't active on every route.
const linkClass =
  "flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition";
const activeProps = { className: "text-accent" };
const inactiveProps = { className: "text-white/50 hover:text-white/80" };

export function AppNav() {
  const me = useMyPreferences();
  const showGrowth = isFeatureVisible(me.data?.feature_visibility ?? {}, "growth");

  return (
    <nav
      aria-label="Primary"
      data-testid="app-nav"
      className="fixed inset-x-0 bottom-0 z-40 mx-auto flex max-w-md border-t border-white/10 bg-bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <Link
        to="/"
        aria-label="Today"
        className={linkClass}
        activeProps={activeProps}
        inactiveProps={inactiveProps}
        activeOptions={{ exact: true }}
      >
        <IconHome />
        Today
      </Link>
      {showGrowth && (
        <Link
          to="/growth"
          aria-label="Growth"
          className={linkClass}
          activeProps={activeProps}
          inactiveProps={inactiveProps}
        >
          <IconChart />
          Growth
        </Link>
      )}
      <Link
        to="/charts"
        aria-label="History"
        className={linkClass}
        activeProps={activeProps}
        inactiveProps={inactiveProps}
      >
        <IconHistory />
        History
      </Link>
      <Link
        to="/settings"
        aria-label="Settings"
        className={linkClass}
        activeProps={activeProps}
        inactiveProps={inactiveProps}
      >
        <IconSettings />
        Settings
      </Link>
    </nav>
  );
}

const svgProps = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function IconHome() {
  return (
    <svg {...svgProps}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg {...svgProps}>
      <path d="M4 4v16h16" />
      <path d="M7 14l3.5-4 3 3L20 7" />
    </svg>
  );
}

function IconHistory() {
  return (
    <svg {...svgProps}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.4-5.9" />
      <path d="M5 3v3.5h3.5" />
      <path d="M12 8v4.2l2.8 2" />
    </svg>
  );
}

function IconSettings() {
  return (
    <svg {...svgProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
