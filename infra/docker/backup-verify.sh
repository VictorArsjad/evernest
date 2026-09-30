#!/bin/sh
# Prove the latest Evernest dump actually restores — a backup you have never
# restored is not a backup. Pulls the newest dump out of the backup-data volume,
# restores it into a throwaway postgres:16 container, prints row counts for a
# few core tables, then tears the throwaway down. Never touches prod data.
#
# Usage: infra/docker/backup-verify.sh   (or `make db-backup-test`)
set -eu

PROJECT="${COMPOSE_PROJECT_NAME:-evernest}"
VOLUME="${BACKUP_VOLUME:-${PROJECT}_backup-data}"
CONTAINER="evernest-restore-test"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT

echo "==> locating latest dump in volume ${VOLUME}"
# Pick the newest by filename (the stamp is the authoritative backup time —
# more reliable than mtime, which a restore/copy could skew).
name="$(docker run --rm -v "${VOLUME}:/backups:ro" alpine:3.20 \
  sh -c 'ls -1 /backups/evernest-*.dump 2>/dev/null | sort | tail -1' | tr -d '\r\n')"
[ -n "$name" ] || { echo "!! no dumps found in ${VOLUME} — run 'make db-backup' first"; exit 1; }
echo "    latest: $name"

docker run --rm -v "${VOLUME}:/backups:ro" -v "$TMP:/out" alpine:3.20 \
  sh -c "cp '$name' /out/dump"

echo "==> starting throwaway postgres:16"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD=verify -e POSTGRES_DB=verify postgres:16-alpine >/dev/null
# Poll with a real authenticated query, not pg_isready: during first-time init
# the image briefly runs a temp server that pg_isready would falsely accept.
ready=no
for _ in $(seq 1 40); do
  if docker exec -e PGPASSWORD=verify "$CONTAINER" \
      psql -U postgres -d verify -tAc 'select 1' >/dev/null 2>&1; then
    ready=yes; break
  fi
  sleep 1
done
[ "$ready" = yes ] || { echo "!! throwaway postgres never became ready"; exit 1; }

echo "==> restoring dump"
docker cp "$TMP/dump" "$CONTAINER:/tmp/dump"
docker exec -e PGPASSWORD=verify "$CONTAINER" \
  pg_restore -U postgres -d verify --no-owner --no-privileges /tmp/dump

echo "==> row counts (sanity check):"
docker exec -e PGPASSWORD=verify "$CONTAINER" \
  psql -U postgres -d verify -tA -c "\
    select 'households='||count(*) from households \
    union all select 'babies='||count(*) from babies \
    union all select 'nursing='||count(*) from nursing_sessions \
    union all select 'diapers='||count(*) from diapers"

echo "==> restore verification OK"
