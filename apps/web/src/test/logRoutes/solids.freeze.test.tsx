// @vitest-environment jsdom
// Characterization ("freeze") tests for /log/solids. Locks in CURRENT behavior
// ahead of the shared log-form shell extraction. Clock and TZ: see logRouteHarness.
// Units: the baby's weight unit is kg (settings), so the amount field is in kg
// and the request sends grams.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EXISTING_ID, ROW_ID } from "../queryHarness";
import {
  BABY_ID,
  installLogRouteHarness,
  mutations,
  NOW_ISO,
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

const CREATE_URL = `/log/solids?babyId=${BABY_ID}`;
const EDIT_URL = `/log/solids?babyId=${BABY_ID}&edit=${EXISTING_ID}`;
const LIST_PATH = `/v1/babies/${BABY_ID}/solid-meals`;

// Avocado, liked, 250 g, notes "soft". 06:45Z is 13:45 in Jakarta.
const ROW = {
  id: EXISTING_ID,
  baby_id: BABY_ID,
  source: "manual",
  created_at: "2026-11-22T06:46:00.000Z",
  occurred_at: "2026-11-22T06:45:00.000Z",
  foods: ["avocado"],
  reaction: "liked",
  amount_g: 250,
  notes: "soft",
  has_photo: false,
  photo_mime: null,
};

const ROW_WITH_PHOTO = { ...ROW, has_photo: true, photo_mime: "image/jpeg" };

const UNCHANGED_PATCH = {
  occurred_at: "2026-11-22T06:45:00.000Z",
  foods: ["avocado"],
  reaction: "liked",
  amount_g: 250,
  notes: "soft",
};

const AMOUNT_PLACEHOLDER = "Leave blank if unknown";

function foodInput(): HTMLInputElement {
  return screen.getByPlaceholderText(/avocado, banana|Add more/) as HTMLInputElement;
}

function amountInput(): HTMLInputElement {
  return screen.getByPlaceholderText(AMOUNT_PLACEHOLDER) as HTMLInputElement;
}

function notesInput(): HTMLInputElement {
  return screen.getByLabelText("Notes (optional)") as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement;
}

commonLifecycle({
  route: "solids",
  segment: "solid-meals",
  itemPath: "/solid-meals",
  row: ROW,
  unchangedPatch: UNCHANGED_PATCH,
  editHeading: "Edit solids",
  listFetchedInEdit: true,
});

// Adds a food chip without touching Enter: Enter also bubbles to the form and
// submits (see the stale-closure test below), so tests add chips on blur.
function addFood(name: string): void {
  fireEvent.change(foodInput(), { target: { value: name } });
  fireEvent.blur(foodInput());
}

describe("log/solids freeze", () => {
  it("create: foods added as chips, Save sends POST with grams and reaction", async () => {
    const r = await renderLogRoute("solids", CREATE_URL);
    addFood("avocado");
    addFood("banana");
    fireEvent.click(screen.getByRole("button", { name: "Liked" }));
    fireEvent.change(amountInput(), { target: { value: "0.25" } });
    fireEvent.change(notesInput(), { target: { value: "soft" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T10:00:00.000Z",
          foods: ["avocado", "banana"],
          reaction: "liked",
          amount_g: 250,
          notes: "soft",
        },
      },
    ]);
  });

  it("create: Save with no foods shows an inline error and sends nothing", async () => {
    const r = await renderLogRoute("solids", CREATE_URL);
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText("Add at least one food")).toBeTruthy());
    expect(mutations(r.calls)).toEqual([]);
  });

  it("create: a negative amount fails native min=0 validation; no inline message, no request", async () => {
    // Surprise: the amount input has min={0}, so jsdom's constraint validation
    // blocks the submit before the app's "must be a non-negative number" check
    // can run. That inline message is unreachable through this form today.
    const r = await renderLogRoute("solids", CREATE_URL);
    addFood("pear");
    fireEvent.change(amountInput(), { target: { value: "-1" } });
    expect(amountInput().validity.valid).toBe(false);
    fireEvent.click(saveButton());

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Amount must be a non-negative number")).toBeNull();
    expect(amountInput()).toBeTruthy();
    expect(mutations(r.calls)).toEqual([]);
  });

  it("create: a blank amount and no reaction are omitted from the body", async () => {
    const r = await renderLogRoute("solids", CREATE_URL);
    addFood("rice");
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: { id: ROW_ID, occurred_at: "2026-11-22T10:00:00.000Z", foods: ["rice"] },
      },
    ]);
  });

  it("create: a JPEG pick is sent as photo + photo_mime", async () => {
    const r = await renderLogRoute("solids", CREATE_URL);
    addFood("rice");
    pickFile(jpegFile());
    await waitFor(() => expect(screen.getByAltText("Selected solids photo")).toBeTruthy());
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T10:00:00.000Z",
          foods: ["rice"],
          photo: STUB_JPEG_BASE64,
          photo_mime: "image/jpeg",
        },
      },
    ]);
  });

  it("create: a HEIC pick is rejected up front with the friendly message and nothing is staged (APPROVED CHANGE solids-heic)", async () => {
    await renderLogRoute("solids", CREATE_URL);
    pickFile(heicFile());
    await waitFor(() => expect(screen.getByText(HEIC_MESSAGE)).toBeTruthy());
    expect(screen.queryByText("The source image could not be decoded.")).toBeNull();
    expect(screen.queryByAltText("Selected solids photo")).toBeNull();
  });

  it("create: Enter in the food field only adds a chip; it does not submit (APPROVED CHANGE solids-enter)", async () => {
    const r = await renderLogRoute("solids", CREATE_URL);
    fireEvent.change(foodInput(), { target: { value: "avocado" } });
    fireEvent.keyDown(foodInput(), { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove avocado" })).toBeTruthy();
    expect(screen.queryByText("Add at least one food")).toBeNull();
    expect(mutations(r.calls)).toEqual([]);
    expect(r.location()).not.toBe("/");
  });

  it("create: Backspace in an empty food field removes the last chip", async () => {
    await renderLogRoute("solids", CREATE_URL);
    addFood("rice");
    expect(screen.getByRole("button", { name: "Remove rice" })).toBeTruthy();
    fireEvent.keyDown(foodInput(), { key: "Backspace" });
    expect(screen.queryByRole("button", { name: "Remove rice" })).toBeNull();
  });

  it("create: has no Start-now button and the harness clock is pinned to NOW_ISO", async () => {
    // Pins the clock every occurred_at default above depends on.
    expect(NOW_ISO).toBe("2026-11-22T10:00:00.000Z");
    await renderLogRoute("solids", CREATE_URL);
    expect(screen.queryByRole("button", { name: "Start now" })).toBeNull();
  });

  it("edit: prefills foods, reaction, amount in kg, local datetime, and notes", async () => {
    await renderLogRoute("solids", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "solid-meals", "", ""], [ROW]),
    });
    await waitFor(() => expect(amountInput().value).toBe("0.25"));
    expect(screen.getByRole("button", { name: "Remove avocado" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Liked" }).className).toContain(
      "border-accent bg-accent/15",
    );
    expect(notesInput().value).toBe("soft");
    expect((screen.getByLabelText("When") as HTMLInputElement).value).toBe("2026-11-22T13:45");
  });

  it("edit: an untouched reaction is sent as \"\" when none is picked (current behavior)", async () => {
    const r = await renderLogRoute("solids", EDIT_URL, {
      seed: (qc) =>
        qc.setQueryData(
          ["babies", BABY_ID, "solid-meals", "", ""],
          [{ ...ROW, reaction: null, amount_g: null, notes: null }],
        ),
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove avocado" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/solid-meals/${EXISTING_ID}`,
        body: {
          occurred_at: "2026-11-22T06:45:00.000Z",
          foods: ["avocado"],
          reaction: "",
          amount_g: null,
          notes: "",
        },
      },
    ]);
  });

  it("edit: clicking the selected reaction again clears it (sent as \"\")", async () => {
    const r = await renderLogRoute("solids", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "solid-meals", "", ""], [ROW]),
    });
    await waitFor(() => expect(amountInput().value).toBe("0.25"));
    fireEvent.click(screen.getByRole("button", { name: "Liked" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/solid-meals/${EXISTING_ID}`,
        body: { ...UNCHANGED_PATCH, reaction: "" },
      },
    ]);
  });

  it("edit: emptying the amount sends amount_g: null", async () => {
    const r = await renderLogRoute("solids", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "solid-meals", "", ""], [ROW]),
    });
    await waitFor(() => expect(amountInput().value).toBe("0.25"));
    fireEvent.change(amountInput(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/solid-meals/${EXISTING_ID}`,
        body: {
          occurred_at: "2026-11-22T06:45:00.000Z",
          foods: ["avocado"],
          reaction: "liked",
          amount_g: null,
          notes: "soft",
        },
      },
    ]);
  });

  it("edit: Remove on a saved photo hides the image, shows the hint, and PATCHes photo: null", async () => {
    // Unlike diaper/note, solids hides the saved image once Remove is clicked
    // (previewUrl is gated on !existingCleared) and shows a replace hint.
    const r = await renderLogRoute("solids", EDIT_URL, {
      backend: { photo: DEFAULT_PHOTO_BYTES },
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "solid-meals", "", ""], [ROW_WITH_PHOTO]),
    });
    await waitFor(() => expect(screen.getByAltText("Saved solids photo")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Remove photo" }));
    expect(screen.queryByAltText("Saved solids photo")).toBeNull();
    expect(screen.queryByAltText("Selected solids photo")).toBeNull();
    expect(
      screen.getByText("Saved photo will be removed. Pick a new one to replace it instead."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/solid-meals/${EXISTING_ID}`,
        body: { ...UNCHANGED_PATCH, photo: null },
      },
    ]);
  });
});
