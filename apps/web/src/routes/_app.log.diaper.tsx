// Quick-log form for diapers. Three giant tap targets (wet / soiled / mixed),
// a "When" datetime defaulting to now, an optional notes field, and an
// optional photo picker (added with migration 000011). Same shape as the
// bottle log so the muscle memory carries over. In edit mode
// (`?edit=<uuid>`) the form patches an existing row and exposes a Delete
// button for accidental double-logs.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { LogFormLayout } from "../components/LogFormLayout";
import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "../lib/datetime";
import { MAX_PHOTO_BYTES, compressForUpload } from "../lib/image";
import {
  useCreateDiaper,
  useDeleteDiaper,
  useDiaperPhotoUrl,
  useUpdateDiaper,
} from "../lib/queries";
import { logSearchSchema, useLogForm, usePrefillOnce, useRestampOnFocus } from "../lib/logForm";
import type { DiaperPhotoMime, DiaperType } from "../lib/types";

export const Route = createFileRoute("/_app/log/diaper")({
  validateSearch: logSearchSchema,
  component: LogDiaperPage,
});

// isHeicFile decides whether a picked file is HEIC/HEIF. We check the
// MIME type first (set by every browser whose picker knows about HEIC)
// and fall back to the extension for old iOS / share-sheet sources
// that leave Blob.type empty.
function isHeicFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (mime === "image/heic" || mime === "image/heif" || mime === "image/heic-sequence") {
    return true;
  }
  const name = file.name.toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

// base64ToBlob round-trips the compressed payload back into a Blob so
// we can build a preview URL. Cheaper than holding onto the original
// File / source bitmap, and lets the preview reflect the exact bytes
// we're about to send to the API.
function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function LogDiaperPage() {
  const create = useCreateDiaper();
  const update = useUpdateDiaper();
  const del = useDeleteDiaper();
  const form = useLogForm({
    segment: "diapers",
    search: Route.useSearch(),
    create,
    update,
    del,
  });
  const { isEditMode, editId, existing } = form;

  const [type, setType] = useState<DiaperType>("wet");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [notes, setNotes] = useState("");

  // Photo state. Two distinct concepts here that the BE PATCH contract
  // also distinguishes:
  //   - `pendingPhoto`     — a freshly-picked image, compressed and
  //                          ready to ship as base64 on submit.
  //   - `existingCleared`  — edit-mode flag: the user tapped Remove on
  //                          the previously-stored photo. Submitting
  //                          will send `"photo": ""` to clear it.
  // The preview URL is whichever takes precedence: a freshly picked
  // local object URL, the BE-fetched URL in edit mode, or null.
  const [pendingPhoto, setPendingPhoto] = useState<
    | { base64: string; mime: DiaperPhotoMime; previewUrl: string; bytes: number }
    | null
  >(null);
  const [existingCleared, setExistingCleared] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // In edit mode, fetch the BE-stored photo lazily so the form shows
  // what's currently saved. The hook is a no-op when has_photo is false
  // or the row isn't loaded yet.
  const existingPhotoUrl = useDiaperPhotoUrl(
    isEditMode ? editId ?? null : null,
    isEditMode && !existingCleared && !!existing?.has_photo,
  );

  const previewUrl = pendingPhoto?.previewUrl ?? existingPhotoUrl ?? null;
  // Show the BE thumb only when the user hasn't already replaced or
  // cleared it — keeps the UX honest about what will actually be saved.
  const showExistingBadge =
    isEditMode && !!existing?.has_photo && !pendingPhoto && !existingCleared;

  usePrefillOnce(isEditMode, existing, (row) => {
    setType(row.type);
    setOccurredLocal(isoToLocalDatetimeInput(row.occurred_at));
    setNotes(row.notes ?? "");
  });

  // Revoke the locally-created blob URL when the user replaces it or
  // navigates away. The BE-fetched URL is managed by useDiaperPhotoUrl
  // itself; we don't touch that.
  useEffect(() => {
    return () => {
      if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
    };
  }, [pendingPhoto?.previewUrl]);

  useRestampOnFocus(isEditMode, setOccurredLocal);

  // onPickPhoto runs the freshly-picked file through compressForUpload
  // (resize → JPEG q=0.8) and stages it for submit. We hold an object
  // URL for the local preview rather than displaying the original file
  // — that way we visually confirm the compressed image, not the
  // pre-compression source.
  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input value so picking the same file twice in a row
    // still fires the change event.
    e.target.value = "";
    if (!file) return;
    setPhotoError(null);
    // Bail out on HEIC/HEIF up front. iPhone Photos exports HEIC by
    // default unless the user has flipped Settings → Camera → Formats
    // → Most Compatible; non-Safari browsers (Chrome/Firefox/Edge,
    // *and* Chrome on Android) cannot decode HEIC via
    // createImageBitmap. Without this sniff the compressor throws a
    // generic DOMException that we surface as "could not process
    // photo" — opaque and unactionable. Detection is belt + braces:
    // most pickers populate file.type ("image/heic" or "image/heif"),
    // but some (older iOS, share sheets) leave it empty, so we also
    // glance at the extension. Anything image/* that's clearly NOT
    // HEIC falls through to compressForUpload where the bitmap
    // decoder is the ultimate gatekeeper.
    if (isHeicFile(file)) {
      console.warn(
        "[diaper-photo] rejecting HEIC input",
        { name: file.name, type: file.type, size: file.size },
      );
      setPhotoError(
        "iPhone HEIC photos aren't supported here. Retake the photo, or change Settings → Camera → Formats → Most Compatible and try again.",
      );
      return;
    }
    setPhotoBusy(true);
    try {
      const compressed = await compressForUpload(file);
      if (compressed.bytes > MAX_PHOTO_BYTES) {
        setPhotoError("Photo is still too large after compression.");
        return;
      }
      // Build a preview URL from a Blob recreated out of the base64;
      // re-decoding is cheap and avoids hanging onto the source File.
      const previewBlob = base64ToBlob(compressed.base64, compressed.mime);
      const previewUrl = URL.createObjectURL(previewBlob);
      // If we already had a pending photo, revoke its URL so we don't
      // leak — the effect cleanup also covers it on unmount, but
      // mid-flight replacements need explicit handling.
      if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
      setPendingPhoto({
        base64: compressed.base64,
        mime: compressed.mime,
        previewUrl,
        bytes: compressed.bytes,
      });
      setExistingCleared(false);
    } catch (err) {
      // First and so far only piece of console logging in apps/web/src.
      // We accept the noise on prod because the alternative is
      // "user reports a vague error and we have nothing to go on".
      console.warn(
        "[diaper-photo] compressForUpload failed",
        { name: file.name, type: file.type, size: file.size, err },
      );
      setPhotoError((err as Error)?.message ?? "could not process photo");
    } finally {
      setPhotoBusy(false);
    }
  };

  const onRemovePhoto = () => {
    if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
    setPendingPhoto(null);
    setPhotoError(null);
    // In edit mode, removing means "ALSO clear what's saved on the
    // server" — track that with existingCleared so submit can send
    // `"photo": ""`.
    if (isEditMode && existing?.has_photo) {
      setExistingCleared(true);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onSubmit = () => {
    // PATCH semantics:
    //   - new photo picked     → send base64 + mime (replace)
    //   - existingCleared flag → send "" (clear)
    //   - neither              → omit, leave column alone
    let photoBase64: string | undefined;
    let photoMime: DiaperPhotoMime | undefined;
    if (pendingPhoto) {
      photoBase64 = pendingPhoto.base64;
      photoMime = pendingPhoto.mime;
    } else if (existingCleared) {
      photoBase64 = "";
    }
    form.save({
      create: {
        occurred_at: localToISO(occurredLocal),
        type,
        notes: notes.trim() || undefined,
        photoBase64: pendingPhoto?.base64,
        photoMime: pendingPhoto?.mime,
      },
      update: {
        occurred_at: localToISO(occurredLocal),
        type,
        notes: notes.trim(),
        photoBase64,
        photoMime,
      },
    });
  };

  return (
    <LogFormLayout
      form={form}
      createTitle="Log diaper"
      editTitle="Edit diaper"
      onSubmit={onSubmit}
    >
        <div>
          <span className="text-xs uppercase tracking-wide text-white/50">Type</span>
          <div className="mt-2 grid grid-cols-3 gap-2">
            <TypeButton selected={type === "wet"} onClick={() => setType("wet")}>
              Wet
            </TypeButton>
            <TypeButton selected={type === "soiled"} onClick={() => setType("soiled")}>
              Soiled
            </TypeButton>
            <TypeButton selected={type === "mixed"} onClick={() => setType("mixed")}>
              Mixed
            </TypeButton>
          </div>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          When
          <input
            type="datetime-local"
            required
            value={occurredLocal}
            onChange={(e) => setOccurredLocal(e.target.value)}
            className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Notes (optional)
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={200}
            placeholder="Anything to remember?"
            className="rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

        <div className="flex flex-col gap-2 text-sm">
          <span>Photo (optional)</span>
          {previewUrl ? (
            <div className="relative w-fit">
              <img
                src={previewUrl}
                alt={showExistingBadge ? "Saved diaper photo" : "Selected diaper photo"}
                className="max-h-48 rounded-xl border border-white/10 object-contain"
              />
              <button
                type="button"
                onClick={onRemovePhoto}
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
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={onPickPhoto}
            disabled={photoBusy}
            className="text-xs text-white/70 file:mr-3 file:rounded-lg file:border-0 file:bg-bg-subtle file:px-3 file:py-2 file:text-white/80 hover:file:bg-bg-subtle/80"
          />
          {photoBusy && <p className="text-xs text-white/50">Compressing…</p>}
          {photoError && <p className="text-xs text-red-400">{photoError}</p>}
        </div>
    </LogFormLayout>
  );
}

function TypeButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-xl border p-4 text-center text-base font-medium transition " +
        (selected
          ? "border-accent bg-accent/15 text-accent"
          : "border-white/10 bg-bg-subtle text-white/70 hover:border-white/20")
      }
    >
      {children}
    </button>
  );
}
