#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$root/infra/docker/compose.production.yml"
shared_env=${TOUCHMYAPI_SHARED_ENV:-$HOME/touchmyapi/shared/.env}

compose() {
  docker compose --env-file "$shared_env" -f "$compose_file" "$@"
}

compose exec -T api bun -e "const r=await fetch('http://127.0.0.1:3000/health');if(!r.ok)process.exit(1)"
compose exec -T admin-api bun -e "const r=await fetch('http://127.0.0.1:3001/health');if(!r.ok)process.exit(1)"
compose exec -T web bun -e "const r=await fetch('http://127.0.0.1:8080/');if(!r.ok||!(await r.text()).includes('TouchMyAPI'))process.exit(1)"
compose exec -T admin bun -e "const r=await fetch('http://127.0.0.1:8080/');if(!r.ok||!(await r.text()).includes('TouchMyAPI'))process.exit(1)"

if [ -n "${CUSTOMER_PUBLIC_HEALTH_URL:-}" ]; then
  curl --fail --silent --show-error --max-time 15 "$CUSTOMER_PUBLIC_HEALTH_URL" >/dev/null
fi
if [ -n "${ADMIN_PUBLIC_HEALTH_URL:-}" ]; then
  curl --fail --silent --show-error --max-time 15 "$ADMIN_PUBLIC_HEALTH_URL" >/dev/null
fi

printf '%s\n' "[deploy] remote smoke passed"
