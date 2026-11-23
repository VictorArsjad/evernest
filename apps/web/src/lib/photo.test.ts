import { describe, expect, it } from "vitest";

import { base64ToBlob, isHeicFile } from "./photo";

const file = (name: string, type: string) => new File(["x"], name, { type });

describe("isHeicFile", () => {
  it.each(["image/heic", "image/heif", "image/heic-sequence", "IMAGE/HEIC"])(
    "detects MIME %s",
    (type) => {
      expect(isHeicFile(file("a.bin", type))).toBe(true);
    },
  );

  it.each(["IMG_1.heic", "IMG_1.HEIF", "x.Heic"])("falls back to the extension for %s", (name) => {
    expect(isHeicFile(file(name, ""))).toBe(true);
  });

  it("is false for ordinary images", () => {
    expect(isHeicFile(file("a.jpg", "image/jpeg"))).toBe(false);
    expect(isHeicFile(file("a.png", ""))).toBe(false);
  });

  it("does not treat a name that merely contains 'heic' as HEIC", () => {
    expect(isHeicFile(file("heic.jpg", "image/jpeg"))).toBe(false);
  });
});

describe("base64ToBlob", () => {
  it("decodes to a Blob with the given MIME type and bytes", async () => {
    const blob = base64ToBlob("SlBFR0JZVEVT", "image/jpeg"); // "JPEGBYTES"
    expect(blob.type).toBe("image/jpeg");
    expect(blob.size).toBe(9);
    expect(new Uint8Array(await blob.arrayBuffer())[0]).toBe("J".charCodeAt(0));
  });

  it("handles an empty payload", () => {
    expect(base64ToBlob("", "image/jpeg").size).toBe(0);
  });
});
