#!/usr/bin/env bash
# Publish one Claude memory capture transactionally.
#
# The retry carrier is removed inside the same fail-closed lock scope, only
# after the cumulative Vault merge and global user_vault publication succeed.
set -euo pipefail

VARS_FILE="${1:-}"
[[ -n "$VARS_FILE" && -f "$VARS_FILE" ]] || exit 2

LOCK_FILE="${MEMCAP_GRAPH_LOCK:-/tmp/graphify-global.lock}"
PYTHON_BIN="${MEMCAP_PYTHON_BIN:-/root/.local/share/uv/tools/graphifyy/bin/python}"
MERGE_SCRIPT="${MEMCAP_MERGE_SCRIPT:-/home/user/.claude/plugins/codeflare-vault/scripts/merge-vault-graph.py}"
GRAPHIFY_BIN="${MEMCAP_GRAPHIFY_BIN:-/usr/local/bin/graphify}"
VAULT_GRAPH="${MEMCAP_VAULT_GRAPH:-/home/user/Vault/graphify-out/vault-graph.json}"

flock -w 300 "$LOCK_FILE" bash -c '
  set -e
  "$1" "$2"
  "$3" global add "$4" --as user_vault
  rm -f -- "$5"
' memory-capture-publish "$PYTHON_BIN" "$MERGE_SCRIPT" "$GRAPHIFY_BIN" "$VAULT_GRAPH" "$VARS_FILE"
