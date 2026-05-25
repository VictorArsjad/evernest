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
- See a "Today" hub: tiles for each event kind, a compact running summary (bottle ml / nursing min / pumping ml / diaper count / latest weight), and a unified Recent list across all kinds, newest first.
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
  docker-compose.yml + Dockerfiles + Caddyfile
docs/
  api.openapi.yaml, schema.md
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
