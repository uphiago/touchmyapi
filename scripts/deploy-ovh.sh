#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tag=${TOUCHMYAPI_IMAGE_TAG:?TOUCHMYAPI_IMAGE_TAG is required}
home_dir=${TOUCHMYAPI_HOME:-$HOME/touchmyapi}
shared_env="$home_dir/shared/.env"
metadata="$home_dir/shared/releases"
compose_file="$root/infra/docker/compose.production.yml"

printf '%s' "$tag" | grep -Eq '^[0-9a-f]{40}$' || {
  printf '%s\n' "invalid immutable image tag" >&2
  exit 1
}
[ -s "$shared_env" ] || {
  printf 'missing host-provisioned environment: %s\n' "$shared_env" >&2
  exit 1
}
env_mode=$(stat -c '%a' "$shared_env" 2>/dev/null || stat -f '%Lp' "$shared_env")
[ "$env_mode" = "600" ] || {
  printf '%s\n' "production environment must be mode 0600" >&2
  exit 1
}
disk_use=$(df -P "$home_dir" | awk 'NR == 2 { gsub("%", "", $5); print $5 }')
[ "${disk_use:-100}" -lt 90 ] || {
  printf '%s\n' "insufficient disk headroom for production release" >&2
  exit 1
}
runner_mode=$(sed -n 's/^RUNNER_MODE=//p' "$shared_env" | tail -n 1)
case "$runner_mode" in
  fixture|\"fixture\"|\'fixture\')
    printf '%s\n' "fixture runner is forbidden in production" >&2
    exit 1
    ;;
esac
install -d -m 0750 "$metadata"

compose() {
  TOUCHMYAPI_IMAGE_TAG="$tag" docker compose --env-file "$shared_env" -f "$compose_file" "$@"
}

compose config --quiet
compose pull api admin-api web admin
compose --profile execution pull worker
compose run --rm migrate
compose run --rm migrate bun packages/db/scripts/configure-connectors.ts
compose up -d --remove-orphans --wait --wait-timeout 180 postgres api admin-api web admin
TOUCHMYAPI_SHARED_ENV="$shared_env" TOUCHMYAPI_IMAGE_TAG="$tag" sh "$root/scripts/smoke-remote.sh"

if [ -s "$metadata/current-sha" ]; then
  cp "$metadata/current-sha" "$metadata/previous-sha"
fi
printf '%s\n' "$tag" > "$metadata/current-sha"
chmod 0640 "$metadata/current-sha"
[ ! -e "$metadata/previous-sha" ] || chmod 0640 "$metadata/previous-sha"
if [ -d "$home_dir/current" ] && [ ! -L "$home_dir/current" ]; then
  printf '%s\n' "refusing to replace non-symlink current directory" >&2
  exit 1
fi
ln -sfn "$root" "$home_dir/current.next"
mv -Tf "$home_dir/current.next" "$home_dir/current"

for repository in touchmyapi-api touchmyapi-web touchmyapi-admin touchmyapi-worker; do
  docker image ls "ghcr.io/uphiago/$repository" --format '{{.Repository}}:{{.Tag}}' |
    while IFS= read -r image; do
      [ -n "$image" ] || continue
      [ "$image" = "ghcr.io/uphiago/$repository:$tag" ] && continue
      docker image rm "$image" >/dev/null 2>&1 || true
    done
done
printf '%s\n' "[deploy] release $tag is healthy"
