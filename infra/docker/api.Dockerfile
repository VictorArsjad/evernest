# syntax=docker/dockerfile:1.7

# --- Build the Go binaries ---
FROM golang:1.26-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY apps/api/go.mod apps/api/go.sum* ./
RUN go mod download
COPY apps/api/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server
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
