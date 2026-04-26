#!/usr/bin/env bash
# Stop hook — enforces SDD review-agent spawning after git push.
#
# Architecture (v4): reflog as source-of-truth + per-repo checkpoint.
#
#   Layer 1 (CANDIDATE) — loose regex finds any "git push" mention in the
#     transcript. Accepts false positives (echo "git push", `gh pr create`
#     bodies, sibling fields, doc snippets) — they get filtered below.
#
#   Layer 2 (TRUTH) — `git reflog` is the unfakeable signal. A successful
#     `git push` writes an `update by push` entry on a refs/remotes/* ref
#     via git itself; no text-emitting command (echo, cat, gh, grep) can
#     produce that entry. We read the latest such timestamp.
#
#   Layer 3 (CHECKPOINT) — `.git/sdd-last-ack-push` stores the unix
#     timestamp of the most recent push whose review pipeline completed.
#     A push is un-acknowledged iff LATEST_PUSH_TS > LAST_ACK_TS.
#
# Enforcement fires iff ALL of:
#   1. Reflog shows an un-acknowledged push (LATEST > LAST_ACK)
#   2. Transcript shows assistant push intent (loose candidate match)
#   3. Required agents have NOT been spawned with transcript timestamp
#      strictly greater than LATEST_PUSH_TS
#
# The connection between push and review is the temporal ordering: each
# new push raises the bar so that prior reviews cannot satisfy it. The
# checkpoint advances only when the full pipeline (code-reviewer +
# spec-reviewer + doc-updater after spec completion) is observed for the
# latest un-acknowledged push.
#
# Multi-push coalescing: only LATEST_PUSH_TS is tracked, so multiple
# un-acked pushes that accumulate before any review pipeline completes
# are reviewed as a single unit (the agents see the cumulative diff via
# `git diff origin/main...HEAD` regardless). This is intentional — a
# single review covers all newly-pushed commits.
#
# Bypass methods (USER-ONLY — the assistant must NEVER create the sentinel
# or write the magic phrase in its own output. An assistant that creates
# its own bypass defeats the entire enforcement layer.):
#   1. Sentinel file: sdd/.skip-next-review (one-shot, auto-deleted on use)
#   2. Magic phrase: USER MESSAGE since the candidate push line contains
#      "skip review" or "skip verification" (case-insensitive, word-bounded)
#   3. 3-strike circuit breaker: after 3 blocks for the same un-acked push,
#      give up and let the user proceed
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
# Layer 2 filters them via reflog state.
# ---------------------------------------------------------------------------
PUSH_LINE=$(awk '/"name"[[:space:]]*:[[:space:]]*"Bash"/ && /git push/ { print NR }' "$TRANSCRIPT" 2>/dev/null | tail -1)
[ -n "$PUSH_LINE" ] || exit 0  # No candidate, no enforcement

# Slice transcript from candidate line forward (used for magic-phrase scan
# and the legacy SINCE_PUSH-based helpers below)
SINCE_PUSH=$(tail -n +"$PUSH_LINE" "$TRANSCRIPT" 2>/dev/null)

# ---------------------------------------------------------------------------
# Bypass 2: magic phrase in user messages since candidate push line
# ---------------------------------------------------------------------------
if echo "$SINCE_PUSH" | grep '"type":"user"' | grep -v '"tool_result"' | grep -qiE '\bskip (the )?(review|verification)\b'; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve git common dir for worktree/submodule compatibility (`.git`
# may be a file pointing into the common dir in those contexts).
# ---------------------------------------------------------------------------
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
[ -n "$GIT_COMMON_DIR" ] || exit 0  # not in a git repo → silent exit
ACK_FILE="$GIT_COMMON_DIR/sdd-last-ack-push"
COUNT_FILE="$GIT_COMMON_DIR/sdd-review-block-count"

# ---------------------------------------------------------------------------
# Layer 2 (TRUTH) — read reflog files directly for `update by push` entries.
# We read .git/logs/refs/{remotes,tags}/** rather than `git reflog --all`
# because it's faster (no git fork + ref enumeration), portable across
# git versions, and immune to "ambiguous argument" errors in unusual
# repo states (worktrees, freshly-cloned, etc).
#
# Reflog line format: `<old-sha> <new-sha> <ident> <ts> <tz>\t<reason>`
# where <ident> is "Name <email>" (name may contain spaces). The
# awk strip-up-to-`> ` pattern locates the field boundary robustly
# regardless of name spacing.
# ---------------------------------------------------------------------------
LOG_BASE="$GIT_COMMON_DIR/logs/refs"
LATEST_PUSH_TS=$(
  { [ -d "$LOG_BASE/remotes" ] && find "$LOG_BASE/remotes" -type f -exec grep -hE 'update by push$' {} + 2>/dev/null
    [ -d "$LOG_BASE/tags" ] && find "$LOG_BASE/tags" -type f -exec grep -hE 'update by push$' {} + 2>/dev/null
  } | awk '{ sub(/^[a-f0-9]+ [a-f0-9]+ .*> /, ""); print $1 }' \
    | sort -n | tail -1
)
# Validate: must be all digits (defend against malformed reflog lines)
case "$LATEST_PUSH_TS" in
  ''|*[!0-9]*) exit 0 ;;
esac

# ---------------------------------------------------------------------------
# Layer 3 (CHECKPOINT) — read the high-water mark of acknowledged pushes
# ---------------------------------------------------------------------------
LAST_ACK_TS=0
if [ -f "$ACK_FILE" ]; then
  raw=$(cat "$ACK_FILE" 2>/dev/null)
  # Validate: must be all digits (defend against corrupt file)
  case "$raw" in
    ''|*[!0-9]*) LAST_ACK_TS=0 ;;
    *) LAST_ACK_TS="$raw" ;;
  esac
fi

# All real pushes already acknowledged → nothing to do
if [ "$LATEST_PUSH_TS" -le "$LAST_ACK_TS" ] 2>/dev/null; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Real un-acknowledged push exists. Enforce.
#
# Convert LATEST_PUSH_TS (unix epoch) to ISO 8601 for direct lexicographic
# comparison against transcript "timestamp" fields. All transcript
# timestamps are UTC, fixed-width, identical shape NNNN-NN-NNTNN:NN:NN.NNNZ
# so string > comparison is correct chronologically.
# ---------------------------------------------------------------------------
# GNU date (Linux): `-d "@TS"`. BSD date (macOS): `-r TS`. Try both.
# Fall back to awk strftime for environments where neither works.
LATEST_PUSH_ISO=$(date -u -d "@$LATEST_PUSH_TS" +'%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null \
  || date -u -r "$LATEST_PUSH_TS" +'%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null \
  || awk -v t="$LATEST_PUSH_TS" 'BEGIN { print strftime("%Y-%m-%dT%H:%M:%S.000Z", t, 1) }' 2>/dev/null)
[ -n "$LATEST_PUSH_ISO" ] || exit 0  # all conversions failed → fail-safe

# Helper: was this subagent_type spawned with transcript timestamp > push?
spawned_after_push() {
  local agent="$1"
  awk -v t="$LATEST_PUSH_ISO" -v a="$agent" '
    index($0, "\"subagent_type\":\"" a "\"") {
      if (match($0, /"timestamp":"[^"]+"/)) {
        ts = substr($0, RSTART+13, RLENGTH-14)
        if (ts > t) { found = 1; exit }
      }
    }
    END { exit !found }
  ' "$TRANSCRIPT"
}

# 3-strike circuit breaker (keyed by LATEST_PUSH_TS — unique per push)
read_count() {
  if [ -f "$COUNT_FILE" ]; then
    local stored hash count
    stored=$(cat "$COUNT_FILE" 2>/dev/null)
    hash="${stored%%:*}"
    count="${stored#*:}"
    # Validate count is numeric (defend against corrupt file)
    case "$count" in
      ''|*[!0-9]*) count=0 ;;
    esac
    if [ "$hash" = "$LATEST_PUSH_TS" ]; then
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
  echo "$LATEST_PUSH_TS:$new" > "$COUNT_FILE" 2>/dev/null || true
  jq -n --arg r "$reason" '{decision:"block", reason:$r}' 2>/dev/null
  exit 0
}

# ---------------------------------------------------------------------------
# Check 1: code-reviewer + spec-reviewer must be spawned after LATEST push
# ---------------------------------------------------------------------------
MISSING=""
spawned_after_push "code-reviewer" || MISSING="$MISSING code-reviewer"
spawned_after_push "spec-reviewer" || MISSING="$MISSING spec-reviewer"

if [ -n "$MISSING" ]; then
  REASON="Push detected (reflog confirms real push at $LATEST_PUSH_ISO), missing SDD review agents:$MISSING. Spawn NOW via the Agent tool with subagent_type=\"code-reviewer\" and subagent_type=\"spec-reviewer\" in parallel (per spec-discipline.md). Do NOT end the turn until both are spawned. The bypasses (sentinel file, magic phrase) are USER-ONLY — do NOT create the sentinel or write the phrase yourself; that defeats the entire enforcement layer. Only the user is allowed to choose to skip review."
  emit_block "$REASON"
fi

# ---------------------------------------------------------------------------
# Check 2: if a spec-reviewer spawn after the push has a completion
# task-notification, doc-updater must be spawned AFTER that completion
# line (sequential discipline).
# ---------------------------------------------------------------------------
# Find the most recent spec-reviewer spawn line whose timestamp > LATEST push,
# and extract its tool_use_id.
SPEC_SPAWN_LINE=$(awk -v t="$LATEST_PUSH_ISO" '
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
      # spec completed AND doc-updater present → full pipeline reviewed
      PIPELINE_COMPLETE=1
    fi
    # else: spec still running → don't ack yet, next Stop will re-check
  fi
fi

# ---------------------------------------------------------------------------
# Advance checkpoint only when the FULL pipeline (incl. doc-updater after
# spec completion) is observed. This is conservative: if spec is still
# running, we exit 0 without ack and the next Stop re-evaluates.
# ---------------------------------------------------------------------------
if [ "$PIPELINE_COMPLETE" = "1" ]; then
  echo "$LATEST_PUSH_TS" > "$ACK_FILE" 2>/dev/null || true
  clear_counter
fi

exit 0
