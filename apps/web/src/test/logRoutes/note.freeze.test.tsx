// @vitest-environment jsdom
// Characterization ("freeze") tests for /log/note. Locks in CURRENT behavior
// ahead of the shared log-form shell extraction. Clock and TZ: see logRouteHarness.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EXISTING_ID, ROW_ID } from "../queryHarness";
import {
  BABY_ID,
  installLogRouteHarness,
  mutations,
  renderLogRoute,
  STUB_JPEG_BASE64,
} from "../logRouteHarness";
import {
  commonLifecycle,
  DEFAULT_PHOTO_BYTES,
  HEIC_MESSAGE,
  heicFile,
  jpegFile,
  pickFile,
} from "./commonFreeze";

installLogRouteHarness();

const CREATE_URL = `/log/note?babyId=${BABY_ID}`;
const EDIT_URL = `/log/note?babyId=${BABY_ID}&edit=${EXISTING_ID}`;
const LIST_PATH = `/v1/babies/${BABY_ID}/notes`;

const ROW = {
  id: EXISTING_ID,
  baby_id: BABY_ID,
  source: "manual",
  created_at: "2026-11-22T06:46:00.000Z",
  occurred_at: "2026-11-22T06:45:00.000Z",
  body: "Small rash on hand",
  has_photo: false,
  photo_mime: null,
};

const ROW_WITH_PHOTO = { ...ROW, has_photo: true, photo_mime: "image/jpeg" };

const UNCHANGED_PATCH = {
  occurred_at: "2026-11-22T06:45:00.000Z",
  body: "Small rash on hand",
};

const PLACEHOLDER = "What happened? (e.g. had a small rash on hand)";

function bodyInput(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement;
}

commonLifecycle({
  route: "note",
  segment: "notes",
  itemPath: "/notes",
  row: ROW,
  unchangedPatch: UNCHANGED_PATCH,
  editHeading: "Edit note",
});

describe("log/note freeze", () => {
  it("create: Save is disabled while the body is empty or whitespace", async () => {
    await renderLogRoute("note", CREATE_URL);
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(bodyInput(), { target: { value: "   " } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(bodyInput(), { target: { value: "hi" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("create: Save sends POST with the trimmed body and local→ISO time, then navigates to /", async () => {
    const r = await renderLogRoute("note", CREATE_URL);
    fireEvent.change(bodyInput(), { target: { value: "  Slept through the night  " } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T10:00:00.000Z",
          body: "Slept through the night",
        },
      },
    ]);
  });

  it("create: Enter inside the textarea does NOT submit (current behavior)", async () => {
    const r = await renderLogRoute("note", CREATE_URL);
    fireEvent.change(bodyInput(), { target: { value: "line one" } });
    fireEvent.keyDown(bodyInput(), { key: "Enter" });
    // Give any (wrong) submit a chance to run before asserting none happened.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutations(r.calls)).toEqual([]);
    expect(r.location()).toBe(CREATE_URL);
  });

  it("create: the textarea is autofocused", async () => {
    await renderLogRoute("note", CREATE_URL);
    expect(document.activeElement).toBe(bodyInput());
  });

  it("create: a JPEG pick is sent as photo + photo_mime", async () => {
    const r = await renderLogRoute("note", CREATE_URL);
    fireEvent.change(bodyInput(), { target: { value: "with photo" } });
    pickFile(jpegFile());
    await waitFor(() => expect(screen.getByAltText("Selected note photo")).toBeTruthy());
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T10:00:00.000Z",
          body: "with photo",
          photo: STUB_JPEG_BASE64,
          photo_mime: "image/jpeg",
        },
      },
    ]);
  });

  it("create: a HEIC pick shows the friendly message and stages nothing", async () => {
    await renderLogRoute("note", CREATE_URL);
    pickFile(heicFile());
    await waitFor(() => expect(screen.getByText(HEIC_MESSAGE)).toBeTruthy());
    expect(screen.queryByAltText("Selected note photo")).toBeNull();
  });

  it("create: a server error is shown inline and the route stays put", async () => {
    const r = await renderLogRoute("note", CREATE_URL, {
      backend: {
        respond: (call) =>
          call.method === "POST"
            ? new Response(
                JSON.stringify({ error: { code: "conflict", message: "note too long" } }),
                { status: 409, headers: { "Content-Type": "application/json" } },
              )
            : undefined,
      },
    });
    fireEvent.change(bodyInput(), { target: { value: "x" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText("note too long")).toBeTruthy());
    expect(r.location()).toBe(CREATE_URL);
  });

  it("edit: prefills body and local datetime; Save is enabled", async () => {
    await renderLogRoute("note", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "notes", "", ""], [ROW]),
    });
    await waitFor(() => expect(bodyInput().value).toBe("Small rash on hand"));
    expect((screen.getByLabelText("When") as HTMLInputElement).value).toBe("2026-11-22T13:45");
    expect(saveButton().disabled).toBe(false);
  });

  it("edit: clearing the body disables Save", async () => {
    await renderLogRoute("note", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "notes", "", ""], [ROW]),
    });
    await waitFor(() => expect(bodyInput().value).toBe("Small rash on hand"));
    fireEvent.change(bodyInput(), { target: { value: "" } });
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("edit: a saved photo is removed with photo: \"\" in PATCH; the image stays visible (current behavior)", async () => {
    const r = await renderLogRoute("note", EDIT_URL, {
      backend: { photo: DEFAULT_PHOTO_BYTES },
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "notes", "", ""], [ROW_WITH_PHOTO]),
    });
    await waitFor(() => expect(screen.getByAltText("Saved note photo")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    // Same as diaper: the cached server photo keeps rendering after Remove.
    expect(screen.getByAltText("Selected note photo")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/notes/${EXISTING_ID}`,
        body: { ...UNCHANGED_PATCH, photo: "" },
      },
    ]);
  });
});
