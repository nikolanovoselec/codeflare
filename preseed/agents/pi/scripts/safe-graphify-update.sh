#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"
cd "$TARGET"

# Pi-owned bounded AST update wrapper. Keeps interactive Pi graph builds local,
# bounded, and free of headless LLM/API-key extraction.
export GRAPHIFY_MAX_WORKERS="${GRAPHIFY_MAX_WORKERS:-1}"
export GRAPHIFY_NO_SEMANTIC="${GRAPHIFY_NO_SEMANTIC:-1}"

CAP_KB="${GRAPHIFY_SAFE_RLIMIT_KB:-1500000}"
ulimit -v "$CAP_KB"

timeout "${GRAPHIFY_UPDATE_TIMEOUT:-120}" graphify update .
timeout "${GRAPHIFY_CLUSTER_TIMEOUT:-120}" graphify cluster-only .
