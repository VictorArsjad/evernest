// Quick-log form for diapers. Three giant tap targets (wet / soiled / mixed),
// a "When" datetime defaulting to now, an optional notes field, and an
// optional photo picker (added with migration 000011). Same shape as the
// bottle log so the muscle memory carries over. In edit mode
// (`?edit=<uuid>`) the form patches an existing row and exposes a Delete
// button for accidental double-logs.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { LogFormLayout } from "../components/LogFormLayout";
import { PhotoField } from "../components/PhotoField";
import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "../lib/datetime";
import {
  useCreateDiaper,
  useDeleteDiaper,
  useDiaperPhotoUrl,
  useUpdateDiaper,
} from "../lib/queries";
import { logSearchSchema, useLogForm, usePrefillOnce, useRestampOnFocus } from "../lib/logForm";
import type { DiaperType } from "../lib/types";
import { usePhotoField } from "../lib/usePhotoField";

export const Route = createFileRoute("/_app/log/diaper")({
  validateSearch: logSearchSchema,
  component: LogDiaperPage,
});

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

  const photo = usePhotoField({
    label: "diaper",
    rowId: editId ?? null,
    isEditMode,
    existingHasPhoto: existing?.has_photo,
    usePhotoUrl: useDiaperPhotoUrl,
    resetInputOnPick: true,
  });

  usePrefillOnce(isEditMode, existing, (row) => {
    setType(row.type);
    setOccurredLocal(isoToLocalDatetimeInput(row.occurred_at));
    setNotes(row.notes ?? "");
  });

  useRestampOnFocus(isEditMode, setOccurredLocal);

  const onSubmit = () => {
    form.save({
      create: {
        occurred_at: localToISO(occurredLocal),
        type,
        notes: notes.trim() || undefined,
        ...photo.createFields(),
      },
      update: {
        occurred_at: localToISO(occurredLocal),
        type,
        notes: notes.trim(),
        // PATCH: new photo replaces, Remove clears (null), otherwise omitted.
        ...photo.updateFields(),
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

        <PhotoField photo={photo} />
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
