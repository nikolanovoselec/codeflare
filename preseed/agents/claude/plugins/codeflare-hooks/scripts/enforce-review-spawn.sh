#!/usr/bin/env bash
# Stop hook — enforces SDD review-agent spawning after git push.
#
# Pattern enforced (per ~/.claude/rules/spec-discipline.md):
#   1. After git push, code-reviewer + spec-reviewer must be spawned in parallel
#   2. doc-updater must be spawned AFTER spec-reviewer task-notification arrives
#
# Bypass methods (USER-ONLY — the assistant must NEVER create the sentinel
# or write the magic phrase in its own output to suppress this hook. Both
# bypasses exist so the *user* can decide to skip review on a specific push.
# An assistant that creates its own bypass defeats the entire enforcement layer.):
#   1. Sentinel file: sdd/.skip-next-review — created BY THE USER only,
#      one-shot, auto-deleted on use
#   2. Magic phrase: most recent USER MESSAGE after push contains
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
# Match "name":"Bash" co-occurring with literal "git push" on the SAME JSONL
# line. We deliberately do NOT anchor the second clause to the JSON "command"
# field opener — JSON-encoded chained commits embed escaped quotes (e.g.
# `git add . && git commit -m \"fix: x\" && git push`), and a `[^"]*` negated
# class would halt at the first `\"` byte, silently bypassing enforcement
# for the canonical `commit -m "..." && push` form (#243 follow-up).
# False-positive surface (Bash tool_use lines containing the literal string
# "git push" in arguments, e.g. `echo 'run git push later'`) is acceptable —
# user has the sentinel-file escape hatch.
# ---------------------------------------------------------------------------
PUSH_LINE=$(awk '/"name"[[:space:]]*:[[:space:]]*"Bash"/ && /git push/ { print NR }' "$TRANSCRIPT" 2>/dev/null | tail -1)
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
# Resolve git common dir for worktree/submodule compatibility — `.git` may
# be a file (gitlink) instead of a directory in those contexts.
# ---------------------------------------------------------------------------
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
COUNT_FILE="${GIT_COMMON_DIR:-.git}/sdd-review-block-count"
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
  REASON="Push detected, missing SDD review agents:$MISSING. Spawn NOW via the Agent tool with subagent_type=\"code-reviewer\" and subagent_type=\"spec-reviewer\" in parallel (per spec-discipline.md). Do NOT end the turn until both are spawned. The bypasses (sentinel file, magic phrase) are USER-ONLY — do NOT create the sentinel or write the phrase yourself; that defeats the entire enforcement layer. Only the user is allowed to choose to skip review."
  emit_block "$REASON"
fi

# ---------------------------------------------------------------------------
# Check 2: if spec-reviewer task-notification is in transcript, doc-updater
# must be spawned after that completion line (sequential discipline).
#
# Detection: correlate via tool_use_id. The spec-reviewer Agent tool_use has
# an id like "toolu_xxx". The completion arrives later as a task-notification
# block containing <tool-use-id>toolu_xxx</tool-use-id> + <status>completed</status>
# on the same JSONL line. This avoids relying on the `description` field text
# (which the assistant phrases freely, e.g. "Validate spec update", "SDD review",
# etc. — the literal "Spec" prefix is not guaranteed).
# ---------------------------------------------------------------------------
# Find the most recent spec-reviewer spawn line and capture its tool_use_id
SPEC_SPAWN_LINE=$(echo "$SINCE_PUSH" | grep -nE '"subagent_type"[[:space:]]*:[[:space:]]*"spec-reviewer"' | tail -1 | cut -d: -f1)

if [ -n "$SPEC_SPAWN_LINE" ]; then
  SPEC_LINE_CONTENT=$(echo "$SINCE_PUSH" | sed -n "${SPEC_SPAWN_LINE}p")
  SPEC_TOOL_USE_ID=$(echo "$SPEC_LINE_CONTENT" | grep -oE '"id"[[:space:]]*:[[:space:]]*"toolu_[^"]+"' | head -1 | grep -oE 'toolu_[^"]+')

  if [ -n "$SPEC_TOOL_USE_ID" ]; then
    SINCE_SPAWN=$(echo "$SINCE_PUSH" | tail -n +"$SPEC_SPAWN_LINE")
    # Match a task-notification line correlating to this tool_use_id with
    # completed status. Both must appear on the same JSONL line (which they
    # do since each task-notification is a single user-message line).
    SPEC_DONE_LINE=$(echo "$SINCE_SPAWN" | grep -nF "tool-use-id>${SPEC_TOOL_USE_ID}<" | grep -F 'completed</status>' | tail -1 | cut -d: -f1)

    if [ -n "$SPEC_DONE_LINE" ]; then
      # spec-reviewer completed — doc-updater must have been spawned AFTER
      SINCE_SPEC_DONE=$(echo "$SINCE_SPAWN" | tail -n +"$SPEC_DONE_LINE")
      if ! echo "$SINCE_SPEC_DONE" | grep -q '"subagent_type"[[:space:]]*:[[:space:]]*"doc-updater"'; then
        REASON="spec-reviewer completed but doc-updater has not been spawned. Spawn NOW via the Agent tool with subagent_type=\"doc-updater\" (sequential after spec-reviewer per SDD discipline — they would race on shared filesystem state if parallel). The bypasses (sentinel file, magic phrase) are USER-ONLY — do NOT create the sentinel or write the phrase yourself; that defeats the entire enforcement layer."
        emit_block "$REASON"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# All checks passed — clear counter, allow stop
# ---------------------------------------------------------------------------
clear_counter
exit 0
