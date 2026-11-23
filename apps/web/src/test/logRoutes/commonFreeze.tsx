// Lifecycle cases every /log/* form shares: Escape, Cancel, cold edit deep
// link, edit Save (PATCH), and the two-tap delete. Imported by the per-route
// freeze files. Not a test file itself (no .test. in the name).
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { EXISTING_ID } from "../queryHarness";
import {
  BABY_ID,
  flush,
  type LogRouteName,
  mutations,
  renderLogRoute,
  type Segment,
} from "../logRouteHarness";

export interface CommonCase {
  route: LogRouteName;
  // Cache + list segment, e.g. "diapers". Also the seeded list key.
  segment: Segment;
  // Item path used for PATCH/DELETE, e.g. "/diapers" (see lib/queries.ts).
  itemPath: string;
  // The cached row the edit form prefills from.
  row: Record<string, unknown>;
  // Exact PATCH body an untouched Save sends for `row`.
  unchangedPatch: Record<string, unknown>;
  editHeading: string;
  // Solids also loads recent meals for food suggestions, so its edit mode
  // does fetch the list. Every other route is expected not to.
  listFetchedInEdit?: boolean;
}

export const DEFAULT_PHOTO_BYTES = "PHOTOBYTES";

export function jpegFile(name = "photo.jpg"): File {
  return new File(["jpeg-source"], name, { type: "image/jpeg" });
}

export function heicFile(name = "IMG_0001.HEIC"): File {
  return new File(["heic-source"], name, { type: "image/heic" });
}

// Picks a file through the route's (only) file input.
export function pickFile(file: File): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

export const HEIC_MESSAGE =
  "iPhone HEIC photos aren't supported here. Retake the photo, or change Settings → Camera → Formats → Most Compatible and try again.";

export function commonLifecycle(c: CommonCase): void {
  const createUrl = `/log/${c.route}?babyId=${BABY_ID}`;
  const editUrl = `/log/${c.route}?babyId=${BABY_ID}&edit=${EXISTING_ID}`;
  const seed = (qc: QueryClient) =>
    qc.setQueryData(["babies", BABY_ID, c.segment, "", ""], [c.row]);

  describe(`log/${c.route} shared lifecycle`, () => {
    it("Escape navigates to / with no request", async () => {
      const r = await renderLogRoute(c.route, createUrl);
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(r.location()).toBe("/"));
      expect(mutations(r.calls)).toEqual([]);
    });

    it("Cancel navigates to / with no request (edit mode)", async () => {
      const r = await renderLogRoute(c.route, editUrl, { seed });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(r.location()).toBe("/"));
      expect(mutations(r.calls)).toEqual([]);
    });

    it("cold edit deep link: heading shows and the form is empty (no prefill without a cached row)", async () => {
      const r = await renderLogRoute(c.route, editUrl);
      expect(screen.getByRole("heading", { name: c.editHeading })).toBeTruthy();
      expect(
        r.calls.some((call) => call.method === "GET" && call.url.includes(`/${c.segment}`)),
      ).toBe(c.listFetchedInEdit ?? false);
      expect(mutations(r.calls)).toEqual([]);
    });

    it("edit: an untouched Save sends PATCH with the whole form, then navigates to /", async () => {
      const r = await renderLogRoute(c.route, editUrl, { seed });
      expect(screen.getByRole("heading", { name: c.editHeading })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => expect(r.location()).toBe("/"));
      expect(mutations(r.calls)).toEqual([
        { method: "PATCH", url: `/v1${c.itemPath}/${EXISTING_ID}`, body: c.unchangedPatch },
      ]);
    });

    it("delete: first tap arms with no request, second tap sends DELETE then navigates to /", async () => {
      const r = await renderLogRoute(c.route, editUrl, { seed });
      fireEvent.click(screen.getByRole("button", { name: "Delete entry" }));
      expect(mutations(r.calls)).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Tap again to confirm delete" }));
      await waitFor(() => expect(r.location()).toBe("/"));
      expect(mutations(r.calls)).toEqual([
        { method: "DELETE", url: `/v1${c.itemPath}/${EXISTING_ID}`, body: undefined },
      ]);
    });
  });
}

export { flush };
