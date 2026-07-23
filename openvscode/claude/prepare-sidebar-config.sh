#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "OpenVSCode data directory is required." >&2
  exit 2
fi

exec /usr/local/bin/node /opt/codeflare/openvscode/claude/prepare-sidebar-config.mjs "$1"
