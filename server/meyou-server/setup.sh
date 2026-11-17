#!/usr/bin/env bash
# meYou server: install and maintenance in one script (Ubuntu/Debian VPS, run as root).
#
#   sudo ./setup.sh              install (asks a few questions, builds, starts, prints the pairing link)
#   sudo ./setup.sh update       rebuild the image and restart (data and token are kept)
#   sudo ./setup.sh status       containers + local ping
#   sudo ./setup.sh logs [svc]   follow logs (svc: caddy or meyou-server)
#   sudo ./setup.sh init         print the pairing link again ONLY on a fresh database (see INSTALL.fa.md)
#   sudo ./setup.sh renew-cert <fullchain.pem> <private.key>
#   sudo ./setup.sh push-key <firebase-service-account.json>   install the Firebase key, restart, check it
#   sudo ./setup.sh push-test [--check]   send a test notification to the registered phones
#   sudo ./setup.sh devices      list the phones that may use the server (no tokens are shown)
#   sudo ./setup.sh rotate-token [<deviceId>|owner]   new token + link for one phone (the old one stops working)
#   sudo ./setup.sh revoke <deviceId>   remove a lost phone from the server
#   sudo ./setup.sh backup       consistent copy of the database into <data folder>/backups (keeps the last 14)
#   sudo ./setup.sh stop         stop everything (data stays in the data folder)
#
# Works on networks where Docker Hub, npm or Debian are blocked or slow: it picks mirrors by testing them
# and builds with the host network. Answers can also be given as environment variables
# (DOMAIN, HTTPS_PORT, MODE=own-cert|auto, CERT_FILE, KEY_FILE, SERVER_NAME) with NONINTERACTIVE=1.
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="meyou-server:local"
ENV_FILE=".env"
HUB_NODE="node:22-slim"
ECR_NODE="public.ecr.aws/docker/library/node:22-slim"
HUB_CADDY="caddy:2"
ECR_CADDY="public.ecr.aws/docker/library/caddy:2"
NPM_OFFICIAL="https://registry.npmjs.org/"
NPM_MIRROR="https://registry.npmmirror.com"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
warn() { printf '\033[33m!! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

need_root()   { [ "$(id -u)" -eq 0 ] || die "Run as root:  sudo ./setup.sh $*"; }
need_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install it first (Ubuntu: curl -fsSL https://get.docker.com | sh), then run this again."
  docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is missing. Install the docker-compose-plugin package."
}

# ---- .env helpers ------------------------------------------------------------------
get_env() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }
set_env() {
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  grep -vE "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
}
# ask VAR "question" "default"  -> value from the environment, else the question, else the default
ask() {
  local q="$2" def="$3" cur="${!1:-}" ans
  if [ -n "$cur" ]; then printf '%s' "$cur"; return; fi
  if [ "${NONINTERACTIVE:-0}" = "1" ] || [ ! -t 0 ]; then printf '%s' "$def"; return; fi
  read -r -p "   $q [$def]: " ans </dev/tty
  printf '%s' "${ans:-$def}"
}

mode()         { local m; m="$(get_env MEYOU_MODE)"; printf '%s' "${m:-own-cert}"; }
compose_file() { if [ "$(mode)" = "auto" ]; then echo docker-compose.yml; else echo docker-compose.own-cert.yml; fi; }
compose()      { docker compose -f "$(compose_file)" "$@"; }

port_in_use() { ss -tln 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1$"; }
our_caddy_running() { compose ps --services --status running 2>/dev/null | grep -qx caddy; }

# ---- mirrors -----------------------------------------------------------------------
pick_images_and_registry() {
  say "Checking which download sources work from this server"
  local node caddy npm
  node="$(get_env NODE_IMAGE)"; caddy="$(get_env CADDY_IMAGE)"; npm="$(get_env NPM_REGISTRY)"
  if [ -z "$node" ]; then
    if timeout 45 docker pull "$HUB_NODE" >/dev/null 2>&1; then node="$HUB_NODE"; info "Docker Hub works"
    else node="$ECR_NODE"; info "Docker Hub is not reachable, using the Amazon ECR mirror"; fi
  fi
  if [ -z "$caddy" ]; then
    case "$node" in public.ecr.aws/*) caddy="$ECR_CADDY" ;; *) caddy="$HUB_CADDY" ;; esac
  fi
  if [ -z "$npm" ]; then
    if curl -sfm 10 -o /dev/null "${NPM_OFFICIAL}fastify"; then npm="$NPM_OFFICIAL"; info "npm registry works"
    else npm="$NPM_MIRROR"; info "npm registry is not reachable, using $NPM_MIRROR"; fi
  fi
  set_env NODE_IMAGE "$node"; set_env CADDY_IMAGE "$caddy"; set_env NPM_REGISTRY "$npm"
}

# ---- certificate discovery (own-cert mode) -------------------------------------------
cert_matches_domain() { openssl x509 -in "$1" -noout -text 2>/dev/null | grep -qiE "DNS:(\*\.)?${2//./\\.}([,[:space:]]|$)|CN ?= ?${2//./\\.}"; }
key_matches_cert() {
  local a b
  a="$(openssl x509 -in "$1" -noout -pubkey 2>/dev/null | sha256sum | cut -d' ' -f1)"
  b="$(openssl pkey -in "$2" -pubout 2>/dev/null | sha256sum | cut -d' ' -f1)"
  [ -n "$a" ] && [ "$a" = "$b" ]
}
find_cert_pair() {   # prints "cert key" for the first certificate of $1 that has a matching key next to it
  local domain="$1" dirs c d k
  dirs="${CERT_SEARCH_DIRS:-/root/cert /root/.acme.sh /etc/letsencrypt/live /etc/x-ui /usr/local/x-ui /etc/ssl /opt}"
  # shellcheck disable=SC2086
  while IFS= read -r c; do
    cert_matches_domain "$c" "$domain" || continue
    d="$(dirname "$c")"
    while IFS= read -r k; do
      if key_matches_cert "$c" "$k"; then printf '%s %s\n' "$c" "$k"; return 0; fi
    done < <(find "$d" -maxdepth 1 \( -name '*.key' -o -name 'privkey*.pem' -o -name 'private*.pem' \) 2>/dev/null)
  done < <(find $dirs -maxdepth 4 \( -name 'fullchain*' -o -name '*.crt' -o -name '*.cer' -o -name 'cert.pem' \) -type f 2>/dev/null | grep -v '/ca-certificates/' || true)
  return 1
}

# ---- build / start / checks ---------------------------------------------------------
build_image() {
  say "Building the server image (a few minutes the first time)"
  # --network host: Docker's own bridge network times out on some VPS providers.
  docker build --network host -t "$IMAGE" \
    --build-arg "NODE_IMAGE=$(get_env NODE_IMAGE)" \
    --build-arg "NPM_REGISTRY=$(get_env NPM_REGISTRY)" .
}
start_stack() { say "Starting"; compose up -d; }

local_ping() {   # ping through Caddy on this machine (proves certificate + proxy + server)
  local domain port
  domain="$(get_env DOMAIN)"; port="$(get_env HTTPS_PORT)"; port="${port:-443}"
  curl -sfm 8 --resolve "$domain:$port:127.0.0.1" "https://$domain:$port/api/v1/ping"
}
wait_ping() {
  local out
  for _ in $(seq 1 40); do
    if out="$(local_ping 2>/dev/null)"; then printf '%s\n' "$out"; return 0; fi
    sleep 3
  done
  return 1
}
open_firewall() {
  command -v ufw >/dev/null 2>&1 || return 0
  ufw status 2>/dev/null | grep -q 'Status: active' || return 0
  say "Opening the port in ufw"
  ufw allow "$1/tcp" >/dev/null && info "ufw: allowed $1/tcp"
  if [ "$(mode)" = "auto" ]; then ufw allow "$(get_env HTTP_PORT)/tcp" >/dev/null || true; fi
}

# ---- commands ------------------------------------------------------------------------
cmd_install() {
  need_root install; need_docker
  say "meYou server setup"
  local domain port name data m cert key pair
  domain="$(ask DOMAIN 'Domain name of this server (DNS already points here)' "$(get_env DOMAIN)")"
  [ -n "$domain" ] || die "DOMAIN is required (example: DOMAIN=meyou.example.com sudo -E ./setup.sh)"
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "DOMAIN must be a bare host name (no https://, no port, no path)"
  m="$(ask MODE 'Certificate: own-cert (use a certificate you already have; no port 80 needed) or auto (Let'"'"'s Encrypt; needs public port 80)' "$(mode)")"
  case "$m" in own-cert|auto) ;; *) die "MODE must be own-cert or auto" ;; esac
  port="$(ask HTTPS_PORT 'HTTPS port (443 if free, otherwise a free high port such as 18443)' "$(get_env HTTPS_PORT || true)")"
  port="${port:-443}"
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "HTTPS_PORT must be a number between 1 and 65535"
  if port_in_use "$port" && ! our_caddy_running; then
    die "Port $port is already used by another program. Pick another one (for example 18443) and run again."
  fi
  name="$(ask SERVER_NAME 'Name shown in the app' "$(get_env SERVER_NAME)")"; name="${name:-meYou}"
  data="$(get_env MEYOU_DATA_DIR)"; data="${data:-/srv/meyou}"

  set_env DOMAIN "$domain"; set_env HTTPS_PORT "$port"; set_env MEYOU_MODE "$m"
  set_env SERVER_NAME "$name"; set_env MEYOU_DATA_DIR "$data"
  if [ "$port" = "443" ]; then set_env PUBLIC_URL "https://$domain"; else set_env PUBLIC_URL "https://$domain:$port"; fi
  [ "$m" = "auto" ] && { [ -n "$(get_env HTTP_PORT)" ] || set_env HTTP_PORT 80; }
  if [ "$m" = "auto" ] && port_in_use "$(get_env HTTP_PORT)" && ! our_caddy_running; then
    die "Port $(get_env HTTP_PORT) (HTTP) is used by another program, and Let's Encrypt needs public port 80. Use MODE=own-cert instead."
  fi

  say "Data folder"
  mkdir -p "$data"; chown -R 1000:1000 "$data"; info "$data (owned by uid 1000)"

  if [ "$m" = "own-cert" ]; then
    say "Certificate for $domain"
    cert="${CERT_FILE:-}"; key="${KEY_FILE:-}"
    if [ -z "$cert" ] || [ -z "$key" ]; then
      if pair="$(find_cert_pair "$domain")"; then
        cert="${pair% *}"; key="${pair#* }"
        info "Found a matching certificate and key on this server:"; info "  $cert"; info "  $key"
      else
        warn "No certificate for $domain was found automatically."
        cert="$(ask CERT_FILE 'Path of the certificate file (fullchain)' '')"
        key="$(ask KEY_FILE 'Path of the private key file' '')"
      fi
    fi
    [ -f "$cert" ] && [ -f "$key" ] || die "Certificate or key file not found. Re-run with CERT_FILE=... KEY_FILE=... or use MODE=auto."
    cert_matches_domain "$cert" "$domain" || die "This certificate is not for $domain."
    key_matches_cert "$cert" "$key" || die "The private key does not belong to this certificate."
    if ! openssl x509 -in "$cert" -noout -checkend 604800 >/dev/null 2>&1; then
      warn "This certificate expires within 7 days (or already expired). Renew it first."
    fi
    ./scripts/copy-cert.sh "$cert" "$key"
  fi

  pick_images_and_registry
  open_firewall "$port"
  build_image
  start_stack

  say "Waiting for the server to answer through HTTPS on this machine"
  if wait_ping; then info "OK: the server answers."; else
    warn "No answer yet. Look at the logs:  sudo ./setup.sh logs"; exit 1
  fi

  say "Owner pairing link (shown ONCE: save it somewhere private)"
  compose exec -T meyou-server meyou-server init

  cat <<EOF2

Next:
  1. Open the port $port (TCP) in your provider's firewall too, if it has one.
  2. From a phone on mobile data open  $(get_env PUBLIC_URL)/api/v1/ping  (you should see the JSON).
  3. In the app: Settings > Server connection > paste the link (or scan the QR code), then Save.
EOF2
}

cmd_update() {
  need_root update; need_docker
  [ -f "$ENV_FILE" ] || die "No .env here: run  sudo ./setup.sh  first."
  build_image; start_stack
  say "Waiting for the server"; wait_ping || { warn "No answer. See: sudo ./setup.sh logs"; exit 1; }
}
cmd_status() {
  need_docker; compose ps; echo
  if out="$(local_ping 2>/dev/null)"; then info "ping (local): $out"; else warn "ping (local) failed"; fi
}
cmd_logs()  { need_docker; compose logs -f --tail=100 "$@"; }
cmd_init()  { need_docker; compose exec -T meyou-server meyou-server init; }
cmd_renew() {
  need_root renew-cert; need_docker
  [ $# -eq 2 ] || die "usage: sudo ./setup.sh renew-cert <fullchain.pem> <private.key>"
  ./scripts/copy-cert.sh "$1" "$2"
}
cmd_push_key() {
  need_root push-key; need_docker
  [ $# -eq 1 ] && [ -f "$1" ] || die "usage: sudo ./setup.sh push-key <firebase-service-account.json>"
  [ -f "$ENV_FILE" ] || die "No .env here: run  sudo ./setup.sh  first."
  local dir; dir="$(get_env FCM_SECRETS_DIR)"; dir="${dir:-./secrets}"
  # The container runs as uid 1000 and mounts the folder read-only.
  install -d -m 755 "$dir"
  install -m 640 -o 1000 -g 1000 "$1" "$dir/service-account.json"
  info "Key installed in $dir/service-account.json (readable only by the server). Delete your original copy of the file."
  say "Restarting the server"
  compose up -d meyou-server; compose restart meyou-server
  wait_ping || { warn "No answer. See: sudo ./setup.sh logs meyou-server"; exit 1; }
  say "Checking the key"
  compose exec -T meyou-server meyou-server push-test --check
}
cmd_push_test() { need_docker; compose exec -T meyou-server meyou-server push-test "$@"; }
cmd_devices() { need_docker; compose exec -T meyou-server meyou-server devices; }
cmd_rotate()  { need_docker; compose exec -T meyou-server meyou-server rotate-token "$@"; }
cmd_purge()   { need_docker; compose exec -T meyou-server meyou-server purge-legacy; }
cmd_revoke()  {
  need_docker; [ $# -eq 1 ] || die "usage: sudo ./setup.sh revoke <deviceId>   (ids: sudo ./setup.sh devices)"
  compose exec -T meyou-server meyou-server revoke "$1"
}
cmd_backup()  {
  need_docker
  # Written by the server itself (SQLite VACUUM INTO): consistent while the server runs. The path is inside
  # the container; /data is the data folder of the host.
  local name="meyou-$(date +%Y%m%d-%H%M%S).sqlite"
  compose exec -T meyou-server meyou-server backup-db "/data/backups/$name"
  # Keep the newest 14 copies.
  compose exec -T meyou-server sh -c 'ls -1t /data/backups/meyou-*.sqlite 2>/dev/null | tail -n +15 | xargs -r rm -f --'
  info "Copy: $(get_env MEYOU_DATA_DIR)/backups/$name   (it holds the pairing/devices data; photos and memories live on the phones, see README)"
}
cmd_stop()  { need_root stop; need_docker; compose down; info "Stopped. Data is kept in $(get_env MEYOU_DATA_DIR)."; }

case "${1:-install}" in
  install)    cmd_install ;;
  update)     cmd_update ;;
  status)     cmd_status ;;
  logs)       shift; cmd_logs "$@" ;;
  init)       cmd_init ;;
  renew-cert) shift; cmd_renew "$@" ;;
  push-key)   shift; cmd_push_key "$@" ;;
  push-test)  shift; cmd_push_test "$@" ;;
  devices)    cmd_devices ;;
  rotate-token) shift; cmd_rotate "$@" ;;
  revoke)     shift; cmd_revoke "$@" ;;
  purge-legacy) cmd_purge ;;
  backup)     cmd_backup ;;
  stop)       cmd_stop ;;
  -h|--help|help) awk 'NR>1 && /^#/ {print} NR>1 && !/^#/ {exit}' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "Unknown command '$1'. Try:  ./setup.sh help" ;;
esac
