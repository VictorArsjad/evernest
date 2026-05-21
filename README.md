# Evernest

A baby tracking app — feedings, pumping, diapers, growth, and charts — designed mobile-first as a PWA, with a household-aware Go backend so multiple caregivers (you, your partner, grandparents) can log activity for the same baby.

- **Frontend**: Vite + React + TypeScript + TanStack Router + TanStack Query + Tailwind. Installable PWA, mobile-first.
- **Backend**: Go (`chi` router, `pgx` driver) + Postgres 16. Dockerized.
- **Data model**: nursing sessions and bottle feeds are separate tables (a bottle can hold expressed breastmilk *or* formula — collapsing them loses real-world data). Canonical storage in ml / cm / grams; the FE converts for display.
- **Multi-caregiver**: households contain one or more babies and one or more members. Link-based invites, no email dependency in v1.
- **Built incrementally**: each "CP" is a usable build. See [.cursor/plans/](.cursor/plans/) for the checkpoint history.

## Current checkpoint: CP1 — first usable loop

What you can do today:

- Register an account.
- Complete onboarding (household name + baby name + DOB + sex).
- Log a bottle feed (amount in ml, expressed-breastmilk or formula, time).
- See today's feeds with a running daily total, ordered newest first.
- Stay signed in across hard-reloads (auto-refresh via httpOnly cookie).
- Sign out.

Coming in later checkpoints (in order):

- **CP2** — nursing / pumping / diapers / growth event kinds + a Go CLI that idempotently imports the BabyPlus JSON export.
- **CP3** — daily bar charts per metric.
- **CP4** — settings screen with unit conversion (ml/oz, cm/in, kg/lb, 24h/12h).
- **CP5** — link-based household invites and multi-baby UI.
- **CP6** — PWA polish (real icons + offline mutation outbox).
- **CP7** — production docker-compose profile behind Caddy.

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
| (CP2+) Import BabyPlus     | `make import-babyplus FILE=... HOUSEHOLD=...` |
