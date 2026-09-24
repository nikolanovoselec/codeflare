#!/bin/sh
set -eu

if cmp -s "$1" "$2"; then
  exit 0
else
  status=$?
fi

if [ "$status" -ne 1 ]; then
  printf 'ERROR: npm tool manifest comparison failed (status %s)\n' "$status" >&2
  exit "$status"
fi

exec npm prune --omit=dev --ignore-scripts --no-audit --no-fund
