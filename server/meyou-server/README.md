# meyou-server

A thin personal server for the meYou app: one couple, two phones. Phase **S1** is the
skeleton: connection only. It answers `GET /api/v1/ping` (public), `GET /api/v1/me`
and `GET /api/v1/roots` (token needed) and creates the owner token with `init`.
Media, partner and push come in later phases (see `docs/SERVER_PHASES.md`).

Stack: Node.js 22, TypeScript, Fastify, built-in `node:sqlite`, Caddy for HTTPS, Docker.

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
  Copy the link or scan the QR with the app (the app side arrives in phase S2).
* `ping` must answer `{"name":"…","version":"…","features":[]}`. The first request can take a few
  seconds while Caddy gets the certificate. If it fails, see Troubleshooting.
* `init` is safe to run again: it prints "Already initialized" and changes nothing.
  If you lost the link before pairing, stop the stack, delete `/srv/meyou/db` and run `init` again
  (a proper token-rotation command comes in phase S11).

Useful commands (run in `server/meyou-server`):

```bash
docker compose logs -f meyou-server     # server logs (no tokens are logged)
docker compose logs -f caddy            # certificate / proxy logs
docker compose restart meyou-server
docker compose down                     # stop (data stays in /srv/meyou)
```

Put photos and videos you want to browse later into `/srv/meyou/library/Photos` and
`/srv/meyou/library/Videos` (every folder directly under `library/` is a root; `init` creates those two).

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
| Build fails at `apt-get` (deb.debian.org timeout) | The image needs no apt: ffmpeg is the npm package `@ffmpeg-installer/ffmpeg`. Keep `INSTALL_FFMPEG=false` (the default, legacy switch) |
| Build is slow or `npm ci` times out | The build downloads about 110 MB from npm (sharp + the ffmpeg binary). Use `BUILD_NETWORK=host` and/or an `NPM_REGISTRY` mirror in `.env`; just run `sudo ./setup.sh update` again, it resumes from the Docker cache |
| Photos are missing in the app | The library is rescanned every `SCAN_INTERVAL_SECONDS` (default 300); a restart scans at once (`sudo ./setup.sh update`, or `docker compose restart meyou-server`; add `-f docker-compose.own-cert.yml` in own-certificate mode) |
| Image pull / `npm ci` timeouts | Set `NODE_IMAGE`, `CADDY_IMAGE`, `NPM_REGISTRY` mirrors in `.env` (see `.env.example`) |

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `DOMAIN` | – | Public host name (needed by `init` and Caddy) |
| `PUBLIC_URL` | `https://$DOMAIN` | Override the URL put into the pairing link (needed when HTTPS is not on 443) |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Docker/Caddy only: the ports Caddy listens on. Let's Encrypt still checks through PUBLIC port 80, so a custom `HTTP_PORT` only gets a certificate when the provider forwards public 80 to it |
| `DATA_DIR` | `./data` (`/data` in Docker) | `db/`, `library/`, `cache/` live here |
| `SERVER_NAME` | `meYou` | Name shown in the app |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `TRUST_PROXY` | `false` (`true` in compose) | Trust `X-Forwarded-*`; only behind Caddy |
| `RATE_LIMIT_MAX` | `600` | Requests per minute per IP |
| `PUBLIC_RATE_LIMIT_MAX` | `30` | Requests per minute per IP on public routes (`ping`) |
| `MEDIA_RATE_LIMIT_MAX` | `6000` | Requests per minute per IP on `thumb`, `preview`, `file` (a library grid asks for many) |
| `SCAN_INTERVAL_SECONDS` | `300` | Library rescan interval; `0` = scan only at start |
| `UPLOAD_MAX_FILE_MB` | `20480` | Largest file one upload may declare (413 above it) |
| `UPLOAD_MAX_CHUNK_MB` | `8` | Largest single `PATCH` body (the app sends 1 MiB) |
| `UPLOAD_MIN_FREE_MB` | `512` | Free disk space that must stay free after an upload (507 below it) |
| `UPLOAD_SESSION_TTL_HOURS` | `48` | Idle unfinished uploads are discarded after this |
| `UPLOAD_RATE_LIMIT_MAX` | `6000` | Requests per minute per IP on `/uploads` routes |
| `JOIN_RATE_LIMIT_MAX` | `10` | Requests per minute per IP on `POST /join` (public) |
| `MAILBOX_RATE_LIMIT_MAX` | `300` | Requests per minute per IP on `/mailbox` routes |
| `MAILBOX_RETENTION_DAYS` | `30` | Partner messages older than this are deleted |
| `MAILBOX_MAX_MESSAGES` | `1000` | Most messages kept per household (oldest go first) |
| `E2E_MAX_BLOB_KB` | `1024` | Encrypted queue: largest single blob (KB) |
| `E2E_TTL_DAYS` | `30` | Encrypted queue: a blob the partner never fetched is deleted after this many days |
| `E2E_MAX_QUEUE_MB` | `256` | Encrypted queue: most MB waiting for one phone; more is refused with `507 queue_full` |
| `FCM_SERVICE_ACCOUNT_FILE` | – (`/run/secrets/fcm/service-account.json` in compose) | Firebase service-account key (S9). Not set or unusable = no push, `push` is not announced |
| `PUSH_PERIOD_DETAIL` | `false` | R1a: `true` = the push text for a partner's period update says which one (started / in pain / feeling better); the text then passes through Google. `false` = one generic text |
| `PUSH_RATE_LIMIT_MAX` | `60` | Requests per minute per IP on `PUT/DELETE /push/token` |
| `AUTH_FAIL_MAX` | `10` | S11: an address is locked after this many DIFFERENT bad tokens/invite codes (the same wrong value repeated counts once); `0` = off |
| `AUTH_FAIL_WINDOW_MINUTES` | `10` | S11: window in which those failures are counted |
| `AUTH_LOCKOUT_MINUTES` | `15` | S11: how long a locked address gets `429 locked_out` (ping stays public). In memory: a restart clears it |
| `FFMPEG_PATH` | – | Use this ffmpeg instead of the one from npm (optional) |

## API (S1 + S3 + S5 + S7 + S9)

| Route | Auth | Answer |
|---|---|---|
| `GET /api/v1/ping` | public | `{ name, version, features[] }` |
| `GET /api/v1/me` | Bearer | `{ deviceId, role, household: { partner }, features }` |
| `GET /api/v1/roots` | Bearer | `[{ id, name }]` (folders under `library/`) |
| `GET /api/v1/tree?root=&path=&cursor=&limit=` | Bearer | `{ items, nextCursor? }` (folders first, 1..500 per page) |
| `GET /api/v1/items/{id}/thumb?size=256` | Bearer | JPEG thumbnail (images and a video frame) |
| `GET /api/v1/items/{id}/preview` | Bearer | JPEG, longest side 1600 |
| `GET /api/v1/items/{id}/file` | Bearer | the original, HTTP Range (206/416), ETag |
| `GET /api/v1/changes?since=` | Bearer | `{ changes: [{ id, op, root, path, item? }], cursor }` |
| `POST /api/v1/uploads` | Bearer | `{ uploadId, offset }`; the same request again resumes (S5) |
| `PATCH /api/v1/uploads/{id}` | Bearer | body = chunk, header `Upload-Offset`; `{ offset }` or `409 { offset }` (S5) |
| `POST /api/v1/uploads/{id}/complete` | Bearer | the new `Item` (400 incomplete, 422 md5 mismatch) (S5) |
| `PUT /api/v1/push/token` | Bearer | body `{ fcmToken, lang, notify? }` → `{ registered: true }` (S9; `notify: { mood, event }` since S11) |
| `DELETE /api/v1/push/token` | Bearer | `{ removed: true }` (idempotent) (S9) |

There is no delete route. Uploaded files go to `library/<root>/<path>/<name>`; an existing name is never
overwritten (`IMG.jpg` becomes `IMG (1).jpg`). Unfinished uploads wait in `$DATA_DIR/uploads` and are removed after
`UPLOAD_SESSION_TTL_HOURS` of silence.

Errors are keys, not text: `{ "error": "unauthorized" }` (401), `rate_limited` (429), `not_found`,
`bad_request`, `payload_too_large`, `internal_error`, `unsupported_media` (415), `range_not_satisfiable` (416),
`offset_mismatch` (409), `upload_incomplete` (400), `md5_mismatch` (422), `insufficient_storage` (507). Full contract: `docs/API_CONTRACT.md` section D.

### Partner API (S7)
Two devices per server. The owner phone (from `init`) invites, the partner phone joins with a code:

```bash
B=https://YOUR-DOMAIN:18443/api/v1
curl -s -X POST -H "Authorization: Bearer $OWNER_TOKEN" $B/invites          # -> code, expiresAt, link (meyou://join?...)
curl -s -X POST -H 'content-type: application/json' \
     -d '{"code":"<CODE>","deviceName":"Her phone"}' $B/join                # -> deviceId, token (shown once)
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" $B/devices/<deviceId>   # unpair / revoke
```
Messages: `POST /mailbox` (send to the partner), `GET /mailbox?since=<seq>` (replay), `GET /mailbox/ws?since=<seq>`
(WebSocket, token in the `Authorization` header, live delivery). `/ping` announces `mailbox`. Full description:
`docs/API_CONTRACT.md` D.10. Nothing is needed on the VPS besides `sudo ./setup.sh update` (data and tokens are
kept; the database gets one new table).

### Push (S9)
When the partner sends a status, an event, a profile change or an unpair, the server also wakes the other phone
through Google FCM, so the app does not need a permanent notification. The text is generic and localized
(Persian or English, from the language the app registered); **no message content ever goes through Google**.
`profile` and `unpair` are silent (data only). Push failures never fail a mailbox write.

Encrypted queue (`/e2e/*`): the server cannot read the type, so the push is generic: `{type:"e2e", seq}` data only, or, when the sender posts `wake:true`, with the text "New update from your partner". It is skipped when the recipient switched all four notification types (mood, event, diary, period) off.

One-time setup on the VPS (you need the service-account JSON from Firebase > Project settings > Service accounts):

```bash
sudo ./setup.sh push-key ~/meyou-firebase-key.json   # installs it (read-only for the server), restarts, checks it
sudo ./setup.sh push-test --check                    # again, any time: validates the key (no phone needed)
sudo ./setup.sh push-test                            # after the push update of the app (S10): sends a test notification
```
Without the file the server runs as before and does not announce `push`; the log says why
(`push disabled: ...`, never the file's content). Manual way: put the file at `./secrets/service-account.json`
(owner uid 1000, e.g. `install -m 640 -o 1000 -g 1000`), or point `FCM_SECRETS_DIR` in `.env` to another folder, then
`docker compose restart meyou-server`. Routes: `PUT /push/token { fcmToken, lang, notify? }`, `DELETE /push/token`
(`docs/API_CONTRACT.md` D.11). A token that FCM rejects is deleted; temporary FCM or network errors are retried twice
(after 2 s and 10 s). Since S11 a phone can switch off the system notification for status (`mood`) or events (`event`) in the app's Settings: the server then skips the FCM send for that type (the message is still stored and reaches the app); this needs migration 5, which runs by itself at the next start (`sudo ./setup.sh update`). Since R1a (server 1.1.0) the same switches exist for memories (`diary`) and period updates (`period`, migration 6), notifications use the channel `meyou-partner-v2` with sound, and a delete/clear sends a silent push; `PUSH_PERIOD_DETAIL=true` in `.env` lets the period text name the update.

## Maintenance (S11)

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
* One line per answered request: `method route status ms ip device`. The **route pattern** is logged (`/api/v1/items/:id/file`),
  never the real URL, query, header, token, file name or message text. 401/403/429 are `warn`, 5xx `error`; the
  health check's `/ping` is `debug` (hidden).
* Docker keeps at most 3 × 10 MB of logs per container.
* `meyou-server` has a health check (`/ping` every 30 s); `sudo ./setup.sh status` shows `healthy`. Caddy starts only after the server is healthy.
  Both containers have `restart: unless-stopped`, so they come back after a reboot or a crash.

### Backup and restore
What matters, and where it lives (`MEYOU_DATA_DIR`, default `/srv/meyou`):

| Folder | Content | Backup? |
|---|---|---|
| `library/` | **the photos and videos** | yes, this is the data |
| `db/meyou.sqlite` | devices (token hashes), partner messages, index, upload sessions | yes, small |
| `cache/` | thumbnails and previews | no (rebuilt on demand) |
| `uploads/` | unfinished uploads | no |
| `secrets/` (next to `.env`) and `.env` | Firebase key, settings | keep a private copy |

1. **Database** (consistent while the server runs): `sudo ./setup.sh backup` writes
   `<data folder>/backups/meyou-YYYYMMDD-HHMMSS.sqlite` (mode 600, newest 14 kept). It contains token **hashes** and partner
   messages: store it privately. Do **not** copy `meyou.sqlite` with `cp` while the server runs (the WAL file is part of it).
2. **Library** (copy only; the app never deletes on the server, so do not use `--delete`):
   `rsync -a /srv/meyou/library/ backup-user@other-host:/backups/meyou-library/`
   or `tar -C /srv/meyou -czf meyou-library-$(date +%F).tar.gz library`.
3. **Restore** (new or damaged VPS): install as usual (`sudo ./setup.sh`, which runs `init`; ignore that new link), then
```
sudo ./setup.sh stop
sudo rsync -a /backup/meyou-library/ /srv/meyou/library/
sudo cp /backup/meyou-20261018-120000.sqlite /srv/meyou/db/meyou.sqlite
sudo rm -f /srv/meyou/db/meyou.sqlite-wal /srv/meyou/db/meyou.sqlite-shm
sudo chown -R 1000:1000 /srv/meyou
sudo ./setup.sh update          # starts it again; the library is scanned at once
```
   Phones keep working with their old tokens (the restored database knows them). Without a database backup, run
   `sudo ./setup.sh devices`/`init` for a new owner link and pair the phones again; the photos in `library/` are untouched.

### Update procedure
```
cd /path/to/meyou/server/meyou-server
git pull                        # or copy the new folder over the old one (keep .env and secrets/)
sudo ./setup.sh backup          # a database copy first (cheap)
sudo ./setup.sh update          # = docker compose build + up -d, waits for /ping
sudo ./setup.sh status
```
Data, tokens and the library are kept. Database migrations run when the server starts, one transaction each, tracked by
`PRAGMA user_version`: running the same update twice changes nothing. **Do not go back to an older version after an update
that migrated the database**; restore the copy taken before the update instead. The README of each phase says when the
**app** needs a new APK too.

## Develop and test

```bash
npm ci
npm test                       # node:test, real server + real SQLite in temp folders
npm run typecheck && npm run build
DOMAIN=localhost DATA_DIR=./data npm run init
DATA_DIR=./data npm run dev
```

Needs Node 22.13 or newer (`node:sqlite` without a flag). Code layout: `src/config.ts` (env),
`src/db.ts` (schema, migrations), `src/tokens.ts` (token/hash/invite helpers), `src/app.ts` (Fastify,
auth hook, routes), `src/init.ts` (household + owner + link/QR), `src/library.ts` (roots), `src/cli.ts`; media (S3): `src/media/indexer.ts` (scan), `store.ts` (queries),
`routes.ts` (tree/thumb/preview/file/changes), `thumbs.ts` (sharp + ffmpeg, cache), `range.ts`, `mime.ts`,
`metadata.ts`, `ffmpeg.ts` (finds the npm ffmpeg binary); uploads (S5): `src/uploads/service.ts` (sessions, offsets, md5, safe placement, cleanup), `routes.ts`; partner (S7): `src/partner/*`; push (S9): `src/push/messages.ts` (texts, payload shape), `transport.ts` (firebase-admin + credential check; tests use a fake), `service.ts` (token registry, retry, dead-token cleanup), `routes.ts`, `test-command.ts` (`push-test`). Supported for thumbnails: JPEG, PNG, WebP, GIF,
AVIF, HEIF with AV1, MP4/MOV/WebM/MKV frames; HEIC encoded with HEVC answers 415.

## Security notes

* Tokens: 32 random bytes, stored only as SHA-256, compared in constant time, never logged. `rotate-token` and `revoke` replace/disable one at once.
* Repeated bad tokens or invite codes lock the address for a while (see Maintenance > Lockout). Logs hold route patterns only.
* No CORS, request bodies limited to 64 KiB, rate limiting on every route (stricter on public ones).
* `trustProxy` is on only in the compose file, where Caddy is the only way in.
* No secrets in the repo: `.env`, `data/` and key files are git-ignored.
