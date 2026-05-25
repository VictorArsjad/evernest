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
- See a "Today" hub: tiles for each event kind, a compact running summary (bottle ml / nursing min / pumping ml / diaper count), and a unified Recent list across all kinds, newest first.
- Stay signed in across hard-reloads (auto-refresh via httpOnly cookie).
- Sign out.

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
  docker-compose.yml          base (db + api)
  docker-compose.prod.yml     prod overlay (Tailscale sidecar, GHCR image)
  docker/api.Dockerfile       multi-stage Go build
  docker/tailscale-serve.json declarative `tailscale serve` config
docs/
  api.openapi.yaml, schema.md, deploy.md
.github/workflows/
  ci.yml          lint + test on every PR / push to master
  deploy-web.yml  GH Pages publish on green CI
  deploy-api.yml  GHCR push + ssh-over-Tailscale deploy on green CI
Makefile        common dev/CI/deploy entrypoints
```

Run `make help` for the full target list.

## Deploy

CP7 ships an end-to-end pipeline: green CI on `master` automatically publishes
the FE to GitHub Pages and the API to GHCR, then ssh-over-Tailscale into a
home server to pull + restart. A Tailscale sidecar container owns ingress and
TLS (no Caddy, no public ports). See [`docs/deploy.md`](docs/deploy.md) for
the full topology, repo-settings checklist, home-server bootstrap, and the
public-access flip.

```bash
make deploy-fe-build      # local FE build with the GH Pages base path
make image-be             # local API image build (linux/amd64)
make compose-prod-config  # validate the prod compose overlay
```

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
