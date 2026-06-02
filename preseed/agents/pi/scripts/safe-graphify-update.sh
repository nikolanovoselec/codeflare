#!/usr/bin/env bash
# safe-graphify-update.sh - thin safety wrapper around upstream `graphify update`.
#
# Mirrors Codeflare's Claude wrapper: no custom extraction, no custom graph
# rewriting, no post-build normalization. The only local behavior is bounding
# worker count and virtual memory so upstream Graphify can fail cleanly in the
# 1-vCPU Codeflare container, then exporting callflow.html next to graph.html.
set -eu

TARGET="${1:-.}"
case "$TARGET" in
  -*) TARGET="." ;;
esac

CAP_KB="${GRAPHIFY_SAFE_RLIMIT_KB:-1500000}"
WORKERS="${GRAPHIFY_SAFE_WORKERS:-1}"

ulimit -v "$CAP_KB"
export GRAPHIFY_MAX_WORKERS="$WORKERS"
export GRAPHIFY_VIZ_NODE_LIMIT="${GRAPHIFY_VIZ_NODE_LIMIT:-100000}"

graphify update "$@"
graphify export callflow-html --graph "$TARGET/graphify-out/graph.json" --output "$TARGET/graphify-out/callflow.html"
