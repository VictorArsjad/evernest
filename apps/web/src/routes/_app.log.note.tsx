// Quick-log form for free-form notes. A required multiline body ("What
// happened?"), a "When" datetime defaulting to now, and an optional photo
// picker (same pipeline as diaper photos). Same shape as the diaper log so the
// muscle memory carries over. In edit mode (`?edit=<uuid>`) the form patches an
// existing row and exposes a Delete button.
//
// Note: `submitOnEnter` deliberately skips textareas, so Enter inside the body
// inserts a newline; the Save button (or Enter from the When field) submits.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { MAX_PHOTO_BYTES, compressForUpload } from "../lib/image";
import {
  useBabies,
  useCreateNote,
  useDeleteNote,
  useHouseholds,
  useNotePhotoUrl,
  useUpdateNote,
} from "../lib/queries";
import { submitOnEnter } from "../lib/submitOnEnter";
import { useActiveBaby } from "../lib/useActiveBaby";
import type { DiaperPhotoMime, Note } from "../lib/types";
import { useEscapeKey } from "../lib/useEscapeKey";
import { DeleteEntryButton } from "./_app.log.bottle";

const search = z.object({
  babyId: z.string().uuid().optional(),
  edit: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_app/log/note")({
  validateSearch: search,
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

function nowLocalDatetimeInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isoToLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localToISO(local: string): string {
  return new Date(local).toISOString();
}

function LogNotePage() {
  const nav = useNavigate();
  useEscapeKey(() => nav({ to: "/" }));
  const { babyId: babyIdFromSearch, edit: editId } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const { baby: activeBaby } = useActiveBaby(householdId, babies.data);
  const babyId = babyIdFromSearch ?? activeBaby?.id ?? null;

  const isEditMode = !!editId;
  const qc = useQueryClient();
  const existing: Note | null = useMemo(() => {
    if (!editId || !babyId) return null;
    const lists = qc.getQueriesData<Note[] | undefined>({
      queryKey: ["babies", babyId, "notes"],
    }) as Array<[unknown, Note[] | undefined]>;
    return (
      lists.flatMap(([, list]) => list ?? []).find((r) => r.id === editId) ?? null
    );
  }, [qc, editId, babyId]);

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

  const create = useCreateNote();
  const update = useUpdateNote();
  const del = useDeleteNote();

  const existingPhotoUrl = useNotePhotoUrl(
    isEditMode ? editId ?? null : null,
    isEditMode && !existingCleared && !!existing?.has_photo,
  );

  const previewUrl = pendingPhoto?.previewUrl ?? existingPhotoUrl ?? null;
  const showExistingBadge =
    isEditMode && !!existing?.has_photo && !pendingPhoto && !existingCleared;

  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!isEditMode || prefilledRef.current || !existing) return;
    setBody(existing.body);
    setOccurredLocal(isoToLocalDatetimeInput(existing.occurred_at));
    prefilledRef.current = true;
  }, [isEditMode, existing]);

  useEffect(() => {
    return () => {
      if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
    };
  }, [pendingPhoto?.previewUrl]);

  useEffect(() => {
    if (isEditMode) return;
    const onFocus = () => setOccurredLocal(nowLocalDatetimeInput());
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [isEditMode]);

  const pending = isEditMode ? update.isPending : create.isPending;
  const errorMsg = isEditMode ? update.error?.message : create.error?.message;
  const hadError = isEditMode ? update.isError : create.isError;

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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId) return;
    const trimmedBody = body.trim();
    if (!trimmedBody) return;
    if (isEditMode && editId) {
      let photoBase64: string | undefined;
      let photoMime: DiaperPhotoMime | undefined;
      if (pendingPhoto) {
        photoBase64 = pendingPhoto.base64;
        photoMime = pendingPhoto.mime;
      } else if (existingCleared) {
        photoBase64 = "";
      }
      update.mutate(
        {
          id: editId,
          babyId,
          occurred_at: localToISO(occurredLocal),
          body: trimmedBody,
          photoBase64,
          photoMime,
        },
        { onSuccess: () => nav({ to: "/" }) },
      );
      return;
    }
    create.mutate(
      {
        babyId,
        occurred_at: localToISO(occurredLocal),
        body: trimmedBody,
        photoBase64: pendingPhoto?.base64,
        photoMime: pendingPhoto?.mime,
      },
      { onSuccess: () => nav({ to: "/" }) },
    );
  };

  if (!babyId) {
    return <p className="p-6 text-white/60">No baby selected.</p>;
  }

  return (
    <main className="flex flex-1 flex-col gap-4 p-5">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">
          {isEditMode ? "Edit note" : "Add note"}
        </h1>
        <button onClick={() => nav({ to: "/" })} className="text-sm text-white/60">
          Cancel
        </button>
      </header>

      <form
        onSubmit={onSubmit}
        onKeyDown={submitOnEnter}
        className="card flex flex-col gap-5 p-5"
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
            capture="environment"
            onChange={onPickPhoto}
            disabled={photoBusy}
            className="text-xs text-white/70 file:mr-3 file:rounded-lg file:border-0 file:bg-bg-subtle file:px-3 file:py-2 file:text-white/80 hover:file:bg-bg-subtle/80"
          />
          {photoBusy && <p className="text-xs text-white/50">Compressing…</p>}
          {photoError && <p className="text-xs text-red-400">{photoError}</p>}
        </div>

        {hadError && (
          <p className="text-sm text-red-400">{errorMsg ?? "could not save"}</p>
        )}

        <button
          type="submit"
          className="btn-primary text-lg"
          disabled={pending || !body.trim()}
        >
          {pending ? "Saving…" : isEditMode ? "Save changes" : "Save"}
        </button>

        {isEditMode && editId && (
          <DeleteEntryButton
            pending={del.isPending}
            onConfirm={() =>
              del.mutate(
                { id: editId, babyId },
                { onSuccess: () => nav({ to: "/" }) },
              )
            }
          />
        )}
      </form>
    </main>
  );
}
