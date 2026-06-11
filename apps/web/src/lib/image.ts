// Image compression for the diaper photo attach feature.
//
// The BE caps a single raw image at 2 MB and the JSON body at 3 MB
// (apps/api/internal/diaper/diaper.go). Modern phone cameras produce
// 3–10 MB JPEGs at 4000×3000 px, so we MUST resize + recompress on the
// FE before send — otherwise the user picks a 6 MB photo, the API
// 413s, and we have to surface a confusing error after the fact.
//
// Strategy: decode → fit into an axis-aligned bounding box (default
// 1024 px) → re-encode as JPEG at quality 0.8. That trio reliably
// lands at 100–400 KB for a typical baby-photo, comfortably under the
// cap and small enough to make the base64-in-JSON round-trip
// imperceptible on tailnet WiFi.
//
// Why JPEG (not WebP) as the canonical re-encode target: every iOS /
// Android / desktop browser we ship to supports lossy JPEG; WebP
// support is universal in 2026 but iOS Safari 14–17 had spotty
// `<canvas>.toBlob('image/webp')` quality semantics that we'd rather
// not relitigate per release. JPEG q=0.8 is the boring choice that
// always works.
//
// This module is framework-agnostic (no React / hooks / date-fns) and
// has a `.test.ts` sibling that mocks the browser globals — matches
// the units.ts convention from apps/web/AGENTS.md.

export type SupportedMime = "image/jpeg" | "image/png" | "image/webp";

export interface CompressedImage {
  // Pure base64 (no `data:` prefix). The BE expects exactly this
  // shape; emitting the prefix would force a substring strip on every
  // upload and risk subtle CRLF/whitespace bugs.
  base64: string;
  mime: SupportedMime;
  // Decoded-byte count, NOT base64 length. Caller uses this to enforce
  // a client-side preflight on the 2 MB BE cap so the user sees a
  // friendly "photo too big" message before the network round-trip.
  bytes: number;
}

export interface CompressOptions {
  // Max length of the longer image edge. Default 1024 px — large
  // enough for a diaper close-up reference photo but small enough to
  // hit our 100–400 KB target.
  maxEdgePx?: number;
  // 0..1. Default 0.8. Lower trades quality for size; 0.8 is the
  // sweet spot for photographic content in our size budget.
  quality?: number;
}

const DEFAULT_MAX_EDGE_PX = 1024;
const DEFAULT_QUALITY = 0.8;

// Hard ceiling matching the BE's maxPhotoBytes. We don't surface this
// as an error here — callers wrap the helper in a try/catch and decide
// whether to retry with lower quality or just bail. Keeping it as a
// shared constant means any tightening on either side propagates.
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

// fitInside returns the scaled (width, height) such that neither edge
// exceeds maxEdge while preserving aspect ratio. A square 4000x4000 in
// → 1024x1024 out; a 4000x3000 → 1024x768.
function fitInside(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  if (width <= maxEdge && height <= maxEdge) return { width, height };
  const ratio = width >= height ? maxEdge / width : maxEdge / height;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

// blobToBase64 strips the data:URL prefix and returns the raw base64
// payload. Exported for testing — production callers go through
// compressForUpload.
export async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader produced non-string result"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx < 0) {
    throw new Error("FileReader did not produce a data: URL");
  }
  return dataUrl.slice(commaIdx + 1);
}

// drawToCanvas decodes the input file into an ImageBitmap and renders
// it onto a canvas at the target size. Split out so tests can mock
// just the decode step. Uses OffscreenCanvas when available (faster,
// no DOM dependency) and falls back to a detached <canvas> element
// for browsers that don't have it yet (Safari < 16.4).
async function drawToCanvas(
  blob: Blob,
  targetWidth: number,
  targetHeight: number,
): Promise<HTMLCanvasElement | OffscreenCanvas> {
  const bitmap = await createImageBitmap(blob);
  try {
    let canvas: HTMLCanvasElement | OffscreenCanvas;
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(targetWidth, targetHeight);
    } else {
      const el = document.createElement("canvas");
      el.width = targetWidth;
      el.height = targetHeight;
      canvas = el;
    }
    const ctx = canvas.getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) throw new Error("2d canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    return canvas;
  } finally {
    bitmap.close?.();
  }
}

// canvasToBlob normalizes the OffscreenCanvas.convertToBlob() vs
// HTMLCanvasElement.toBlob() shape. Both browsers' implementations
// return undefined or null on failure; we surface that as an Error
// rather than letting downstream code see a missing Blob.
async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mime: SupportedMime,
  quality: number,
): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    const blob = await canvas.convertToBlob({ type: mime, quality });
    if (!blob) throw new Error("convertToBlob returned null");
    return blob;
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("canvas.toBlob returned null"));
          return;
        }
        resolve(blob);
      },
      mime,
      quality,
    );
  });
}

// compressForUpload is the single entry point the UI calls. It returns
// a structure ready to drop into the diaper create/update body:
// `body.photo = result.base64; body.photo_mime = result.mime`. The
// caller is responsible for any preflight UI on `bytes > MAX_PHOTO_BYTES`;
// this helper does NOT throw on oversize because the user agent's
// best-effort compress is sometimes "good enough" even if a single
// quality pass exceeded the cap (rare for 1024 px JPEG q=0.8, but
// possible for a high-detail photo of a printed page).
export async function compressForUpload(
  file: Blob,
  opts: CompressOptions = {},
): Promise<CompressedImage> {
  const maxEdge = opts.maxEdgePx ?? DEFAULT_MAX_EDGE_PX;
  const quality = opts.quality ?? DEFAULT_QUALITY;

  // Decode first so we know the natural dimensions; the bitmap is
  // closed inside drawToCanvas to release the underlying buffer.
  // createImageBitmap accepts whatever the browser natively decodes:
  //   - Safari/WebKit: also HEIC/HEIF (the iOS-native format)
  //   - Chrome/Firefox/Edge (incl. Chrome on Android): NOT HEIC
  // Callers are expected to pre-filter HEIC inputs and surface a
  // friendly error — see onPickPhoto in _app.log.diaper.tsx. If a
  // HEIC slips through, this will throw a DOMException that we
  // translate to "could not process photo".
  const tempBitmap = await createImageBitmap(file);
  const { width, height } = fitInside(tempBitmap.width, tempBitmap.height, maxEdge);
  tempBitmap.close?.();

  const canvas = await drawToCanvas(file, width, height);
  const outputBlob = await canvasToBlob(canvas, "image/jpeg", quality);
  const base64 = await blobToBase64(outputBlob);
  return {
    base64,
    mime: "image/jpeg",
    bytes: outputBlob.size,
  };
}
