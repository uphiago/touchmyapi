#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file="$root/infra/docker/compose.production.yml"
shared_env=${TOUCHMYAPI_SHARED_ENV:-$HOME/touchmyapi/shared/.env}

compose() {
  docker compose --env-file "$shared_env" -f "$compose_file" "$@"
}

compose exec -T api bun -e "const r=await fetch('http://127.0.0.1:3000/health');if(!r.ok)process.exit(1)"
compose exec -T api bun -e "const r=await fetch('http://127.0.0.1:3000/api/v1/auth/providers');const b=await r.json();if(!r.ok||!Array.isArray(b.providers))process.exit(1)"
compose exec -T admin-api bun -e "const r=await fetch('http://127.0.0.1:3001/health');if(!r.ok)process.exit(1)"
compose exec -T web bun -e "const r=await fetch('http://127.0.0.1:8080/');if(!r.ok||!(await r.text()).includes('TouchMyAPI'))process.exit(1)"
compose exec -T admin bun -e "const r=await fetch('http://127.0.0.1:8080/');if(!r.ok||!(await r.text()).includes('TouchMyAPI'))process.exit(1)"

# The execution profile must remain disabled until the isolated runner is
# reviewed. Do not start it as part of a smoke check.
if compose --profile execution ps --services --filter status=running | grep -qx worker; then
  printf '%s\n' "worker execution profile is unexpectedly running" >&2
  exit 1
fi

if [ -n "${CUSTOMER_PUBLIC_HEALTH_URL:-}" ]; then
  curl --fail --silent --show-error --max-time 15 "$CUSTOMER_PUBLIC_HEALTH_URL" >/dev/null
fi
if [ -n "${ADMIN_PUBLIC_HEALTH_URL:-}" ]; then
  curl --fail --silent --show-error --max-time 15 "$ADMIN_PUBLIC_HEALTH_URL" >/dev/null
fi

printf '%s\n' "[deploy] remote smoke passed"
