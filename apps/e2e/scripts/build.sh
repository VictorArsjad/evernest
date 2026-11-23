#!/usr/bin/env bash
# Build the production-shaped binary the same way infra/docker/api.Dockerfile
# does: web build -> copy into the SPA embed dir -> go build -tags embedspa.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

if [ ! -d "$ROOT/apps/web/node_modules" ]; then
  (cd "$ROOT/apps/web" && npm ci)
fi
(cd "$ROOT/apps/web" && VITE_BASE_PATH=/ VITE_API_BASE_URL="" npm run build)

DIST="$ROOT/apps/api/internal/spa/dist"
rm -rf "$DIST"
cp -R "$ROOT/apps/web/dist" "$DIST"

mkdir -p "$ROOT/apps/api/bin"
(cd "$ROOT/apps/api" && CGO_ENABLED=0 go build -tags embedspa -trimpath -o bin/e2e-server ./cmd/server)
