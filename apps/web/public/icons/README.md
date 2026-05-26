# Evernest PWA icons

This directory holds the source SVG and every rasterized PNG variant
referenced by `apps/web/vite.config.ts`'s web manifest and by the iOS
meta tags in `apps/web/index.html`.

## Files

| File                              | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `icon-source.svg`                 | Master mark. Edit this; never edit the PNGs by hand.     |
| `icon-192.png` (`192x192`)        | Android home-screen icon (`purpose: "any"`)              |
| `icon-512.png` (`512x512`)        | Android splash + manifest large icon (`purpose: "any"`)  |
| `icon-192-maskable.png` (`192x`)  | Android adaptive icon, small (`purpose: "maskable"`)     |
| `icon-512-maskable.png` (`512x`)  | Android adaptive icon, large (`purpose: "maskable"`)     |
| `../apple-touch-icon.png` (`180`) | iOS home-screen icon (linked from `index.html`)          |
| `../favicon-32.png`, `favicon-16.png` | Browser tab favicons (linked from `index.html`)      |
| `../favicon.svg`                  | Vector tab favicon for browsers that support it          |

Note: the iOS / browser-favicon PNGs live in `apps/web/public/` (one
level up), not here, because both rel-types are conventionally served
from the site root.

## Regenerating

The PNGs are committed to the repo so dev runs and CI builds don't have
to install `sharp` from scratch. When the mark changes, edit
`icon-source.svg` and then run:

```bash
cd apps/web
npm run icons
```

This invokes `scripts/generate-icons.mjs` (uses `sharp`, a Node-native
image library — no ImageMagick / external CLI required). The script
re-rasterizes every variant from the SVG and overwrites the PNG files
in place. Commit the updated PNGs alongside the SVG change.

## Design notes

The mark is a stylized **sleeping crescent moon** with a tiny companion
star on a deep-navy rounded-square tile:

- Background: `#0b1220` (the app shell `bg-bg-base`)
- Halo: `#7c9cff` (the app accent) at 10% opacity
- Moon + star: `#f5edd6` (a warm cream that reads against the navy)
- Rounded corners (`rx=96` on a 512 canvas) so launchers that don't
  apply their own mask still render an iOS-style app tile.

The mark is sized to fit comfortably inside the inner 80% maskable
safe zone, so the same PNGs can be advertised as both `purpose: "any"`
and `purpose: "maskable"` without losing the moon to an adaptive-icon
mask crop.
