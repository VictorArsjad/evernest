#!/bin/sh
set -eu

if [ -n "${DATABASE_URL:-}" ]; then
  echo "running migrations against ${DATABASE_URL}"
  migrate -path /app/migrations -database "$DATABASE_URL" up
else
  echo "DATABASE_URL not set, skipping migrations"
fi

exec server
