# Homelab CI via Portainer API (experimental)

Reusable pattern for deploying containerized apps to a home server **without
SSH or manual Portainer clicks after bootstrap**. This repo ships an experimental
workflow; copy the idea to other homelab projects.

**Default prod path is unchanged:** `deploy-api.yml` still SSHs into the server.
This experimental workflow is opt-in and disabled until you flip
`HOMELAB_DEPLOY_ENABLED=true`.

## How it works

```
push master → ci green → deploy-api-homelab-experimental
                              ├── build + push ghcr.io/.../evernest-api:{sha,latest}
                              └── tailscale join → PUT Portainer /stacks/{id}/git/redeploy
                                                      ├── git pull latest compose
                                                      └── repullImageAndRedeploy (:latest)
```

Portainer remains the source of truth for the running stack. CI never SSHs and
never runs `docker compose` on the host.

## One-time Portainer bootstrap (~10 min)

Do this once per app/stack. After that, only CI touches deploys.

### 1. Git stack in Portainer

**Stacks → Add stack → Git repository**

| Field | Evernest value |
|---|---|
| Name | `evernest` |
| Repository URL | `https://github.com/victorarsjad/evernest` |
| Repository reference | `refs/heads/master` |
| Compose path | `infra/docker-compose.homeserver.yml` |
| Authentication | GitHub PAT (`repo` scope) if the repo is private |

**Stack environment variables** (Portainer UI — not committed to git):

| Variable | Example |
|---|---|
| `POSTGRES_PASSWORD` | strong random |
| `JWT_SECRET` | `openssl rand -hex 32` |
| `EVERNEST_API_IMAGE` | `ghcr.io/victorarsjad/evernest-api:latest` |
| `CORS_ALLOW_ORIGIN` | `https://victorarsjad.github.io/evernest` |
| `PUBLIC_WEB_ORIGIN` | same as CORS |
| `COOKIE_SAMESITE` | `none` |
| `TS_AUTHKEY` | reusable Tailscale auth key |
| `TS_HOSTNAME` | `evernest` |

Deploy the stack once. Confirm `curl https://<TS_HOSTNAME>.<tail>.ts.net/healthz`.

**Registry:** if GHCR is private, add credentials under **Registries** so
Portainer can pull the API image.

### 2. Collect Portainer IDs

From a machine that can reach Portainer (browser or curl on tailnet):

```bash
# API token: Portainer → User menu → Account settings → Access tokens

export PORTAINER_URL="https://<your-portainer-host>:9443"   # tailnet-reachable
export PORTAINER_API_KEY="ptr_..."

# Endpoint ID (usually 1 for "local")
curl -sS "$PORTAINER_URL/api/endpoints" -H "X-API-Key: $PORTAINER_API_KEY" | jq '.[] | {Id, Name}'

# Stack ID
curl -sS "$PORTAINER_URL/api/stacks" -H "X-API-Key: $PORTAINER_API_KEY" | jq '.[] | {Id, Name}'
```

Note the numeric **stack Id** and **endpoint Id**.

### 3. GitHub repo configuration

The split between `vars` and `secrets` follows what's actually sensitive: the
API key (and optional git PAT) live in `secrets`; the URL and IDs live in
`vars` so they're visible in the Actions UI for debugging.

**Variables** (Settings → Secrets and variables → Actions → Variables):

| Name | Value |
|---|---|
| `HOMELAB_DEPLOY_ENABLED` | `true` when ready (leave unset/`false` while testing) |
| `PORTAINER_URL` | Base URL, tailnet-reachable (e.g. `https://ubuntu.<tail>.ts.net:9443`) |
| `PORTAINER_STACK_ID` | Numeric stack id |
| `PORTAINER_ENDPOINT_ID` | Numeric endpoint id (usually `1`) |

**Secrets** (Settings → Secrets and variables → Actions → Secrets):

| Name | Purpose |
|---|---|
| `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` | Same as prod — runner joins tailnet to reach Portainer |
| `PORTAINER_API_KEY` | Access token (`ptr_...`) |
| `PORTAINER_GIT_TOKEN` | Optional — GitHub PAT if Portainer stack pulls a private repo |

**Important:** while experimenting, keep `HOMELAB_DEPLOY_ENABLED` false (or
unset) so you do not double-deploy alongside `deploy-api.yml` SSH on every push.

### 4. Smoke-test

```bash
# Manual trigger first — Actions → deploy-api-homelab-experimental → Run workflow
```

Check Portainer stack logs and `curl .../healthz`.

## Copying to another homelab repo

1. Copy `.github/workflows/deploy-api-homelab-experimental.yml`.
2. Adjust `file:` in the build step to your Dockerfile path and image name.
3. Point the Portainer Git stack at that repo’s compose file.
4. Set `EVERNEST_API_IMAGE` equivalent to `ghcr.io/<owner>/<app>:latest` in
   Portainer env.
5. Reuse the same GitHub secrets if Portainer/Tailscale live on one homelab;
   use per-app `PORTAINER_STACK_ID` values.

Minimal secret set per app: `PORTAINER_STACK_ID` (+ shared Portainer URL/key/endpoint).

## Portainer API vs SSH (prod)

| | SSH (`deploy-api.yml`) | Portainer API (this doc) |
|---|---|---|
| Runner reachability | Tailscale → SSH | Tailscale → Portainer HTTPS |
| Host needs git clone | Yes (`~/evernest`) | No — Portainer clones |
| Ongoing homelab ops | `git pull` + compose | Portainer `git/redeploy` |
| Portainer UI | Optional | One-time stack create |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `endpointId` / environment not found | Pass correct `PORTAINER_ENDPOINT_ID` query param |
| Git pull fails in redeploy | Set `PORTAINER_GIT_TOKEN` secret; enable auth in Portainer stack |
| Image not updating | Stack env must use `:latest` (or bump tag in Portainer); redeploy sends `repullImageAndRedeploy: true` |
| Runner cannot reach Portainer | Expose Portainer on tailnet (MagicDNS); verify `PORTAINER_URL` |
| Env vars wiped after redeploy | Never send partial `env` in the API body — this workflow omits `env` entirely so Portainer keeps UI-configured vars |
| `curl: (60) SSL certificate problem` | Portainer's default cert is self-signed. The workflow uses `curl -k` since the runner is already on the tailnet; if you front Portainer with Tailscale serve (real cert), you can drop `-k` |

## Reference

- Portainer git redeploy: `PUT /api/stacks/{id}/git/redeploy?endpointId={id}`
- Workflow: `.github/workflows/deploy-api-homelab-experimental.yml`
- Compose file: `infra/docker-compose.homeserver.yml`
