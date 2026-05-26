#!/usr/bin/env node
// Rasterize the master SVG mark into the full PWA icon set.
//
// Outputs (relative to apps/web/public/):
//   icons/icon-192.png            — Android home-screen + Chrome install
//   icons/icon-512.png            — Android splash + manifest large
//   icons/icon-192-maskable.png   — Android adaptive icon (small)
//   icons/icon-512-maskable.png   — Android adaptive icon (large)
//   apple-touch-icon.png  (180x180) — iOS home-screen
//   favicon-32.png        (32x32)   — desktop browser tab
//   favicon-16.png        (16x16)   — small UI surfaces
//
// "Regular" vs "maskable" both use the same source SVG. The mark in
// icon-source.svg is already sized to fit inside the 80% maskable
// safe zone, so we don't need separate art — only separate filenames
// so vite-plugin-pwa can advertise the `purpose: "maskable"` variants
// in the web manifest.
//
// Run: `npm run icons` (or `node scripts/generate-icons.mjs`).
// Commit the resulting PNGs — they're consumed at build time.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "..", "public");
const sourceSvg = resolve(publicDir, "icons", "icon-source.svg");

const targets = [
  { out: "icons/icon-192.png", size: 192 },
  { out: "icons/icon-512.png", size: 512 },
  { out: "icons/icon-192-maskable.png", size: 192 },
  { out: "icons/icon-512-maskable.png", size: 512 },
  { out: "apple-touch-icon.png", size: 180 },
  { out: "favicon-32.png", size: 32 },
  { out: "favicon-16.png", size: 16 },
];

async function main() {
  const svgBuf = await sharp(sourceSvg).toBuffer();
  for (const { out, size } of targets) {
    const dest = resolve(publicDir, out);
    await mkdir(dirname(dest), { recursive: true });
    const png = await sharp(svgBuf)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await writeFile(dest, png);
    process.stdout.write(`  wrote public/${out} (${size}x${size}, ${png.length} bytes)\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`generate-icons failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
