# syntax=docker/dockerfile:1.7
#
# Tiny scheduled-backup sidecar for the Evernest Postgres DB.
#   - postgresql16-client: pg_dump/pg_restore that match the postgres:16 server
#   - rclone:              encrypted offsite mirror (crypt remote over Google Drive)
#   - coreutils:           GNU date for the ISO-week math in backup.sh
#   - curl:                healthchecks.io dead-man's-switch ping
# Built from the repo root (compose sets context: ..), so COPY paths are
# relative to the repository root.
FROM alpine:3.20

RUN apk add --no-cache postgresql16-client rclone coreutils curl tzdata

COPY infra/docker/backup.sh /usr/local/bin/backup.sh
COPY infra/docker/backup-entrypoint.sh /usr/local/bin/backup-entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/backup-entrypoint.sh

ENTRYPOINT ["backup-entrypoint.sh"]
