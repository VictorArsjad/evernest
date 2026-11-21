// Quick-log form for solid meals. Foods as chips (enter/comma to add),
// optional meal-level reaction, optional amount (baby unit_weight ↔ grams),
// optional notes + diaper-style photo. Edit mode via `?edit=<uuid>`.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { LogFormLayout } from "../components/LogFormLayout";
import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "../lib/datetime";
import { MAX_PHOTO_BYTES, compressForUpload } from "../lib/image";
import {
  useCreateSolidMeal,
  useDeleteSolidMeal,
  useSolidMealPhotoUrl,
  useSolidMeals,
  useUpdateSolidMeal,
} from "../lib/queries";
import { logSearchSchema, useLogForm } from "../lib/logForm";
import type { DiaperPhotoMime, SolidMealReaction } from "../lib/types";
import { displayWeightToG, gToDisplayWeight, weightUnitLabel } from "../lib/units";
import { usePreferences } from "../lib/usePreferences";

export const Route = createFileRoute("/_app/log/solids")({
  validateSearch: logSearchSchema,
  component: LogSolidsPage,
});

const REACTIONS: { value: SolidMealReaction; label: string }[] = [
  { value: "liked", label: "Liked" },
  { value: "neutral", label: "OK" },
  { value: "refused", label: "Refused" },
  { value: "reaction", label: "Reaction" },
];

function isHeicFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (mime === "image/heic" || mime === "image/heif" || mime === "image/heic-sequence") {
    return true;
  }
  const name = file.name.toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function LogSolidsPage() {
  const create = useCreateSolidMeal();
  const update = useUpdateSolidMeal();
  const del = useDeleteSolidMeal();
  // Solids reads create AND update for pending/error state, not just the
  // mutation matching the mode.
  const form = useLogForm({
    segment: "solid-meals",
    search: Route.useSearch(),
    create,
    update,
    del,
    errorScope: "either",
  });
  const { babyId, isEditMode, editId, existing } = form;
  const { prefs } = usePreferences(babyId);

  // Recent meals for food-name suggestions (last ~14 days).
  const suggestFrom = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    return d.toISOString();
  }, []);
  const recentMeals = useSolidMeals(babyId, suggestFrom, undefined, { limit: 50 });
  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const meal of recentMeals.data ?? []) {
      for (const f of meal.foods) {
        const key = f.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
        if (out.length >= 12) return out;
      }
    }
    return out;
  }, [recentMeals.data]);

  const [foods, setFoods] = useState<string[]>([]);
  const [foodDraft, setFoodDraft] = useState("");
  const [reaction, setReaction] = useState<SolidMealReaction | null>(null);
  const [amountDisplay, setAmountDisplay] = useState("");
  const [notes, setNotes] = useState("");
  const [occurredLocal, setOccurredLocal] = useState(nowLocalDatetimeInput);
  const [pendingPhoto, setPendingPhoto] = useState<
    | { base64: string; mime: DiaperPhotoMime; previewUrl: string; bytes: number }
    | null
  >(null);
  const [existingCleared, setExistingCleared] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const existingPhotoUrl = useSolidMealPhotoUrl(
    isEditMode ? editId ?? null : null,
    isEditMode && !!existing?.has_photo && !existingCleared && !pendingPhoto,
  );

  useEffect(() => {
    if (!existing) return;
    setFoods(existing.foods);
    setReaction(existing.reaction ?? null);
    setNotes(existing.notes ?? "");
    setOccurredLocal(isoToLocalDatetimeInput(existing.occurred_at));
    if (existing.amount_g != null) {
      setAmountDisplay(String(gToDisplayWeight(Number(existing.amount_g), prefs.unit_weight)));
    } else {
      setAmountDisplay("");
    }
    setExistingCleared(false);
  }, [existing, prefs.unit_weight]);

  useEffect(() => {
    return () => {
      if (pendingPhoto?.previewUrl) URL.revokeObjectURL(pendingPhoto.previewUrl);
    };
  }, [pendingPhoto?.previewUrl]);

  const addFood = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    setFoods((prev) => [...prev, trimmed]);
    setFoodDraft("");
  };

  const onFoodKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addFood(foodDraft.replace(/,$/, ""));
    } else if (e.key === "Backspace" && foodDraft === "" && foods.length > 0) {
      setFoods((prev) => prev.slice(0, -1));
    }
  };

  const onPickPhoto = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoError(null);
    if (isHeicFile(file)) {
      // compressForUpload handles HEIC when the browser can decode it;
      // surface a clearer error if it can't.
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
      console.warn("[solids-photo] compressForUpload failed", {
        name: file.name,
        type: file.type,
        size: file.size,
        err,
      });
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

  const parseAmountG = (): number | null | undefined => {
    const trimmed = amountDisplay.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
      setFormError("Amount must be a non-negative number");
      return undefined;
    }
    return displayWeightToG(n, prefs.unit_weight);
  };

  const onSubmit = () => {
    setFormError(null);
    if (foods.length === 0) {
      setFormError("Add at least one food");
      return;
    }
    const amountG = parseAmountG();
    if (amountG === undefined) return;

    let photoBase64: string | undefined;
    let photoMime: DiaperPhotoMime | undefined;
    if (pendingPhoto) {
      photoBase64 = pendingPhoto.base64;
      photoMime = pendingPhoto.mime;
    } else if (existingCleared) {
      photoBase64 = "";
    }
    const hadAmount = existing?.amount_g != null;
    form.save({
      create: {
        occurred_at: localToISO(occurredLocal),
        foods,
        reaction: reaction ?? undefined,
        amount_g: amountG,
        notes: notes.trim() || undefined,
        photoBase64: pendingPhoto?.base64,
        photoMime: pendingPhoto?.mime,
      },
      update: {
        occurred_at: localToISO(occurredLocal),
        foods,
        reaction: reaction ?? "",
        amount_g: amountG,
        clear_amount_g: amountG === null && hadAmount,
        notes: notes.trim(),
        photoBase64,
        photoMime,
      },
    });
  };

  const previewUrl =
    pendingPhoto?.previewUrl ??
    (existingPhotoUrl && !existingCleared ? existingPhotoUrl : null);
  const showExistingBadge = !!existingPhotoUrl && !pendingPhoto && !existingCleared;

  return (
    <LogFormLayout
      form={form}
      createTitle="Log solids"
      editTitle="Edit solids"
      onSubmit={onSubmit}
      formError={formError}
    >
        <div className="flex flex-col gap-2 text-sm">
          <span className="text-xs uppercase tracking-wide text-white/50">Foods</span>
          <div className="flex flex-wrap gap-2 rounded-xl bg-bg-subtle px-3 py-2">
            {foods.map((f, i) => (
              <button
                key={`${f}-${i}`}
                type="button"
                onClick={() => setFoods((prev) => prev.filter((_, j) => j !== i))}
                className="rounded-lg bg-accent/20 px-2 py-1 text-sm text-accent"
                aria-label={`Remove ${f}`}
              >
                {f} ×
              </button>
            ))}
            <input
              type="text"
              value={foodDraft}
              onChange={(e) => setFoodDraft(e.target.value)}
              onKeyDown={onFoodKeyDown}
              onBlur={() => {
                if (foodDraft.trim()) addFood(foodDraft);
              }}
              placeholder={foods.length === 0 ? "avocado, banana…" : "Add more"}
              className="min-w-[8rem] flex-1 bg-transparent py-1 text-base outline-none"
            />
          </div>
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {suggestions
                .filter((s) => !foods.some((f) => f.toLowerCase() === s.toLowerCase()))
                .slice(0, 8)
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => addFood(s)}
                    className="rounded-lg border border-white/10 px-2 py-1 text-xs text-white/60 hover:border-white/25"
                  >
                    + {s}
                  </button>
                ))}
            </div>
          )}
        </div>

        <div>
          <span className="text-xs uppercase tracking-wide text-white/50">
            Reaction (optional)
          </span>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {REACTIONS.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() =>
                  setReaction((cur) => (cur === r.value ? null : r.value))
                }
                className={
                  "rounded-xl border p-3 text-center text-sm font-medium transition " +
                  (reaction === r.value
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-white/10 bg-bg-subtle text-white/70 hover:border-white/20")
                }
              >
                {r.label}
              </button>
            ))}
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
          Amount (optional, {weightUnitLabel(prefs.unit_weight)})
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={amountDisplay}
            onChange={(e) => setAmountDisplay(e.target.value)}
            placeholder="Leave blank if unknown"
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
                alt={showExistingBadge ? "Saved solids photo" : "Selected solids photo"}
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
