// @vitest-environment jsdom
// Characterization ("freeze") tests for /log/diaper. Locks in CURRENT behavior
// ahead of the shared log-form shell extraction. See logRouteHarness for the
// pinned clock (17:00 Jakarta = 10:00Z) and TZ.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EXISTING_ID, ROW_ID, json } from "../queryHarness";
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

const CREATE_URL = `/log/diaper?babyId=${BABY_ID}`;
const EDIT_URL = `/log/diaper?babyId=${BABY_ID}&edit=${EXISTING_ID}`;
const LIST_PATH = `/v1/babies/${BABY_ID}/diapers`;

// A soiled diaper with a note and no photo. 06:45Z is 13:45 in Jakarta.
const ROW = {
  id: EXISTING_ID,
  baby_id: BABY_ID,
  source: "manual",
  created_at: "2026-11-22T06:46:00.000Z",
  occurred_at: "2026-11-22T06:45:00.000Z",
  type: "soiled",
  notes: "rash",
  has_photo: false,
  photo_mime: null,
};

const ROW_WITH_PHOTO = { ...ROW, has_photo: true, photo_mime: "image/jpeg" };

const UNCHANGED_PATCH = {
  occurred_at: "2026-11-22T06:45:00.000Z",
  type: "soiled",
  notes: "rash",
};

function notesInput(): HTMLInputElement {
  return screen.getByLabelText("Notes (optional)") as HTMLInputElement;
}

function typeButton(name: "Wet" | "Soiled" | "Mixed"): HTMLElement {
  return screen.getByRole("button", { name });
}

commonLifecycle({
  route: "diaper",
  segment: "diapers",
  itemPath: "/diapers",
  row: ROW,
  unchangedPatch: UNCHANGED_PATCH,
  editHeading: "Edit diaper",
});

describe("log/diaper freeze", () => {
  it("create: Save sends POST with type, local→ISO time, and notes; then navigates to /", async () => {
    const r = await renderLogRoute("diaper", CREATE_URL);
    fireEvent.click(typeButton("Soiled"));
    fireEvent.change(notesInput(), { target: { value: "rash" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T10:00:00.000Z",
          type: "soiled",
          notes: "rash",
        },
      },
    ]);
  });

  it("create: Enter in the notes field submits the same form (default type wet)", async () => {
    const r = await renderLogRoute("diaper", CREATE_URL);
    fireEvent.keyDown(notesInput(), { key: "Enter" });

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: { id: ROW_ID, occurred_at: "2026-11-22T10:00:00.000Z", type: "wet" },
      },
    ]);
  });

  it("create: has no required-field validation; Save is enabled on the empty default form", async () => {
    await renderLogRoute("diaper", CREATE_URL);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("create: a JPEG pick is compressed and sent as photo + photo_mime", async () => {
    const r = await renderLogRoute("diaper", CREATE_URL);
    pickFile(jpegFile());
    await waitFor(() => expect(screen.getByAltText("Selected diaper photo")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T10:00:00.000Z",
          type: "wet",
          photo: STUB_JPEG_BASE64,
          photo_mime: "image/jpeg",
        },
      },
    ]);
  });

  it("create: a HEIC pick is rejected up front with the friendly message and nothing is staged", async () => {
    const r = await renderLogRoute("diaper", CREATE_URL);
    pickFile(heicFile());
    await waitFor(() => expect(screen.getByText(HEIC_MESSAGE)).toBeTruthy());
    expect(screen.queryByAltText("Selected diaper photo")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: { id: ROW_ID, occurred_at: "2026-11-22T10:00:00.000Z", type: "wet" },
      },
    ]);
  });

  it("create: a server error is shown inline and the route stays put", async () => {
    const r = await renderLogRoute("diaper", CREATE_URL, {
      backend: {
        respond: (call) =>
          call.method === "POST"
            ? json({ error: { code: "validation", message: "bad type" } }, 422)
            : undefined,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("bad type")).toBeTruthy());
    expect(r.location()).toBe(CREATE_URL);
  });

  it("edit: prefills type, local datetime, and notes from the cached row", async () => {
    await renderLogRoute("diaper", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "diapers", "", ""], [ROW]),
    });
    await waitFor(() => expect((notesInput()).value).toBe("rash"));
    expect((screen.getByLabelText("When") as HTMLInputElement).value).toBe("2026-11-22T13:45");
    expect(typeButton("Soiled").className).toContain("border-accent bg-accent/15");
    expect(typeButton("Wet").className).not.toContain("border-accent bg-accent/15");
  });

  it("edit: changing the type sends the whole form in PATCH", async () => {
    const r = await renderLogRoute("diaper", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "diapers", "", ""], [ROW]),
    });
    await waitFor(() => expect(notesInput().value).toBe("rash"));
    fireEvent.click(typeButton("Mixed"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/diapers/${EXISTING_ID}`,
        body: { ...UNCHANGED_PATCH, type: "mixed" },
      },
    ]);
  });

  it("edit: Remove on a saved photo still PATCHes photo: \"\" (current behavior: the image stays on screen)", async () => {
    // Surprise: after Remove, the cached server photo keeps rendering (the
    // preview falls back to existingPhotoUrl, whose query is only disabled, not
    // cleared). The "will be removed" hint therefore never shows for diapers.
    // Save still clears the server copy. Frozen as-is.
    const r = await renderLogRoute("diaper", EDIT_URL, {
      backend: { photo: DEFAULT_PHOTO_BYTES },
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "diapers", "", ""], [ROW_WITH_PHOTO]),
    });
    await waitFor(() => expect(screen.getByAltText("Saved diaper photo")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    expect(screen.queryByText(/Saved photo will be removed/)).toBeNull();
    expect(screen.getByAltText("Selected diaper photo")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/diapers/${EXISTING_ID}`,
        body: { ...UNCHANGED_PATCH, photo: "" },
      },
    ]);
  });

  it("edit: picking a new photo replaces the saved one (photo + photo_mime in PATCH)", async () => {
    const r = await renderLogRoute("diaper", EDIT_URL, {
      backend: { photo: DEFAULT_PHOTO_BYTES },
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "diapers", "", ""], [ROW_WITH_PHOTO]),
    });
    await waitFor(() => expect(screen.getByAltText("Saved diaper photo")).toBeTruthy());
    pickFile(jpegFile());
    await waitFor(() => expect(screen.getByAltText("Selected diaper photo")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/diapers/${EXISTING_ID}`,
        body: {
          ...UNCHANGED_PATCH,
          photo: STUB_JPEG_BASE64,
          photo_mime: "image/jpeg",
        },
      },
    ]);
  });
});
