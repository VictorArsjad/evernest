// isHeicFile decides whether a picked file is HEIC/HEIF. We check the MIME
// type first (set by every browser whose picker knows about HEIC) and fall
// back to the extension for old iOS / share-sheet sources that leave
// Blob.type empty.
export function isHeicFile(file: File): boolean {
  const mime = file.type.toLowerCase();
  if (mime === "image/heic" || mime === "image/heif" || mime === "image/heic-sequence") {
    return true;
  }
  const name = file.name.toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

// base64ToBlob round-trips the compressed payload back into a Blob so we can
// build a preview URL. Cheaper than holding onto the original File / source
// bitmap, and lets the preview reflect the exact bytes we're about to send.
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
