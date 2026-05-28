#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"
cd "$TARGET" 2>/dev/null || { echo "safe-graphify-update: target directory '$TARGET' does not exist" >&2; exit 1; }

# Pi-owned bounded AST update wrapper. Keeps interactive Pi graph builds local,
# bounded, and free of headless LLM/API-key extraction.
export GRAPHIFY_MAX_WORKERS="${GRAPHIFY_MAX_WORKERS:-1}"
export GRAPHIFY_NO_SEMANTIC="${GRAPHIFY_NO_SEMANTIC:-1}"
# graph.html must always be generated; keep the viz node limit high even if the
# inherited process env was scrubbed by a sandboxed exec.
export GRAPHIFY_VIZ_NODE_LIMIT="${GRAPHIFY_VIZ_NODE_LIMIT:-100000}"

# Fail closed: if the RLIMIT_AS cap cannot be applied, abort before graphify runs so a
# runaway rebuild dies with ENOMEM instead of OOM-killing the session.
CAP_KB="${GRAPHIFY_SAFE_RLIMIT_KB:-1500000}"
ulimit -v "$CAP_KB" || { echo "safe-graphify-update: cannot apply RLIMIT_AS cap ${CAP_KB}KB; aborting" >&2; exit 1; }

command -v graphify >/dev/null 2>&1 || { echo "safe-graphify-update: graphify CLI not found on PATH" >&2; exit 127; }

timeout "${GRAPHIFY_UPDATE_TIMEOUT:-120}" graphify update .
timeout "${GRAPHIFY_CLUSTER_TIMEOUT:-120}" graphify cluster-only .
