# Evernest

A baby tracking app — feedings, pumping, diapers, growth, and charts — designed mobile-first as a PWA, with a household-aware Go backend so multiple caregivers (you, your partner, grandparents) can log activity for the same baby.

- **Frontend**: Vite + React + TypeScript + TanStack Router + TanStack Query + Tailwind. Installable PWA, mobile-first.
- **Backend**: Go (`chi` router, `pgx` driver) + Postgres 16. Dockerized.
- **Data model**: nursing sessions and bottle feeds are separate tables (a bottle can hold expressed breastmilk *or* formula — collapsing them loses real-world data). Canonical storage in ml / cm / grams; the FE converts for display.
- **Multi-caregiver**: households contain one or more babies and one or more members. Link-based invites, no email dependency in v1.
- **Built incrementally**: features ship in small, end-to-end usable slices rather than one big bang.

## What it does today

- Register an account.
- Complete onboarding (household name + baby name + DOB + sex).
- Log a bottle feed (amount in ml, expressed-breastmilk or formula, time).
- Log a diaper change (wet / soiled / mixed, time, optional notes).
- Log a pumping session (amount in ml, optional duration, time).
- Log a nursing session (side: left / right / both, per-side duration in minutes, starting breast when both, time).
- Log a growth measurement (any combination of weight in grams, height in cm, head circumference in cm; at least one required).
- See a "Today" hub: a wide banner infographic across the top with a glanceable "Fed Xh Ym ago" headline (or "Nursing now — 12m" while a session is open), "Last diaper Xh ago" subline, and a 7-day bottle-intake sparkline in the corner; below it, a tile for each event kind plus five inline stat cells (bottle / nursing / pumping / diaper / growth) with thin progress bars against age-based daily targets sourced from public AAP/WHO midpoints (not medical advice — toggle off in Settings if you find them prescriptive). Below the grid: a unified Recent list across all kinds, newest first.
- See a combined "Charts & History" view (one shared 7 / 14 / 30 day range control): charts on top — a sparkline per metric (bottle, nursing, pumping, diaper stack, weight) with hover/tap tooltips that surface the active day's value (mouse hover on desktop, tap-to-toggle on mobile); the bottle chart is a stacked bar that splits expressed-breastmilk vs formula per day, and each card's "/day avg" headline excludes today (still in progress) so the average reflects completed days and doesn't drift down as the day ticks forward or reset at midnight (the "total" headline still counts today). Below the charts, History lists every event grouped by local day (Today / Yesterday / weekday), each day prefixed with a one-line roll-up (e.g. "120 ml · 18 min nursing · 3 diapers") — Charts shows daily *totals*, History shows the individual events that made them up. Clicking (desktop) or tapping a bar's tooltip link "View entries →" (touch) jumps straight to that day's History entries, expanding the day and briefly glowing the matching-kind rows so it's obvious which events the bar summarized.
- Edit or delete any past entry from any of the five log forms. Tap a row in the Today or History list to reopen the same form in edit mode (`/log/<kind>?edit=<id>`) with a Delete button for accidental double-logs.
- Configure display units on the Settings screen — volume (ml/oz), length (cm/in), weight (kg/lb), and clock (24h/12h). Conversion happens entirely on the FE; historical rows always stay in canonical ml/cm/g.
- Customize chart appearance from Settings → "Chart colors": pick one of five named presets (default, warm, pastel, high contrast, colorblind) and optionally override individual series colors via a native color picker. The "Today banner" card on the same screen lets you hide the recommended-target progress bars if you'd rather not see them.
- Hide event kinds you don't track from the UI (Settings → "Visible features"): each toggle removes the matching Today banner stat, action tile, and Charts card without touching the underlying data — past entries stay in their tables and are still reachable from History.
- Have the bottle-feed form prefill the Amount field with your most common recent bottle (the mode over the last ~14 days, so a one-off top-up never wins). Toggle off via Settings → "Bottle feeding" if you'd rather always start from a blank field.
- Invite co-caregivers via single-use link (Settings → Household → Generate link). The link is `https://<your-origin>/invite/<token>`; recipients who tap the link sign in (or register), and are automatically added to the household with the role you picked (`owner` or `caregiver`). No email is sent in v1 — copy + share the link yourself.
- Track multiple babies in a single household. The Today hub renders a baby switcher in the header when more than one exists, and remembers your selection per-household in localStorage so each device keeps its own active baby.
- Stay signed in across hard-reloads and PWA cold starts (silent auto-refresh on boot). The refresh token rides a first-party `httpOnly` cookie set by the API, which works because the API serves the web app from its own origin (the SPA is embedded in the API binary). A first-party cookie survives iOS WebKit's ITP storage eviction, unlike the `localStorage` token the old cross-site `github.io` → ts.net deploy was forced to use; see `apps/web/src/lib/authStore.ts` and `apps/api/internal/spa/` for the details.
- Sign out.
- Install as a real app on iOS (Safari → Share → Add to Home Screen) or Android (Chrome's install prompt is surfaced via an in-app banner on the Today hub). Runs standalone with a proper app icon, dark status bar, and offline-capable shell via a Workbox-generated service worker.
- Log feeds, diapers, pumpings, nursing sessions, and growth measurements while offline. The mutation lands in the Today list immediately with a small "syncing…" hint, and an IndexedDB-backed outbox replays it the next time the network returns. The Today header shows a compact `↑ N` badge whenever the queue has items, and `⚠ N` if any mutation hit a permanent error (4xx); tap the badge to retry or discard individually.

## Offline-first

Reads use TanStack Query's normal cache so the app boots from the cached Today list when offline. Writes go through a thin IndexedDB outbox (`apps/web/src/lib/outbox.ts`): every event kind generates its row id client-side, the BE accepts that id and `INSERT ... ON CONFLICT (id) DO NOTHING` makes replay safe to repeat, and the outbox processes records sequentially with exponential backoff (1s → 2s → 4s → … capped at 60s, then `dead` after eight tries). Permanent 4xx errors move straight to `dead`; 401s pause without burning the retry budget and resume after the next successful login. The Today hub subscribes via a small pub/sub so the badge and per-row "syncing…" hint update without polling, and fires an "All caught up" toast once per recovery.

Known v1 limitations: the replay loop is foreground-only — a backgrounded tab won't drain until it's focused again. Workbox's `BackgroundSync` plugin is the natural v2 upgrade if that becomes a real problem. Multiple Evernest tabs each hold their own outbox; the only failure mode is a double-replay of the same mutation, which the BE deduplicates by id.

## Quick start

### One-time setup

```bash
make env-init      # copy .env.example -> .env
make db            # start postgres in docker
make migrate-up    # apply schema migrations
make web-install   # install web dependencies
```

### Dev loop (two terminals)

```bash
# terminal 1 — API on :8080
make api-run

# terminal 2 — Vite dev server on :5173 (proxies /v1/* to the API)
make web-dev
```

Then open <http://localhost:5173>:

1. Create an account.
2. Set up your household + baby on the onboarding screen.
3. Tap **Log bottle feed**, enter amount + source + time, save.
4. Watch today's list update; the running daily total is on the card at the top.

### Tests

```bash
make api-test      # Go unit + integration tests (auth integration test hits the live db)
make web-build     # type-check + bundle the frontend
make lint          # api + web linters
```

## Repo layout

```
apps/
  api/      Go backend (chi router, pgx, migrations under apps/api/migrations)
  web/      Vite + React + TS PWA
infra/
  docker-compose.yml            dev (db only by default; `--profile dev` adds api)
  docker-compose.prod.yml       prod overlay used by deploy-api.yml
  docker-compose.homeserver.yml self-contained home-server stack (api + db + tailscale sidecar)
  docker/                       api.Dockerfile, api-entrypoint.sh, tailscale-serve.json
docs/
  api.openapi.yaml, schema.md, deploy.md
Makefile    common dev/CI entrypoints
```

Run `make help` for the full target list.

## Common commands

| Task                       | Command                            |
| -------------------------- | ---------------------------------- |
| Start db only (dev loop)   | `make db`                          |
| Start db + dockerized API  | `make up`                          |
| Stop stack                 | `make down`                        |
| Tail logs                  | `make logs`                        |
| Apply migrations           | `make migrate-up`                  |
| New migration              | `make migrate-new name=add_xyz`    |
| Run API natively           | `make api-run`                     |
| Run web dev server         | `make web-dev`                     |
| Lint everything            | `make lint`                        |
| Test everything            | `make test`                        |
| Import BabyPlus export     | `make import-babyplus FILE=... HOUSEHOLD=...` |
| Regenerate PWA icons       | `cd apps/web && npm run icons`     |

## Generating PWA icons

The home-screen / favicon PNGs under `apps/web/public/` are rasterized
from a single SVG mark at `apps/web/public/icons/icon-source.svg` using
[`sharp`](https://sharp.pixelplumbing.com/) (a Node-native image
library — no ImageMagick / external CLI required).

The generated PNGs are committed so dev runs and CI builds don't have
to invoke `sharp` from scratch. When you edit the mark:

```bash
cd apps/web
npm run icons
```

That writes:

- `public/icons/icon-{192,512}.png` (regular Android icons)
- `public/icons/icon-{192,512}-maskable.png` (Android adaptive icons)
- `public/apple-touch-icon.png` (iOS home-screen icon, `180×180`)
- `public/favicon-{16,32}.png` (browser tab favicons)

Commit the regenerated PNGs alongside the SVG change. See
[`apps/web/public/icons/README.md`](apps/web/public/icons/README.md)
for the full file map and design notes.

## Importing a BabyPlus export

If you're switching from the iOS BabyPlus app, export your data from inside
the app (Settings → Export) and ingest the resulting JSON with:

```bash
make import-babyplus FILE=~/Downloads/babyplus_data_export.json HOUSEHOLD=<household-uuid>
```

Optional flags:

- `BABY=<baby-uuid>` — required when the household has more than one baby.
- `DRY_RUN=1` — parse + validate + roll back every section instead of
  committing. Always run a dry-run first against an unfamiliar export.
- `VERBOSE=1` — log every parser/insert error to stderr alongside the summary.

Equivalent direct CLI invocation:

```bash
DATABASE_URL="$DATABASE_URL_LOCAL" go run ./apps/api/cmd/import-babyplus \
    --file=~/Downloads/babyplus_data_export.json \
    --household=<household-uuid> --dry-run --verbose
```

Re-running the import is safe: every row's id is a deterministic UUIDv5 of
`(section, babyplus_pk)`, so the second pass reports `0 imported, N skipped
(already present)` for every section. Every imported row is tagged with
`source='import_babyplus'` so you can audit or revert the import with a
single `DELETE WHERE baby_id=$1 AND source='import_babyplus'`.
