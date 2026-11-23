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
  eventstore/          shared HTTP+SQL module for every event kind
  <domain>/            event-kind descriptors (bottlefeed, diaper, pumping, nursing,
                       sleep, solidmeal, note, growth) and chart, household, preferences
```

## How an event kind is shaped (the descriptor pattern)

All eight event kinds (bottlefeed, diaper, pumping, nursing, growth, sleep,
note, solidmeal) share ONE implementation, `internal/eventstore`. A kind
package holds only a descriptor:

- Its exported row type (e.g. `BottleFeed`) and the `createReq` / `updateReq`
  structs with `validate` tags.
- An `eventstore.Spec[T]`: `Table`, `Path`, `Noun`, `TimeCol`, `Window`,
  `Select`, `InsertCols`, a `Scan`, and `NewCreate` / `NewPatch` hooks that
  turn a decoded request into insert args or an UPDATE `Set` clause (or a
  422 via `eventstore.Invalid`).
- Photo kinds embed `eventstore.PhotoIn` / `eventstore.PhotoPatch` in the request
  structs and use `eventstore.PhotoCreateOf` / `PhotoPatchOf` (the compiler
  checks the embed; there is no `Spec.Photo` flag, it is derived); `Open: true` plus `eventstore.SessionPatch` for
  start-now/end-later kinds (nursing, sleep).
- `NewHandler(st, logger) *eventstore.Handler[T]`.

`eventstore` owns the routes (`BabyRoutes` under `/v1/babies/{babyID}`:
POST/GET, plus `/open` for Open kinds; `ItemRoutes` under `/v1/<path>/{id}`:
PATCH/DELETE, plus `/photo`), authz, body cap, decode + validate, the
idempotent insert, list ranges and error envelopes. To add a kind, write a new
descriptor package and wire its `NewHandler` in `internal/api/router.go` -
never build a separate router. `router.go` carries an import-cycle note:
`httpx` provides helpers, domains consume them, `api` is the composition root.

## Non-obvious invariants (don't break these)

- **Authz on every baby-scoped request** goes through
  `baby.MustOwnBaby(ctx, store, uid, babyID)`; `eventstore` does this for the
  event kinds. Map its errors with `baby.WriteAuthErr` (404 `ErrNotFound`, 403
  `ErrUnauthorized`; anything else is a logged 500 with a generic message).
  Never query an event table without first proving the caller owns the baby.
- **DELETE is not idempotent.** An unknown / already-deleted id answers 404
  `not_found` (same envelope as PATCH); the web outbox treats that as success.
  Auth paths (403 from `MustOwnBaby`) are unchanged.
- **PATCH is JSON Merge Patch (RFC 7396).** Per field: key absent → keep,
  `"f": null` → clear (SQL NULL), `"f": <value>` → set. There are no `clear_*`
  request fields (sending one is a 400, unknown field). Convention for every
  new nullable column: declare the PATCH field as
  `eventstore.Optional[T]` (`json:"f"`, no omitempty), put validation rules in
  a `check:"..."` tag (the validator can't see inside the wrapper;
  `decodeBody` runs the tag on the value when present), and apply it with
  `Set.Nullable(col, cast, opt)` (or `Set.Text` for free text, where `""` also
  clears). Fields that are NOT `Optional` (timestamps, enums, NOT NULL
  amounts) reject an explicit `null` with 422 `"<field> cannot be null"`
  automatically. Photos use `eventstore.PhotoPatch` (`photo` null/`""` clears
  photo + mime; null photo with a non-null mime is 422).
- **Idempotent creates.** Inserts use the `WITH ins AS (INSERT … ON CONFLICT
  (id) DO NOTHING RETURNING …) SELECT … UNION ALL SELECT … WHERE NOT EXISTS`
  shape so a client retry (offline outbox replay) returns the existing row
  instead of erroring. Keep this shape for new event kinds.
- **Client-supplied ids.** `create` accepts an optional `id` in the body; if
  absent, generate with `uuidx.NewV7()`. This is what makes the FE outbox safe.
- **PATCH is partial.** Omitted fields stay untouched (`COALESCE($n, col)`).
  `id` / `source` / `created_at` / `created_by_user_id` are preserved because
  the UPDATE never sets them. They are NOT silently ignored if sent:
  `httpx.DecodeJSON` uses `DisallowUnknownFields`, so any field the PATCH body
  doesn't declare (including `source` and `id`) is a 400 `bad_request`.
- **Request bodies are capped** at 3 MiB for every kind (413
  `payload_too_large`).
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
