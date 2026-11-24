# Host Evernest yourself

This guide sets up Evernest on a server you control, so your household can use
it from their phones. It takes about 20 minutes.

The setup runs four containers on one machine:

- **api**: the Evernest server. It also serves the web app.
- **db**: Postgres, which stores your data. It has no open port.
- **tailscale**: gives the app a private HTTPS address on your
  [Tailscale](https://tailscale.com) network (your *tailnet*).
- **backup**: dumps the database every night.

Only devices on your tailnet can open the app. Nothing is exposed to the
public internet.

## Before you start

You need:

- A Linux machine that stays on, such as a home server or a small VPS. It
  must be x86-64 (amd64): the published image has no ARM build yet. It needs
  Docker with the Compose plugin, git, and `/dev/net/tun`. For a Proxmox LXC
  container, allow the TUN device first.
- A free Tailscale account. In the
  [admin console](https://login.tailscale.com/admin/dns), turn on **MagicDNS**
  and **HTTPS Certificates**.
- The Tailscale app on every phone that will use Evernest, signed in to your
  tailnet.

## 1. Get the files

```bash
git clone https://github.com/VictorArsjad/evernest.git
cd evernest
```

The API image is public on GHCR, so you don't need `docker login`.

## 2. Create a Tailscale auth key

In the Tailscale admin console, open **Settings → Keys → Generate auth key**.
Turn on **Reusable**. Leave **Ephemeral** off, so the server keeps its name
after a restart. Copy the key (`tskey-auth-…`).

## 3. Configure

```bash
cp infra/.env.homeserver.example .env
touch infra/secrets/rclone.conf
```

The empty `rclone.conf` keeps Docker from creating a directory in its place.
You only fill it in if you turn on off-site backups (see [Backups](#backups)).

Open `.env` and set:

| Variable | Value |
| --- | --- |
| `POSTGRES_PASSWORD` | A strong password. Generate one with `openssl rand -hex 24`. |
| `JWT_SECRET` | The output of `openssl rand -hex 32`. |
| `TS_AUTHKEY` | The key from step 2. |
| `TS_HOSTNAME` | The device name on your tailnet. `evernest` is fine. |
| `CORS_ALLOW_ORIGIN`, `PUBLIC_WEB_ORIGIN` | `https://<TS_HOSTNAME>.<tailnet>.ts.net`, with no trailing slash. Your tailnet name is under **DNS** in the admin console. |
| `EVERNEST_API_IMAGE` | `ghcr.io/victorarsjad/evernest-api:latest`, or a commit tag to pin a version. |
| `TZ` | Your time zone (for example `Europe/Berlin`), so the nightly backup runs at night. |

Keep `.env` private. It holds your database password and signing key.

## 4. Start

```bash
docker compose -f infra/docker-compose.homeserver.yml --env-file .env up -d
```

The first start builds the backup image and pulls the others. The API applies
database migrations every time it starts.

Check that it works from any device on your tailnet:

```bash
curl https://<TS_HOSTNAME>.<tailnet>.ts.net/healthz
```

The first HTTPS request can take a few seconds while Tailscale gets the
certificate.

## 5. Open it on your phone

1. Make sure the Tailscale app is connected.
2. Open `https://<TS_HOSTNAME>.<tailnet>.ts.net` and create an account, a
   household, and a baby.
3. Install it to the home screen. On iOS, tap **Share → Add to Home Screen** in
   Safari. On Android, tap **Install app** in Chrome.

## 6. Add caregivers

Each caregiver needs two things:

1. **Access to your tailnet.** Invite them from **Users → Invite users** in the
   Tailscale admin console, or share only the Evernest machine with them from
   **Machines → Share**.
2. **An invite to your household.** In Evernest, open **Settings** and send them
   an invite link.

## Update

```bash
git pull
docker compose -f infra/docker-compose.homeserver.yml --env-file .env up -d
```

The stack pulls the newest image on every `up` and runs migrations on start.
If you pinned a commit tag in `EVERNEST_API_IMAGE`, change the tag first.

## Backups

The backup container runs `pg_dump` every night at 03:30 (change it with
`BACKUP_CRON`). It keeps 7 daily, 4 weekly, and 6 monthly dumps in a Docker
volume on the same machine.

| Task | Command |
| --- | --- |
| Back up now | `make db-backup` |
| Check the latest dump restores | `make db-backup-test` |
| Restore a dump (overwrites live data) | `make db-restore FILE=/backups/evernest-<stamp>.dump` |

**Off-site copies (optional).** A dump on the same disk does not survive a
disk failure. To also upload an encrypted copy to Google Drive, follow the
steps in `infra/secrets/rclone.conf.example`, then set
`RCLONE_REMOTE=gdrive-crypt:` in `.env` and run `up -d` again. Store the crypt
passphrase somewhere other than the server; without it, the copies cannot be
decrypted.

**Backup alerts (optional).** Set `HEALTHCHECK_URL` to a
[healthchecks.io](https://healthchecks.io) ping URL to get alerted when a
nightly backup does not run.

## Import from BabyPlus

Copy the export onto the server, then run the importer inside the API
container:

```bash
docker cp babyplus_data_export.json evernest-api-1:/tmp/export.json
docker exec evernest-api-1 import-babyplus --file=/tmp/export.json --household=<household-uuid> --dry-run
```

Drop `--dry-run` once the summary looks right. See
[import-babyplus.md](import-babyplus.md) for every flag.

## Remove

```bash
docker compose -f infra/docker-compose.homeserver.yml --env-file .env down -v
```

`-v` deletes the database and the local backups. Leave it off to keep your
data. Then remove the machine from the Tailscale admin console.

## Troubleshooting

- **The address doesn't load.** Check that the phone's Tailscale app is
  connected, then run `docker exec evernest-tailscale tailscale status` on the
  server.
- **Certificate errors.** Turn on HTTPS Certificates in the Tailscale admin
  console, then restart the tailscale container.
- **The API keeps restarting.** Run `docker compose -f infra/docker-compose.homeserver.yml logs api`.
  A missing `.env` value or a wrong `POSTGRES_PASSWORD` is the usual cause.
