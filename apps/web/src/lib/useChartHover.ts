// useChartHover owns the active-point index for a single chart card. The
// hover state is per-chart (not global) so tooltips on different cards
// don't fight each other when the user drags across a grid.
//
// - `setActive(i)` shows the tooltip at `i`.
// - `clear()` hides it.
// - `toggle(i)` is the mobile tap behavior: tap a point shows it; tapping
//   the same point again toggles off; tapping a different one moves it.
// - `containerRef` is attached to the chart wrapper; the effect below
//   listens for a `pointerdown` anywhere on the document and clears the
//   active state when the event landed outside this chart, so a mobile
//   user can dismiss a tooltip by tapping anywhere off-chart.
//
// Shared by the activity charts (_app.charts.tsx) and the growth chart
// (_app.growth.tsx) so hover/tap behavior stays identical.
import { useCallback, useEffect, useRef, useState } from "react";

export function useChartHover() {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const setActive = useCallback((i: number) => setActiveIndex(i), []);
  const clear = useCallback(() => setActiveIndex(null), []);
  const toggle = useCallback((i: number) => {
    setActiveIndex((prev) => (prev === i ? null : i));
  }, []);

  useEffect(() => {
    if (activeIndex == null) return;
    const onDown = (e: PointerEvent) => {
      const c = containerRef.current;
      if (!c) return;
      if (e.target instanceof Node && c.contains(e.target)) return;
      setActiveIndex(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [activeIndex]);

  return { activeIndex, setActive, clear, toggle, containerRef };
}

export type ChartHover = ReturnType<typeof useChartHover>;
