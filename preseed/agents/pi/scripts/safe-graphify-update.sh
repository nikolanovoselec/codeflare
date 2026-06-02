#!/usr/bin/env bash
# safe-graphify-update.sh - thin safety wrapper around upstream `graphify update`.
#
# Mirrors Codeflare's Claude wrapper: no custom extraction, no custom graph
# rewriting, no post-build normalization. The only local behavior is bounding
# worker count and virtual memory so upstream Graphify can fail cleanly in the
# 1-vCPU Codeflare container.
#
# Important: upstream `graphify update` may write a provisional graph.html. The
# final user-facing graph.html and callflow.html must be regenerated *after* the
# Pi main session writes .graphify_labels.json, by running
# local-graphify-labels.sh apply.
set -eu

CAP_KB="${GRAPHIFY_SAFE_RLIMIT_KB:-1500000}"
WORKERS="${GRAPHIFY_SAFE_WORKERS:-1}"

ulimit -v "$CAP_KB"
export GRAPHIFY_MAX_WORKERS="$WORKERS"
export GRAPHIFY_VIZ_NODE_LIMIT="${GRAPHIFY_VIZ_NODE_LIMIT:-100000}"

graphify update "$@"

echo "safe-graphify-update: graph.html from graphify update is provisional; run local-graphify-labels.sh apply to regenerate graph.html and callflow.html after labels"
