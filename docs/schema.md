# Evernest schema notes

Authoritative migrations live in [`apps/api/migrations/`](../apps/api/migrations/).
This document explains the *why* behind the shape — the *what* should always be
read from the SQL.

## Canonical units

Every measurement is stored in a single canonical unit, regardless of what the
user prefers to see:

| concept | canonical column        | unit  |
| ------- | ----------------------- | ----- |
| volume  | `amount_ml`             | ml    |
| length  | `*_cm`                  | cm    |
| weight  | `weight_g`              | grams |
| time    | all timestamps          | UTC   |

Display conversion happens entirely on the FE. Changing a user's `unit_volume`
from `ml` to `oz` never mutates historical rows; only the rendered value
changes. This keeps historical data comparable forever.

## Households, members, babies

```
users -< household_members >- households -< babies
```

A household has one or more members (`owner` or `caregiver`) and one or more
babies. Every event row is scoped to a baby; authorization is "is the
authenticated user a member of the household that owns this baby?".

This model is intentionally identical to the one a multi-tenant SaaS would
need — adding open signup + OAuth + billing later doesn't require schema
changes.

## Why nursing and bottle feeds are separate tables

A real BabyPlus export (used to validate the schema) shows that ~67% of
"bottle feeds" are bottled *expressed breastmilk*, not formula. A single
`feedings.type ∈ {breast, formula}` column conflates two orthogonal things:

1. **Method** — at the breast (duration + side) vs from a bottle (volume).
2. **Milk source** — only meaningful for bottle feeds (`breast` vs `formula`).

So we split:

- `nursing_sessions(started_at, ended_at, starting_breast, nursing_side, left_duration_s, right_duration_s)`
- `bottle_feeds(occurred_at, milk_source, amount_ml)`

The FE groups them under a single "Feedings" tab. Charts can either query each
table independently or `UNION ALL` them when the metric calls for it (e.g.
"total volume ingested per day" combines bottle volume with… well, nursing
has no volume, so this is why we don't try to fuse them at the DB layer).

## `source` column on every event table

Every event table has a `source text not null default 'manual'` column. Values
in use:

- `manual` — entered through the UI
- `import_babyplus` — created by `cmd/import-babyplus`

This makes it trivial to revert an import (`DELETE WHERE baby_id=$1 AND
source='import_babyplus'`) or to display a "imported" badge in the UI.

## Idempotency keys

Mutations accept a client-generated UUIDv7 as the `id`. Re-running an insert
with the same id is safe because every event table's primary key is `id` and
the API uses `INSERT … ON CONFLICT (id) DO NOTHING`. This is what lets the
PWA queue mutations offline and retry without dedupe logic.

For the BabyPlus importer, the same idea applies: each imported row's id is a
deterministic UUIDv5 derived from `(section, babyplus_pk)`, so re-running
the importer is a no-op.

## Indexes

Every event table has a composite `(baby_id, occurred_at DESC)` (or
`(baby_id, started_at DESC)` for nursing, `(baby_id, measured_at DESC)` for
growths). This single index serves both the timeline view (most recent N for
a baby) and the daily chart aggregation (date range scan for a baby).
