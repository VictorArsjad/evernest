# AGENTS.md

Briefing for AI coding agents working on this repo. Read me before exploring;
I'll save you a lot of token spend.

## What this is

Evernest is a baby tracker. Mobile-first PWA, household-aware backend so
multiple caregivers log activity for the same baby. Design notes live in
`~/obsidian/Everything/Engineering/Evernest/`; this repo is the implementation.

- **Frontend** — Vite + React + TS, TanStack Router/Query, Tailwind, Workbox PWA.
- **Backend** — Go (`chi`, `pgx`) + Postgres 16. Migrations in `apps/api/migrations`.
- **Data model contract** — canonical units in DB are `ml`, `cm`, `grams`, UTC
  timestamps. The FE converts for display. Every event has a client-generated
  id so the offline outbox can replay safely (`INSERT … ON CONFLICT (id) DO NOTHING`).
- **Multi-caregiver** — households contain N babies and N members. Invites are
  link-based; no email dependency in v1.

## Production topology

- **FE** — GitHub Pages: <https://victorarsjad.github.io/evernest/>
- **API** — `https://evernest.taila60dd0.ts.net` (tailnet only; `/healthz` reachable from any tailnet device).
- **Home server** — Ubuntu host, hostname `ubuntu`, LAN `192.168.1.125`, tailnet `evernest` (`100.102.144.43`). Owner reaches it via `ssh victor@192.168.1.125`.
- **Stack on the host** — `infra/docker-compose.homeserver.yml`, compose project name `evernest`. Containers:
  - `evernest-api-1` — Go API, `network_mode: service:tailscale` (no direct port; reached only through the tailscale sidecar's serve config).
  - `evernest-db-1` — Postgres 16, internal-only (no published port).
  - `evernest-tailscale` — owns the netns; terminates TLS for the API.
- **Image** — `ghcr.io/victorarsjad/evernest-api:<sha>` (pin in `.env`'s `EVERNEST_API_IMAGE`).
- **Deploy** — push to `master` → `.github/workflows/ci.yml` → green → `deploy-web.yml` (GH Pages) + `deploy-api.yml` (GHCR build/push, then Tailscale-OAuth join + ssh-action over the tailnet).

## How to run admin / one-shot tasks on prod

The DB has no published port and the home server's docker host is reached via
SSH (`ssh victor@192.168.1.125`). The API image already bundles every CLI tool
(server + import-babyplus + migrate). Don't write new ssh tunnels or deploy
new images for one-offs — exec into the running API container instead:

```bash
ssh victor@192.168.1.125 'docker exec evernest-api-1 <command>'
ssh victor@192.168.1.125 'docker exec evernest-db-1 psql -U evernest -d evernest -c "<sql>"'
```

For files (e.g. a BabyPlus JSON export): `scp` to `/home/victor/`, then
`docker cp` into the container.

## Local dev loop

```bash
make env-init         # one-time, copies .env.example -> .env
make db               # postgres in docker
make migrate-up       # apply schema
make web-install      # one-time
# two terminals:
make api-run          # native Go API on :8080 against the docker db
make web-dev          # Vite on :5173, proxies /v1 to :8080
```

Smoke checks before claiming done: `make lint && make api-test && make web-build`
(matches CI). Don't push without those passing — CI will reject.

## Repo layout

```
apps/
  api/                      Go BE
  api/cmd/server/           HTTP server entrypoint
  api/cmd/import-babyplus/  one-shot importer (also bundled in the api image)
  api/migrations/           golang-migrate SQL pairs
  api/internal/             handlers, store, auth, etc.
  web/                      Vite + React PWA
  web/src/lib/outbox.ts     IndexedDB-backed offline outbox (don't bypass for writes)
  web/src/routes/           TanStack Router routes
infra/
  docker-compose.yml             dev (db only, default profile)
  docker-compose.prod.yml        overlay used by deploy-api.yml
  docker-compose.homeserver.yml  self-contained stack for the home server
  docker/api.Dockerfile          BE image (multi-stage; bundles server + import-babyplus + migrate)
  .env.homeserver                live prod env (gitignored expected — verify before commits)
docs/
  api.openapi.yaml          authoritative HTTP contract
  schema.md                 DB schema reference
  deploy.md                 deploy runbook
.github/workflows/          ci.yml + deploy-web.yml + deploy-api.yml (+ experimental homelab path)
```

## House style + non-obvious invariants

- **Idempotent imports** — `apps/api/cmd/import-babyplus/parse.go` derives every
  imported row's id as `uuid.NewSHA1(babyplusNamespace, section+":"+pk)`.
  Don't change `babyplusNamespace`; it would orphan every previously imported row.
- **Source tagging** — every imported event has `source='import_babyplus'`.
  Rollback is `DELETE … WHERE source='import_babyplus'` — keep that contract.
- **Canonical units in DB**, conversion on the FE only. Don't add a "user prefers
  oz" column to `bottle_feeds`.
- **Never bypass the outbox** for FE writes — it's what makes the app work
  offline. New event kinds need an outbox kind + replay handler.
- **Comments** — only when they explain non-obvious *why*. Don't narrate code.
- **Mobile safe areas** — `apps/web/src/routes/__root.tsx` already pads the
 shell with `env(safe-area-inset-*)` so in-flow content clears the iOS
 Dynamic Island / status bar / home indicator and the Android gesture-nav
 bar. New `fixed`/`sticky` UI must opt in itself: e.g.
 `bottom-[calc(env(safe-area-inset-bottom)+1.5rem)]` for a toast, or
 `pb-[max(1rem,env(safe-area-inset-bottom))]` on an `items-end` bottom-sheet
 backdrop. `viewport-fit=cover` + `apple-mobile-web-app-status-bar-style:
 black-translucent` in `index.html` make this a hard requirement, not a
 nice-to-have.
- **Don't push to `master` directly.** Open a PR; CI is the gate.

## Common tasks → starting points

| Task | Where to look |
|---|---|
| Add a new event kind (e.g. sleep) | `apps/api/migrations/` (new table) → `apps/api/internal/store/` (CRUD) → `apps/api/internal/handlers/` (HTTP) → `docs/api.openapi.yaml` (contract) → `apps/web/src/lib/outbox.ts` (kind) → `apps/web/src/routes/log.<kind>.tsx` (form) |
| Tweak the BabyPlus importer | `apps/api/cmd/import-babyplus/{parse,importer}.go` + `*_test.go` |
| Adjust the FE chart range | `apps/web/src/routes/charts.tsx` |
| New migration | `make migrate-new name=<snake>` |
| Bump prod image | merge to `master` → CI pushes `:<sha>` and `:latest` to GHCR → `deploy-api.yml` rolls the home server |

## Don'ts (cheap mistakes I keep wanting to make)

- Don't `ssh evernest` over tailscale — sshd is **not** exposed on the LXC.
  Use `ssh victor@192.168.1.125` (LAN) instead.
- Don't add a published port to `db` in `docker-compose.homeserver.yml`. The
  DB is intentionally internal-only.
- Don't write a brand-new admin script when the api image already contains the
  CLI you need. `docker exec evernest-api-1 import-babyplus …` is the path.
- Don't read every file in this repo before answering. The README + this file
  + `docs/deploy.md` cover ~95% of the operational surface area.
