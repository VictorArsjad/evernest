#!/bin/sh
# Nightly logical backup of the Evernest Postgres DB.
#
# pg_dump runs inside a single transaction, so it produces a consistent
# snapshot of a *live* database — the `db` container keeps serving the API
# while this runs. The dump is written to a local rotated store and then an
# encrypted copy is mirrored offsite via an `rclone crypt` remote (Google
# never sees plaintext family data).
#
# Invoked nightly by cron (see backup.Dockerfile) or on demand via
# `make db-backup`. Exits non-zero on any failure so the dead-man's-switch
# (HEALTHCHECK_URL) is only pinged on a fully successful run.
set -eu

: "${POSTGRES_DB:=evernest}"
: "${POSTGRES_USER:=evernest}"
: "${PGHOST:=db}"
: "${PGPORT:=5432}"
: "${BACKUP_DIR:=/backups}"
: "${RCLONE_REMOTE:=}"     # e.g. gdrive-crypt: — empty disables offsite
: "${HEALTHCHECK_URL:=}"   # optional healthchecks.io ping URL

# Grandfather-father-son retention (applied to both local and offsite copies).
: "${KEEP_DAILY:=7}"
: "${KEEP_WEEKLY:=4}"
: "${KEEP_MONTHLY:=6}"

# Password is required; never hardcode it — it comes from the compose env,
# which sources it from .env.
export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"

stamp="$(date -u +%Y%m%d-%H%M)"
dump="${BACKUP_DIR}/evernest-${stamp}.dump"
mkdir -p "$BACKUP_DIR"

echo "==> pg_dump ${POSTGRES_DB}@${PGHOST}:${PGPORT} -> ${dump}"
pg_dump -h "$PGHOST" -p "$PGPORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc --no-owner --no-privileges -f "$dump"

# A zero-byte dump means something went wrong silently — refuse to treat it
# as a good backup (and don't let it push a useless file offsite).
if [ ! -s "$dump" ]; then
  echo "!! dump is empty, aborting" >&2
  exit 1
fi
echo "    wrote $(du -h "$dump" | cut -f1)"

# --- Local rotation (grandfather-father-son) ---------------------------------
# Walk dumps newest-first and keep: the most recent KEEP_DAILY distinct days,
# one dump per ISO week for KEEP_WEEKLY weeks, and one per month for
# KEEP_MONTHLY months. Everything else is pruned. The whole while-loop runs in
# one pipe subshell, so the counters/seen-lists persist across iterations.
echo "==> pruning local copies (daily=${KEEP_DAILY} weekly=${KEEP_WEEKLY} monthly=${KEEP_MONTHLY})"
# Dump filenames are controlled (evernest-YYYYMMDD-HHMM.dump), so parsing `ls`
# is safe here; find(1) would only add noise.
# shellcheck disable=SC2012
ls -1 "$BACKUP_DIR"/evernest-*.dump 2>/dev/null | sort -r | (
  seen_day=" "; seen_week=" "; seen_month=" "
  nd=0; nw=0; nm=0
  while IFS= read -r f; do
    base="$(basename "$f")"
    d="${base#evernest-}"; d="${d%%-*}"        # YYYYMMDD
    day="$d"
    week="$(date -u -d "$d" +%G-%V)"           # ISO year-week (GNU date)
    month="${d%??}"                            # YYYYMM
    keep=no
    case "$seen_day" in *" $day "*) : ;; *)
      if [ "$nd" -lt "$KEEP_DAILY" ]; then seen_day="$seen_day$day "; nd=$((nd+1)); keep=yes; fi ;;
    esac
    case "$seen_week" in *" $week "*) : ;; *)
      if [ "$nw" -lt "$KEEP_WEEKLY" ]; then seen_week="$seen_week$week "; nw=$((nw+1)); keep=yes; fi ;;
    esac
    case "$seen_month" in *" $month "*) : ;; *)
      if [ "$nm" -lt "$KEEP_MONTHLY" ]; then seen_month="$seen_month$month "; nm=$((nm+1)); keep=yes; fi ;;
    esac
    if [ "$keep" = no ]; then
      echo "    prune $base"
      rm -f "$f"
    fi
  done
)

# --- Offsite mirror (encrypted) ---------------------------------------------
# `rclone sync` mirrors the pruned local dir to the crypt remote so retention
# is identical offsite. --max-delete guards against a catastrophic local wipe
# nuking the offsite copy too: if more files than that would be deleted, sync
# refuses and errors out.
if [ -n "$RCLONE_REMOTE" ]; then
  echo "==> rclone sync ${BACKUP_DIR} -> ${RCLONE_REMOTE}"
  rclone sync "$BACKUP_DIR" "$RCLONE_REMOTE" --max-delete 5 --stats-one-line
else
  echo "==> RCLONE_REMOTE unset, skipping offsite mirror"
fi

# --- Dead-man's-switch ------------------------------------------------------
if [ -n "$HEALTHCHECK_URL" ]; then
  echo "==> pinging healthcheck"
  curl -fsS -m 10 --retry 3 "$HEALTHCHECK_URL" >/dev/null || \
    echo "!! healthcheck ping failed (backup itself succeeded)" >&2
fi

echo "==> backup complete"
