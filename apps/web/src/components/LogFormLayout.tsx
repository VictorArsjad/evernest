import type { ReactNode } from "react";

import type { LogFormChrome } from "../lib/logForm";
import { submitOnEnter } from "../lib/submitOnEnter";
import { DeleteEntryButton } from "./DeleteEntryButton";

// Either the default Save button (optionally disabled further), or custom
// actions that replace it — never both, so `submitDisabled` can't be ignored.
type SubmitProps =
  | {
      // Added to the in-flight check on the default Save button.
      submitDisabled?: boolean;
      actions?: never;
    }
  | {
      // Replaces the default Save button (nursing/sleep add "Start now").
      actions: ReactNode;
      submitDisabled?: never;
    };

// Page chrome shared by every /log/* form: title + Cancel, the card form with
// Enter-to-submit, the error line, the submit button, and (edit mode) Delete.
// The route supplies only its fields as children.
export function LogFormLayout({
  form,
  createTitle,
  editTitle,
  onSubmit,
  formError,
  children,
  ...submit
}: {
  form: LogFormChrome;
  createTitle: string;
  editTitle: string;
  onSubmit: () => void;
  // A client-side validation message; shown in place of the mutation error.
  formError?: string | null;
  children: ReactNode;
} & SubmitProps) {
  if (!form.babyId) {
    return <p className="p-6 text-white/60">No baby selected.</p>;
  }
  return (
    <main className="flex flex-1 flex-col gap-4 p-5">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{form.isEditMode ? editTitle : createTitle}</h1>
        <button onClick={form.exit} className="text-sm text-white/60">
          Cancel
        </button>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        onKeyDown={submitOnEnter}
        className="card flex flex-col gap-5 p-5"
      >
        {children}

        {(form.hadError || !!formError) && (
          <p className="text-sm text-red-400">{formError ?? form.errorMsg ?? "could not save"}</p>
        )}

        {submit.actions ?? (
          <button
            type="submit"
            className="btn-primary text-lg"
            disabled={form.pending || (submit.submitDisabled ?? false)}
          >
            {form.pending ? "Saving…" : form.isEditMode ? "Save changes" : "Save"}
          </button>
        )}

        {form.isEditMode && form.editId && (
          <DeleteEntryButton pending={form.deleting} onConfirm={form.remove} />
        )}
      </form>
    </main>
  );
}
