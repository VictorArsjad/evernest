// Shared "recent event" row used by Today and History. Lifted out of
// _app.index.tsx so the History view can render the exact same card UI
// without forking. The `syncing` prop stays at the call site: Today
// reads it from the outbox singleton; History deliberately passes
// `false` because past events aren't being mutated on that screen.
import { Link } from "@tanstack/react-router";
import { format, isToday, parseISO } from "date-fns";

import type { RecentEvent } from "../lib/recentEvents";
import { formatLength, formatTime, formatVolume, formatWeight } from "../lib/units";
import type { CombinedPreferences } from "../lib/usePreferences";

export function growthSummary(
  g: {
    weight_g?: number | null;
    height_cm?: number | null;
    head_circumference_cm?: number | null;
  },
  prefs: CombinedPreferences,
): string {
  // Compose the Recent-list label from whichever fields are present —
  // dropping NULL columns rather than rendering "0 kg / 0 cm" placeholders.
  const parts: string[] = [];
  if (g.weight_g != null) {
    parts.push(formatWeight(Number(g.weight_g), prefs.unit_weight));
  }
  if (g.height_cm != null) {
    parts.push(formatLength(Number(g.height_cm), prefs.unit_length));
  }
  if (g.head_circumference_cm != null) {
    parts.push(`${formatLength(Number(g.head_circumference_cm), prefs.unit_length)} head`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Measurement";
}

export function RecentRow({
  ev,
  prefs,
  syncing,
}: {
  ev: RecentEvent;
  prefs: CombinedPreferences;
  // CP6b: the row was created or modified via a mutation that's still
  // sitting in the outbox queue. Render a small "syncing…" hint so
  // the user knows the row is local-only until the queue drains.
  syncing?: boolean;
}) {
  const at = parseISO(ev.at);
  const icon =
    ev.kind === "bottle"
      ? "🍼"
      : ev.kind === "diaper"
        ? "🧷"
        : ev.kind === "pumping"
          ? "💧"
          : ev.kind === "growth"
            ? "📏"
            : "👶";
  // Tap target: the row body links to the matching /log/<kind>?edit=<id>
  // form so users can correct mistyped values. Open nursing sessions are
  // intentionally NOT editable from here — those flow through the
  // in-progress chip's End-now modal, which is the only place that
  // owns the close-session transition. Syncing rows stay tappable
  // because the edit form prefills from the same cache that holds the
  // unsynced row.
  const editable = !(ev.kind === "nursing" && ev.data.ended_at == null);
  const body = (
    <>
      {ev.kind === "bottle" && (
        <>
          <div className="text-base font-medium">
            {formatVolume(Number(ev.data.amount_ml), prefs.unit_volume)}
            <span className="ml-2 text-xs font-normal text-white/50">
              {ev.data.milk_source === "breast" ? "expressed" : "formula"}
            </span>
          </div>
          {ev.data.notes && (
            <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
          )}
        </>
      )}
      {ev.kind === "diaper" && (
        <>
          <div className="text-base font-medium capitalize">{ev.data.type} diaper</div>
          {ev.data.notes && (
            <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
          )}
        </>
      )}
      {ev.kind === "pumping" && (
        <>
          <div className="text-base font-medium">
            {formatVolume(Number(ev.data.amount_ml), prefs.unit_volume)} pumped
            {ev.data.duration_seconds != null && (
              <span className="ml-2 text-xs font-normal text-white/50">
                · {Math.round(ev.data.duration_seconds / 60)} min
              </span>
            )}
          </div>
          {ev.data.notes && (
            <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
          )}
        </>
      )}
      {ev.kind === "nursing" && (
        <>
          <div className="text-base font-medium">
            Nursed {Math.round((ev.data.left_duration_s + ev.data.right_duration_s) / 60)} min
            <span className="ml-2 text-xs font-normal capitalize text-white/50">
              · {ev.data.nursing_side}
            </span>
          </div>
          {ev.data.notes && (
            <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
          )}
        </>
      )}
      {ev.kind === "growth" && (
        <>
          <div className="text-base font-medium">{growthSummary(ev.data, prefs)}</div>
          {ev.data.notes && (
            <div className="truncate text-xs text-white/50">{ev.data.notes}</div>
          )}
        </>
      )}
      {!isToday(at) && (
        <div className="text-xs text-white/40">{format(at, "MMM d")}</div>
      )}
    </>
  );
  return (
    <li className="card flex items-center gap-3 p-3">
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-2xl leading-none">{icon}</span>
        <span className="text-sm tabular-nums text-white/60 w-16">
          {formatTime(ev.at, prefs.time_format)}
        </span>
        {syncing && (
          <span
            title="Waiting for network sync"
            aria-label="Waiting for network sync"
            className="rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-white/50"
          >
            ⏳ syncing
          </span>
        )}
      </div>
      {editable ? (
        <Link
          to={`/log/${ev.kind}`}
          search={{ babyId: ev.data.baby_id, edit: ev.data.id }}
          className="-my-3 -mr-3 flex min-w-0 flex-1 flex-col justify-center py-3 pr-3 transition active:opacity-70"
        >
          {body}
        </Link>
      ) : (
        <div className="min-w-0 flex-1">{body}</div>
      )}
    </li>
  );
}
