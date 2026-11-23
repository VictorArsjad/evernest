import { useEffect, useState } from "react";

// DeleteEntryButton — two-tap inline confirm. First tap arms; second tap
// fires. The arm auto-resets after 3s if the user does nothing, so a
// stray finger on Delete on phone-edge never deletes anything.
export function DeleteEntryButton({
  pending,
  onConfirm,
}: {
  pending: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [armed]);
  return (
    <button
      type="button"
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        onConfirm();
      }}
      disabled={pending}
      className={
        "mt-1 rounded-xl border px-4 py-3 text-sm font-medium transition disabled:opacity-50 " +
        (armed
          ? "border-red-400/60 bg-red-400/15 text-red-200"
          : "border-red-400/30 bg-transparent text-red-300 hover:bg-red-400/5")
      }
    >
      {pending
        ? "Deleting…"
        : armed
          ? "Tap again to confirm delete"
          : "Delete entry"}
    </button>
  );
}
