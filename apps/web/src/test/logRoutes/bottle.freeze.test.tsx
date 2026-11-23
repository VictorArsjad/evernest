// @vitest-environment jsdom
// Characterization ("freeze") tests for /log/bottle. They lock in CURRENT
// behavior ahead of extracting a shared log-form shell. Every expected value is
// a literal (see logRouteHarness for the pinned clock and TZ = Asia/Jakarta).
// Where the current behavior is surprising, the test asserts it as-is and the
// comment says so.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EXISTING_ID, ROW_ID, json } from "../queryHarness";
import {
  BABY_ID,
  installLogRouteHarness,
  mutations,
  NOW_ISO,
  renderLogRoute,
} from "../logRouteHarness";

installLogRouteHarness();

const CREATE_URL = `/log/bottle?babyId=${BABY_ID}`;
const EDIT_URL = `/log/bottle?babyId=${BABY_ID}&edit=${EXISTING_ID}`;
const LIST_PATH = `/v1/babies/${BABY_ID}/bottle-feeds`;

// A closed feed as the API returns it. 06:45Z is 13:45 in Jakarta.
const EXISTING_ROW = {
  id: EXISTING_ID,
  baby_id: BABY_ID,
  source: "manual",
  created_at: "2026-11-22T06:46:00.000Z",
  occurred_at: "2026-11-22T06:45:00.000Z",
  milk_source: "formula",
  amount_ml: 90,
  notes: null,
};

function amountInput(): HTMLInputElement {
  return screen.getByPlaceholderText("60") as HTMLInputElement;
}

function whenInput(): HTMLInputElement {
  return screen.getByLabelText("When") as HTMLInputElement;
}

function notesInput(): HTMLInputElement {
  return screen.getByLabelText("Notes (optional)") as HTMLInputElement;
}

describe("log/bottle freeze", () => {
  it("pins the test clock: 17:00 Jakarta is the harness NOW", () => {
    expect(new Date(2026, 10, 22, 17, 0).toISOString()).toBe(NOW_ISO);
  });

  it("create: Save sends POST with the local-time → ISO conversion, then navigates to /", async () => {
    const r = await renderLogRoute("bottle", CREATE_URL);
    fireEvent.change(amountInput(), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: /Expressed/ }));
    fireEvent.change(whenInput(), { target: { value: "2026-11-22T16:30" } });
    fireEvent.change(notesInput(), { target: { value: "after nap" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T09:30:00.000Z",
          milk_source: "breast",
          amount_ml: 120,
          notes: "after nap",
        },
      },
    ]);
  });

  it("create: pressing Enter in a field submits the same request", async () => {
    const r = await renderLogRoute("bottle", CREATE_URL);
    fireEvent.change(amountInput(), { target: { value: "120" } });
    fireEvent.change(whenInput(), { target: { value: "2026-11-22T16:30" } });
    fireEvent.change(notesInput(), { target: { value: "after nap" } });
    fireEvent.keyDown(notesInput(), { key: "Enter" });

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T09:30:00.000Z",
          milk_source: "formula",
          amount_ml: 120,
          notes: "after nap",
        },
      },
    ]);
  });

  it("create: a blank notes field is omitted from the body (not sent as empty string)", async () => {
    const r = await renderLogRoute("bottle", CREATE_URL);
    fireEvent.change(amountInput(), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "POST",
        url: LIST_PATH,
        body: {
          id: ROW_ID,
          occurred_at: "2026-11-22T10:00:00.000Z",
          milk_source: "formula",
          amount_ml: 60,
        },
      },
    ]);
  });

  it("create: Save is disabled until the amount is in (0, 2000] ml", async () => {
    await renderLogRoute("bottle", CREATE_URL);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(amountInput(), { target: { value: "0" } });
    expect(save.disabled).toBe(true);

    fireEvent.change(amountInput(), { target: { value: "2001" } });
    expect(save.disabled).toBe(true);

    fireEvent.change(amountInput(), { target: { value: "2000" } });
    expect(save.disabled).toBe(false);
  });

  it("create: a server error is shown inline and the route stays put", async () => {
    const r = await renderLogRoute("bottle", CREATE_URL, {
      backend: {
        respond: (call) =>
          call.method === "POST"
            ? json({ error: { code: "validation", message: "amount out of range" } }, 422)
            : undefined,
      },
    });
    fireEvent.change(amountInput(), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("amount out of range")).toBeTruthy());
    expect(r.location()).toBe(CREATE_URL);
  });

  it("edit: prefills every field from the cached row (datetime-local value, ml amount, source, notes)", async () => {
    await renderLogRoute("bottle", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "bottle-feeds", "", ""], [EXISTING_ROW]),
    });
    expect(screen.getByRole("heading", { name: "Edit bottle feed" })).toBeTruthy();
    // The prefill runs in an effect after mount, so wait for it.
    await waitFor(() => expect(amountInput().value).toBe("90"));
    expect(whenInput().value).toBe("2026-11-22T13:45");
    expect(notesInput().value).toBe("");
    expect(screen.getByRole("button", { name: /Formula/ }).className).toContain(
      "border-accent bg-accent/15",
    );
  });

  it("edit: Save sends PATCH with every form field, not only the changed one (current behavior)", async () => {
    // Surprise: the PATCH body is the whole form, not a diff. Unchanged
    // occurred_at comes back truncated to the minute, and blank notes are
    // sent as "" (which clears the server note).
    const r = await renderLogRoute("bottle", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "bottle-feeds", "", ""], [EXISTING_ROW]),
    });
    fireEvent.change(amountInput(), { target: { value: "95" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      {
        method: "PATCH",
        url: `/v1/bottle-feeds/${EXISTING_ID}`,
        body: {
          occurred_at: "2026-11-22T06:45:00.000Z",
          milk_source: "formula",
          amount_ml: 95,
          notes: "",
        },
      },
    ]);
  });

  it("cold edit deep link (row not cached): empty form, Save disabled, no GET for the row", async () => {
    const r = await renderLogRoute("bottle", EDIT_URL);
    expect(screen.getByRole("heading", { name: "Edit bottle feed" })).toBeTruthy();
    expect(amountInput().value).toBe("");
    expect(whenInput().value).toBe("2026-11-22T17:00");
    expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Edit mode skips the recent-feeds lookup, and the list is never fetched.
    expect(r.calls.some((c) => c.url.includes("bottle-feeds"))).toBe(false);
  });

  it("Escape navigates to / with no request", async () => {
    const r = await renderLogRoute("bottle", CREATE_URL);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([]);
  });

  it("Cancel navigates to / with no request", async () => {
    const r = await renderLogRoute("bottle", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "bottle-feeds", "", ""], [EXISTING_ROW]),
    });
    fireEvent.change(amountInput(), { target: { value: "70" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([]);
  });

  it("delete: first tap arms (no request), second tap sends DELETE then navigates to /", async () => {
    const r = await renderLogRoute("bottle", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "bottle-feeds", "", ""], [EXISTING_ROW]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    expect(screen.getByRole("button", { name: "Tap again to confirm delete" })).toBeTruthy();
    expect(mutations(r.calls)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Tap again to confirm delete" }));
    await waitFor(() => expect(r.location()).toBe("/"));
    expect(mutations(r.calls)).toEqual([
      { method: "DELETE", url: `/v1/bottle-feeds/${EXISTING_ID}`, body: undefined },
    ]);
  });

  it("delete: the armed state resets to 'Delete entry' after 3s with no second tap", async () => {
    await renderLogRoute("bottle", EDIT_URL, {
      seed: (qc) => qc.setQueryData(["babies", BABY_ID, "bottle-feeds", "", ""], [EXISTING_ROW]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
    expect(screen.getByRole("button", { name: "Tap again to confirm delete" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete entry" })).toBeTruthy(), {
      timeout: 4000,
    });
  });

  it("autofill: with the pref on, the amount is seeded from the mode of recent feeds and a Clear hint shows", async () => {
    const recent = [
      { id: "a", occurred_at: "2026-11-21T10:00:00.000Z", amount_ml: 120, milk_source: "formula" },
      { id: "b", occurred_at: "2026-11-21T14:00:00.000Z", amount_ml: 120, milk_source: "formula" },
      { id: "c", occurred_at: "2026-11-21T18:00:00.000Z", amount_ml: 90, milk_source: "formula" },
    ];
    await renderLogRoute("bottle", CREATE_URL, {
      backend: { prefs: { autofill_bottle_amount: true }, lists: { "bottle-feeds": recent } },
    });
    await waitFor(() => expect(amountInput().value).toBe("120"));
    expect(screen.getByText("Suggested from recent feeds")).toBeTruthy();
  });

  it("autofill: Clear empties the amount and it is not re-filled", async () => {
    const recent = [
      { id: "a", occurred_at: "2026-11-21T10:00:00.000Z", amount_ml: 120, milk_source: "formula" },
    ];
    await renderLogRoute("bottle", CREATE_URL, {
      backend: { prefs: { autofill_bottle_amount: true }, lists: { "bottle-feeds": recent } },
    });
    await waitFor(() => expect(amountInput().value).toBe("120"));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(amountInput().value).toBe("");
    expect(screen.queryByText("Suggested from recent feeds")).toBeNull();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
