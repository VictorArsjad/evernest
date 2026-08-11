import { useEffect, useRef } from "react";

interface SwipeHandlers {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
}

// useSwipe recognizes a horizontal touch/pen swipe on `ref`'s element and
// calls the matching handler on release. Deliberately minimal:
//
// - Listeners are passive and never call preventDefault or capture the
//   pointer, so vertical scrolling, taps on buttons, and the charts'
//   pointerdown tooltip toggles all keep working untouched.
// - Mouse pointers are ignored — desktop navigates via the chevron
//   buttons, and a mouse drag would fight text selection.
// - The gesture fires only when the horizontal travel beats the
//   threshold AND clearly dominates the vertical travel, so a normal
//   page scroll can't accidentally navigate.
// - The effect has no dependency array on purpose: the charts page
//   early-returns a loading shell before the swipeable div exists, so a
//   bind-once effect would capture `ref.current === null` and never
//   attach. Rebinding after each render (with cleanup) is cheap and
//   always tracks the current element.
export function useSwipe(
  ref: React.RefObject<HTMLElement | null>,
  handlers: SwipeHandlers,
  opts?: { threshold?: number },
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const threshold = opts?.threshold ?? 50;

  // Tracked gesture, or null when idle / cancelled. Lives in a ref (not
  // a variable inside the effect) because a pointerdown on a chart bar
  // toggles its tooltip → re-render → the effect below rebinds — a
  // gesture in flight must survive that.
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
  } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (gestureRef.current) return; // second finger — keep tracking the first only
      gestureRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      g.lastX = e.clientX;
      g.lastY = e.clientY;
    };

    const onPointerUp = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      const dx = g.lastX - g.startX;
      const dy = g.lastY - g.startY;
      gestureRef.current = null;
      if (Math.abs(dx) < threshold || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
      if (dx > 0) handlersRef.current.onSwipeRight?.();
      else handlersRef.current.onSwipeLeft?.();
    };

    const onPointerCancel = (e: PointerEvent) => {
      // Browser claimed the pointer (usually for scrolling) — not a swipe.
      if (gestureRef.current && e.pointerId === gestureRef.current.pointerId) {
        gestureRef.current = null;
      }
    };

    const listenerOpts: AddEventListenerOptions = { passive: true };
    el.addEventListener("pointerdown", onPointerDown, listenerOpts);
    el.addEventListener("pointermove", onPointerMove, listenerOpts);
    el.addEventListener("pointerup", onPointerUp, listenerOpts);
    el.addEventListener("pointercancel", onPointerCancel, listenerOpts);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
    };
  });
}
