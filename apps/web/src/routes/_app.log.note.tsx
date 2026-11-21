// Quick-log form for free-form notes. A required multiline body ("What
// happened?"), a "When" datetime defaulting to now, and an optional photo
// picker (same pipeline as diaper photos). Same shape as the diaper log so the
// muscle memory carries over. In edit mode (`?edit=<uuid>`) the form patches an
// existing row and exposes a Delete button.
//
// Note: `submitOnEnter` deliberately skips textareas, so Enter inside the body
// inserts a newline; the Save button (or Enter from the When field) submits.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { LogFormLayout } from "../components/LogFormLayout";
import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "../lib/datetime";
import { MAX_PHOTO_BYTES, compressForUpload } from "../lib/image";
import {
  useCreateNote,
  useDeleteNote,
  useNotePhotoUrl,
  useUpdateNote,
} from "../lib/queries";
import { logSearchSchema, useLogForm, usePrefillOnce, useRestampOnFocus } from "../lib/logForm";
import type { DiaperPhotoMime } from "../lib/types";

export const Route = createFileRoute("/_app/log/note")({
  validateSearch: logSearchSchema,
  component: LogNotePage,
});

// isHeicFile decides whether a picked file is HEIC/HEIF. We check the MIME
// type first (set by every browser whose picker knows about HEIC) and fall
// back to the extension for old iOS / share-sheet sources that leave
// Blob.type empty.
function isHeicFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (mime === "image/heic" || mime === "image/heif" || mime === "image/heic-sequence") {
    return true;
  }
  const name = file.name.toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

// base64ToBlob round-trips the compressed payload back into a Blob so we can
// build a preview URL.
function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function LogNotePage() {
  const create = useCreateNote();
  const update = useUpdateNote();
  const del = useDeleteNote();
  const form = useLogForm({
    segment: "notes",
    search: Route.useSearch(),
    create,
    update,
    del,
  });
  const { isEditMode, editId, existing } = form;

  const [body, setBody] = useState("");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);

  // Photo state. `pendingPhoto` is a freshly-picked image ready to ship as
  // base64 on submit; `existingCleared` is the edit-mode flag for "the user
  // tapped Remove on the previously-stored photo".
  const [pendingPhoto, setPendingPhoto] = useState<
    | { base64: string; mime: DiaperPhotoMime; previewUrl: string; bytes: number }
    | null
  >(null);
  const [existingCleared, setExistingCleared] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const existingPhotoUrl = useNotePhotoUrl(
    isEditMode ? editId ?? null : null,
    isEditMode && !existingCleared && !!existing?.has_photo,
  );

  const previewUrl = pendingPhoto?.previewUrl ?? existingPhotoUrl ?? null;
  const showExistingBadge =
    isEditMode && !!existing?.has_photo && !pendingPhoto && !existingCleared;

  usePrefillOnce(isEditMode, existing, (row) => {
    setBody(row.body);
    setOccurredLocal(isoToLocalDatetimeInput(row.occurred_at));
  });

  useEffect(() => {
    return () => {
      if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
    };
  }, [pendingPhoto?.previewUrl]);

  useRestampOnFocus(isEditMode, setOccurredLocal);

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPhotoError(null);
    if (isHeicFile(file)) {
      console.warn(
        "[note-photo] rejecting HEIC input",
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
      const previewBlob = base64ToBlob(compressed.base64, compressed.mime);
      const previewUrl = URL.createObjectURL(previewBlob);
      if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
      setPendingPhoto({
        base64: compressed.base64,
        mime: compressed.mime,
        previewUrl,
        bytes: compressed.bytes,
      });
      setExistingCleared(false);
    } catch (err) {
      console.warn(
        "[note-photo] compressForUpload failed",
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
    if (isEditMode && existing?.has_photo) {
      setExistingCleared(true);
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onSubmit = () => {
    const trimmedBody = body.trim();
    if (!trimmedBody) return;
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
        body: trimmedBody,
        photoBase64: pendingPhoto?.base64,
        photoMime: pendingPhoto?.mime,
      },
      update: {
        occurred_at: localToISO(occurredLocal),
        body: trimmedBody,
        photoBase64,
        photoMime,
      },
    });
  };

  return (
    <LogFormLayout
      form={form}
      createTitle="Add note"
      editTitle="Edit note"
      onSubmit={onSubmit}
      submitDisabled={!body.trim()}
    >
        <label className="flex flex-col gap-1 text-sm">
          Notes
          <textarea
            required
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={1000}
            rows={4}
            placeholder="What happened? (e.g. had a small rash on hand)"
            className="resize-y rounded-xl bg-bg-subtle px-4 py-3 text-base outline-none focus:ring-2 focus:ring-accent"
          />
        </label>

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

        <div className="flex flex-col gap-2 text-sm">
          <span>Photo (optional)</span>
          {previewUrl ? (
            <div className="relative w-fit">
              <img
                src={previewUrl}
                alt={showExistingBadge ? "Saved note photo" : "Selected note photo"}
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
