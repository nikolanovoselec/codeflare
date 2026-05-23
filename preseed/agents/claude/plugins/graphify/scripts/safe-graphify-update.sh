#!/usr/bin/env bash
# safe-graphify-update.sh - drop-in replacement for `graphify update <path>`
# that pins single-worker AST extraction and caps virtual memory so a
# runaway rebuild dies with ENOMEM instead of OOM-killing the whole
# container session.
#
# Reason for existing:
#   The codeflare container is 1 vCPU / 3.2 GB RAM / no swap. A bare
#   `graphify update .` on a dense ~700-file codebase has been observed
#   to take down the entire Claude session by exhausting memory before
#   the kernel could intervene gracefully. Measured peak on graphify
#   0.8.16 + codeflare: 445 MB with GRAPHIFY_MAX_WORKERS=1, well under
#   the cap below; a hypothetical multi-worker run or a future regression
#   would still be bounded by RLIMIT_AS rather than crashing the session.
#
# Tuning knobs (env overrides, all optional):
#   GRAPHIFY_SAFE_RLIMIT_KB  default 2500000  (2.5 GB virtual-memory cap;
#                                              leaves ~700 MB headroom on
#                                              a 3.2 GB container)
#   GRAPHIFY_SAFE_WORKERS    default 1        (AST extraction subprocess
#                                              count; 1 is safest on a
#                                              1 vCPU container)
#
# Forwards "$@" to `graphify update`, so any flag the underlying CLI
# accepts (`--force`, `--no-cluster`, etc.) works unchanged.
#
# Usage:
#   safe-graphify-update.sh .                       # equivalent of `graphify update .`
#   safe-graphify-update.sh . --no-cluster          # forwarded flag
#   GRAPHIFY_SAFE_RLIMIT_KB=3000000 safe-graphify-update.sh .  # raise cap

set -u

CAP_KB="${GRAPHIFY_SAFE_RLIMIT_KB:-2500000}"
WORKERS="${GRAPHIFY_SAFE_WORKERS:-1}"

# RLIMIT_AS cap; inherited by the exec'd graphify child. If graphify
# tries to allocate past it, malloc/mmap returns ENOMEM and graphify
# crashes cleanly - the parent shell (and session) survive.
ulimit -v "$CAP_KB"

export GRAPHIFY_MAX_WORKERS="$WORKERS"

exec graphify update "$@"
