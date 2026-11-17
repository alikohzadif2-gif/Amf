#!/bin/sh
# Copy an existing certificate for DOMAIN into the folder Caddy reads, then reload Caddy.
# Usage:  ./scripts/copy-cert.sh /path/to/fullchain.pem /path/to/private.key
# Run it again after every renewal of the certificate (it is safe to repeat).
set -eu
[ $# -eq 2 ] || { echo "usage: $0 <fullchain.pem> <private.key>" >&2; exit 2; }
DEST="${CERT_DIR:-/srv/meyou-certs}"
mkdir -p "$DEST"
cp -L "$1" "$DEST/fullchain.pem"
cp -L "$2" "$DEST/privkey.pem"
chmod 644 "$DEST/fullchain.pem"
chmod 600 "$DEST/privkey.pem"
echo "Copied to $DEST"
openssl x509 -in "$DEST/fullchain.pem" -noout -subject -enddate || true
cd "$(dirname "$0")/.."
if docker compose -f docker-compose.own-cert.yml ps --status running --services 2>/dev/null | grep -qx caddy; then
  docker compose -f docker-compose.own-cert.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile
  echo "Caddy reloaded"
fi
