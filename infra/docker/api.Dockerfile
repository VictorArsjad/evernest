# syntax=docker/dockerfile:1.7

# --- Build the web bundle (embedded into the API binary for same-origin) ---
# Same-origin (FE + API on one ts.net host) is what lets the refresh token
# ride a first-party cookie iOS won't evict. Build relative: VITE_API_BASE_URL
# empty -> requests hit /v1 on the serving origin; VITE_BASE_PATH=/ -> assets
# resolve at the root.
FROM node:22-alpine AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
ENV VITE_BASE_PATH=/
ENV VITE_API_BASE_URL=""
RUN npm run build

# --- Build the Go binaries ---
FROM golang:1.26-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY apps/api/go.mod apps/api/go.sum* ./
RUN go mod download
COPY apps/api/ ./
# Embed the built SPA so the server serves the front-end from the same origin.
# The `embedspa` build tag activates apps/api/internal/spa/spa_embed.go's
# //go:embed of this directory; tag-free builds (CI, local) use the noop.
COPY --from=web /web/dist ./internal/spa/dist
RUN CGO_ENABLED=0 GOOS=linux go build -tags embedspa -trimpath -ldflags="-s -w" -o /out/server ./cmd/server
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/import-babyplus ./cmd/import-babyplus

# --- Pull a migrate binary for the target arch from the official image ---
FROM migrate/migrate:v4.17.1 AS migrate

# --- Runtime image ---
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=migrate /usr/local/bin/migrate /usr/local/bin/migrate
COPY --from=build /out/server /usr/local/bin/server
COPY --from=build /out/import-babyplus /usr/local/bin/import-babyplus
COPY apps/api/migrations /app/migrations
COPY infra/docker/api-entrypoint.sh /usr/local/bin/api-entrypoint.sh
RUN chmod +x /usr/local/bin/api-entrypoint.sh
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["api-entrypoint.sh"]
