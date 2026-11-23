// Quick-log form for free-form notes. A required multiline body ("What
// happened?"), a "When" datetime defaulting to now, and an optional photo
// picker (same pipeline as diaper photos). Same shape as the diaper log so the
// muscle memory carries over. In edit mode (`?edit=<uuid>`) the form patches an
// existing row and exposes a Delete button.
//
// Note: `submitOnEnter` deliberately skips textareas, so Enter inside the body
// inserts a newline; the Save button (or Enter from the When field) submits.
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { LogFormLayout } from "../components/LogFormLayout";
import { PhotoField } from "../components/PhotoField";
import { isoToLocalDatetimeInput, localToISO, nowLocalDatetimeInput } from "../lib/datetime";
import {
  useCreateNote,
  useDeleteNote,
  useNotePhotoUrl,
  useUpdateNote,
} from "../lib/queries";
import { logSearchSchema, useLogForm, usePrefillOnce, useRestampOnFocus } from "../lib/logForm";
import { usePhotoField } from "../lib/usePhotoField";

export const Route = createFileRoute("/_app/log/note")({
  validateSearch: logSearchSchema,
  component: LogNotePage,
});

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

  const photo = usePhotoField({
    label: "note",
    rowId: editId ?? null,
    isEditMode,
    existingHasPhoto: existing?.has_photo,
    usePhotoUrl: useNotePhotoUrl,
    resetInputOnPick: true,
  });

  usePrefillOnce(isEditMode, existing, (row) => {
    setBody(row.body);
    setOccurredLocal(isoToLocalDatetimeInput(row.occurred_at));
  });

  useRestampOnFocus(isEditMode, setOccurredLocal);

  const onSubmit = () => {
    const trimmedBody = body.trim();
    if (!trimmedBody) return;
    form.save({
      create: {
        occurred_at: localToISO(occurredLocal),
        body: trimmedBody,
        ...photo.createFields(),
      },
      update: {
        occurred_at: localToISO(occurredLocal),
        body: trimmedBody,
        // PATCH: new photo replaces, Remove clears (null), otherwise omitted.
        ...photo.updateFields(),
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

        <PhotoField photo={photo} />
    </LogFormLayout>
  );
}
