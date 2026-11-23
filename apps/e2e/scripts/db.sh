#!/usr/bin/env bash
# Ensure the dedicated e2e database exists and is migrated.
# E2E_FRESH_DB=1 drops it first. Refuses to touch anything but the e2e db.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=env.sh
. "$HERE/env.sh"

if [ -z "${CI:-}" ]; then
  case "$DATABASE_URL" in
    */evernest_e2e\?*|*/evernest_e2e_*) ;;
    *) echo "refusing: DATABASE_URL must point at evernest_e2e or evernest_e2e_<suffix> locally" >&2; exit 1 ;;
  esac
  PSQL=(docker exec -i evernest-db-1 psql -U evernest -d postgres -v ON_ERROR_STOP=1 -tA)
  if [ "${E2E_FRESH_DB:-}" = "1" ]; then
    "${PSQL[@]}" -c "DROP DATABASE IF EXISTS ${E2E_DB_NAME} WITH (FORCE)"
  fi
  if [ -z "$("${PSQL[@]}" -c "SELECT 1 FROM pg_database WHERE datname='${E2E_DB_NAME}'")" ]; then
    "${PSQL[@]}" -c "CREATE DATABASE ${E2E_DB_NAME}"
  fi
fi
migrate -path "$ROOT/apps/api/migrations" -database "$DATABASE_URL" up
