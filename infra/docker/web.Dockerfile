# syntax=docker/dockerfile:1.7

# --- Build the static bundle ---
FROM node:22-alpine AS build
WORKDIR /src
COPY apps/web/package.json apps/web/package-lock.json* ./
RUN npm ci || npm install
COPY apps/web/ ./
RUN npm run build

# --- Serve via Caddy (prod) ---
FROM caddy:2-alpine AS prod
COPY --from=build /src/dist /srv
COPY infra/docker/web.Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
