#!/usr/bin/env bash
# Stop hook — enforces SDD review-agent spawning at the PR boundary.
#
# Architecture (v5): PR HEAD SHA checkpoint + open-PR gate.
#
#   Layer 1 (CANDIDATE) — loose regex finds any "git push" mention in the
#     transcript. Accepts false positives — they get filtered below.
#
#   Layer 2 (TRUTH) — `gh pr view <branch>` returns the current PR HEAD
#     SHA. The PR HEAD SHA is the unfakeable signal at PR-boundary
#     scope: it changes only when a real push lands on the PR's source
#     branch. The legacy reflog `update by push` truth layer is kept as
#     a comment-anchored documentation reference (search "update by
#     push" or "reflog" in this file) and is no longer read at runtime,
#     because PR HEAD SHA is a stricter signal that already requires a
#     real push to advance.
#
#   Layer 3 (CHECKPOINT) — `.git/sdd-last-ack-pr-head` stores the PR
#     HEAD SHA whose review pipeline completed. A PR is un-acknowledged
#     iff CURRENT_PR_HEAD ≠ LAST_ACK_PR_HEAD.
#
# Trigger semantics (PR-boundary):
#
#   - No open PR for current branch → exit 0 (deferred; the review
#     fires when the PR opens)
#   - Open PR + CURRENT_PR_HEAD == LAST_ACK → exit 0 (already reviewed
#     at this state)
#   - Open PR + CURRENT_PR_HEAD ≠ LAST_ACK → enforce: require
#     code-reviewer + spec-reviewer + doc-updater spawned with
#     transcript timestamps after the PR HEAD landed
#
# Migration from v4: if .git/sdd-last-ack-push (timestamp checkpoint)
# exists, it is deleted on first v5 invocation. The PR HEAD SHA
# checkpoint takes over.
#
# Bypass methods (USER-ONLY — the assistant must NEVER create the
# sentinel or write the magic phrase in its own output. An assistant
# that creates its own bypass defeats the entire enforcement layer.):
#   1. Sentinel file: sdd/.skip-next-review (one-shot, auto-deleted)
#   2. Magic phrase: USER MESSAGE since the candidate push line contains
#      "skip review" or "skip verification" (case-insensitive, word-bounded)
#   3. 3-strike circuit breaker: after 3 blocks for the same un-acked
#      PR HEAD SHA, give up and let the user proceed
#
# Scope: only fires on main session Stop event (not SubagentStop).
# Vibe-coding gate: no enforcement if sdd/ is missing.
# Fail-safe: any unexpected error → exit 0 (never lock users out).

set +e

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

[ "$HOOK_EVENT" = "Stop" ] || exit 0
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# ---------------------------------------------------------------------------
# Bypass 1: sentinel file (one-shot, auto-delete)
# ---------------------------------------------------------------------------
if [ -f "sdd/.skip-next-review" ]; then
  rm -f "sdd/.skip-next-review"
  exit 0
fi

# ---------------------------------------------------------------------------
# Layer 1 (CANDIDATE) — loose regex finds any Bash tool_use line that
# mentions `git push` literally. Accepts false positives intentionally;
# Layer 2 filters them via PR HEAD SHA state.
# ---------------------------------------------------------------------------
PUSH_LINE=$(awk '/"name"[[:space:]]*:[[:space:]]*"Bash"/ && /git push/ { print NR }' "$TRANSCRIPT" 2>/dev/null | tail -1)
[ -n "$PUSH_LINE" ] || exit 0  # No candidate, no enforcement

SINCE_PUSH=$(tail -n +"$PUSH_LINE" "$TRANSCRIPT" 2>/dev/null)

# ---------------------------------------------------------------------------
# Bypass 2: magic phrase in user messages since candidate push line
# ---------------------------------------------------------------------------
if echo "$SINCE_PUSH" | grep '"type":"user"' | grep -v '"tool_result"' | grep -qiE '\bskip (the )?(review|verification)\b'; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve git common dir for worktree/submodule compatibility
# ---------------------------------------------------------------------------
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
[ -n "$GIT_COMMON_DIR" ] || exit 0  # not in a git repo → silent exit
ACK_FILE="$GIT_COMMON_DIR/sdd-last-ack-pr-head"
COUNT_FILE="$GIT_COMMON_DIR/sdd-review-block-count"

# Migration: clean up v4 timestamp checkpoint on first v5 run
LEGACY_ACK="$GIT_COMMON_DIR/sdd-last-ack-push"
[ -f "$LEGACY_ACK" ] && rm -f "$LEGACY_ACK" 2>/dev/null

# ---------------------------------------------------------------------------
# Layer 2 (TRUTH) — PR HEAD SHA via gh pr view
#
# If the current branch has no open PR, exit 0 (deferred). The review
# pipeline fires when the PR opens (handled by git-push-review-reminder.sh
# at PR-OPEN time). No open PR → no enforcement here.
# ---------------------------------------------------------------------------
CURRENT=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
[ -n "$CURRENT" ] || exit 0
[ "$CURRENT" = "HEAD" ] && exit 0  # detached HEAD — skip

if ! command -v gh >/dev/null 2>&1; then
  exit 0  # gh missing → can't verify PR state → fail-safe exit
fi

PR_INFO=$(gh pr view "$CURRENT" --json state,headRefOid 2>/dev/null) || exit 0
[ -n "$PR_INFO" ] || exit 0

PR_STATE=$(echo "$PR_INFO" | jq -r '.state // empty' 2>/dev/null)
CURRENT_PR_HEAD=$(echo "$PR_INFO" | jq -r '.headRefOid // empty' 2>/dev/null)

# No open PR for current branch → exit 0 (deferred review)
[ "$PR_STATE" = "OPEN" ] || exit 0
[ -n "$CURRENT_PR_HEAD" ] || exit 0

# ---------------------------------------------------------------------------
# Layer 3 (CHECKPOINT) — read the high-water mark of acknowledged PR HEADs
# ---------------------------------------------------------------------------
LAST_ACK_PR_HEAD=""
if [ -f "$ACK_FILE" ]; then
  LAST_ACK_PR_HEAD=$(cat "$ACK_FILE" 2>/dev/null)
fi

# PR HEAD already reviewed → exit 0
if [ -n "$LAST_ACK_PR_HEAD" ] && [ "$LAST_ACK_PR_HEAD" = "$CURRENT_PR_HEAD" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Real un-acknowledged PR HEAD exists. Enforce.
#
# Find the timestamp of the candidate push line — agents must be spawned
# with timestamps strictly after the push to count as a fresh review.
# ---------------------------------------------------------------------------
PUSH_LINE_CONTENT=$(sed -n "${PUSH_LINE}p" "$TRANSCRIPT" 2>/dev/null)
PUSH_TS=$(echo "$PUSH_LINE_CONTENT" | grep -oE '"timestamp":"[^"]+"' | head -1 | sed -E 's/.*"timestamp":"([^"]+)"/\1/')

# Helper: was this subagent_type spawned with transcript timestamp > push ts?
spawned_after_push() {
  local agent="$1"
  awk -v t="$PUSH_TS" -v a="$agent" '
    index($0, "\"subagent_type\":\"" a "\"") {
      if (match($0, /"timestamp":"[^"]+"/)) {
        ts = substr($0, RSTART+13, RLENGTH-14)
        if (ts > t) { found = 1; exit }
      }
    }
    END { exit !found }
  ' "$TRANSCRIPT"
}

# 3-strike circuit breaker (keyed by CURRENT_PR_HEAD — unique per PR state)
read_count() {
  if [ -f "$COUNT_FILE" ]; then
    local stored hash count
    stored=$(cat "$COUNT_FILE" 2>/dev/null)
    hash="${stored%%:*}"
    count="${stored#*:}"
    case "$count" in
      ''|*[!0-9]*) count=0 ;;
    esac
    if [ "$hash" = "$CURRENT_PR_HEAD" ]; then
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
  if [ "$current" -ge 3 ]; then
    clear_counter
    exit 0
  fi
  local new=$((current + 1))
  echo "$CURRENT_PR_HEAD:$new" > "$COUNT_FILE" 2>/dev/null || true
  jq -n --arg r "$reason" '{decision:"block", reason:$r}' 2>/dev/null
  exit 0
}

# ---------------------------------------------------------------------------
# Check 1: code-reviewer + spec-reviewer must be spawned after the push
# ---------------------------------------------------------------------------
MISSING=""
spawned_after_push "code-reviewer" || MISSING="$MISSING code-reviewer"
spawned_after_push "spec-reviewer" || MISSING="$MISSING spec-reviewer"

if [ -n "$MISSING" ]; then
  REASON="PR-boundary push detected (PR #$CURRENT, head $CURRENT_PR_HEAD), missing SDD review agents:$MISSING. Spawn NOW via the Agent tool with subagent_type=\"code-reviewer\" and subagent_type=\"spec-reviewer\" in parallel (per spec-discipline.md). Do NOT end the turn until both are spawned. The bypasses (sentinel file, magic phrase) are USER-ONLY — do NOT create the sentinel or write the phrase yourself; that defeats the entire enforcement layer. Only the user is allowed to choose to skip review."
  emit_block "$REASON"
fi

# ---------------------------------------------------------------------------
# Check 2: spec-reviewer completion → doc-updater must follow
# ---------------------------------------------------------------------------
SPEC_SPAWN_LINE=$(awk -v t="$PUSH_TS" '
  /"subagent_type":"spec-reviewer"/ {
    if (match($0, /"timestamp":"[^"]+"/)) {
      ts = substr($0, RSTART+13, RLENGTH-14)
      if (ts > t) print NR
    }
  }
' "$TRANSCRIPT" | tail -1)

PIPELINE_COMPLETE=0
if [ -n "$SPEC_SPAWN_LINE" ]; then
  SPEC_LINE_CONTENT=$(sed -n "${SPEC_SPAWN_LINE}p" "$TRANSCRIPT")
  SPEC_TOOL_USE_ID=$(echo "$SPEC_LINE_CONTENT" | grep -oE '"id"[[:space:]]*:[[:space:]]*"toolu_[^"]+"' | head -1 | grep -oE 'toolu_[^"]+')

  if [ -n "$SPEC_TOOL_USE_ID" ]; then
    SINCE_SPEC=$(tail -n +"$SPEC_SPAWN_LINE" "$TRANSCRIPT" 2>/dev/null)
    SPEC_DONE_LINE=$(echo "$SINCE_SPEC" | grep -nF "tool-use-id>${SPEC_TOOL_USE_ID}<" | grep -F 'completed</status>' | tail -1 | cut -d: -f1)

    if [ -n "$SPEC_DONE_LINE" ]; then
      SINCE_SPEC_DONE=$(echo "$SINCE_SPEC" | tail -n +"$SPEC_DONE_LINE")
      if ! echo "$SINCE_SPEC_DONE" | grep -q '"subagent_type"[[:space:]]*:[[:space:]]*"doc-updater"'; then
        REASON="spec-reviewer completed but doc-updater has not been spawned. Spawn NOW via the Agent tool with subagent_type=\"doc-updater\" (sequential after spec-reviewer per SDD discipline — they would race on shared filesystem state if parallel). The bypasses (sentinel file, magic phrase) are USER-ONLY — do NOT create the sentinel or write the phrase yourself; that defeats the entire enforcement layer."
        emit_block "$REASON"
      fi
      PIPELINE_COMPLETE=1
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Advance checkpoint only when the FULL pipeline completed for this PR HEAD.
# Conservative: if spec is still running, exit 0 without ack and the next
# Stop re-evaluates.
# ---------------------------------------------------------------------------
if [ "$PIPELINE_COMPLETE" = "1" ]; then
  echo "$CURRENT_PR_HEAD" > "$ACK_FILE" 2>/dev/null || true
  clear_counter
fi

exit 0
