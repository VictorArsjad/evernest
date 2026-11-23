// @vitest-environment jsdom
// Characterization ("freeze") tests for /log/growth. Locks in CURRENT behavior
// ahead of the shared log-form shell extraction. Clock and TZ: see logRouteHarness.
// Units: weight kg and length cm (settings), so the form sends grams and cm.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EXISTING_ID, ROW_ID } from "../queryHarness";
import { BABY_ID, installLogRouteHarness, mutations, renderLogRoute } from "../logRouteHarness";
import { commonLifecycle } from "./commonFreeze";

installLogRouteHarness();

const CREATE_URL = `/log/growth?babyId=${BABY_ID}`;
const EDIT_URL = `/log/growth?babyId=${BABY_ID}&edit=${EXISTING_ID}`;
const LIST_PATH = `/v1/babies/${BABY_ID}/growths`;

// 6.5 kg, 62 cm, no head measurement. 06:45Z is 13:45 in Jakarta.
const ROW = {
  id: EXISTING_ID,
  baby_id: BABY_ID,
  source: "manual",
  created_at: "2026-11-22T06:46:00.000Z",
  measured_at: "2026-11-22T06:45:00.000Z",
  weight_g: 6500,
  height_cm: 62,
  head_circumference_cm: null,
  notes: null,
};

const UNCHANGED_PATCH = {
  measured_at: "2026-11-22T06:45:00.000Z",
  weight_g: 6500,
  height_cm: 62,
  head_circumference_cm: null,
  notes: "",
};

// Placeholders are the only handles on these unlabelled measurement inputs.
const WEIGHT = "6.5";
const HEIGHT = "62";
const HEAD = "42";

function weightInput(): HTMLInputElement {
  return screen.getByPlaceholderText(WEIGHT) as HTMLInputElement;
}

function heightInput(): HTMLInputElement {
  return screen.getByPlaceholderText(HEIGHT) as HTMLInputElement;
}

function headInput(): HTMLInputElement {
  return screen.getByPlaceholderText(HEAD) as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

commonLifecycle({
  route: "growth",
  segment: "growths",
  itemPath: "/growths",
  row: ROW,
  unchangedPatch: UNCHANGED_PATCH,
  editHeading: "Edit growth",
});

describe("log/growth freeze", () => {
  it("create: Save sends POST with kg→grams and cm, then navigates to /", async () => {
    const r = await renderLogRoute("growth", CREATE_URL);
    fireEvent.change(weightInput(), { target: { value: "6.5" } });
    fireEvent.change(heightInput(), { target: { value: "62" } });
    fireEvent.change(headInput(), { target: { value: "42" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          measured_at: "2026-11-22T10:00:00.000Z",
          weight_g: 6500,
          height_cm: 62,
          head_circumference_cm: 42,
        },
      },
    ]);
  });

  it("create: a single measurement is enough; blanks are omitted; Enter submits", async () => {
    const r = await renderLogRoute("growth", CREATE_URL);
    fireEvent.change(heightInput(), { target: { value: "60.5" } });
    fireEvent.keyDown(heightInput(), { key: "Enter" });

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: { id: ROW_ID, measured_at: "2026-11-22T10:00:00.000Z", height_cm: 60.5 },
      },
    ]);
  });

  it("create: Save is disabled until at least one measurement is entered", async () => {
    await renderLogRoute("growth", CREATE_URL);
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(headInput(), { target: { value: "40" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("create: weight must be > 0 and < 30 kg (0 and 30 disable Save; 29.9 is accepted)", async () => {
    await renderLogRoute("growth", CREATE_URL);
    fireEvent.change(weightInput(), { target: { value: "0" } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(weightInput(), { target: { value: "30" } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(weightInput(), { target: { value: "29.9" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("create: height must be < 200 cm and head must be < 80 cm (bounds are exclusive)", async () => {
    await renderLogRoute("growth", CREATE_URL);
    fireEvent.change(heightInput(), { target: { value: "200" } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(heightInput(), { target: { value: "62" } });
    fireEvent.change(headInput(), { target: { value: "80" } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(headInput(), { target: { value: "79.9" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("create: a server error is shown inline and the route stays put", async () => {
    const r = await renderLogRoute("growth", CREATE_URL, {
      backend: {
        respond: (call) =>
          call.method === "POST"
            ? new Response(
                JSON.stringify({ error: { code: "validation", message: "weight out of range" } }),
                { status: 422, headers: { "Content-Type": "application/json" } },
              )
            : undefined,
      },
    });
    fireEvent.change(weightInput(), { target: { value: "5" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText("weight out of range")).toBeTruthy());
    expect(r.location()).toBe(CREATE_URL);
  });

  it("edit: prefills kg, cm, local datetime and notes from the cached row", async () => {
    await renderLogRoute("growth", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "growths", "", ""], [ROW]),
    });
    await waitFor(() => expect(weightInput().value).toBe("6.5"));
    expect(heightInput().value).toBe("62");
    expect(headInput().value).toBe("");
    expect((screen.getByLabelText("When measured") as HTMLInputElement).value).toBe(
      "2026-11-22T13:45",
    );
  });

  it("edit: an untouched Save sends PATCH with only the measured fields plus notes", async () => {
    const r = await renderLogRoute("growth", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "growths", "", ""], [ROW]),
    });
    await waitFor(() => expect(weightInput().value).toBe("6.5"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      { method: "PATCH", url: `/v1/growths/${EXISTING_ID}`, body: UNCHANGED_PATCH },
    ]);
  });

  it("edit: emptying a previously-filled field sends its field as null", async () => {
    const r = await renderLogRoute("growth", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "growths", "", ""], [ROW]),
    });
    await waitFor(() => expect(weightInput().value).toBe("6.5"));
    fireEvent.change(weightInput(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/growths/${EXISTING_ID}`,
        body: {
          measured_at: "2026-11-22T06:45:00.000Z",
          height_cm: 62,
          weight_g: null,
          head_circumference_cm: null,
          notes: "",
        },
      },
    ]);
  });

  it("edit: a blank field that never had a value is also sent as null", async () => {
    const r = await renderLogRoute("growth", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "growths", "", ""], [ROW]),
    });
    await waitFor(() => expect(weightInput().value).toBe("6.5"));
    expect(headInput().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)[0]?.body).toHaveProperty("head_circumference_cm", null);
  });

  it("cold edit deep link: Save changes is disabled (no measurement present)", async () => {
    await renderLogRoute("growth", EDIT_URL);
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
