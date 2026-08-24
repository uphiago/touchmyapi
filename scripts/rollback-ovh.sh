#!/bin/sh
set -eu

home_dir=${TOUCHMYAPI_HOME:-$HOME/touchmyapi}
previous_file="$home_dir/shared/releases/previous-sha"
[ -s "$previous_file" ] || {
  printf '%s\n' "no previous release recorded" >&2
  exit 1
}
previous=$(tr -d '\n' < "$previous_file")
printf '%s' "$previous" | grep -Eq '^[0-9a-f]{40}$' || {
  printf '%s\n' "invalid previous release metadata" >&2
  exit 1
}
TOUCHMYAPI_IMAGE_TAG="$previous" sh "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/deploy-ovh.sh"
