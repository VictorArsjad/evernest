// State machine behind the optional photo picker on diaper / note / solids.
// Two distinct concepts, mirroring the BE PATCH contract:
//   - `pendingPhoto`    — a freshly-picked image, compressed and ready to ship
//                         as base64 on submit.
//   - `existingCleared` — edit-mode flag: the user tapped Remove on the
//                         previously-stored photo; submit sends `"photo": ""`.
// The per-route differences that predate this module are explicit options
// (see PhotoFieldOptions) rather than silently unified.
import { useCallback, useEffect, useRef, useState } from "react";

import { MAX_PHOTO_BYTES, compressForUpload } from "./image";
import { base64ToBlob, isHeicFile } from "./photo";
import type { DiaperPhotoMime } from "./types";

interface PendingPhoto {
  base64: string;
  mime: DiaperPhotoMime;
  previewUrl: string;
  bytes: number;
}

export interface PhotoFieldOptions {
  // Alt text ("Saved <label> photo") and console tag ("[<label>-photo]").
  label: "diaper" | "note" | "solids";
  // The edit row's id, or null in create mode.
  rowId: string | null;
  isEditMode: boolean;
  existingHasPhoto: boolean | undefined;
  // The kind's `use<Kind>PhotoUrl` hook.
  usePhotoUrl: (id: string | null, hasPhoto: boolean | undefined) => string | null;
  // diaper/note reject HEIC/HEIF up front with an actionable message; solids
  // has never pre-checked and surfaces the raw decoder error instead.
  heicPrecheck: boolean;
  // diaper/note clear the input value on pick so re-picking the same file
  // fires change again; solids never did.
  resetInputOnPick: boolean;
}

const HEIC_MESSAGE =
  "iPhone HEIC photos aren't supported here. Retake the photo, or change Settings → Camera → Formats → Most Compatible and try again.";

export function usePhotoField(o: PhotoFieldOptions) {
  const [pendingPhoto, setPendingPhoto] = useState<PendingPhoto | null>(null);
  const [existingCleared, setExistingCleared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // In edit mode, fetch the BE-stored photo lazily so the form shows what's
  // currently saved. The hook is a no-op when has_photo is false or the row
  // isn't loaded yet.
  const existingPhotoUrl = o.usePhotoUrl(
    o.isEditMode ? o.rowId : null,
    o.isEditMode && !!o.existingHasPhoto && !existingCleared && !pendingPhoto,
  );

  // After Remove (or while a replacement is pending) the saved image is hidden.
  const previewUrl =
    pendingPhoto?.previewUrl ?? (existingPhotoUrl && !existingCleared ? existingPhotoUrl : null);
  // Show the BE thumb only when the user hasn't already replaced or cleared it
  // — keeps the UX honest about what will actually be saved.
  const showExistingBadge = !!existingPhotoUrl && !pendingPhoto && !existingCleared;

  // Revoke the locally-created blob URL when the user replaces it or navigates
  // away. The BE-fetched URL is managed by the photo-url hook itself.
  useEffect(() => {
    return () => {
      if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
    };
  }, [pendingPhoto?.previewUrl]);

  // Runs the picked file through compressForUpload (resize → JPEG q=0.8) and
  // stages it for submit. The preview URL is built from the compressed bytes,
  // not the source file, so the user sees what will actually be sent.
  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input value so picking the same file twice in a row still
    // fires the change event.
    if (o.resetInputOnPick) e.target.value = "";
    if (!file) return;
    setError(null);
    // Browsers other than Safari can't decode HEIC via createImageBitmap, and
    // the compressor's generic DOMException would surface as an opaque "could
    // not process photo". Detection is MIME first, extension second.
    if (o.heicPrecheck && isHeicFile(file)) {
      console.warn(`[${o.label}-photo] rejecting HEIC input`, {
        name: file.name,
        type: file.type,
        size: file.size,
      });
      setError(HEIC_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      const compressed = await compressForUpload(file);
      if (compressed.bytes > MAX_PHOTO_BYTES) {
        setError("Photo is still too large after compression.");
        return;
      }
      const previewBlob = base64ToBlob(compressed.base64, compressed.mime);
      const nextPreviewUrl = URL.createObjectURL(previewBlob);
      // Mid-flight replacements need an explicit revoke; the effect cleanup
      // only covers unmount.
      if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
      setPendingPhoto({
        base64: compressed.base64,
        mime: compressed.mime,
        previewUrl: nextPreviewUrl,
        bytes: compressed.bytes,
      });
      setExistingCleared(false);
    } catch (err) {
      // Accepted console noise on prod: the alternative is "user reports a
      // vague error and we have nothing to go on".
      console.warn(`[${o.label}-photo] compressForUpload failed`, {
        name: file.name,
        type: file.type,
        size: file.size,
        err,
      });
      setError((err as Error)?.message ?? "could not process photo");
    } finally {
      setBusy(false);
    }
  };

  const onRemove = () => {
    if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
    setPendingPhoto(null);
    setError(null);
    // In edit mode, removing means "ALSO clear what's saved on the server".
    if (o.isEditMode && o.existingHasPhoto) setExistingCleared(true);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const resetCleared = useCallback(() => setExistingCleared(false), []);

  return {
    label: o.label,
    busy,
    error,
    previewUrl,
    showExistingBadge,
    existingCleared,
    fileInputRef,
    onPick,
    onRemove,
    // Solids re-applies its prefill whenever the cached row changes, which also
    // un-marks a pending removal.
    resetCleared,
    // Photo fields for the create body: only a freshly-picked image.
    createFields: () => ({
      photoBase64: pendingPhoto?.base64,
      photoMime: pendingPhoto?.mime,
    }),
    // Photo fields for the PATCH body:
    //   new photo picked     → base64 + mime (replace)
    //   existingCleared flag → "" (clear)
    //   neither              → omitted, leave the column alone
    updateFields: (): { photoBase64?: string; photoMime?: DiaperPhotoMime } => {
      if (pendingPhoto) return { photoBase64: pendingPhoto.base64, photoMime: pendingPhoto.mime };
      if (existingCleared) return { photoBase64: "" };
      return {};
    },
  };
}

export type PhotoFieldState = ReturnType<typeof usePhotoField>;
