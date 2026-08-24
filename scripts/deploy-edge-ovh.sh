#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
edge_dir=${TOUCHMYAPI_EDGE_HOME:-$HOME/touchmyapi-edge}
source_file=${TOUCHMYAPI_EDGE_CONFIG:-$root/infra/edge/Caddyfile}

# Older release archives predate the tracked edge contract. Preserve the
# independently provisioned edge only when an explicit rollback opts into that
# behavior; a new release must never silently keep an unreviewed edge config.
if [ ! -f "$source_file" ]; then
  [ "${TOUCHMYAPI_ALLOW_MISSING_EDGE:-0}" = "1" ] || {
    printf 'missing tracked edge configuration: %s\n' "$source_file" >&2
    exit 1
  }
  exit 0
fi
[ -d "$edge_dir" ] || {
  printf '%s\n' "missing edge directory: $edge_dir" >&2
  exit 1
}
[ -f "$edge_dir/compose.yml" ] || {
  printf '%s\n' "missing edge Compose file: $edge_dir/compose.yml" >&2
  exit 1
}

compose() {
  docker compose -f "$edge_dir/compose.yml" "$@"
}

compose config --quiet
temporary=$(mktemp "$edge_dir/.Caddyfile.XXXXXX")
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT INT TERM
install -m 0644 "$source_file" "$temporary"
compose run --rm -T -v "$temporary:/etc/caddy/Caddyfile.review:ro" caddy \
  caddy validate --config /etc/caddy/Caddyfile.review --adapter caddyfile

if [ -f "$edge_dir/Caddyfile" ]; then
  install -m 0644 "$edge_dir/Caddyfile" "$edge_dir/Caddyfile.previous"
fi
cp "$temporary" "$edge_dir/Caddyfile"
if ! compose up -d --force-recreate --no-deps caddy; then
  if [ -f "$edge_dir/Caddyfile.previous" ]; then
    cp "$edge_dir/Caddyfile.previous" "$edge_dir/Caddyfile"
    compose up -d --force-recreate --no-deps caddy >/dev/null 2>&1 || true
  fi
  printf '%s\n' "edge recreation failed; previous configuration restored" >&2
  exit 1
fi
printf '%s\n' "[edge] Caddy configuration is active"
