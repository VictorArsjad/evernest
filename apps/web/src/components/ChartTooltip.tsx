// ChartTooltip is the dark popover anchored above the active point on a
// chart. It is absolutely positioned with `pointer-events-none` so it
// never affects layout or eats events; the `clamp(8%, x%, 92%)` keeps the
// popover from running off the card edges without any JS measurement.
//
// Shared by the activity charts (_app.charts.tsx) and the growth chart
// (_app.growth.tsx).
import type { ReactNode } from "react";

export function ChartTooltip({ xPct, children }: { xPct: number; children: ReactNode }) {
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-white/10 bg-bg-subtle px-2 py-1.5 text-[11px] tabular-nums text-white shadow-lg"
      style={{ left: `clamp(8%, ${xPct}%, 92%)` }}
    >
      {children}
      <span
        aria-hidden="true"
        className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-x-4 border-t-4 border-x-transparent border-t-white/10"
      />
    </div>
  );
}
