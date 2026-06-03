// SyncStatusDialog — slide-up sheet that lists every record in the
// offline mutation outbox. Pending items appear first (with a
// "syncing…" pulse) and dead items appear below with their last error
// + per-item Retry / Discard. A "Retry all" button on the dead section
// re-enqueues every dead record at attempts=0.
//
// The dialog is mounted on demand by SyncStatusBadge; it closes on
// background tap or the Done button. No focus-trap because the
// component renders a bottom-sheet on mobile and tapping the backdrop
// dismisses — adding a trap would just fight that gesture.

import type { OutboxRecord } from "../lib/outbox";

interface Props {
  pending: OutboxRecord[];
  dead: OutboxRecord[];
  onClose: () => void;
  onRetryAll: () => Promise<void>;
  onRetryOne: (id: number) => Promise<void>;
  onDiscardOne: (id: number) => Promise<void>;
}

export function SyncStatusDialog({
  pending,
  dead,
  onClose,
  onRetryAll,
  onRetryOne,
  onDiscardOne,
}: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Sync status"
      >
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Sync status</h2>
          <button type="button" onClick={onClose} className="text-sm text-white/60">
            Done
          </button>
        </div>

        {pending.length === 0 && dead.length === 0 && (
          <p className="text-sm text-white/60">Nothing queued. All caught up.</p>
        )}

        {pending.length > 0 && (
          <section className="mb-4">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-white/50">
              Pending ({pending.length})
            </h3>
            <ul className="flex flex-col gap-2">
              {pending.map((r) => (
                <li
                  key={r.id}
                  className="rounded-xl border border-white/10 bg-bg-subtle p-3 text-sm"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <code className="truncate text-xs text-white/80">
                      {r.method} {prettyPath(r.path)}
                    </code>
                    <span className="text-[10px] text-white/40">
                      {timeAgo(r.createdAt)}
                    </span>
                  </div>
                  {r.attempts > 0 && (
                    <div className="mt-1 text-[11px] text-white/50">
                      {r.attempts} attempt{r.attempts === 1 ? "" : "s"} ·{" "}
                      {r.lastError ?? "retrying…"}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {dead.length > 0 && (
          <section>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-xs uppercase tracking-wide text-red-300/80">
                Failed ({dead.length})
              </h3>
              <button
                type="button"
                onClick={() => {
                  void onRetryAll();
                }}
                className="text-xs font-medium text-accent hover:underline"
              >
                Retry all
              </button>
            </div>
            <ul className="flex flex-col gap-2">
              {dead.map((r) => (
                <li
                  key={r.id}
                  className="rounded-xl border border-red-400/20 bg-red-400/5 p-3 text-sm"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <code className="truncate text-xs text-white/80">
                      {r.method} {prettyPath(r.path)}
                    </code>
                    <span className="text-[10px] text-white/40">
                      {timeAgo(r.createdAt)}
                    </span>
                  </div>
                  {r.lastError && (
                    <div className="mt-1 text-[11px] text-red-200/80">{r.lastError}</div>
                  )}
                  <div className="mt-2 flex gap-3 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        void onRetryOne(r.id);
                      }}
                      className="font-medium text-accent hover:underline"
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void onDiscardOne(r.id);
                      }}
                      className="font-medium text-white/50 hover:text-white"
                    >
                      Discard
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

// prettyPath: strip the trailing UUID off `/bottle-feeds/<uuid>` style
// paths to keep the dialog readable. The full path stays in the
// underlying record for replay; this is purely cosmetic.
function prettyPath(path: string): string {
  const UUID_RE = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i;
  return path.replace(UUID_RE, "/…$1");
}

function timeAgo(t: number): string {
  const diffMs = Date.now() - t;
  if (diffMs < 60_000) return "just now";
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
