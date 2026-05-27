// SyncStatusBadge — compact header chip on Today that reflects the
// state of the offline mutation outbox. Shows nothing when the queue
// is empty (the steady state for online users); shows `↑ N` when N
// items are pending; shows `⚠ N` when any items have moved to dead
// (out of retries or 4xx) and need user action. Tapping the badge
// opens SyncStatusDialog for details + per-item retry/discard.
//
// Deliberately minimal: a single button with a tooltip + count. The
// goal is to keep the header uncluttered for the common case (queue
// empty) and pull the eye when there's something the user might want
// to act on.

import { useState } from "react";

import { useOutbox } from "../lib/useOutbox";
import { SyncStatusDialog } from "./SyncStatusDialog";

export function SyncStatusBadge() {
  const { pending, dead, retryAll, retryOne, discardOne } = useOutbox();
  const [open, setOpen] = useState(false);

  if (pending.length === 0 && dead.length === 0) return null;

  const hasDead = dead.length > 0;
  const label = hasDead
    ? `${dead.length} item${dead.length === 1 ? "" : "s"} failed to sync — tap to review`
    : `${pending.length} item${pending.length === 1 ? "" : "s"} pending sync`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={label}
        aria-label={label}
        className={
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition " +
          (hasDead
            ? "border-red-400/40 bg-red-400/10 text-red-200 hover:bg-red-400/20"
            : "border-white/15 bg-white/5 text-white/70 hover:bg-white/10")
        }
      >
        <span aria-hidden="true">{hasDead ? "⚠" : "↑"}</span>
        <span className="tabular-nums">{hasDead ? dead.length : pending.length}</span>
      </button>
      {open && (
        <SyncStatusDialog
          pending={pending}
          dead={dead}
          onClose={() => setOpen(false)}
          onRetryAll={retryAll}
          onRetryOne={retryOne}
          onDiscardOne={discardOne}
        />
      )}
    </>
  );
}
