// Shared page chrome for every authenticated screen. Renders a
// title-only header (title / headline node + optional subtitle) with an
// optional right-aligned `aside` slot (the Today page hangs its
// SyncStatusBadge there). Navigation between primary destinations lives
// in the persistent bottom tab bar (AppNav), not here — so this shell
// carries no nav links, back link, or sign-out affordance.
//
// The extra bottom padding (pb-24) keeps page content clear of the
// fixed AppNav bar; AppNav itself owns the safe-area inset.
import type { ReactNode } from "react";

export function PageShell({
  title,
  titleNode,
  subtitle,
  aside,
  children,
}: {
  title?: string;
  titleNode?: ReactNode;
  subtitle?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="flex flex-1 flex-col gap-5 p-5 pb-24">
      <header className="flex items-start justify-between gap-3">
        <div>
          {titleNode ?? <h1 className="text-2xl font-semibold">{title}</h1>}
          {subtitle && <p className="text-xs text-white/50">{subtitle}</p>}
        </div>
        {aside && <div className="flex items-center gap-4">{aside}</div>}
      </header>
      {children}
    </main>
  );
}
