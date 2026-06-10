# AGENTS.md — `apps/api` (Go backend)

Scoped notes for the Go API. Read the **repo root `AGENTS.md`** first for the
big picture (prod topology, deploy, data-model contract). This file only covers
backend-local conventions.

## Layout

```
cmd/server/            HTTP server entrypoint (wires config + store + router)
cmd/import-babyplus/   one-shot BabyPlus importer (also bundled in the api image)
migrations/            golang-migrate SQL pairs (NNNNNN_name.{up,down}.sql)
internal/
  api/                 router.go — the ONLY place domain routes get wired together
  httpx/               JSON/error helpers + slog middleware (DecodeJSON, WriteJSON, WriteError)
  store/               thin pgxpool wrapper; each domain owns its own SQL
  auth/                JWT, sessions, password, RequireUser middleware, UserIDFrom(ctx)
  baby/                MustOwnBaby authz gate + ErrNotFound / ErrUnauthorized
  config/              env-driven config
  <domain>/            one package per event kind: bottlefeed, diaper, pumping,
                       nursing, growth, chart, household, preferences
```

## How a domain package is shaped (the pattern to copy)

Every event-kind package follows `bottlefeed` almost verbatim:

- A `Handler` struct holding `*store.Store`, `*slog.Logger`, and a
  `*validator.Validate` (`validator.New(validator.WithRequiredStructEnabled())`).
- `NewHandler(st, logger)` constructor.
- `BabyRoutes(r chi.Router)` mounts collection routes under
  `/v1/babies/{babyID}` (POST create, GET list).
- `ItemRoutes(r chi.Router)` mounts item routes under `/v1/<kind>/{id}`
  (PATCH update, DELETE delete).
- Routes get wired in `internal/api/router.go` — add the handler there, never
  build a separate router. `router.go` carries an import-cycle note: `httpx`
  provides helpers, domains consume them, `api` is the composition root.

## Non-obvious invariants (don't break these)

- **Authz on every baby-scoped request** goes through
  `baby.MustOwnBaby(ctx, store, uid, babyID)`. Map its errors with the local
  `writeBabyAuthErr` helper (404 `ErrNotFound`, 403 `ErrUnauthorized`). Never
  query an event table without first proving the caller owns the baby.
- **Idempotent creates.** Inserts use the `WITH ins AS (INSERT … ON CONFLICT
  (id) DO NOTHING RETURNING …) SELECT … UNION ALL SELECT … WHERE NOT EXISTS`
  shape so a client retry (offline outbox replay) returns the existing row
  instead of erroring. Keep this shape for new event kinds.
- **Client-supplied ids.** `create` accepts an optional `id` in the body; if
  absent, generate with `uuidx.NewV7()`. This is what makes the FE outbox safe.
- **PATCH is partial.** Omitted fields stay untouched (`COALESCE($n, col)`).
  The server always preserves `id` / `source` / `created_at` /
  `created_by_user_id` regardless of input so an `import_babyplus` row stays
  correctly tagged after a user correction. For nullable text like `notes`,
  follow the "present-flag + NULLIF(value,'')" convention used in `bottlefeed`
  (Go's JSON decoder can't tell "absent" from "explicit null" on a `*string`).
- **Canonical units only.** DB stores `ml` / `cm` / `grams` and UTC timestamps.
  Do NOT add user-preference unit columns to event tables — conversion is the
  FE's job.
- **Source tagging.** Manual rows are `source='manual'`; importer rows are
  `source='import_babyplus'`. Importer rollback contract is
  `DELETE … WHERE source='import_babyplus'`.
- **Error envelope.** Always respond via `httpx.WriteError(w, status, code,
  message)` — the FE's `api.ts` parses `{ error: { code, message } }`. Use
  `httpx.WriteJSON` for success bodies and `httpx.DecodeJSON` for request
  bodies.
- **List range params.** List endpoints accept RFC3339 `from`/`to` and a
  `limit` (default 200, capped 1000). The FE computes the window per the user's
  timezone; the API treats everything as UTC.

## Migrations

- `make migrate-new name=<snake>` scaffolds a numbered up/down pair in
  `migrations/`. Always write a real `.down.sql` (CI / local rollback rely on
  it).
- Apply locally with `make migrate-up`. Schema reference lives in
  `docs/schema.md`; the HTTP contract in `docs/api.openapi.yaml`. Update both
  when you add an event kind or column.
- On prod, migrate runs inside the api image — `docker exec evernest-api-1
  migrate …` (see root `AGENTS.md`); never hand-roll a tunnel.

## Tests & checks

- Unit/integration tests live next to the code (`*_test.go`). Integration tests
  (e.g. `chart_integration_test.go`) need a Postgres; run `make db` first.
- Before claiming done: `make lint && make api-test` (matches CI).
- `cmd/import-babyplus` is covered by `parse_test.go` / `importer_test.go`. The
  importer derives each row id as
  `uuid.NewSHA1(babyplusNamespace, section+":"+pk)` — **never change
  `babyplusNamespace`**, it would orphan every previously imported row.
