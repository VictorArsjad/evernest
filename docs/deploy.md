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
                                                       └── PUT Portainer /api/stacks/{id}/git/redeploy
                                                           ├── Portainer git-pulls latest compose
                                                           └── repullImageAndRedeploy (:latest)
```

The home server is a Portainer-managed Git stack (compose project at
`/data/compose/<id>/...` on the host). Portainer owns the stack's
filesystem and `docker compose` lifecycle; CI just builds the image and
tells Portainer to redeploy. Bootstrap details: see
[homelab-ci-portainer.md](./homelab-ci-portainer.md).

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
  - `PORTAINER_URL` / `PORTAINER_STACK_ID` / `PORTAINER_ENDPOINT_ID` — see
    [homelab-ci-portainer.md](./homelab-ci-portainer.md) §3.
- **Settings → Secrets → Actions**:
  - `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` — Tailscale admin → Settings →
    OAuth clients. Scope `auth_keys`, tag `tag:ci`.
  - `PORTAINER_API_KEY` — Portainer access token (`ptr_…`).
  - `PORTAINER_GIT_TOKEN` — optional GitHub PAT if Portainer is pulling this
    repo as a private source.
- **Settings → Actions → General → Workflow permissions**: "Read and write
  permissions" (so `GITHUB_TOKEN` can push to GHCR).

### 2. Home-server bootstrap

Use Portainer's UI for a one-time stack create — see
[homelab-ci-portainer.md](./homelab-ci-portainer.md) §1 for the Git stack
fields and environment variables Portainer needs.

Compose file the stack points at:
`infra/docker-compose.homeserver.yml`.

After Portainer pulls and starts the stack once, smoke-check from any
tailnet device:

```bash
ssh victor@<homelab-lan-ip> 'docker exec evernest-tailscale tailscale status'
curl https://<TS_HOSTNAME>.<tail>.ts.net/healthz   # → 200
```

### 3. CI/CD sanity-check

Push a no-op commit to `master`. You should see:

1. `ci` workflow runs → green.
2. `deploy-web` triggers via `workflow_run` → publishes to GH Pages.
3. `deploy-api` triggers in parallel → builds + pushes to GHCR, then
   PUTs Portainer's git/redeploy endpoint.

The GH Pages URL is shown on the `deploy` job summary; the deploy job's
log includes the new image's `:<sha>` tag, and Portainer's stack page
shows the redeploy timestamp.

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

CI uses `infra/docker-compose.homeserver.yml` as the source of truth (it's
what Portainer pulls). Set `EVERNEST_API_IMAGE` in the Portainer stack's UI
to pin a `:<sha>` tag instead of `:latest` if you want belt-and-suspenders.

## What CI cannot verify

These only work after a real push to `master`:

- GitHub Pages publishes to `https://<owner>.github.io/evernest/`.
- The GHCR image actually pushes (requires the `packages: write` permission to
  be enabled at the repo level).
- The Tailscale OAuth client successfully joins the runner to the tailnet.
- The Portainer API responds at `PORTAINER_URL` from the tailnet.
- Portainer can pull the GHCR image and git-pull the repo (if private,
  `PORTAINER_GIT_TOKEN` is set).

If any of those break, the `deploy-api.yml` job will fail with a clear log
(it dumps Portainer's HTTP response body on any 4xx/5xx, see
[homelab-ci-portainer.md](./homelab-ci-portainer.md) §Troubleshooting).
The failure is contained: Portainer only flips the running stack once the
redeploy succeeds end-to-end.

## Reference

- Plan note: `~/obsidian/Everything/Engineering/Evernest/CP7 Deploy Pipeline.md`.
- Tailscale + Docker sidecar pattern: <https://tailscale.com/kb/1282/docker>.
