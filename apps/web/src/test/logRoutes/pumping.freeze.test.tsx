// @vitest-environment jsdom
// Characterization ("freeze") tests for /log/pumping. Locks in CURRENT behavior
// ahead of the shared log-form shell extraction. Clock and TZ: see logRouteHarness.
// Units: volume unit is ml (settings), duration is typed in minutes and sent
// as seconds.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EXISTING_ID, ROW_ID } from "../queryHarness";
import { BABY_ID, installLogRouteHarness, mutations, renderLogRoute } from "../logRouteHarness";
import { commonLifecycle } from "./commonFreeze";

installLogRouteHarness();

const CREATE_URL = `/log/pumping?babyId=${BABY_ID}`;
const EDIT_URL = `/log/pumping?babyId=${BABY_ID}&edit=${EXISTING_ID}`;
const LIST_PATH = `/v1/babies/${BABY_ID}/pumpings`;

// 90 ml over 10 minutes, no notes. 06:45Z is 13:45 in Jakarta.
const ROW = {
  id: EXISTING_ID,
  baby_id: BABY_ID,
  source: "manual",
  created_at: "2026-11-22T06:46:00.000Z",
  occurred_at: "2026-11-22T06:45:00.000Z",
  amount_ml: 90,
  duration_seconds: 600,
  notes: null,
};

const UNCHANGED_PATCH = {
  occurred_at: "2026-11-22T06:45:00.000Z",
  amount_ml: 90,
  duration_seconds: 600,
  notes: "",
};

// The amount field is the only one with the "80" placeholder (ml default).
function amountInput(): HTMLInputElement {
  return screen.getByPlaceholderText("80") as HTMLInputElement;
}

function durationInput(): HTMLInputElement {
  return screen.getByPlaceholderText("15") as HTMLInputElement;
}

function notesInput(): HTMLInputElement {
  return screen.getByLabelText("Notes (optional)") as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

commonLifecycle({
  route: "pumping",
  segment: "pumpings",
  itemPath: "/pumpings",
  row: ROW,
  unchangedPatch: UNCHANGED_PATCH,
  editHeading: "Edit pumping",
});

describe("log/pumping freeze", () => {
  it("create: Save sends POST with ml, duration in seconds, and local→ISO time, then navigates to /", async () => {
    const r = await renderLogRoute("pumping", CREATE_URL);
    fireEvent.change(amountInput(), { target: { value: "120" } });
    fireEvent.change(durationInput(), { target: { value: "15" } });
    fireEvent.change(notesInput(), { target: { value: "left side" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T10:00:00.000Z",
          amount_ml: 120,
          duration_seconds: 900,
          notes: "left side",
        },
      },
    ]);
  });

  it("create: Enter in a field submits; a blank duration is omitted from the body", async () => {
    const r = await renderLogRoute("pumping", CREATE_URL);
    fireEvent.change(amountInput(), { target: { value: "60" } });
    fireEvent.keyDown(amountInput(), { key: "Enter" });

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: { id: ROW_ID, occurred_at: "2026-11-22T10:00:00.000Z", amount_ml: 60 },
      },
    ]);
  });

  it("create: Save is disabled while the amount is blank", async () => {
    await renderLogRoute("pumping", CREATE_URL);
    expect(saveButton().disabled).toBe(true);
  });

  it("create: the amount upper bound is 2000 ml (2001 disabled, 2000 enabled)", async () => {
    await renderLogRoute("pumping", CREATE_URL);
    fireEvent.change(amountInput(), { target: { value: "2001" } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(amountInput(), { target: { value: "2000" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("create: a zero amount is ACCEPTED (unlike bottle, which needs > 0; current behavior)", async () => {
    await renderLogRoute("pumping", CREATE_URL);
    fireEvent.change(amountInput(), { target: { value: "0" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("create: the duration bound is 360 minutes (361 disables Save)", async () => {
    await renderLogRoute("pumping", CREATE_URL);
    fireEvent.change(amountInput(), { target: { value: "60" } });
    fireEvent.change(durationInput(), { target: { value: "361" } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(durationInput(), { target: { value: "360" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("create: a server error is shown inline and the route stays put", async () => {
    const r = await renderLogRoute("pumping", CREATE_URL, {
      backend: {
        respond: (call) =>
          call.method === "POST"
            ? new Response(
                JSON.stringify({ error: { code: "validation", message: "amount too small" } }),
                { status: 422, headers: { "Content-Type": "application/json" } },
              )
            : undefined,
      },
    });
    fireEvent.change(amountInput(), { target: { value: "60" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText("amount too small")).toBeTruthy());
    expect(r.location()).toBe(CREATE_URL);
  });

  it("edit: prefills ml amount, duration minutes, local datetime, and notes", async () => {
    await renderLogRoute("pumping", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "pumpings", "", ""], [ROW]),
    });
    await waitFor(() => expect(amountInput().value).toBe("90"));
    expect(durationInput().value).toBe("10");
    expect(notesInput().value).toBe("");
    expect((screen.getByLabelText("When") as HTMLInputElement).value).toBe("2026-11-22T13:45");
  });

  it("edit: clearing the duration does NOT clear it on the server (PATCH omits duration_seconds; current behavior)", async () => {
    // Surprise: updateBody skips undefined, so a blank duration is simply not
    // sent. The server keeps the old value.
    const r = await renderLogRoute("pumping", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "pumpings", "", ""], [ROW]),
    });
    await waitFor(() => expect(durationInput().value).toBe("10"));
    fireEvent.change(durationInput(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/pumpings/${EXISTING_ID}`,
        body: { occurred_at: "2026-11-22T06:45:00.000Z", amount_ml: 90, notes: "" },
      },
    ]);
  });

  it("edit: a changed amount sends the whole form in PATCH", async () => {
    const r = await renderLogRoute("pumping", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "pumpings", "", ""], [ROW]),
    });
    await waitFor(() => expect(amountInput().value).toBe("90"));
    fireEvent.change(amountInput(), { target: { value: "95" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/pumpings/${EXISTING_ID}`,
        body: { ...UNCHANGED_PATCH, amount_ml: 95 },
      },
    ]);
  });
});
