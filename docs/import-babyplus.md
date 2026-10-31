# Importing a BabyPlus export

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
