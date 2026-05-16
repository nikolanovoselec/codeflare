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
# Trigger semantics (PR-boundary, gated on PR target = main/master):
#
#   - No open PR for current branch → exit 0 (deferred; the review
#     fires when the PR opens)
#   - Open PR + base ∉ (main, master) → exit 0 (deferred; the
#     integration branch's own PR-to-main carries the cumulative
#     review). Feature → develop PRs do not fire; develop → main
#     PRs do.
#   - Open PR + CURRENT_PR_HEAD == LAST_ACK → exit 0 (already reviewed
#     at this state)
#   - Open PR + CURRENT_PR_HEAD ≠ LAST_ACK → enforce: require
#     code-reviewer + spec-reviewer + doc-updater spawned later in
#     the transcript than the push line
#
# Migration from v4: if .git/sdd-last-ack-push (timestamp checkpoint)
# exists, it is deleted on first v5 invocation. The PR HEAD SHA
# checkpoint takes over.
#
# Bypass methods (USER-ONLY — the assistant must NEVER create the
# sentinel or write the magic phrase in its own output. An assistant
# that creates its own bypass defeats the entire enforcement layer.):
#   1. Sentinel file: /tmp/review-bypass (one-shot, auto-deleted)
#   2. Magic phrase: USER MESSAGE since the candidate push line contains
#      "skip review" or "skip verification" (case-insensitive, word-bounded)
#   3. 3-strike circuit breaker: after 3 blocks for the same un-acked
#      PR HEAD SHA, give up and let the user proceed
#
# Scope: only fires on main session Stop event (not SubagentStop).
# Vibe-coding gate: no enforcement if sdd/ is missing.
# Fail-safe: any unexpected error → exit 0 (never lock users out).
#
# Known under-block conditions (all fail-safe by design — review fires
# on the next eligible push instead of locking the user out):
#   1. Web-UI driven PR HEAD changes (amend from GitHub UI, branch
#      reset via API): the current Claude session has no `git push`
#      line in its transcript, so PUSH_LINE detection exits 0. Review
#      fires on the next local push to the branch.
#   2. Spec-reviewer subagent errored without writing
#      `completed</status>` for its tool-use id: doc-updater is not
#      required → push proceeds. The user sees the spec-reviewer
#      failure in the agent's own report; rerun manually.
#   3. Transcript file rotated or truncated mid-session: PUSH_LINE
#      detection silently returns 0. Review fires on the next push.
#
# Operational requirements (see rules/spec-discipline.md →
#   "Operational requirements for the Stop hook"):
#   - Current branch must have upstream tracking (`git rev-parse @{u}`
#     must resolve). The cheap @{u} short-circuit relies on it; without
#     it the hook still works via gh pr view but loses the fast path.
#   - `gh` on PATH for the authoritative PR HEAD SHA check.
#   - sdd/README.md present (vibe-coding gate).

set +e

# ---------------------------------------------------------------------------
# Read hook input (must come before sentinel cleanup so SubagentStop doesn't
# eat the one-shot sentinel before the actual Stop event honors it)
# ---------------------------------------------------------------------------
INPUT=$(cat 2>/dev/null) || exit 0
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

[ "$HOOK_EVENT" = "Stop" ] || exit 0
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# Ordering note (PUSH_LINE -> REPO_DIR -> gates -> bypasses -> enforcement):
# PUSH_LINE detection and REPO_DIR derivation must run BEFORE the
# vibe-coding gate and SDD transition gate, because in codeflare the
# agent CWD is /home/user/workspace/ (NOT a git repo) and cloned repos
# live one dir below. The gates need to evaluate `sdd/` from the push
# target, not the invocation CWD. Bypass-1 (sentinel) and bypass-2
# (magic phrase) must run AFTER the gates, otherwise a routine Stop
# on a vibe-coding project (no sdd/) silently consumes the user's
# one-shot /tmp/review-bypass sentinel.

# ---------------------------------------------------------------------------
# Layer 1 (CANDIDATE) — find tool_use lines whose effective shell command
# actually runs `git push` (not just mentions it inside an echo or
# narration). Three tool surfaces are scanned:
#
#   A. Bash tool                  → field `"command":"..."`
#   B. mcp__*__ctx_batch_execute  → field `"command":"..."` (per array entry,
#                                   inline on the same JSONL line)
#   C. mcp__*__ctx_execute        → field `"code":"..."` (only when the
#                                   sibling `"language":"shell"` appears on
#                                   the same JSONL line)
#
# Issue #319: prior to multi-tool scanning, `git push` made via ctx_execute
# or ctx_batch_execute was invisible to PUSH_LINE detection because the awk
# regex required `"name":"Bash"`. The review gate silently fell through
# (exit 0 - "no candidate") and unreviewed PR HEADs slipped past the
# Stop hook. The fix mirrors the multi-shape parsing already shipped in
# git-push-review-reminder.sh for issue #317.
#
# Match positions inside the command/code value:
#   1. starts with `git push` - e.g. `"command":"git push origin..."`
#   2. has a shell separator (;&|) before `git push` - chained pipelines
#      like `git add . && git push` or `git status; git push`
# Acceptable false-negative: heredoc/multi-line commands that JSON-encode
# newlines as `\n` and put `git push` after that. Rare in practice.
# Acceptable false-positive: still possible if a quoted string ends in a
# separator, but Layer 2 (PR HEAD SHA) filters these.
#
# ---------------------------------------------------------------------------
PUSH_LINE=$(awk '
  # A. Bash tool_use
  # Two-pattern detection: anchored start (`"command":"git push`) catches
  # bare pushes; loose chained (`<sep> git push`) catches piped/chained
  # pushes. The chained form is NOT anchored to start-of-command-string
  # because JSON-escaped quotes inside the value (e.g. `cd "/path with
  # spaces" && git push`) break the `[^"]*` inner-string constraint. The
  # outer `"name":"Bash"` guard keeps false positives bounded; Layer 2
  # (PR HEAD SHA) filters any that slip through.
  /"name"[[:space:]]*:[[:space:]]*"Bash"/ {
    if ($0 ~ /"command"[[:space:]]*:[[:space:]]*"git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /[;&|]+[[:space:]]*git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
  }
  # B. mcp__*__ctx_batch_execute tool_use (per-entry `"command"` field).
  #    Pattern note: `mcp__[^"]*ctx_batch_execute"` requires the literal
  #    `ctx_batch_execute` to end at the closing `"`, so it cannot match the
  #    bare `ctx_execute` tool name handled in block C below. Blocks B and C
  #    are mutually exclusive per tool_use line.
  /"name"[[:space:]]*:[[:space:]]*"mcp__[^"]*ctx_batch_execute"/ {
    if ($0 ~ /"command"[[:space:]]*:[[:space:]]*"git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /[;&|]+[[:space:]]*git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
  }
  # C. mcp__*__ctx_execute with `"language":"shell"` (uses `"code"` field).
  #    Pattern note: `mcp__[^"]*ctx_execute"` requires the literal `ctx_execute`
  #    to end at the closing `"` - the trailing `_batch_execute` form does NOT
  #    match. This is the mutual-exclusion anchor that lets blocks B and C
  #    share the line-level `mcp__` prefix without firing twice on one entry.
  /"name"[[:space:]]*:[[:space:]]*"mcp__[^"]*ctx_execute"/ {
    if ($0 !~ /"language"[[:space:]]*:[[:space:]]*"shell"/) next
    if ($0 ~ /"code"[[:space:]]*:[[:space:]]*"git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /[;&|]+[[:space:]]*git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
  }
' "$TRANSCRIPT" 2>/dev/null | tail -1)
[ -n "$PUSH_LINE" ] || exit 0  # No candidate, no enforcement

SINCE_PUSH=$(tail -n +"$PUSH_LINE" "$TRANSCRIPT" 2>/dev/null)

# ---------------------------------------------------------------------------
# Derive repo dir from the PUSH_LINE tool_use envelope before resolving git.
#
# Why: in codeflare the session CWD is /home/user/workspace/ (NOT a git
# repo); cloned repos live one level down (e.g. /home/user/workspace/codeflare/).
# The hook is invoked with the agent's CWD, so `git rev-parse` from that
# dir returns empty and the enforcement silently exits 0. Issue surfaced
# when round-2 pushes on PR #369 reached main with un-acked HEAD.
#
# Strategy: read the PUSH_LINE record's envelope `.cwd` and the leading
# `cd <path>` prefix from its command/code field. Try each in order until
# `git rev-parse --show-toplevel` resolves. Then `cd` to the toplevel so
# all subsequent gates evaluate from the repo root (a `cd src/foo && git
# push` command must not put us into a subdir where `sdd/` is missing).
#
# CD_PATH parser supports three command shapes:
#   - cd /abs/path && ...       (unquoted, no spaces)
#   - cd "/abs/path with spaces" && ...   (double-quoted)
#   - cd '/abs/path with spaces' && ...   (single-quoted)
# Accepted limitation: paths containing the literal characters used as
# quote terminators inside an opposite-quoted form (e.g. `cd "/a'b/c"`)
# parse the embedded `'` as content, which is correct. Paths containing
# escaped quotes within their own quote class (`cd "/a\"b/c"`) are NOT
# supported - graphify-verified that no codeflare path has this shape.
# ---------------------------------------------------------------------------
PUSH_RECORD=$(sed -n "${PUSH_LINE}p" "$TRANSCRIPT" 2>/dev/null)
ENVELOPE_CWD=$(echo "$PUSH_RECORD" | jq -r '.cwd // empty' 2>/dev/null)
# jq -r decodes the JSON-encoded command/code string back to its raw
# shell form (handles `&&`, `\"`, etc.). The `..` recursive
# descent finds the first command/code field anywhere in the record.
COMMAND_TEXT=$(echo "$PUSH_RECORD" | jq -r '
  [.. | objects | (.command? // .code?) | select(type=="string")] | .[0] // empty
' 2>/dev/null)
CD_PATH=$(printf '%s' "$COMMAND_TEXT" | awk '
  /^[[:space:]]*cd[[:space:]]+/ {
    sub(/^[[:space:]]*cd[[:space:]]+/, "");
    if (substr($0,1,1) == "\"") {
      sub(/^"/, "");
      n = index($0, "\"");
      if (n > 0) { print substr($0, 1, n-1); exit }
    } else if (substr($0,1,1) == "\047") {
      sub(/^\047/, "");
      n = index($0, "\047");
      if (n > 0) { print substr($0, 1, n-1); exit }
    } else {
      n = match($0, /[[:space:];&|]/);
      if (n > 0) print substr($0, 1, n-1); else print $0;
      exit
    }
  }
')
if [ -n "$CD_PATH" ] && [ "${CD_PATH:0:1}" != "/" ] && [ -n "$ENVELOPE_CWD" ]; then
  CD_PATH="$ENVELOPE_CWD/$CD_PATH"
fi

REPO_DIR=""
for d in "$CD_PATH" "$ENVELOPE_CWD" "."; do
  [ -n "$d" ] && [ -d "$d" ] || continue
  # show-toplevel (NOT git-common-dir): climbs to the working-tree root
  # so a `cd src/foo` candidate resolves to the repo root and the
  # subsequent `sdd/` gate evaluates against the right tree.
  TOPLEVEL=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$TOPLEVEL" ]; then
    REPO_DIR="$TOPLEVEL"
    break
  fi
done
[ -n "$REPO_DIR" ] || exit 0  # no resolvable git repo from any candidate
cd "$REPO_DIR" 2>/dev/null || exit 0

# ---------------------------------------------------------------------------
# Vibe-coding gate (evaluated from repo toplevel, not invocation CWD)
# ---------------------------------------------------------------------------
if [ ! -d "sdd" ] || [ ! -f "sdd/README.md" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# SDD transition gate (REQ-AGENT-022) - do not block turn-end while the
# user is mid-transition. The condition is the single source of truth
# defined in spec-discipline.md "Transition gate condition": BOTH
# transition: true in sdd/config.yml AND at least one **Status:** open
# item in sdd/init-triage.md (case-insensitive on `open`). Both required.
#
# If transition: true is set but no open items exist, this is corrupted
# state -- let the run proceed so spec-reviewer flags it (Step 0b.5
# writes a HIGH finding to sdd/.review-needed.md).
# ---------------------------------------------------------------------------
if grep -q '^transition:[[:space:]]*true' sdd/config.yml 2>/dev/null \
   && [ -f "sdd/init-triage.md" ] \
   && grep -qiE '^\*\*Status:\*\*[[:space:]]+open\b' "sdd/init-triage.md" 2>/dev/null; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Bypass 1: sentinel file (one-shot, auto-delete).
#
# Ordering: runs AFTER the vibe-coding gate and transition gate so a
# routine Stop event on a vibe-coding project (no sdd/) or during SDD
# transition does NOT consume the user's one-shot /tmp/review-bypass
# sentinel - that bypass is reserved for skipping enforcement on the
# next gate-active Stop event.
#
# Sentinel path is overridable via REVIEW_BYPASS_FILE for hermetic
# tests; production reads /tmp/review-bypass. Codeflare runs a
# single-user container, so /tmp scoping is sufficient - multi-user
# hosts should set REVIEW_BYPASS_FILE per user.
# ---------------------------------------------------------------------------
BYPASS_FILE="${REVIEW_BYPASS_FILE:-/tmp/review-bypass}"
if [ -f "$BYPASS_FILE" ]; then
  rm -f "$BYPASS_FILE" 2>/dev/null || true
  exit 0
fi

# ---------------------------------------------------------------------------
# Bypass 2: magic phrase in user messages since candidate push line.
#
# Ordering note: SINCE_PUSH only includes transcript content from the
# push line forward. A user message saying "skip review for the next
# push" sent BEFORE the assistant ran git push won't bypass - only
# messages between the push line and the Stop event are scanned.
# Users who need pre-emptive bypass should use the sentinel file
# (`touch /tmp/review-bypass`), which fires first via Bypass 1.
# ---------------------------------------------------------------------------
if echo "$SINCE_PUSH" | grep '"type":"user"' | grep -v '"tool_result"' | grep -qiE '\bskip (the )?(review|verification)\b'; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Resolve git common dir for worktree/submodule compatibility
# ---------------------------------------------------------------------------
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null)
[ -n "$GIT_COMMON_DIR" ] || exit 0  # not in a git repo → silent exit
case "$GIT_COMMON_DIR" in /*) ;; *) GIT_COMMON_DIR="$REPO_DIR/$GIT_COMMON_DIR" ;; esac
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

# ---------------------------------------------------------------------------
# Cheap pre-check: skip the gh network call if all four conditions hold,
# falling through to the authoritative gh check otherwise.
#
#   1. last-ack matches the local remote-tracking ref (@{u})
#   2. local HEAD matches @{u} (no local commits ahead — guards against
#      `git reset --hard` regressing HEAD to an old acked SHA while a
#      newer un-acked SHA exists upstream that the next push would
#      promote)
#   3. ack file mtime is within 5 minutes (bounds the staleness of
#      @{u}: if the user hasn't fetched recently, @{u} could be stale
#      and an upstream push from elsewhere would go un-reviewed)
#   4. @{u} resolves at all
#
# Without all four, fall through. The cheap path saves a 200-500ms
# gh round-trip in the steady-state post-review tail of a session;
# the constraints above ensure we never short-circuit on a stale
# signal that hides a real un-acked PR HEAD.
# ---------------------------------------------------------------------------
LAST_ACK_PR_HEAD=""
if [ -f "$ACK_FILE" ]; then
  LAST_ACK_PR_HEAD=$(cat "$ACK_FILE" 2>/dev/null)
fi

if [ -n "$LAST_ACK_PR_HEAD" ]; then
  REMOTE_HEAD=$(git rev-parse "@{u}" 2>/dev/null)
  LOCAL_HEAD=$(git rev-parse HEAD 2>/dev/null)
  if [ -n "$REMOTE_HEAD" ] \
     && [ "$REMOTE_HEAD" = "$LAST_ACK_PR_HEAD" ] \
     && [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
    ack_age=$(( $(date +%s) - $(stat -c %Y "$ACK_FILE" 2>/dev/null || stat -f %m "$ACK_FILE" 2>/dev/null || echo 0) ))
    if [ "$ack_age" -lt 300 ] 2>/dev/null; then
      exit 0
    fi
  fi
fi

if ! command -v gh >/dev/null 2>&1; then
  exit 0  # gh missing → can't verify PR state → fail-safe exit
fi

# Shared CLI invocation; see lib/gh-pr-state.sh for the contract
. "$(dirname "$0")/lib/gh-pr-state.sh" 2>/dev/null || exit 0
PR_INFO=$(gh_pr_state "$CURRENT") || exit 0
[ -n "$PR_INFO" ] || exit 0

PR_STATE=$(echo "$PR_INFO" | jq -r '.state // empty' 2>/dev/null)
CURRENT_PR_HEAD=$(echo "$PR_INFO" | jq -r '.headRefOid // empty' 2>/dev/null)
BASE_REF=$(echo "$PR_INFO" | jq -r '.baseRefName // empty' 2>/dev/null)

# No open PR → exit 0 (deferred review)
# MERGED/CLOSED with un-acked HEAD → record visibility finding but do
# not block (the merge already happened; blocking turn-end is moot).
if [ "$PR_STATE" = "MERGED" ] || [ "$PR_STATE" = "CLOSED" ]; then
  if [ -n "$CURRENT_PR_HEAD" ] \
     && [ -n "$LAST_ACK_PR_HEAD" ] \
     && [ "$LAST_ACK_PR_HEAD" != "$CURRENT_PR_HEAD" ]; then
    {
      printf '\n## %s — PR %s un-acked at merge/close\n' \
        "$(date +%Y-%m-%d)" "$PR_STATE"
      printf -- '- PR for branch `%s` reached %s with un-acked HEAD `%s` (last ack: `%s`). Review pipeline did not complete before merge.\n' \
        "$CURRENT" "$PR_STATE" "${CURRENT_PR_HEAD:0:7}" "${LAST_ACK_PR_HEAD:0:7}"
    } >> sdd/.review-needed.md 2>/dev/null || true
  fi
  exit 0
fi
[ "$PR_STATE" = "OPEN" ] || exit 0
[ -n "$CURRENT_PR_HEAD" ] || exit 0

# Gate on PR target: only PRs landing on main/master trigger the review
# pipeline. Feature → develop defers until the develop → main PR.
#
# Empty BASE_REF (transient gh / jq failure between successful state
# parse and base parse — rare but possible) is treated as fail-open:
# enforcement still runs. Better to over-block when truth is uncertain
# than to silently let an unreviewed PR-to-main slip through.
case "$BASE_REF" in
  main|master|"") ;;
  *) exit 0 ;;
esac

# Authoritative PR HEAD check (network result may differ from @{u} if
# the local-tracking ref is stale): bail if already acked.
if [ -n "$LAST_ACK_PR_HEAD" ] && [ "$LAST_ACK_PR_HEAD" = "$CURRENT_PR_HEAD" ]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Real un-acknowledged PR HEAD exists. Enforce.
#
# "Spawned after push" = appears later in the transcript than the push
# line. The transcript is append-only JSONL, so line number is the
# authoritative order. No timestamp parsing needed.
# ---------------------------------------------------------------------------

spawned_after_push() {
  local agent="$1"
  awk -v p="$PUSH_LINE" -v a="$agent" '
    NR > p && index($0, "\"subagent_type\":\"" a "\"") { found = 1; exit }
    END { exit !found }
  ' "$TRANSCRIPT"
}

# 3-strike circuit breaker (keyed by CURRENT_PR_HEAD — unique per PR state)
#
# Counter format on disk: "<sha>:<count>" or "<sha>:GIVEUP".
# After the third block for the same SHA, the counter is set to GIVEUP
# rather than deleted -- this makes the give-up state sticky for that
# specific SHA. Without GIVEUP, deleting the file on the third strike
# would let the next Stop event start at 0 and block 3 more times,
# repeating forever. The counter resets only when CURRENT_PR_HEAD
# changes (next push lands).
read_count() {
  if [ -f "$COUNT_FILE" ]; then
    local stored hash count
    stored=$(cat "$COUNT_FILE" 2>/dev/null)
    hash="${stored%%:*}"
    count="${stored#*:}"
    if [ "$hash" = "$CURRENT_PR_HEAD" ]; then
      if [ "$count" = "GIVEUP" ]; then
        echo "GIVEUP"
        return
      fi
      case "$count" in
        ''|*[!0-9]*) count=0 ;;
      esac
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
  if [ "$current" = "GIVEUP" ]; then
    exit 0
  fi
  if [ "$current" -ge 3 ] 2>/dev/null; then
    echo "$CURRENT_PR_HEAD:GIVEUP" > "$COUNT_FILE" 2>/dev/null || true
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
  REASON="PR #$CURRENT (head ${CURRENT_PR_HEAD:0:7}) needs SDD review. Spawn missing:$MISSING in parallel via Agent tool. USER bypass: 'skip review' or 'touch /tmp/review-bypass'."
  emit_block "$REASON"
fi

# ---------------------------------------------------------------------------
# Check 2: spec-reviewer completion → doc-updater must follow
# ---------------------------------------------------------------------------
SPEC_SPAWN_LINE=$(awk -v p="$PUSH_LINE" '
  NR > p && /"subagent_type":"spec-reviewer"/ { print NR }
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
        REASON="spec-reviewer done; doc-updater missing. Spawn doc-updater via Agent tool (sequential — shared filesystem). USER bypass: 'skip review' or 'touch /tmp/review-bypass'."
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
