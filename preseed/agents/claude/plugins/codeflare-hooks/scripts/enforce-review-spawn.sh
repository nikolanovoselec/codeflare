#!/usr/bin/env bash
# Stop hook — enforces SDD review-agent spawning after git push.
#
# Pattern enforced (per ~/.claude/rules/spec-discipline.md):
#   1. After git push, code-reviewer + spec-reviewer must be spawned in parallel
#   2. doc-updater must be spawned AFTER spec-reviewer task-notification arrives
#
# Bypass methods (any one bypasses enforcement):
#   1. Sentinel file: sdd/.skip-next-review (one-shot, auto-deleted on use)
#   2. Magic phrase: most recent user message after push contains
#      "skip review" or "skip verification" (case-insensitive, word-bounded)
#   3. 3-strike circuit breaker: after 3 blocks for the same push, give up
#
# Scope: only fires on main session Stop event (not SubagentStop).
# Vibe-coding gate: no enforcement if sdd/ is missing.
# Fail-safe: any unexpected error → exit 0 (never lock users out).

set +e  # don't abort on grep returning 1

# ---------------------------------------------------------------------------
# Vibe-coding gate
# ---------------------------------------------------------------------------
if [ ! -d "sdd" ] || [ ! -f "sdd/README.md" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Read hook input
# ---------------------------------------------------------------------------
INPUT=$(cat 2>/dev/null) || exit 0
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

# Only enforce on main session Stop, not SubagentStop
[ "$HOOK_EVENT" = "Stop" ] || exit 0

# Sanity check transcript
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# ---------------------------------------------------------------------------
# Bypass 1: sentinel file (one-shot, auto-delete)
# ---------------------------------------------------------------------------
if [ -f "sdd/.skip-next-review" ]; then
  rm -f "sdd/.skip-next-review"
  exit 0
fi

# ---------------------------------------------------------------------------
# Find most recent push line in transcript
# ---------------------------------------------------------------------------
PUSH_LINE=$(grep -n '"command":"git push' "$TRANSCRIPT" 2>/dev/null | tail -1 | cut -d: -f1)
[ -n "$PUSH_LINE" ] || exit 0  # No push, no enforcement

PUSH_LINE_CONTENT=$(sed -n "${PUSH_LINE}p" "$TRANSCRIPT")

# Slice transcript from push line forward
SINCE_PUSH=$(tail -n +"$PUSH_LINE" "$TRANSCRIPT" 2>/dev/null)

# ---------------------------------------------------------------------------
# Bypass 2: magic phrase in user messages since push
# ---------------------------------------------------------------------------
# Look at user-typed text content since push.
# Pattern: "skip review", "skip the review", "skip verification", "skip the verification"
if echo "$SINCE_PUSH" | grep '"type":"user"' | grep -v '"tool_result"' | grep -qiE '\bskip (the )?(review|verification)\b'; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
spawned() {
  echo "$SINCE_PUSH" | grep -q "\"subagent_type\"[[:space:]]*:[[:space:]]*\"$1\""
}

# ---------------------------------------------------------------------------
# Bypass 3: 3-strike circuit breaker (per-push counter)
# ---------------------------------------------------------------------------
COUNT_FILE=".git/sdd-review-block-count"
PUSH_HASH=$(echo -n "$PUSH_LINE_CONTENT" | sha256sum 2>/dev/null | cut -c1-12)

read_count() {
  if [ -f "$COUNT_FILE" ]; then
    local stored hash count
    stored=$(cat "$COUNT_FILE" 2>/dev/null)
    hash="${stored%%:*}"
    count="${stored#*:}"
    if [ "$hash" = "$PUSH_HASH" ]; then
      echo "$count"
      return
    fi
  fi
  echo "0"
}

clear_counter() {
  rm -f "$COUNT_FILE" 2>/dev/null || true
}

emit_block() {
  local reason="$1"
  local current
  current=$(read_count)
  # Already blocked 3 times for this push → give up
  if [ "$current" -ge 3 ]; then
    clear_counter
    exit 0
  fi
  local new=$((current + 1))
  echo "$PUSH_HASH:$new" > "$COUNT_FILE" 2>/dev/null || true
  jq -n --arg r "$reason" '{decision:"block", reason:$r}' 2>/dev/null
  exit 0
}

# ---------------------------------------------------------------------------
# Check 1: code-reviewer + spec-reviewer must be spawned after push
# ---------------------------------------------------------------------------
MISSING=""
spawned "code-reviewer" || MISSING="$MISSING code-reviewer"
spawned "spec-reviewer" || MISSING="$MISSING spec-reviewer"

if [ -n "$MISSING" ]; then
  REASON="Push detected, missing SDD review agents:$MISSING. Spawn NOW via the Agent tool with subagent_type=\"code-reviewer\" and subagent_type=\"spec-reviewer\" in parallel (per spec-discipline.md). Do NOT end the turn until both are spawned. Bypass options: type 'skip review' / 'skip verification', or 'touch sdd/.skip-next-review' (one-shot)."
  emit_block "$REASON"
fi

# ---------------------------------------------------------------------------
# Check 2: if spec-reviewer task-notification is in transcript, doc-updater
# must be spawned after that completion line (sequential discipline)
# ---------------------------------------------------------------------------
# task-notification format: <summary>Agent "Spec ..." completed</summary>
SPEC_DONE_LINE=$(echo "$SINCE_PUSH" | grep -nE 'summary>Agent \\"Spec[^<]*completed</summary>|summary>Agent "Spec[^<]*completed</summary>' | tail -1 | cut -d: -f1)

if [ -n "$SPEC_DONE_LINE" ]; then
  SINCE_SPEC=$(echo "$SINCE_PUSH" | tail -n +"$SPEC_DONE_LINE")
  if ! echo "$SINCE_SPEC" | grep -q '"subagent_type"[[:space:]]*:[[:space:]]*"doc-updater"'; then
    REASON="spec-reviewer completed but doc-updater has not been spawned. Spawn NOW via the Agent tool with subagent_type=\"doc-updater\" (sequential after spec-reviewer per SDD discipline — they would race on shared filesystem state if parallel). Bypass options: type 'skip review' / 'skip verification', or 'touch sdd/.skip-next-review' (one-shot)."
    emit_block "$REASON"
  fi
fi

# ---------------------------------------------------------------------------
# All checks passed — clear counter, allow stop
# ---------------------------------------------------------------------------
clear_counter
exit 0
