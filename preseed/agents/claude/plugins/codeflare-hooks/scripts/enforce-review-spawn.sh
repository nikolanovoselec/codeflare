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
  #
  # `gh pr merge` is also recognised: a server-side merge into develop
  # advances origin/develop without a local `git push`, but it is the
  # exact event that creates an un-acked develop->main PR HEAD. Without
  # this surface, develop->main reviewers silently fail to arm. See
  # commit history for the "stop hook never fires after gh pr merge"
  # incident.
  /"name"[[:space:]]*:[[:space:]]*"Bash"/ {
    if ($0 ~ /"command"[[:space:]]*:[[:space:]]*"git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /(\\n|[;&|])[[:space:]]*git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /"command"[[:space:]]*:[[:space:]]*"gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /(\\n|[;&|])[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) {
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
    if ($0 ~ /(\\n|[;&|])[[:space:]]*git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /"command"[[:space:]]*:[[:space:]]*"gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /(\\n|[;&|])[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) {
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
    if ($0 ~ /(\\n|[;&|])[[:space:]]*git[[:space:]]+push[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /"code"[[:space:]]*:[[:space:]]*"gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) {
      print NR; next
    }
    if ($0 ~ /(\\n|[;&|])[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) {
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
PUSH_RECORD=$(awk -v L="$PUSH_LINE" 'NR==L { print; exit }' "$TRANSCRIPT" 2>/dev/null)
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
# transition: true in config AND at least one **Status:** open item in
# init-triage (case-insensitive on `open`). Both required. Layout-aware:
# nested sdd/spec/* paths override flat sdd/* paths.
#
# If transition: true is set but no open items exist, this is corrupted
# state -- let the run proceed so spec-reviewer flags it (Step 0b.5
# writes a HIGH finding to the layout-resolved triage file).
# ---------------------------------------------------------------------------
_config_file=$(test -f sdd/spec/config.yml && echo sdd/spec/config.yml || echo sdd/config.yml)
_triage_init=$(test -f sdd/spec/init-triage.md && echo sdd/spec/init-triage.md || echo sdd/init-triage.md)
if grep -q '^transition:[[:space:]]*true' "$_config_file" 2>/dev/null \
   && [ -f "$_triage_init" ] \
   && grep -qiE '^\*\*Status:\*\*[[:space:]]+open\b' "$_triage_init" 2>/dev/null; then
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
  # SHA-shape guard: only accept a 40-char lower-hex string. A corrupt or
  # accidentally-touched ACK file (truncated, contains a stray newline, or
  # holds non-SHA bytes) used to silently load and force the authoritative
  # gh round-trip via the !match path below; this explicit validation
  # makes the self-heal visible in audit and prevents the unlikely future
  # case of a partially-valid prefix matching by accident.
  case "$LAST_ACK_PR_HEAD" in
    *[!0-9a-f]* | "" ) LAST_ACK_PR_HEAD="" ;;
    *) [ "${#LAST_ACK_PR_HEAD}" -eq 40 ] || LAST_ACK_PR_HEAD="" ;;
  esac
fi

# ---------------------------------------------------------------------------
# Retroactive ack scan (v7) -- handles the fix-push cascade pattern.
#
# The classic flow at the bottom of this file advances LAST_ACK only when
# Stop fires for the CURRENT HEAD AND finds agents spawned-and-completed
# AFTER the most recent push line. In a cascade where the assistant does
# "push fix -> spawn agents -> agents complete -> apply more findings ->
# push again" all inside one turn, Stop fires only at turn-end -- by which
# time PUSH_LINE has already moved past the spawn lines for the EARLIER
# push, and the completion markers no longer count for the CURRENT HEAD.
# Result: LAST_ACK stuck for many rounds even though each round had a
# fully-observed pipeline of agents reviewing the cumulative diff.
#
# Semantics:
# - Walk push lines from oldest to newest.
# - For each (push_line, push_sha) pair, check whether the window
#   (push_line, next_push_line) contains a complete pipeline for the
#   cumulative diff running_ack..push_sha (running_ack starts at the
#   persisted LAST_ACK_PR_HEAD and advances as the walk progresses).
# - "Complete" = each lane in compute_required_lanes(running_ack, push_sha)
#   has a spawn-AND-completion in the window.
# - On a complete window: advance running_ack to push_sha.
# - On an INCOMPLETE window (some required lane spawn or completion is
#   missing): leave running_ack where it is and continue to the next
#   push. A later push's reviewers will cover the cumulative diff that
#   includes this push's changes.
# - "Skipped" pushes (no spawns at all, e.g. user said `skip review`)
#   simply don't advance running_ack - the next complete window's
#   cumulative review will absorb them.
#
# Safety: `git merge-base --is-ancestor` at the call site gates the
# actual file write so a stale or rebased transcript can never make
# LAST_ACK regress or jump to a SHA that is not an ancestor of (or
# equal to) HEAD.
# ---------------------------------------------------------------------------
retroactive_ack_scan() {
  [ -f "$TRANSCRIPT" ] || return
  local total
  total=$(wc -l < "$TRANSCRIPT" 2>/dev/null || echo 0)
  [ "$total" -gt 0 ] || return

  # Push line detection - SAME precise regex as the main PUSH_LINE
  # detector at the top of this file. A loose `index($0, "git push")`
  # would false-positive on Edit/Read tool_use envelopes whose
  # old_string/new_string content quotes the phrase (e.g. an edit to
  # this hook itself).
  local all_push_lines
  all_push_lines=$(awk '
    /"name"[[:space:]]*:[[:space:]]*"Bash"/ {
      if ($0 ~ /"command"[[:space:]]*:[[:space:]]*"git[[:space:]]+push[[:space:]"\\\047);&|]/) { print NR; next }
      if ($0 ~ /(\\n|[;&|])[[:space:]]*git[[:space:]]+push[[:space:]"\\\047);&|]/) { print NR; next }
      if ($0 ~ /"command"[[:space:]]*:[[:space:]]*"gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) { print NR; next }
      if ($0 ~ /(\\n|[;&|])[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) { print NR; next }
    }
    /"name"[[:space:]]*:[[:space:]]*"mcp__[^"]*ctx_batch_execute"/ {
      if ($0 ~ /"command"[[:space:]]*:[[:space:]]*"git[[:space:]]+push[[:space:]"\\\047);&|]/) { print NR; next }
      if ($0 ~ /(\\n|[;&|])[[:space:]]*git[[:space:]]+push[[:space:]"\\\047);&|]/) { print NR; next }
      if ($0 ~ /"command"[[:space:]]*:[[:space:]]*"gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) { print NR; next }
      if ($0 ~ /(\\n|[;&|])[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) { print NR; next }
    }
    /"name"[[:space:]]*:[[:space:]]*"mcp__[^"]*ctx_execute"/ {
      if ($0 !~ /"language"[[:space:]]*:[[:space:]]*"shell"/) next
      if ($0 ~ /"code"[[:space:]]*:[[:space:]]*"git[[:space:]]+push[[:space:]"\\\047);&|]/) { print NR; next }
      if ($0 ~ /(\\n|[;&|])[[:space:]]*git[[:space:]]+push[[:space:]"\\\047);&|]/) { print NR; next }
      if ($0 ~ /"code"[[:space:]]*:[[:space:]]*"gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) { print NR; next }
      if ($0 ~ /(\\n|[;&|])[[:space:]]*gh[[:space:]]+pr[[:space:]]+merge[[:space:]"\\\047);&|]/) { print NR; next }
    }
  ' "$TRANSCRIPT")
  [ -n "$all_push_lines" ] || return

  # Source the lane classifier so we can compute per-push required lanes.
  . "$(dirname "$0")/lib/lane-classifier.sh" 2>/dev/null || return

  # Convert space-separated push lines to an array for indexed access.
  local -a push_arr
  while IFS= read -r line; do
    [ -n "$line" ] && push_arr+=("$line")
  done <<< "$all_push_lines"
  local n=${#push_arr[@]}
  [ "$n" -gt 0 ] || return

  local running_ack="$LAST_ACK_PR_HEAD"
  local best_sha=""

  local i
  for ((i=0; i<n; i++)); do
    local start=${push_arr[$i]}
    local end
    if [ $((i+1)) -lt "$n" ]; then
      end=${push_arr[$((i+1))]}
    else
      end=$total
    fi

    # Destination SHA from THIS push's window. git push abbreviates SHAs
    # to 7 chars; expand to full 40-hex via git rev-parse.
    #
    # Regex target-branch is `[A-Za-z0-9_-]+` (NO slash) to exclude
    # `git fetch` output: fetch writes `<old>..<new>  <ref> -> <remote>/<ref>`
    # with a slash in the target. Push writes `<old>..<new>  <ref> -> <ref>`
    # with a plain target. Without this exclusion, a `git fetch` between
    # pushes in the same turn would land its own SHA pair in the window
    # and `head -1` would pick the wrong (fetched, not pushed) SHA.
    #
    # `gh pr merge` does NOT emit a `xxxxxxx..yyyyyyy` line at all (it
    # prints "Merged pull request #N"), so this regex extracts nothing
    # and the window is silently skipped. That is the right behaviour:
    # the next normal `git push` to develop will absorb the merge diff
    # into its cumulative review window via the running_ack chain.
    local sha_short
    sha_short=$(awk -v s="$start" -v e="$end" 'NR >= s && NR < e' "$TRANSCRIPT" \
      | grep -oE '[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}[[:space:]]+[A-Za-z0-9_/-]+[[:space:]]+->[[:space:]]+[A-Za-z0-9_-]+' \
      | head -1 \
      | sed -E 's/^[0-9a-f]+\.\.([0-9a-f]+).*/\1/')
    [ -n "$sha_short" ] || continue
    local push_sha
    push_sha=$(git rev-parse "$sha_short" 2>/dev/null)
    [ -n "$push_sha" ] && [ "${#push_sha}" -eq 40 ] || continue

    # Required lanes for the cumulative diff running_ack..push_sha.
    local required_lanes
    required_lanes=$(compute_required_lanes "$running_ack" "$push_sha" 2>/dev/null)

    # Empty required lanes - the lane classifier returns empty ONLY for
    # the no-op short-circuit (running_ack == push_sha). For any other
    # uncertainty branch it returns all-three fail-closed. Treat empty
    # output as a trivial ack ONLY when the SHAs actually match; any
    # other empty result is a classifier regression and we fail-closed
    # by leaving running_ack alone (a later complete window will absorb
    # this push's diff).
    if [ -z "$required_lanes" ]; then
      if [ "$running_ack" = "$push_sha" ]; then
        best_sha="$push_sha"
        running_ack="$push_sha"
      fi
      continue
    fi

    # Check each required lane in the window. If any is missing or its
    # spawn lacks a completion marker, leave running_ack unchanged and
    # continue (a LATER complete window will absorb this push's diff
    # into its cumulative review).
    local window_complete=1
    local lane
    for lane in $required_lanes; do
      local spawn_line
      spawn_line=$(awk -v s="$start" -v e="$end" -v a="$lane" '
        NR > s && NR < e \
          && index($0, "\"type\":\"tool_use\"") \
          && index($0, "\"name\":\"Agent\"") \
          && index($0, "\"subagent_type\":\"" a "\"") { print NR }
      ' "$TRANSCRIPT" | tail -1)
      if [ -z "$spawn_line" ]; then
        window_complete=0; break
      fi
      local line_content tool_use_id
      line_content=$(awk -v L="$spawn_line" 'NR==L { print; exit }' "$TRANSCRIPT")
      tool_use_id=$(echo "$line_content" | grep -oE '"id"[[:space:]]*:[[:space:]]*"toolu_[^"]+"' | head -1 | grep -oE 'toolu_[^"]+')
      if [ -z "$tool_use_id" ]; then
        window_complete=0; break
      fi
      # Completion can land anywhere after the spawn (notifications may
      # arrive in a later turn).
      if ! awk -v s="$spawn_line" 'NR > s' "$TRANSCRIPT" \
          | grep -F "tool-use-id>${tool_use_id}<" \
          | grep -qF 'completed</status>'; then
        window_complete=0; break
      fi
    done

    if [ "$window_complete" = "1" ]; then
      best_sha="$push_sha"
      running_ack="$push_sha"
    fi
    # If incomplete: continue walking. Don't break -- a later push's
    # cumulative review will absorb this push's diff.
  done

  echo "$best_sha"
}

RETRO_SHA=$(retroactive_ack_scan 2>/dev/null)
if [ -n "$RETRO_SHA" ] && [ "$RETRO_SHA" != "$LAST_ACK_PR_HEAD" ]; then
  # Only advance forward. The merge-base check covers the rebase / force-
  # push edge case: if RETRO_SHA is not an ancestor of (or equal to) the
  # current HEAD chain, the transcript is referring to an obsolete tip and
  # we ignore it.
  CURRENT_HEAD_LOCAL=$(git rev-parse HEAD 2>/dev/null)
  if [ -n "$CURRENT_HEAD_LOCAL" ] && git cat-file -e "$RETRO_SHA" 2>/dev/null; then
    if { [ -z "$LAST_ACK_PR_HEAD" ] || git merge-base --is-ancestor "$LAST_ACK_PR_HEAD" "$RETRO_SHA" 2>/dev/null; } \
       && { [ "$RETRO_SHA" = "$CURRENT_HEAD_LOCAL" ] \
            || git merge-base --is-ancestor "$RETRO_SHA" "$CURRENT_HEAD_LOCAL" 2>/dev/null; }; then
      LAST_ACK_PR_HEAD="$RETRO_SHA"
      echo "$LAST_ACK_PR_HEAD" > "$ACK_FILE" 2>/dev/null || true
    fi
  fi
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
    triage_file=$(test -f sdd/spec/triage.md && echo sdd/spec/triage.md || echo sdd/.review-needed.md)
    {
      printf '\n## %s — PR %s un-acked at merge/close\n' \
        "$(date +%Y-%m-%d)" "$PR_STATE"
      printf -- '- PR for branch `%s` reached %s with un-acked HEAD `%s` (last ack: `%s`). Review pipeline did not complete before merge.\n' \
        "$CURRENT" "$PR_STATE" "${CURRENT_PR_HEAD:0:7}" "${LAST_ACK_PR_HEAD:0:7}"
    } >> "$triage_file" 2>/dev/null || true
  fi
  exit 0
fi
[ "$PR_STATE" = "OPEN" ] || exit 0
[ -n "$CURRENT_PR_HEAD" ] || exit 0

# Gate on PR target: only PRs landing on main/master trigger the review
# pipeline. Feature → develop defers until the develop → main PR.
#
# Empty BASE_REF (transient gh / jq failure between successful state
# parse and base parse — rare but possible) is treated as fail-CLOSED:
# enforcement still runs (the safe direction). Better to over-block
# when truth is uncertain than to silently let an unreviewed PR-to-main
# slip through.
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
  # Anchor on `"type":"tool_use"` AND `"name":"Agent"` on the same line so
  # the substring match only fires on actual Agent tool_use envelopes, not
  # on prose / tool_result text / ctx_execute output that happens to quote
  # the literal `"subagent_type":"<name>"` bytes (e.g. a diagnostic script
  # printing hook JSON to the transcript). The JSONL transcript serialises
  # each tool_use envelope on a single line, so this triple-condition match
  # is reliable.
  awk -v p="$PUSH_LINE" -v a="$agent" '
    NR > p \
      && index($0, "\"type\":\"tool_use\"") \
      && index($0, "\"name\":\"Agent\"") \
      && index($0, "\"subagent_type\":\"" a "\"") { found = 1; exit }
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
# Lane gating (v6) — only require lanes whose surface the push actually
# touches. Skip lanes that were clean last cycle and are not affected by
# the new diff. The previous version always demanded code+spec+doc on
# every push, burning tokens on lanes that returned 0 findings the round
# before. See task #58 for rationale.
#
# Classification logic lives in lib/lane-classifier.sh so the PostToolUse
# nudge (git-push-review-reminder.sh) can emit a directive that names
# only the required agents - preventing the in-turn nudge from telling
# the agent to spawn lanes this Stop hook would silently exclude.
#
# Fail-safe direction (FAIL-CLOSED): if the classifier helper is missing
# or fails to source, default REQUIRED_LANES to the legacy all-three set
# rather than `exit 0`. Silently bypassing the enforcement gate would be
# the worst-of-both-worlds outcome: a partially-deployed install with a
# present Stop hook but a missing lib would silently disable review
# enforcement. Demanding all-three on the unhappy path matches the
# PostToolUse nudge's symmetric fall-back and preserves the gate's
# security shape (over-enforce rather than under-enforce on uncertainty).
# Initial state (no LAST_ACK) or unresolvable git diff -> same conservative
# all-three posture inside compute_required_lanes itself.
# ---------------------------------------------------------------------------
REQUIRED_LANES="code-reviewer spec-reviewer doc-updater"
if . "$(dirname "$0")/lib/lane-classifier.sh" 2>/dev/null; then
  REQUIRED_LANES=$(compute_required_lanes "$LAST_ACK_PR_HEAD" "$CURRENT_PR_HEAD")
fi

# No lanes required -> already-clean PR HEAD for this diff shape. Ack
# the checkpoint and exit silently so the next Stop event short-circuits
# on the cheap path.
if [ -z "$REQUIRED_LANES" ]; then
  echo "$CURRENT_PR_HEAD" > "$ACK_FILE" 2>/dev/null || true
  clear_counter
  exit 0
fi

# Helpers shared by the parallel and sequential checks below.
requires_lane() {
  case " $REQUIRED_LANES " in
    *" $1 "*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# Parallel block: code-reviewer + spec-reviewer can be spawned together.
# Only the ones present in REQUIRED_LANES are demanded.
# ---------------------------------------------------------------------------
MISSING=""
if requires_lane "code-reviewer" && ! spawned_after_push "code-reviewer"; then
  MISSING="$MISSING code-reviewer"
fi
if requires_lane "spec-reviewer" && ! spawned_after_push "spec-reviewer"; then
  MISSING="$MISSING spec-reviewer"
fi

if [ -n "$MISSING" ]; then
  REASON="PR #$CURRENT (head ${CURRENT_PR_HEAD:0:7}) needs SDD review. Spawn missing:$MISSING in parallel via Agent tool. Lanes required for this push: $REQUIRED_LANES. USER bypass: 'skip review' or 'touch /tmp/review-bypass'."
  emit_block "$REASON"
fi

# ---------------------------------------------------------------------------
# Doc-updater check. Two modes:
#
#   - Sequential (spec-reviewer ALSO required): doc-updater must follow
#     spec-reviewer's completion to avoid racing on sdd/ files. This is
#     the legacy behaviour and the path the spec-discipline rule relies
#     on for the AC-backlink follow-up.
#
#   - Independent (spec-reviewer NOT required): doc-updater can be
#     spawned any time after the push. This is the pure-documentation
#     push case that motivated task #58.
# ---------------------------------------------------------------------------
PIPELINE_COMPLETE=0
DOC_REQUIRED=0
requires_lane "doc-updater" && DOC_REQUIRED=1
SPEC_REQUIRED=0
requires_lane "spec-reviewer" && SPEC_REQUIRED=1

if [ "$DOC_REQUIRED" = "1" ] && [ "$SPEC_REQUIRED" = "1" ]; then
  # Sequential gating: wait for spec-reviewer's tool-use to mark
  # completed</status>, then require doc-updater to follow.
  # Anchor each subagent_type match on `"type":"tool_use"` AND
  # `"name":"Agent"` so prose / tool_result text quoting the bytes
  # cannot false-positive (see spawned_after_push comment above).
  SPEC_SPAWN_LINE=$(awk -v p="$PUSH_LINE" '
    NR > p \
      && index($0, "\"type\":\"tool_use\"") \
      && index($0, "\"name\":\"Agent\"") \
      && index($0, "\"subagent_type\":\"spec-reviewer\"") { print NR }
  ' "$TRANSCRIPT" | tail -1)

  if [ -n "$SPEC_SPAWN_LINE" ]; then
    SPEC_LINE_CONTENT=$(awk -v L="$SPEC_SPAWN_LINE" 'NR==L { print; exit }' "$TRANSCRIPT")
    SPEC_TOOL_USE_ID=$(echo "$SPEC_LINE_CONTENT" | grep -oE '"id"[[:space:]]*:[[:space:]]*"toolu_[^"]+"' | head -1 | grep -oE 'toolu_[^"]+')

    if [ -n "$SPEC_TOOL_USE_ID" ]; then
      SINCE_SPEC=$(tail -n +"$SPEC_SPAWN_LINE" "$TRANSCRIPT" 2>/dev/null)
      SPEC_DONE_LINE=$(echo "$SINCE_SPEC" | grep -nF "tool-use-id>${SPEC_TOOL_USE_ID}<" | grep -F 'completed</status>' | tail -1 | cut -d: -f1)

      if [ -n "$SPEC_DONE_LINE" ]; then
        SINCE_SPEC_DONE=$(echo "$SINCE_SPEC" | tail -n +"$SPEC_DONE_LINE")
        # Same precision anchor for the doc-updater follow-up scan.
        if ! echo "$SINCE_SPEC_DONE" | awk '
          index($0, "\"type\":\"tool_use\"") \
            && index($0, "\"name\":\"Agent\"") \
            && index($0, "\"subagent_type\":\"doc-updater\"") { found=1; exit }
          END { exit !found }
        '; then
          REASON="spec-reviewer done; doc-updater missing. Spawn doc-updater via Agent tool (sequential -- shared filesystem). Lanes required for this push: $REQUIRED_LANES. USER bypass: 'skip review' or 'touch /tmp/review-bypass'."
          emit_block "$REASON"
        fi
        PIPELINE_COMPLETE=1
      fi
    fi
  fi
elif [ "$DOC_REQUIRED" = "1" ]; then
  # Independent doc-updater (spec-reviewer not required this round).
  # No completion-marker dependency: must just be spawned later in the
  # transcript than the push. PIPELINE_COMPLETE only flips once we see
  # the doc-updater tool-use envelope; we cannot ack a SHA we never
  # verified.
  if ! spawned_after_push "doc-updater"; then
    REASON="PR #$CURRENT (head ${CURRENT_PR_HEAD:0:7}) needs doc-updater (lane required: documentation surface touched, spec/code clean). Spawn via Agent tool. USER bypass: 'skip review' or 'touch /tmp/review-bypass'."
    emit_block "$REASON"
  fi
  PIPELINE_COMPLETE=1
elif [ "$SPEC_REQUIRED" = "1" ]; then
  # Spec-reviewer was required but doc-updater was not (would only
  # happen if the classification table changes; today every sdd/ touch
  # also pulls doc-updater). Ack once spec-reviewer's tool-use is
  # marked completed.
  SPEC_SPAWN_LINE=$(awk -v p="$PUSH_LINE" '
    NR > p \
      && index($0, "\"type\":\"tool_use\"") \
      && index($0, "\"name\":\"Agent\"") \
      && index($0, "\"subagent_type\":\"spec-reviewer\"") { print NR }
  ' "$TRANSCRIPT" | tail -1)
  if [ -n "$SPEC_SPAWN_LINE" ]; then
    SPEC_LINE_CONTENT=$(awk -v L="$SPEC_SPAWN_LINE" 'NR==L { print; exit }' "$TRANSCRIPT")
    SPEC_TOOL_USE_ID=$(echo "$SPEC_LINE_CONTENT" | grep -oE '"id"[[:space:]]*:[[:space:]]*"toolu_[^"]+"' | head -1 | grep -oE 'toolu_[^"]+')
    if [ -n "$SPEC_TOOL_USE_ID" ]; then
      SINCE_SPEC=$(tail -n +"$SPEC_SPAWN_LINE" "$TRANSCRIPT" 2>/dev/null)
      if echo "$SINCE_SPEC" | grep -F "tool-use-id>${SPEC_TOOL_USE_ID}<" | grep -qF 'completed</status>'; then
        PIPELINE_COMPLETE=1
      fi
    fi
  fi
else
  # Only code-reviewer required (no spec, no docs). Ack once
  # code-reviewer's tool-use is marked completed.
  CODE_SPAWN_LINE=$(awk -v p="$PUSH_LINE" '
    NR > p \
      && index($0, "\"type\":\"tool_use\"") \
      && index($0, "\"name\":\"Agent\"") \
      && index($0, "\"subagent_type\":\"code-reviewer\"") { print NR }
  ' "$TRANSCRIPT" | tail -1)
  if [ -n "$CODE_SPAWN_LINE" ]; then
    CODE_LINE_CONTENT=$(awk -v L="$CODE_SPAWN_LINE" 'NR==L { print; exit }' "$TRANSCRIPT")
    CODE_TOOL_USE_ID=$(echo "$CODE_LINE_CONTENT" | grep -oE '"id"[[:space:]]*:[[:space:]]*"toolu_[^"]+"' | head -1 | grep -oE 'toolu_[^"]+')
    if [ -n "$CODE_TOOL_USE_ID" ]; then
      SINCE_CODE=$(tail -n +"$CODE_SPAWN_LINE" "$TRANSCRIPT" 2>/dev/null)
      if echo "$SINCE_CODE" | grep -F "tool-use-id>${CODE_TOOL_USE_ID}<" | grep -qF 'completed</status>'; then
        PIPELINE_COMPLETE=1
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Advance checkpoint only when the FULL pipeline completed for this PR HEAD.
# Conservative: if any required lane is still running, exit 0 without ack
# and the next Stop re-evaluates.
# ---------------------------------------------------------------------------
if [ "$PIPELINE_COMPLETE" = "1" ]; then
  echo "$CURRENT_PR_HEAD" > "$ACK_FILE" 2>/dev/null || true
  clear_counter
fi

exit 0
