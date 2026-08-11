#!/usr/bin/env bash
# Publish one Claude memory capture transactionally.
#
# The retry carrier is removed inside the same fail-closed lock scope, only
# after the cumulative Vault merge and global user_vault publication succeed.
set -euo pipefail

VARS_FILE="${1:-}"
[[ -n "$VARS_FILE" && -f "$VARS_FILE" ]] || exit 2

# Publication only means something if the capture actually produced its file.
# Pi gates the same finalizer on memorySuccessQualifies() rather than on the
# subagent's own report of success, because a subagent that returns "done"
# without writing anything would otherwise advance the counter and burn the
# window. Requests armed before capture_file existed carry no such field and
# keep the old unverified behaviour rather than failing closed on upgrade.
CAPTURE_FILE=$(jq -r '.capture_file // empty' "$VARS_FILE" 2>/dev/null || true)
if [[ -n "$CAPTURE_FILE" && ! -f "$CAPTURE_FILE" ]]; then
  echo "publish-memory-capture: refusing to publish, capture file absent: $CAPTURE_FILE" >&2
  exit 3
fi

# Counter coordinates: advancing it is what marks this window captured.
COUNTER_FILE=$(jq -r '.counter_file // empty' "$VARS_FILE" 2>/dev/null || true)
CURRENT_COUNT=$(jq -r '.current_count // empty' "$VARS_FILE" 2>/dev/null || true)
TOTAL_LINES=$(jq -r '.total_lines // empty' "$VARS_FILE" 2>/dev/null || true)
[[ "$CURRENT_COUNT" =~ ^[0-9]+$ ]] || { COUNTER_FILE=""; CURRENT_COUNT=0; }
[[ "$TOTAL_LINES" =~ ^[0-9]+$ ]] || TOTAL_LINES=0

LOCK_FILE="${MEMCAP_GRAPH_LOCK:-/tmp/graphify-global.lock}"
PYTHON_BIN="${MEMCAP_PYTHON_BIN:-/root/.local/share/uv/tools/graphifyy/bin/python}"
MERGE_SCRIPT="${MEMCAP_MERGE_SCRIPT:-/home/user/.claude/plugins/codeflare-vault/scripts/merge-vault-graph.py}"
GRAPHIFY_BIN="${MEMCAP_GRAPHIFY_BIN:-/usr/local/bin/graphify}"
VAULT_GRAPH="${MEMCAP_VAULT_GRAPH:-/home/user/Vault/graphify-out/vault-graph.json}"

flock -w 300 "$LOCK_FILE" bash -c '
  set -e
  "$1" "$2"
  "$3" global add "$4" --as user_vault
  # The counter advances here and nowhere else. The arming hook used to do it,
  # which meant a capture that died still marked its window as covered and
  # those messages were never revisited. Monotonic, like Pi'"'"'s
  # Math.max(readCount, promptCount): a stale request publishing late must not
  # drag the committed count backwards.
  if [ -n "$6" ]; then
    prev=$(head -1 "$6" 2>/dev/null || echo 0)
    case "$prev" in ""|*[!0-9]*) prev=0 ;; esac
    if [ "$7" -gt "$prev" ]; then printf "%s\n%s\n" "$7" "$8" > "$6"; fi
  fi
  rm -f -- "$5" "$9"
' memory-capture-publish "$PYTHON_BIN" "$MERGE_SCRIPT" "$GRAPHIFY_BIN" "$VAULT_GRAPH" "$VARS_FILE" "$COUNTER_FILE" "$CURRENT_COUNT" "$TOTAL_LINES" "${VARS_FILE%.vars}.latched"

# Re-render the viz, outside the lock on purpose. It reads data the lock above
# already committed, so holding the global graph lock through a whole-vault
# clustering pass only makes every concurrent publisher wait out someone else's
# render. The capture prompt owned this step until the two-call rewrite dropped
# it and nothing picked it up, so Raw/Graphs/vault-graph.html drifted behind the
# JSON after every capture. Non-fatal for the same reason vault-extract treats
# it as non-fatal: the graph data is committed, only the HTML is at stake.
#
# The root is derived from VAULT_GRAPH rather than written literally, because
# every other path here is MEMCAP_*-overridable and the fixtures do override it.
# A literal would send a test run into the real vault. cluster-only takes a
# PROJECT root and writes to <root>/graphify-out/, so it gets "." from there.
VAULT_ROOT=$(dirname "$(dirname "$VAULT_GRAPH")")
(
  cd "$VAULT_ROOT" \
    && mkdir -p Raw/Graphs \
    && "$GRAPHIFY_BIN" cluster-only . >/dev/null 2>/dev/null \
    && cp -f graphify-out/graph.html Raw/Graphs/vault-graph.html
) || echo "publish-memory-capture: viz re-render skipped; vault-graph.html may be stale" >&2
