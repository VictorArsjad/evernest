#!/bin/sh
# Self-contained smoke test for the backup pipeline. Builds the backup image,
# seeds an ephemeral postgres:16, runs backup.sh (dump + rotation), then
# backup-verify.sh (restore into a throwaway db), and asserts the round-trip
# preserved every row and that grandfather-father-son rotation pruned to the
# expected count. Used by CI (.github/workflows/backup-ci.yml) and runnable
# locally. Requires docker; never touches real data or any cloud remote.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE="${BACKUP_IMAGE:-evernest-backup:smoke}"
NET=evernest-smoke-net
DB=evernest-smoke-db
# backup-verify.sh derives the volume name from COMPOSE_PROJECT_NAME.
export COMPOSE_PROJECT_NAME=evernest
VOL=evernest_backup-data

cleanup() {
  docker rm -f "$DB" evernest-restore-test >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
cleanup
trap cleanup EXIT

echo "==> build backup image"
docker build -q -f "$ROOT/infra/docker/backup.Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null

echo "==> start ephemeral postgres:16"
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" \
  -e POSTGRES_USER=evernest -e POSTGRES_PASSWORD=smoke-pw -e POSTGRES_DB=evernest \
  postgres:16-alpine >/dev/null
# Poll with a real authenticated query (pg_isready would falsely accept the
# temp server the image runs during first-time init).
ready=no
for _ in $(seq 1 40); do
  if docker exec -e PGPASSWORD=smoke-pw "$DB" \
      psql -U evernest -d evernest -tAc 'select 1' >/dev/null 2>&1; then
    ready=yes; break
  fi
  sleep 1
done
[ "$ready" = yes ] || { echo "!! ephemeral postgres never became ready"; exit 1; }

echo "==> seed schema + rows"
# NB: docker exec needs -i to forward the heredoc to psql's stdin.
docker exec -i -e PGPASSWORD=smoke-pw "$DB" \
  psql -U evernest -d evernest -v ON_ERROR_STOP=1 -q <<'SQL'
create table households (id uuid primary key default gen_random_uuid(), name text);
create table babies (id uuid primary key default gen_random_uuid(), name text);
create table nursing_sessions (id uuid primary key default gen_random_uuid(), note text);
create table diapers (id uuid primary key default gen_random_uuid(), kind text);
insert into households(name) values ('Home');
insert into babies(name) values ('Baby A'),('Baby B');
insert into nursing_sessions(note) values ('a'),('b'),('c');
insert into diapers(kind) values ('wet'),('dirty'),('wet'),('dirty'),('wet');
SQL

echo "==> pre-seed old dumps so rotation has something to prune"
docker run --rm -v "$VOL:/backups" alpine:3.20 sh -c '
  for d in 20200101 20200102 20200103 20200104 20200105 20200106 20200107 20200108 20200109 20200110; do
    echo old > "/backups/evernest-$d-0300.dump"
  done'

echo "==> run backup.sh (offsite disabled)"
docker run --rm --network "$NET" \
  -e PGHOST="$DB" -e POSTGRES_USER=evernest -e POSTGRES_PASSWORD=smoke-pw -e POSTGRES_DB=evernest \
  -e RCLONE_REMOTE= -e KEEP_DAILY=7 -e KEEP_WEEKLY=4 -e KEEP_MONTHLY=6 \
  -v "$VOL:/backups" --entrypoint /usr/local/bin/backup.sh "$IMAGE"

echo "==> assert rotation kept exactly 7 dumps"
# 10 fakes (all Jan 2020, spanning 2 ISO weeks / 1 month) + 1 fresh dump: the 6
# most-recent-day fakes already cover every weekly+monthly slot, so 4 are pruned.
kept="$(docker run --rm -v "$VOL:/backups" alpine:3.20 \
  sh -c 'ls -1 /backups/evernest-*.dump | wc -l' | tr -d ' ')"
[ "$kept" = 7 ] || { echo "FAIL: expected 7 dumps after rotation, got $kept"; exit 1; }
echo "    OK (${kept} dumps)"

echo "==> restore + verify"
out="$("$ROOT/infra/docker/backup-verify.sh")"
echo "$out"

echo "==> assert restored row counts"
for want in households=1 babies=2 nursing=3 diapers=5; do
  echo "$out" | grep -qx "$want" || { echo "FAIL: expected '$want' in restore output"; exit 1; }
done

echo "==> SMOKE TEST PASSED"
