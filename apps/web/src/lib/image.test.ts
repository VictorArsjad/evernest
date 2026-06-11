// vitest runs in the default "node" environment, so this file stubs
// the browser globals (FileReader, createImageBitmap, OffscreenCanvas)
// just enough to drive image.ts through its full pipeline. We
// deliberately don't pull in a heavyweight DOM (jsdom / happy-dom) —
// the helper's surface area is small and the explicit mocks below make
// the data flow obvious to a future reader.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { blobToBase64, compressForUpload } from "./image";

// fakeBlob is a thin stand-in for Blob that captures `size` and the
// type we serialized as. It satisfies the structural typing used in
// image.ts (only `.size` and the Promise resolution path matter for
// our assertions).
function fakeBlob(size: number, type: string): Blob {
  return { size, type } as unknown as Blob;
}

// installFileReaderMock replaces the global FileReader with a minimal
// stub that emits a data:URL synchronously via queueMicrotask. The
// reader's `result` is built from a deterministic base64 payload we
// hand in — that way blobToBase64 + compressForUpload can be asserted
// against a known string.
function installFileReaderMock(base64Body: string): void {
  class FakeFileReader {
    public result: string | null = null;
    public error: unknown = null;
    public onload: (() => void) | null = null;
    public onerror: (() => void) | null = null;
    readAsDataURL(_blob: Blob): void {
      queueMicrotask(() => {
        this.result = `data:image/jpeg;base64,${base64Body}`;
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("FileReader", FakeFileReader as unknown as typeof FileReader);
}

describe("blobToBase64", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips the data:URL prefix and returns the raw base64 payload", async () => {
    installFileReaderMock("aGVsbG8td29ybGQ=");
    const got = await blobToBase64(fakeBlob(11, "image/jpeg"));
    expect(got).toBe("aGVsbG8td29ybGQ=");
  });

  it("rejects when FileReader returns a non-string result", async () => {
    class BrokenFileReader {
      public result: ArrayBuffer | null = new ArrayBuffer(8);
      public error: unknown = null;
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;
      readAsDataURL(_blob: Blob): void {
        queueMicrotask(() => {
          this.onload?.();
        });
      }
    }
    vi.stubGlobal("FileReader", BrokenFileReader as unknown as typeof FileReader);
    await expect(blobToBase64(fakeBlob(1, "image/jpeg"))).rejects.toThrow(
      /non-string result/,
    );
  });
});

describe("compressForUpload", () => {
  // Track the size the mock canvas was asked to produce, so we can
  // verify the resize math. fitInside is private but compressForUpload
  // exposes it via the canvas geometry — we capture that via the spy
  // wired up below.
  let lastCanvasSize: { width: number; height: number } | null = null;
  // What we want canvasToBlob (via convertToBlob) to return — caller
  // tests pick a Blob size to assert the bytes field threads through.
  let outputSize = 200_000;

  beforeEach(() => {
    lastCanvasSize = null;
    outputSize = 200_000;

    // createImageBitmap mock: returns a fake bitmap with the natural
    // dimensions we chose. The pipeline calls this twice — once to
    // measure (in compressForUpload) and once inside drawToCanvas. Both
    // call sites can share the same mock.
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 4000,
        height: 3000,
        close: vi.fn(),
      })),
    );

    // OffscreenCanvas mock: records the size on construction, returns a
    // 2d context with a drawImage stub, and surfaces a convertToBlob
    // that yields a Blob of `outputSize` bytes typed as image/jpeg.
    class FakeOffscreenCanvas {
      public width: number;
      public height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
        lastCanvasSize = { width: w, height: h };
      }
      getContext(kind: string) {
        if (kind !== "2d") return null;
        return { drawImage: vi.fn() };
      }
      async convertToBlob(_opts: { type: string; quality: number }): Promise<Blob> {
        return fakeBlob(outputSize, "image/jpeg");
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas as unknown as typeof OffscreenCanvas);

    // FileReader stub for the final blob → base64 step. The body
    // doesn't need to be a real JPEG; we only assert that it flows
    // through unchanged.
    installFileReaderMock("ZmFrZS1qcGVnLWJ5dGVz");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resizes a 4000x3000 source into a 1024x768 canvas at the default options", async () => {
    const result = await compressForUpload(fakeBlob(6_000_000, "image/jpeg"));

    expect(lastCanvasSize).toEqual({ width: 1024, height: 768 });
    expect(result.mime).toBe("image/jpeg");
    expect(result.base64).toBe("ZmFrZS1qcGVnLWJ5dGVz");
    expect(result.bytes).toBe(outputSize);
  });

  it("respects a custom maxEdgePx", async () => {
    await compressForUpload(fakeBlob(6_000_000, "image/jpeg"), { maxEdgePx: 512 });
    expect(lastCanvasSize).toEqual({ width: 512, height: 384 });
  });

  it("does not upscale images already within the limit", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({
        width: 800,
        height: 600,
        close: vi.fn(),
      })),
    );
    await compressForUpload(fakeBlob(200_000, "image/jpeg"));
    expect(lastCanvasSize).toEqual({ width: 800, height: 600 });
  });

  it("forwards convertToBlob's reported size as `bytes`", async () => {
    outputSize = 350_123;
    const result = await compressForUpload(fakeBlob(6_000_000, "image/jpeg"));
    expect(result.bytes).toBe(350_123);
  });
});
