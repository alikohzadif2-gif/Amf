# meyou-server 2.0

A **very light** personal server for the meYou app: one couple, two phones. It does four things only:
pairing (token, devices, invite/join), a **temporary encrypted queue** between the two phones (`/e2e/queue`,
`/e2e/ws`), push wake-ups through Firebase (FCM) and a lock against token guessing. It never stores photos,
videos, memories, events or chat: the phones keep those and send each other **end-to-end encrypted blobs** that the
server cannot read. A blob is deleted when the partner's phone acknowledges it (or after `E2E_TTL_DAYS`).

Stack: Node.js 22, TypeScript, Fastify, built-in `node:sqlite`, Caddy for HTTPS, Docker. No native dependencies
(no sharp, no ffmpeg), no background scanning and no polling: the only timers are an hourly clean-up, a 30 s socket
check and the WebSocket pings. The container is capped at 256 MB (Node heap 128 MB) so it can share a small VPS with other
services; the real RAM use has not been measured yet (check `docker stats` after the first week).

> **Upgrading from 1.x?** See "Update procedure > Upgrading from 1.x" below. The 2.0 server needs the 2B+ app
> (the old app used `/mailbox`, `/tree`, `/uploads`, which no longer exist).

## Deploy on your VPS (exact steps)

Before you start (your tasks):

1. DNS: an **A record** for the sub-domain (for example `meyou.example.com`) pointing at the server IP.
2. Docker and Docker Compose are installed on the VPS; ports **80** and **443** are open (also in the provider's firewall).
3. A permanent data folder, owned by uid 1000 (the user inside the container):
   ```bash
   sudo mkdir -p /srv/meyou && sudo chown -R 1000:1000 /srv/meyou
   ```

Then:

```bash
git clone <your-repo-url> meyou && cd meyou/server/meyou-server
cp .env.example .env
nano .env                       # set DOMAIN (and MEYOU_DATA_DIR if you chose another folder)
docker compose up -d --build
docker compose exec meyou-server meyou-server init
curl https://YOUR-DOMAIN/api/v1/ping
```

* **Port 443 not available?** Put `HTTPS_PORT=8443` and `PUBLIC_URL=https://YOUR-DOMAIN:8443` in `.env`
  (and open that port in the firewall). Port 80 must stay open: the certificate is proven through it.
  Then use `https://YOUR-DOMAIN:8443/...` in the `curl` line and in the app.
* `init` prints a **link** (`meyou://server?url=…&token=…&name=…`), an ASCII **QR code** and the same
  data as JSON. This is the only time the owner token is shown: the server stores only its hash.
  Copy the link or scan the QR with the app (Settings > Server connection).
* `ping` must answer `{"name":"…","version":"2.0.0","features":["e2e"]}` (`"push"` is added once the Firebase key is installed). The first request can take a few
  seconds while Caddy gets the certificate. If it fails, see Troubleshooting.
* `init` is safe to run again: it prints "Already initialized" and changes nothing.
  If you lost the owner link, run `sudo ./setup.sh rotate-token` for a new one (see Maintenance).

Useful commands (run in `server/meyou-server`):

```bash
docker compose logs -f meyou-server     # server logs (no tokens are logged)
docker compose logs -f caddy            # certificate / proxy logs
docker compose restart meyou-server
docker compose down                     # stop (data stays in /srv/meyou)
```


### Ports 80 and 443 not available, but you already have a certificate for the domain

Let's Encrypt can only check a domain through public port 80 or 443. If both are taken (for example by a VPN
panel) but a valid certificate for `DOMAIN` already exists on this server, use it: no port 80, any HTTPS port.

```bash
# 1. find the two files of the existing certificate (fullchain + private key), e.g. in /root/cert/... or ~/.acme.sh/...
# 2. copy them where Caddy reads them (repeat this after every renewal)
./scripts/copy-cert.sh /path/to/fullchain.pem /path/to/private.key
# 3. .env: DOMAIN, HTTPS_PORT=18443 (a free port), PUBLIC_URL=https://YOUR-DOMAIN:18443
# 4. start with the own-certificate compose file (instead of docker-compose.yml)
docker compose -f docker-compose.own-cert.yml up -d --build
docker compose -f docker-compose.own-cert.yml exec meyou-server meyou-server init
curl https://YOUR-DOMAIN:18443/api/v1/ping
```

Only `HTTPS_PORT` is opened. The certificate must be for exactly `DOMAIN`. Use the same `-f docker-compose.own-cert.yml`
in every later `docker compose` command (`logs`, `restart`, `down`).


### Troubleshooting

| Symptom | Check |
|---|---|
| `curl` times out | DNS A record correct (`dig +short YOUR-DOMAIN`), ports 80/443 open in the VPS firewall |
| Certificate error | `docker compose logs caddy`; the domain must resolve to this server and port 80 must be reachable |
| `EACCES` in `meyou-server` logs | `sudo chown -R 1000:1000 /srv/meyou` |
| `service "meyou-server" ... DOMAIN` error | `.env` is missing or `DOMAIN` is empty |
| Build is slow or `npm ci` times out | The build downloads only pure-JavaScript packages (about 30 MB). Use `BUILD_NETWORK=host` and/or an `NPM_REGISTRY` mirror in `.env`; `sudo ./setup.sh` picks a working source by itself |
| Image pull / `npm ci` timeouts | Set `NODE_IMAGE`, `CADDY_IMAGE`, `NPM_REGISTRY` mirrors in `.env` (see `.env.example`) |
| Container restarts with "out of memory" | It is capped at `SERVER_MEM_LIMIT` (default 256m, Node heap 128 MB). Check `docker stats`; raise the cap in `.env` only if the VPS has room |
| App says "queue full" (507) | The partner's phone has not fetched for a long time: `E2E_MAX_QUEUE_MB` of blobs wait for it. It drains when that phone opens the app |

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DOMAIN` | – | Public host name (needed by `init` and Caddy) |
| `PUBLIC_URL` | `https://$DOMAIN` | Override the URL put into the pairing link (needed when HTTPS is not on 443) |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Docker/Caddy only: the ports Caddy listens on. Let's Encrypt still checks through PUBLIC port 80 |
| `DATA_DIR` | `./data` (`/data` in Docker) | `db/` lives here (nothing else is written) |
| `SERVER_NAME` | `meYou` | Name shown in the app |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `TRUST_PROXY` | `false` (`true` in compose) | Trust `X-Forwarded-*`; only behind Caddy |
| `RATE_LIMIT_MAX` | `600` | Requests per minute per IP (routes without their own limit) |
| `PUBLIC_RATE_LIMIT_MAX` | `30` | Requests per minute per IP on public routes (`ping`) |
| `JOIN_RATE_LIMIT_MAX` | `10` | Requests per minute per IP on `POST /join` (public) |
| `MAILBOX_RATE_LIMIT_MAX` | `1200` | Requests per minute per IP on `/e2e/*` (name kept for old `.env` files). A 200 MB video is about 270 chunks of 750 KB; a sender with 8 chunks in flight does at most ~480 POST/min, the receiver adds one GET + one ACK per batch, chat/status come on top: 1200 leaves 2x room and is still a tight cap for one IP |
| `E2E_MAX_BLOB_KB` | `1024` | Encrypted queue: largest single blob (KB). Stays at the 1 MB ceiling; the app's chunks (up to ~750 KB, stage 2D) must fit under it. Body size is this x 4/3 (base64url) + 1 KB |
| `E2E_TTL_DAYS` | `30` | A blob the partner never fetched is deleted after this many days |
| `E2E_MAX_QUEUE_MB` | `256` | Most MB waiting for one phone; more is refused with `507 queue_full` |
| `SERVER_MEM_LIMIT` | `256m` | Docker/compose only: hard memory cap of the server container (swap off). Node's heap is capped at 128 MB (`NODE_OPTIONS`) |
| `FCM_SERVICE_ACCOUNT_FILE` | – (`/run/secrets/fcm/service-account.json` in compose) | Firebase service-account key. Not set or unusable = no push, `push` is not announced |
| `PUSH_RATE_LIMIT_MAX` | `60` | Requests per minute per IP on `PUT/DELETE /push/token` |
| `AUTH_FAIL_MAX` | `10` | An address is locked after this many DIFFERENT bad tokens/invite codes (the same wrong value repeated counts once); `0` = off |
| `AUTH_FAIL_WINDOW_MINUTES` | `10` | Window in which those failures are counted |
| `AUTH_LOCKOUT_MINUTES` | `15` | How long a locked address gets `429 locked_out` (ping stays public). In memory: a restart clears it |

Removed in 2.0 (old `.env` lines are ignored, nothing breaks): `SCAN_INTERVAL_SECONDS`, `UPLOAD_*`, `MEDIA_RATE_LIMIT_MAX`,
`MAILBOX_RETENTION_DAYS`, `MAILBOX_MAX_MESSAGES`, `INSTALL_FFMPEG`, `FFMPEG_PATH`.

## API (2.0)

| Route | Auth | Answer |
|---|---|---|
| `GET /api/v1/ping` | public | `{ name, version, features[] }`, features = `e2e` (+ `push`) |
| `GET /api/v1/me` | Bearer | `{ deviceId, role, household: { partner }, features }` |
| `POST /api/v1/invites` | Bearer (owner) | `{ code, expiresAt, link }` |
| `POST /api/v1/join` | public (code) | `{ deviceId, token }` (token shown once) |
| `DELETE /api/v1/devices/{id}` | Bearer | `{ revoked: true }` (unpair / leave) |
| `POST /api/v1/e2e/queue` | Bearer | body `{ id, blob (base64url), wake? }` → `{ seq, time }` (same `id` again = same row) |
| `GET /api/v1/e2e/queue?since=&limit=` | Bearer | `{ messages: [{ seq, time, id, blob }], cursor, more }` |
| `POST /api/v1/e2e/ack` | Bearer | body `{ seqs: [...] }` → `{ deleted }` (the blobs are removed) |
| `GET /api/v1/e2e/stats` | Bearer | `{ count, bytes }` waiting for this phone |
| `GET /api/v1/e2e/ws?since=` | Bearer (header) | WebSocket: replay, `ready`, `presence` (partner connected or not; sent again on change), then live frames. Frames from the phone are ignored |
| `PUT /api/v1/push/token` | Bearer | body `{ fcmToken, lang, notify? }` → `{ registered: true }` |
| `DELETE /api/v1/push/token` | Bearer | `{ removed: true }` (idempotent) |

Gone in 2.0 (404): `/roots`, `/tree`, `/items/*`, `/changes`, `/uploads/*`, `/mailbox`, `/mailbox/ws`.

Errors are keys, not text: `{ "error": "unauthorized" }` (401), `rate_limited` (429), `locked_out` (429), `not_found`,
`bad_request`, `payload_too_large` (413), `no_partner` (409), `household_full` (409), `queue_full` (507),
`internal_error`. Full contract: `docs/API_CONTRACT.md`.

### Pairing
Two devices per server. The owner phone (from `init`) invites, the partner phone joins with a code:

```bash
B=https://YOUR-DOMAIN:18443/api/v1
curl -s -X POST -H "Authorization: Bearer $OWNER_TOKEN" $B/invites          # -> code, expiresAt, link (meyou://join?...)
curl -s -X POST -H 'content-type: application/json' \
     -d '{"code":"<CODE>","deviceName":"Her phone"}' $B/join                # -> deviceId, token (shown once)
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" $B/devices/<deviceId>   # unpair / revoke
```

### Push
When a blob is posted the server wakes the other phone through Google FCM, so the app needs no permanent
notification. The server cannot read what a blob is, so the push is generic and carries **no type and no content**:
data only (`{type:"e2e", seq}`) or, when the sender posts `wake:true`, the visible text "New update from your
partner" (Persian or English from the language the app registered). Silent pushes are coalesced (at most one per
10 s per phone, plus one trailing push), because a video is hundreds of blobs. A visible push is skipped only when
the recipient switched all four notification switches off in the app. Push failures never fail a queue write.

One-time setup on the VPS (you need the service-account JSON from Firebase > Project settings > Service accounts):

```bash
sudo ./setup.sh push-key ~/meyou-firebase-key.json   # installs it (read-only for the server), restarts, checks it
sudo ./setup.sh push-test --check                    # again, any time: validates the key (no phone needed)
sudo ./setup.sh push-test                            # sends a test notification to every registered phone
```
Without the file the server runs and simply does not announce `push`; the log says why (`push disabled: ...`, never
the file's content). Manual way: put the file at `./secrets/service-account.json` (owner uid 1000), or point
`FCM_SECRETS_DIR` in `.env` to another folder, then `docker compose restart meyou-server`. A token that FCM rejects
is deleted; temporary FCM or network errors are retried twice (after 2 s and 10 s).

## Maintenance

All commands run on the VPS in this folder. Without `setup.sh` use
`docker compose exec meyou-server meyou-server <command>` (add `-f docker-compose.own-cert.yml` in own-certificate mode).

### Devices, lost phone, leaked token
| Need | Command |
|---|---|
| See the phones that may use the server (id, role, last seen, push) – never a token | `sudo ./setup.sh devices` |
| A token leaked, or you want a fresh one: new token + link + QR for one phone. The old token stops working **at once**; open the new link on that phone | `sudo ./setup.sh rotate-token` (owner) or `sudo ./setup.sh rotate-token <deviceId>` |
| A phone was lost or stolen: remove it from the server (the other phone stays; the last device is refused; if the owner goes, the partner becomes owner) | `sudo ./setup.sh revoke <deviceId>` |

A running server closes the live connection of a re-keyed or revoked device within 30 seconds. In the app, a phone with a
rejected token shows "The server did not accept the token" in Settings > Server connection: remove that server entry and add the new link.

### Lockout
An address that sends many **different** wrong tokens or invite codes (default 10 in 10 minutes) gets
`429 {"error":"locked_out","retryAfter":<seconds>}` for 15 minutes, even with a valid token; `/ping` stays public.
A phone that keeps retrying with one revoked token does not count again and never locks the Wi-Fi it shares with its partner.
Tune with `AUTH_FAIL_MAX`, `AUTH_FAIL_WINDOW_MINUTES`, `AUTH_LOCKOUT_MINUTES` in `.env` (`AUTH_FAIL_MAX=0` turns it off).
Locks are logged as `address locked ...` (see `sudo ./setup.sh logs meyou-server`) and are cleared by a restart.

### Logs and health
* One line per answered request: `method route status ms ip device`. The **route pattern** is logged (`/api/v1/e2e/queue`),
  never the real URL, query, header, token, blob or id. 401/403/429 are `warn`, 5xx `error`; the
  health check's `/ping` is `debug` (hidden).
* Docker keeps at most 3 x 10 MB of logs per container.
* `meyou-server` has a health check (`/ping` every 30 s); `sudo ./setup.sh status` shows `healthy`. Caddy starts only after the server is healthy.
  Both containers have `restart: unless-stopped`, so they come back after a reboot or a crash.

### Backup and restore
Everything the server keeps lives in `MEYOU_DATA_DIR` (default `/srv/meyou`):

| Item | Content | Backup? |
|---|---|---|
| `db/meyou.sqlite` | devices (token **hashes**), invites, the encrypted blobs still waiting | yes, small |
| `secrets/` (next to `.env`) and `.env` | Firebase key, settings | keep a private copy |

Photos, memories, events and chat are **not** on the server: they live in each phone's vault (back them up from the app).

1. **Database** (consistent while the server runs): `sudo ./setup.sh backup` writes
   `<data folder>/backups/meyou-YYYYMMDD-HHMMSS.sqlite` (mode 600, newest 14 kept). It contains token hashes and the
   encrypted blobs waiting in the queue: store it privately. Do **not** copy `meyou.sqlite` with `cp` while the server runs.
2. **Restore**: install as usual, then `sudo ./setup.sh stop`, copy the `.sqlite` to `/srv/meyou/db/meyou.sqlite`,
   `sudo rm -f /srv/meyou/db/meyou.sqlite-wal /srv/meyou/db/meyou.sqlite-shm`, `sudo chown -R 1000:1000 /srv/meyou`,
   `sudo ./setup.sh update`. Phones keep working with their old tokens. Without a database backup, run
   `sudo ./setup.sh devices`/`init` for a new owner link and pair the phones again.

### Update procedure
```
cd /path/to/meyou/server/meyou-server
git pull                        # or copy the new folder over the old one (keep .env and secrets/)
sudo ./setup.sh backup          # a database copy first (cheap)
sudo ./setup.sh update          # = docker build + up -d, waits for /ping
sudo ./setup.sh status
```
Data and tokens are kept. Database migrations run when the server starts, one transaction each, tracked by
`PRAGMA user_version`: running the same update twice changes nothing. **Do not go back to an older version after an
update that migrated the database**; restore the copy taken before the update instead.

#### Upgrading from 1.x to 2.0
`sudo ./setup.sh update` is enough: no migration is added, tokens, devices and the phones' pairing are untouched.
Afterwards (all optional):

* `docker compose exec meyou-server meyou-server purge-legacy` empties the 1.x tables that 2.0 no longer reads
  (**the old plaintext partner mailbox**, media index, change log, upload sessions) and shrinks the database. Take a
  `backup` first; it cannot be undone. Without it those rows just sit in the file (the 1.x pruning no longer runs).
* The folders `library/`, `uploads/` and `cache/` inside `MEYOU_DATA_DIR` are no longer used. `purge-legacy` does **not**
  delete them (the library may hold the only copy of someone's photos): check, copy what you need, then remove them yourself.
* Old `.env` lines (`SCAN_INTERVAL_SECONDS`, `UPLOAD_*`, `INSTALL_FFMPEG`, ...) can stay or go.
* The app must be 2B or newer: an old app calls routes that now answer 404.

## Develop and test

```bash
npm ci
npm test                       # node:test, real server + real SQLite in temp folders
npm run typecheck && npm run build
DOMAIN=localhost DATA_DIR=./data npm run init
DATA_DIR=./data npm run dev
```

Needs Node 22.13 or newer (`node:sqlite` without a flag). Code layout: `src/config.ts` (env), `src/db.ts` (schema,
migrations; tables `items`, `changes`, `uploads`, `mailbox` are 1.x leftovers, never read), `src/tokens.ts`
(token/hash/invite helpers), `src/result.ts`, `src/app.ts` (Fastify, auth hook, routes), `src/household.ts` +
`household-routes.ts` (invite, join, revoke), `src/e2e/*` (`queue.ts` blobs and push triggers, `hub.ts` WebSocket
fan-out, `routes.ts`, `coalesce.ts`), `src/push/*` (FCM), `src/lockout.ts`, `src/init.ts`, `src/admin.ts` (CLI helpers), `src/cli.ts`.

## Security notes

* Tokens: 32 random bytes, stored only as SHA-256, compared in constant time, never logged. `rotate-token` and `revoke` replace/disable one at once.
* The server only ever holds opaque encrypted blobs (XChaCha20-Poly1305, keys exist only on the two phones). It knows who sent a blob to whom, when and how big.
* Repeated bad tokens or invite codes lock the address for a while (see Maintenance > Lockout). Logs hold route patterns only.
* No CORS, request bodies limited to 64 KiB (the queue route allows one blob plus JSON), rate limiting on every route (stricter on public ones).
* `trustProxy` is on only in the compose file, where Caddy is the only way in.
* No secrets in the repo: `.env`, `data/` and key files are git-ignored.
