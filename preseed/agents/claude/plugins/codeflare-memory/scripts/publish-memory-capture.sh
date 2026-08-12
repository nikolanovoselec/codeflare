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
#
# Branching on jq's status rather than its output is the whole point here. `jq
# -r … || true` collapsed two different answers into the same empty string: "the
# request predates this field", which legitimately keeps the old behaviour, and
# "jq failed or the carrier is corrupt", which must not. Empty then skipped the
# existence gate entirely, so a corrupt carrier advanced the counter and marked
# the window captured with no file -- exactly what the paragraph above claims
# this code prevents. jq -e exits 1 for null/absent and >1 for a real failure.
if CAPTURE_FILE=$(jq -e -r '.capture_file' "$VARS_FILE" 2>/dev/null); then
  if [[ ! -f "$CAPTURE_FILE" ]]; then
    echo "publish-memory-capture: refusing to publish, capture file absent: $CAPTURE_FILE" >&2
    exit 3
  fi
elif [[ $? -gt 1 ]]; then
  echo "publish-memory-capture: refusing to publish, carrier unreadable: $VARS_FILE" >&2
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
# every other path here is MEMCAP_*-overridable and the fixtures do override it,
# so a literal would send a test run into the real vault. The derivation assumes
# the production layout <root>/graphify-out/<graph>.json and says so, because a
# blind dirname-of-dirname does not hold for a flat override path: it lands on
# the parent of the graph directory, which for a fixture under /tmp/x/ is /tmp.
# That is not the vault, but it is not harmless either -- it rendered into a
# sibling and clobbered a log another test asserts on. cluster-only takes a
# PROJECT root and writes to <root>/graphify-out/, so it gets "." from there.
GRAPH_DIR=$(dirname "$VAULT_GRAPH")
if [[ "$(basename "$GRAPH_DIR")" == graphify-out ]]; then
  VAULT_ROOT=$(dirname "$GRAPH_DIR")
else
  VAULT_ROOT="$GRAPH_DIR"
fi

# Two guards. There is nothing to re-render where no graphify-out exists, which
# is the shape every publisher fixture uses, so this is also what keeps the
# render out of tests that never asked for it. And it takes its own
# non-blocking lock: moving out of the global lock removed the queueing and the
# mutual exclusion together, leaving two publishers free to cluster into one
# graphify-out and copy the same graph.html over each other. A second publisher
# skips rather than interleaves, which costs nothing a later capture will not redo.
if [[ -d "$VAULT_ROOT/graphify-out" ]]; then
  flock -n "$LOCK_FILE.viz" bash -c '
    cd "$1" \
      && mkdir -p Raw/Graphs \
      && "$2" cluster-only . >/dev/null 2>/dev/null \
      && cp -f graphify-out/graph.html Raw/Graphs/vault-graph.html
  ' memory-capture-viz "$VAULT_ROOT" "$GRAPHIFY_BIN" \
    || echo "publish-memory-capture: viz re-render skipped; vault-graph.html may be stale" >&2
fi
