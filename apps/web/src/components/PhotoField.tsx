import type { PhotoFieldState } from "../lib/usePhotoField";

// The "Photo (optional)" block of the diaper / note / solids forms. All state
// lives in usePhotoField; this only renders it.
export function PhotoField({ photo }: { photo: PhotoFieldState }) {
  const { label, previewUrl, showExistingBadge, existingCleared } = photo;
  return (
    <div className="flex flex-col gap-2 text-sm">
      <span>Photo (optional)</span>
      {previewUrl ? (
        <div className="relative w-fit">
          <img
            src={previewUrl}
            alt={showExistingBadge ? `Saved ${label} photo` : `Selected ${label} photo`}
            className="max-h-48 rounded-xl border border-white/10 object-contain"
          />
          <button
            type="button"
            onClick={photo.onRemove}
            aria-label="Remove photo"
            className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-1 text-xs text-white/90 hover:bg-black/90"
          >
            Remove
          </button>
        </div>
      ) : existingCleared ? (
        <p className="text-xs text-white/50">
          Saved photo will be removed. Pick a new one to replace it instead.
        </p>
      ) : null}
      <input
        ref={photo.fileInputRef}
        type="file"
        accept="image/*"
        onChange={photo.onPick}
        disabled={photo.busy}
        className="text-xs text-white/70 file:mr-3 file:rounded-lg file:border-0 file:bg-bg-subtle file:px-3 file:py-2 file:text-white/80 hover:file:bg-bg-subtle/80"
      />
      {photo.busy && <p className="text-xs text-white/50">Compressing…</p>}
      {photo.error && <p className="text-xs text-red-400">{photo.error}</p>}
    </div>
  );
}
