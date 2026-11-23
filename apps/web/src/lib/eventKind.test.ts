import { describe, expect, it } from "vitest";

import {
  createdPhoto,
  createPhotoBody,
  editedText,
  patchBody,
  listKeyFor,
  openKeyFor,
  updatedPhoto,
  updatePhotoBody,
} from "./eventKind";

describe("cache keys", () => {
  it("listKeyFor pads a missing window with empty strings", () => {
    expect(listKeyFor("diapers")("b1")).toEqual(["babies", "b1", "diapers", "", ""]);
    expect(listKeyFor("diapers")("b1", "f", "t")).toEqual(["babies", "b1", "diapers", "f", "t"]);
  });

  it("openKeyFor nests under the list prefix", () => {
    expect(openKeyFor("sleeps")("b1")).toEqual(["babies", "b1", "sleeps", "open"]);
  });
});

describe("patchBody", () => {
  it("passes explicit null through and omits undefined", () => {
    expect(
      patchBody({ a: 1, b: null, c: undefined, d: "" } as {
        a?: number;
        b?: number | null;
        c?: number | null;
        d?: string;
      }, ["a", "b", "c", "d"]),
    ).toEqual({ a: 1, b: null, d: "" });
  });
});

describe("editedText", () => {
  it("leaves the column on undefined, clears on empty string, else replaces", () => {
    expect(editedText(undefined, "old")).toBe("old");
    expect(editedText(undefined, undefined)).toBeNull();
    expect(editedText("", "old")).toBeNull();
    expect(editedText("new", "old")).toBe("new");
  });
});

describe("photo synthesis", () => {
  it("createdPhoto sets has_photo only when a payload is present", () => {
    expect(createdPhoto({})).toEqual({ has_photo: false, photo_mime: null });
    expect(createdPhoto({ photoBase64: "x", photoMime: "image/png" })).toEqual({
      has_photo: true,
      photo_mime: "image/png",
    });
    expect(createdPhoto({ photoBase64: "x" })).toEqual({ has_photo: true, photo_mime: null });
  });

  it("createPhotoBody is empty without a payload", () => {
    expect(createPhotoBody({})).toEqual({});
    expect(createPhotoBody({ photoBase64: "x", photoMime: "image/webp" })).toEqual({
      photo: "x",
      photo_mime: "image/webp",
    });
  });

  it("updatedPhoto leaves, clears or replaces relative to the cached row", () => {
    const existing = { has_photo: true, photo_mime: "image/jpeg" as const };
    expect(updatedPhoto({}, existing)).toEqual({ has_photo: true, photo_mime: "image/jpeg" });
    expect(updatedPhoto({}, undefined)).toEqual({ has_photo: false, photo_mime: null });
    expect(updatedPhoto({ photoBase64: "" }, existing)).toEqual({ has_photo: false, photo_mime: null });
    expect(updatedPhoto({ photoBase64: "x", photoMime: "image/png" }, existing)).toEqual({
      has_photo: true,
      photo_mime: "image/png",
    });
    // No new mime: keep the cached one.
    expect(updatedPhoto({ photoBase64: "x" }, existing)).toEqual({
      has_photo: true,
      photo_mime: "image/jpeg",
    });
  });

  it("updatePhotoBody omits the mime on clear and when none is given", () => {
    expect(updatePhotoBody({})).toEqual({});
    expect(updatePhotoBody({ photoBase64: "", photoMime: "image/png" })).toEqual({ photo: null });
    expect(updatePhotoBody({ photoBase64: "x" })).toEqual({ photo: "x" });
    expect(updatePhotoBody({ photoBase64: "x", photoMime: "image/png" })).toEqual({
      photo: "x",
      photo_mime: "image/png",
    });
  });
});
