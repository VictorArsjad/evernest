#!/bin/sh
# Entrypoint for the backup sidecar: install a crontab from $BACKUP_CRON and
# run crond in the foreground. busybox crond launches jobs with a minimal
# environment, so we snapshot the relevant env vars into a file the job sources.
set -eu

: "${BACKUP_CRON:=30 3 * * *}"   # 03:30 UTC daily
: "${RUN_ON_START:=false}"       # set true to also dump immediately on boot

# Snapshot env for the cron job, single-quote-escaping values so passwords with
# spaces/quotes survive intact.
printenv | while IFS='=' read -r k v; do
  case "$k" in
    POSTGRES_*|PG*|BACKUP_DIR|RCLONE_*|HEALTHCHECK_URL|KEEP_*|TZ)
      esc=$(printf '%s' "$v" | sed "s/'/'\\\\''/g")
      printf "export %s='%s'\n" "$k" "$esc"
      ;;
  esac
done > /etc/backup.env

# Route the job's stdout/stderr to PID 1 so `docker logs` shows backup output.
cat > /etc/crontabs/root <<EOF
${BACKUP_CRON} . /etc/backup.env; /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1
EOF

echo "backup sidecar ready — schedule: ${BACKUP_CRON}"

if [ "$RUN_ON_START" = "true" ]; then
  echo "RUN_ON_START=true — running an initial backup now"
  /usr/local/bin/backup.sh || echo "!! initial backup failed" >&2
fi

exec crond -f -l 8
