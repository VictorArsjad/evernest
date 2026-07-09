// Shared "recent event" row used by Today and History. Lifted out of
// _app.index.tsx so the History view can render the exact same card UI
// without forking. The `syncing` prop stays at the call site: Today
// reads it from the outbox singleton; History deliberately passes
// `false` because past events aren't being mutated on that screen.
import { Link } from "@tanstack/react-router";
import { format, isToday, parseISO } from "date-fns";
import { useState } from "react";

import { useDiaperPhotoUrl } from "../lib/queries";
import type { RecentEvent } from "../lib/recentEvents";
import { formatLength, formatTime, formatVolume, formatWeight } from "../lib/units";
import type { CombinedPreferences } from "../lib/usePreferences";

// Internal helper — not exported because nothing outside this file uses
// it. Keeping it un-exported also satisfies `react-refresh/only-export-
// components`, which would otherwise force the dev server into a full
// page reload (instead of a hot module swap) whenever this file changes.
function growthSummary(
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
  highlight,
}: {
  ev: RecentEvent;
  prefs: CombinedPreferences;
  // CP6b: the row was created or modified via a mutation that's still
  // sitting in the outbox queue. Render a small "syncing…" hint so
  // the user knows the row is local-only until the queue drains.
  syncing?: boolean;
  // Briefly pulse the row when the user jumped here by clicking the
  // matching chart bar. Reduced-motion users skip the pulse (they still
  // get the expand + scroll).
  highlight?: boolean;
}) {
  const at = parseISO(ev.at);
  // Diaper rows can carry an optional photo (migration 000011). The
  // badge is only rendered when has_photo is true; tapping it lazily
  // mounts the photo URL hook so we don't pre-fetch every diaper image
  // on the Today / History screens.
  const isDiaperWithPhoto = ev.kind === "diaper" && !!ev.data.has_photo;
  const [photoExpanded, setPhotoExpanded] = useState(false);
  const diaperPhotoUrl = useDiaperPhotoUrl(
    isDiaperWithPhoto ? ev.data.id : null,
    isDiaperWithPhoto && photoExpanded,
  );
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
    <li
      className={
        "card flex flex-col gap-2 p-3" +
        (highlight ? " animate-history-glow motion-reduce:animate-none" : "")
      }
    >
      <div className="flex items-center gap-3">
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
          {isDiaperWithPhoto && (
            <button
              type="button"
              onClick={(e) => {
                // The row body is wrapped in a <Link>, but this button
                // lives in the metadata cluster outside it. Stop
                // propagation defensively in case a future refactor
                // nests these.
                e.stopPropagation();
                e.preventDefault();
                setPhotoExpanded((v) => !v);
              }}
              aria-label={photoExpanded ? "Hide photo" : "Show photo"}
              aria-expanded={photoExpanded}
              className="rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-white/70 hover:bg-white/10"
            >
              📷
            </button>
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
      </div>
      {isDiaperWithPhoto && photoExpanded && (
        // Indent so the thumbnail lines up under the row body, past the
        // icon (≈2 rem) + gap + time chip (4 rem) + gap. Tweak this
        // alongside the metadata cluster widths above.
        <div className="pl-[calc(2rem+0.5rem+4rem+0.5rem)]">
          {diaperPhotoUrl ? (
            <img
              src={diaperPhotoUrl}
              alt="Diaper photo"
              className="max-h-48 rounded-xl border border-white/10 object-contain"
            />
          ) : (
            <div className="h-24 w-24 animate-pulse rounded-xl bg-white/5" />
          )}
        </div>
      )}
    </li>
  );
}
