// @vitest-environment jsdom
// Characterization ("freeze") tests for /log/nursing. Locks in CURRENT behavior
// ahead of the shared log-form shell extraction. Clock and TZ: see logRouteHarness.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EXISTING_ID, ROW_ID } from "../queryHarness";
import { BABY_ID, installLogRouteHarness, mutations, renderLogRoute } from "../logRouteHarness";
import { commonLifecycle } from "./commonFreeze";

installLogRouteHarness();

const CREATE_URL = `/log/nursing?babyId=${BABY_ID}`;
const EDIT_URL = `/log/nursing?babyId=${BABY_ID}&edit=${EXISTING_ID}`;
const LIST_PATH = `/v1/babies/${BABY_ID}/nursing-sessions`;

// A closed "both" session: left 10 min, right 8 min, right side started.
// 06:45Z is 13:45 in Jakarta; 07:03Z is the computed end (18 min later).
const ROW = {
  id: EXISTING_ID,
  baby_id: BABY_ID,
  source: "manual",
  created_at: "2026-11-22T07:04:00.000Z",
  started_at: "2026-11-22T06:45:00.000Z",
  ended_at: "2026-11-22T07:03:00.000Z",
  starting_breast: "right",
  nursing_side: "both",
  left_duration_s: 600,
  right_duration_s: 480,
  notes: null,
};

const OPEN_ROW = { ...ROW, ended_at: null, left_duration_s: 0, right_duration_s: 0 };

const UNCHANGED_PATCH = {
  started_at: "2026-11-22T06:45:00.000Z",
  ended_at: "2026-11-22T07:03:00.000Z",
  starting_breast: "right",
  nursing_side: "both",
  left_duration_s: 600,
  right_duration_s: 480,
  notes: "",
};

// Two duration inputs render for "both"; left is first in the DOM.
function durationInputs(): HTMLInputElement[] {
  return screen.getAllByPlaceholderText("10") as HTMLInputElement[];
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
}

commonLifecycle({
  route: "nursing",
  segment: "nursing-sessions",
  itemPath: "/nursing-sessions",
  row: ROW,
  unchangedPatch: UNCHANGED_PATCH,
  editHeading: "Edit nursing",
});

describe("log/nursing freeze", () => {
  it("create: 'both' with left 10 and right 8 sends POST with computed ended_at and per-side seconds", async () => {
    const r = await renderLogRoute("nursing", CREATE_URL);
    const [left, right] = durationInputs();
    fireEvent.change(left!, { target: { value: "10" } });
    fireEvent.change(right!, { target: { value: "8" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          started_at: "2026-11-22T10:00:00.000Z",
          ended_at: "2026-11-22T10:18:00.000Z",
          starting_breast: "left",
          nursing_side: "both",
          left_duration_s: 600,
          right_duration_s: 480,
        },
      },
    ]);
  });

  it("create: side 'left' hides the right input, sends right_duration_s 0 and no notes", async () => {
    const r = await renderLogRoute("nursing", CREATE_URL);
    fireEvent.click(screen.getByRole("button", { name: "Left" }));
    expect(durationInputs()).toHaveLength(1);
    fireEvent.change(durationInputs()[0]!, { target: { value: "12" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          started_at: "2026-11-22T10:00:00.000Z",
          ended_at: "2026-11-22T10:12:00.000Z",
          starting_breast: "left",
          nursing_side: "left",
          left_duration_s: 720,
          right_duration_s: 0,
        },
      },
    ]);
  });

  it("create: 'Started on' picker only shows for 'both'", async () => {
    await renderLogRoute("nursing", CREATE_URL);
    expect(screen.getByRole("button", { name: "Right first" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Right" }));
    expect(screen.queryByRole("button", { name: "Right first" })).toBeNull();
  });

  it("create: Save is disabled while the total duration is 0", async () => {
    await renderLogRoute("nursing", CREATE_URL);
    expect(saveButton().disabled).toBe(true);
    const [left] = durationInputs();
    fireEvent.change(left!, { target: { value: "5" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("create: a duration above 360 minutes disables Save", async () => {
    await renderLogRoute("nursing", CREATE_URL);
    const [left] = durationInputs();
    fireEvent.change(left!, { target: { value: "361" } });
    expect(saveButton().disabled).toBe(true);
  });

  it("create: Start now sends an OPEN session (started_at only, no ended_at, no durations)", async () => {
    // Surprise: the body still carries the side and starting breast, since
    // the form defaults to "both" + "left first".
    const r = await renderLogRoute("nursing", CREATE_URL);
    fireEvent.click(screen.getByRole("button", { name: "Start now" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          started_at: "2026-11-22T10:00:00.000Z",
          nursing_side: "both",
          starting_breast: "left",
        },
      },
    ]);
  });

  it("create: Start now ignores the 'When started' field and uses the wall clock (current behavior)", async () => {
    // Surprise: Start now is always stamped with new Date(), not the picked
    // start time. Here the picked time is 16:20 local, but the body is NOW_ISO.
    const r = await renderLogRoute("nursing", CREATE_URL);
    fireEvent.change(screen.getByLabelText("When started"), {
      target: { value: "2026-11-22T16:20" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start now" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)[0]?.body).toMatchObject({
      started_at: "2026-11-22T10:00:00.000Z",
    });
  });

  it("create: Enter in the notes field submits a timed session", async () => {
    const r = await renderLogRoute("nursing", CREATE_URL);
    const [left] = durationInputs();
    fireEvent.change(left!, { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Notes (optional)"), { target: { value: "fussy" } });
    fireEvent.keyDown(screen.getByLabelText("Notes (optional)"), { key: "Enter" });

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)[0]).toMatchObject({
      method: "POST",
      body: { notes: "fussy", left_duration_s: 600, right_duration_s: 0 },
    });
  });

  it("edit: prefills per-side minutes, starting breast, and the start time", async () => {
    await renderLogRoute("nursing", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "nursing-sessions", "", ""], [ROW]),
    });
    await waitFor(() => expect(durationInputs()[0]!.value).toBe("10"));
    expect(durationInputs()[1]!.value).toBe("8");
    expect((screen.getByLabelText("When started") as HTMLInputElement).value).toBe(
      "2026-11-22T13:45",
    );
    expect(screen.getByRole("button", { name: "Right first" }).className).toContain(
      "border-accent bg-accent/15",
    );
  });

  it("edit: no Start-now button is shown in edit mode", async () => {
    await renderLogRoute("nursing", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "nursing-sessions", "", ""], [ROW]),
    });
    expect(screen.queryByRole("button", { name: "Start now" })).toBeNull();
  });

  it("edit: an OPEN session disables Save and shows the in-progress notice; Delete stays available", async () => {
    await renderLogRoute("nursing", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "nursing-sessions", "", ""], [OPEN_ROW]),
    });
    await waitFor(() =>
      expect(screen.getByText(/This session is still in progress/)).toBeTruthy(),
    );
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Delete entry" })).toBeTruthy();
  });

  it("edit: a changed duration recomputes ended_at from started_at + total", async () => {
    const r = await renderLogRoute("nursing", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "nursing-sessions", "", ""], [ROW]),
    });
    await waitFor(() => expect(durationInputs()[0]!.value).toBe("10"));
    fireEvent.change(durationInputs()[1]!, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/nursing-sessions/${EXISTING_ID}`,
        body: {
          ...UNCHANGED_PATCH,
          ended_at: "2026-11-22T07:15:00.000Z",
          right_duration_s: 1200,
        },
      },
    ]);
  });

  it("cold edit deep link: Save changes is disabled (total is 0 on an empty form)", async () => {
    await renderLogRoute("nursing", EDIT_URL);
    expect(
      (screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
