// Quick-log form for diapers. Three giant tap targets (wet / soiled / mixed),
// a "When" datetime defaulting to now, an optional notes field, and an
// optional photo picker (added with migration 000011). Same shape as the
// bottle log so the muscle memory carries over. In edit mode
// (`?edit=<uuid>`) the form patches an existing row and exposes a Delete
// button for accidental double-logs.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { MAX_PHOTO_BYTES, compressForUpload } from "../lib/image";
import {
  useBabies,
  useCreateDiaper,
  useDeleteDiaper,
  useDiaperPhotoUrl,
  useHouseholds,
  useUpdateDiaper,
} from "../lib/queries";
import { useActiveBaby } from "../lib/useActiveBaby";
import type { Diaper, DiaperPhotoMime, DiaperType } from "../lib/types";
import { DeleteEntryButton } from "./_app.log.bottle";

const search = z.object({
  babyId: z.string().uuid().optional(),
  edit: z.string().uuid().optional(),
});

export const Route = createFileRoute("/_app/log/diaper")({
  validateSearch: search,
  component: LogDiaperPage,
});

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

function LogDiaperPage() {
  const nav = useNavigate();
  const { babyId: babyIdFromSearch, edit: editId } = Route.useSearch();
  const households = useHouseholds();
  const householdId = households.data?.[0]?.id ?? null;
  const babies = useBabies(householdId);
  const { baby: activeBaby } = useActiveBaby(householdId, babies.data);
  const babyId = babyIdFromSearch ?? activeBaby?.id ?? null;

  const isEditMode = !!editId;
  const qc = useQueryClient();
  const existing: Diaper | null = useMemo(() => {
    if (!editId || !babyId) return null;
    const lists = qc.getQueriesData<Diaper[] | undefined>({
      queryKey: ["babies", babyId, "diapers"],
    }) as Array<[unknown, Diaper[] | undefined]>;
    return (
      lists.flatMap(([, list]) => list ?? []).find((r) => r.id === editId) ?? null
    );
  }, [qc, editId, babyId]);

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

  const create = useCreateDiaper();
  const update = useUpdateDiaper();
  const del = useDeleteDiaper();

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

  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!isEditMode || prefilledRef.current || !existing) return;
    setType(existing.type);
    setOccurredLocal(isoToLocalDatetimeInput(existing.occurred_at));
    setNotes(existing.notes ?? "");
    prefilledRef.current = true;
  }, [isEditMode, existing]);

  // Revoke the locally-created blob URL when the user replaces it or
  // navigates away. The BE-fetched URL is managed by useDiaperPhotoUrl
  // itself; we don't touch that.
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

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!babyId) return;
    if (isEditMode && editId) {
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
      update.mutate(
        {
          id: editId,
          babyId,
          occurred_at: localToISO(occurredLocal),
          type,
          notes: notes.trim(),
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
        type,
        notes: notes.trim() || undefined,
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
          {isEditMode ? "Edit diaper" : "Log diaper"}
        </h1>
        <button onClick={() => nav({ to: "/" })} className="text-sm text-white/60">
          Cancel
        </button>
      </header>

      <form onSubmit={onSubmit} className="card flex flex-col gap-5 p-5">
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

        <button type="submit" className="btn-primary text-lg" disabled={pending}>
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
