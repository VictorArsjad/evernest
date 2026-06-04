# Deploy pipeline (CP7)

This is the operational runbook for the Evernest deploy stack. The design
notes (why GH Pages vs. Cloudflare, why Tailscale vs. Caddy, public-access
flip plan) live alongside the rest of the engineering plans; this file is the
"what do I actually do" version.

## Topology

```
   git push origin master
            │
            ▼
   .github/workflows/ci.yml ─── on green ───┬───► deploy-web.yml ──► GitHub Pages
                                            │      (apps/web/dist published at
                                            │       https://<owner>.github.io/evernest/)
                                            │
                                            └───► deploy-api.yml
                                                   ├── docker build + push
                                                   │     ghcr.io/<owner>/evernest-api:{sha,latest}
                                                   └── tailscale up (ephemeral, tag:ci)
                                                       └── ssh victor@<DEPLOY_HOST>
                                                           └── git pull + compose pull/up
                                                                  on the home server
```

On the home server, the prod compose stack is:

- `db` — postgres 16, internal-only (no published ports).
- `tailscale` — `tailscale/tailscale:latest`, owns the netns. `tailscale serve`
  terminates TLS at `https://<TS_HOSTNAME>.<tail>.ts.net:443` and proxies to
  `http://127.0.0.1:8080` inside the same netns.
- `api` — published GHCR image, `network_mode: service:tailscale`, so the
  tailnet only ever sees the sidecar's interface. Talks to `db` over the
  internal docker network through the shared netns.

The frontend is **not** in compose anymore; GitHub Pages serves it.

## One-time setup

### 1. GitHub repo settings

- **Settings → Pages → Source**: GitHub Actions.
- **Settings → Variables → Actions** (`vars`):
  - `VITE_API_BASE_URL` = `https://<TS_HOSTNAME>.<tail>.ts.net` (no trailing
    slash).
- **Settings → Secrets → Actions**:
  - `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` — Tailscale admin → Settings →
    OAuth clients. Scope `auth_keys`, tag `tag:ci`.
  - `DEPLOY_HOST` — MagicDNS name of the home server (e.g. `evernest`).
  - `DEPLOY_SSH_KEY` — ed25519 private key whose pub is in
    `victor@<DEPLOY_HOST>:~/.ssh/authorized_keys`.
- **Settings → Actions → General → Workflow permissions**: "Read and write
  permissions" (so `GITHUB_TOKEN` can push to GHCR).

### 2. Home-server bootstrap

On the Ubuntu home server (`victor@<DEPLOY_HOST>`):

```bash
git clone git@github.com:<owner>/evernest.git /home/victor/evernest
cd /home/victor/evernest

cp .env.example .env
# Edit .env — at minimum:
#   GHCR_OWNER=<owner-lowercase>
#   TS_AUTHKEY=tskey-auth-...           # reusable, ephemeral=false, tag:server
#   TS_HOSTNAME=evernest
#   POSTGRES_PASSWORD=<strong>
#   JWT_SECRET=<openssl rand -hex 32>
#   CORS_ALLOW_ORIGIN=https://<owner>.github.io
#   PUBLIC_WEB_ORIGIN=https://<owner>.github.io
#   COOKIE_SAMESITE=none
chmod 600 .env

# read:packages PAT for GHCR pull (one-time per server).
echo "$GHCR_PAT" | docker login ghcr.io -u <gh-user> --password-stdin

# Bring the stack up. The first run blocks on tailscale logging in with
# TS_AUTHKEY; subsequent runs reuse the persisted state in the ts-state volume.
docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml --profile prod up -d

# Smoke-check from any tailnet device:
docker exec evernest-tailscale tailscale status
docker exec evernest-tailscale tailscale serve status
curl https://<TS_HOSTNAME>.<tail>.ts.net/healthz   # → 200
```

### 3. CI/CD sanity-check

Push a no-op commit to `master`. You should see:

1. `ci` workflow runs → green.
2. `deploy-web` triggers via `workflow_run` → publishes to GH Pages.
3. `deploy-api` triggers in parallel → builds + pushes to GHCR, then
   ssh-deploys.

The GH Pages URL is shown on the `deploy` job summary; `docker compose ps`
on the home server should show the new image SHA in `IMAGE`.

## Public-access flip

To open the API to the public internet (Tailscale Funnel):

1. Edit `infra/docker/tailscale-serve.json`: set
   `"AllowFunnel"."${TS_CERT_DOMAIN}:443"` from `false` to `true`.
2. Commit + push.
3. Next deploy will roll the change. The hostname and cert don't change.

(If you don't want to wait for the deploy, ssh in and
`docker compose ... up -d tailscale` after the push.)

## Local validation

```bash
make lint                # CI parity
make api-test            # go test -race
make web-build           # vite build w/ default base path
make deploy-fe-build     # vite build with VITE_BASE_PATH=/evernest/ (GH Pages parity)
make compose-prod-config # docker compose config on the merged prod overlay
make image-be            # build the api image locally (linux/amd64)
```

### Standalone home-server stack

For a single-file deploy (no overlay merge), use `infra/docker-compose.homeserver.yml`.
It defaults to the published GHCR image (`EVERNEST_API_IMAGE`, e.g.
`ghcr.io/victorarsjad/evernest-api:743149a`):

```bash
cp infra/.env.homeserver.example .env
# edit .env — passwords, JWT_SECRET, TS_AUTHKEY, web origins
echo "$GHCR_PAT" | docker login ghcr.io -u <gh-user> --password-stdin
docker compose -f infra/docker-compose.homeserver.yml --env-file .env up -d
```

The merged prod overlay (`docker-compose.yml` + `docker-compose.prod.yml`) remains
what CI uses on deploy; set `EVERNEST_API_IMAGE` in `.env` to pin a SHA instead of
`:latest`.

### Experimental: Portainer API homelab CI

Opt-in alternative that redeploys via Portainer’s API (no SSH, no git clone on
the host). Disabled by default — see [homelab-ci-experimental.md](./homelab-ci-experimental.md).

## What CI cannot verify

These only work after a real push to `master`:

- GitHub Pages publishes to `https://<owner>.github.io/evernest/`.
- The GHCR image actually pushes (requires the `packages: write` permission to
  be enabled at the repo level).
- The Tailscale OAuth client successfully joins the runner to the tailnet.
- The SSH-into-tailnet host step actually reaches `<DEPLOY_HOST>`.
- The home server has docker, the right ssh key, and a populated `.env`.

If any of those break, the `deploy-api.yml` job will fail with a clear log;
the failure is contained (no half-deploy state because compose `up -d` is
atomic per service).

## Reference

- Plan note: `~/obsidian/Everything/Engineering/Evernest/CP7 Deploy Pipeline.md`.
- Tailscale + Docker sidecar pattern: <https://tailscale.com/kb/1282/docker>.
