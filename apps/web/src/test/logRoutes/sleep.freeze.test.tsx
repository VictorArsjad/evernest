// @vitest-environment jsdom
// Characterization ("freeze") tests for /log/sleep. Locks in CURRENT behavior
// ahead of the shared log-form shell extraction. Clock and TZ: see logRouteHarness.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EXISTING_ID, ROW_ID } from "../queryHarness";
import { BABY_ID, installLogRouteHarness, mutations, renderLogRoute } from "../logRouteHarness";
import { commonLifecycle } from "./commonFreeze";

installLogRouteHarness();

const CREATE_URL = `/log/sleep?babyId=${BABY_ID}`;
const EDIT_URL = `/log/sleep?babyId=${BABY_ID}&edit=${EXISTING_ID}`;
const LIST_PATH = `/v1/babies/${BABY_ID}/sleeps`;

// A night sleep, closed. 06:45Z..07:30Z is 13:45..14:30 in Jakarta.
const ROW = {
  id: EXISTING_ID,
  baby_id: BABY_ID,
  source: "manual",
  created_at: "2026-11-22T07:31:00.000Z",
  started_at: "2026-11-22T06:45:00.000Z",
  ended_at: "2026-11-22T07:30:00.000Z",
  sleep_type: "night",
  location: "crib",
  notes: null,
};

const OPEN_ROW = { ...ROW, ended_at: null };

const UNCHANGED_PATCH = {
  started_at: "2026-11-22T06:45:00.000Z",
  ended_at: "2026-11-22T07:30:00.000Z",
  sleep_type: "night",
  location: "crib",
  notes: "",
};

function startedInput(): HTMLInputElement {
  return screen.getByLabelText("Fell asleep") as HTMLInputElement;
}

function endedInput(): HTMLInputElement {
  return screen.getByLabelText(/Woke up/) as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

commonLifecycle({
  route: "sleep",
  segment: "sleeps",
  itemPath: "/sleeps",
  row: ROW,
  unchangedPatch: UNCHANGED_PATCH,
  editHeading: "Edit sleep",
});

describe("log/sleep freeze", () => {
  it("create: Save sends POST with the interval and type, then navigates to /", async () => {
    const r = await renderLogRoute("sleep", CREATE_URL);
    fireEvent.click(screen.getByRole("button", { name: "Nap" }));
    fireEvent.change(endedInput(), { target: { value: "2026-11-22T18:30" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          started_at: "2026-11-22T10:00:00.000Z",
          ended_at: "2026-11-22T11:30:00.000Z",
          sleep_type: "nap",
        },
      },
    ]);
  });

  it("create: tapping the selected type again deselects it (no sleep_type sent)", async () => {
    const r = await renderLogRoute("sleep", CREATE_URL);
    fireEvent.click(screen.getByRole("button", { name: "Nap" }));
    fireEvent.click(screen.getByRole("button", { name: "Nap" }));
    fireEvent.change(endedInput(), { target: { value: "2026-11-22T17:20" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          started_at: "2026-11-22T10:00:00.000Z",
          ended_at: "2026-11-22T10:20:00.000Z",
        },
      },
    ]);
  });

  it("create: Save is disabled while 'Woke up' is empty", async () => {
    await renderLogRoute("sleep", CREATE_URL);
    expect(saveButton().disabled).toBe(true);
  });

  it("create: Save is disabled when 'Woke up' is not after 'Fell asleep'", async () => {
    await renderLogRoute("sleep", CREATE_URL);
    fireEvent.change(endedInput(), { target: { value: "2026-11-22T17:00" } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(endedInput(), { target: { value: "2026-11-22T16:59" } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(endedInput(), { target: { value: "2026-11-22T17:01" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("create: Start now opens a session (started_at only, no ended_at) and uses the Fell asleep time", async () => {
    // Surprise: Start now stamps the picked "Fell asleep" value, not the wall
    // clock. Here it is 16:20 local = 09:20Z.
    const r = await renderLogRoute("sleep", CREATE_URL);
    fireEvent.change(startedInput(), { target: { value: "2026-11-22T16:20" } });
    fireEvent.change(screen.getByPlaceholderText("Crib, stroller, arms…"), {
      target: { value: "stroller" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start now" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: { id: ROW_ID, started_at: "2026-11-22T09:20:00.000Z", location: "stroller" },
      },
    ]);
  });

  it("create: Start now stays enabled even with an invalid or empty 'Woke up'", async () => {
    const r = await renderLogRoute("sleep", CREATE_URL);
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Start now" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)[0]).toMatchObject({
      method: "POST",
      body: { started_at: "2026-11-22T10:00:00.000Z" },
    });
    expect(mutations(r.calls)[0]?.body).not.toHaveProperty("ended_at");
  });

  it("edit: prefills type, both times, location and notes", async () => {
    await renderLogRoute("sleep", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "sleeps", "", ""], [ROW]),
    });
    await waitFor(() => expect(startedInput().value).toBe("2026-11-22T13:45"));
    expect(endedInput().value).toBe("2026-11-22T14:30");
    expect(screen.getByRole("button", { name: "Night" }).className).toContain(
      "border-accent bg-accent/15",
    );
    expect(screen.getByPlaceholderText("Crib, stroller, arms…")).toHaveProperty("value", "crib");
  });

  it("edit: no Start-now button in edit mode", async () => {
    await renderLogRoute("sleep", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "sleeps", "", ""], [ROW]),
    });
    expect(screen.queryByRole("button", { name: "Start now" })).toBeNull();
  });

  it("edit: clearing the type sends clear_sleep_type: true and no sleep_type", async () => {
    const r = await renderLogRoute("sleep", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "sleeps", "", ""], [ROW]),
    });
    await waitFor(() => expect(startedInput().value).toBe("2026-11-22T13:45"));
    fireEvent.click(screen.getByRole("button", { name: "Night" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    const { sleep_type: _omitted, ...rest } = UNCHANGED_PATCH;
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/sleeps/${EXISTING_ID}`,
        body: { ...rest, clear_sleep_type: true },
      },
    ]);
  });

  it("edit: an OPEN session disables Save and shows the in-progress notice; Delete stays available", async () => {
    await renderLogRoute("sleep", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "sleeps", "", ""], [OPEN_ROW]),
    });
    await waitFor(() => expect(screen.getByText(/This sleep is still in progress/)).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Delete entry" })).toBeTruthy();
  });

  it("cold edit deep link: Save changes is disabled (no woke-up time)", async () => {
    await renderLogRoute("sleep", EDIT_URL);
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
