#!/usr/bin/env bash
# Stop hook - enforces SDD review-agent spawning at the PR boundary.
#
# Architecture: authoritative checked-out branch state plus a per-PR checkpoint.
#
#   Layer 1 (CANDIDATE) finds executable `git` or `gh` commands, and separately
#     marks the delivery ones (`git push`, `gh pr create`, `gh pr merge`).
#     Candidates trigger enforcement; only a delivery anchors the coverage
#     window (AD121).
#   Layer 2 (TRUTH) requires a normal checked-out branch whose open
#     main/master/develop PR head exactly equals local HEAD.
#   Layer 3 (CHECKPOINT) stores the acknowledged SHA by PR number.
#
# Command syntax never decides eligibility. After a merge, switching to and
# synchronizing the merge-target branch exposes that branch's new PR head.
#
# Bypass methods (USER-ONLY - the assistant must NEVER create the
# sentinel or write the magic phrase in its own output. An assistant
# that creates its own bypass defeats the entire enforcement layer.):
#   1. Sentinel file: /tmp/review-bypass (one-shot, auto-deleted)
#   2. Magic phrase: USER MESSAGE since the candidate push line contains
#      "skip review" or "skip verification" (case-insensitive, word-bounded)
#   3. 5-strike circuit breaker: after 5 blocks for the same un-acked
#      PR HEAD SHA, give up and let the user proceed
#
# Scope: only fires on main session Stop event (not SubagentStop).
# Vibe-coding gate: no enforcement if sdd/ is missing.
# Fail-safe: any unexpected error → exit 0 (never lock users out).
#
# Known under-block conditions (all fail-safe by design):
#   1. Remote-only PR HEAD changes remain inert until the user synchronizes
#      the checked-out branch and runs another Git or GitHub CLI command.
#   2. A required review lane is still in flight or lacks a completed
#      marker: the hook withholds acknowledgement and continues blocking
#      until every required parallel lane has a current-head completion.
#   3. Transcript file rotated or truncated mid-session: PUSH_LINE
#      detection silently returns 0. Review fires on the next push.
#
# Operational requirements: a normal checked-out branch, `gh` on PATH,
# and sdd/README.md present.

set +e

# ---------------------------------------------------------------------------
# Read hook input (must come before sentinel cleanup so SubagentStop doesn't
# eat the one-shot sentinel before the actual Stop event honors it)
# ---------------------------------------------------------------------------
INPUT=$(cat 2>/dev/null) || exit 0
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

# Main session only, as the header says. Claude Code fires PreToolUse for a
# subagent's tool calls exactly as for the main agent's, and hands them the
# PARENT's transcript_path, so the triage gate below would read the main
# session's review state and refuse a subagent's Write or Bash for a round it
# takes no part in. Memory capture lost writes to this, the vault capture file
# among them.
#
# agent_type/agent_id are present only on a subagent's payload; a main-agent
# call carries neither. That is the whole discriminator, and it is why this
# needs no transcript inspection: reading the calling identity out of the
# transcript is a race, reading it off the payload is not. The Stop path never
# needed the guard (SubagentStop is its own event and the case below drops it),
# but scoping both here keeps the contract in one place.
#
# Placed before any sentinel handling so a subagent can never consume the
# one-shot bypass the main session is owed.
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null)
# Both the Stop path's transcript scan and the PreToolUse gate classify shell
# text with the same parser. Absolute, because `require` reads a bare relative
# specifier as a package name: invoked as `bash path/to/enforce-review-spawn.sh`
# the relative form throws MODULE_NOT_FOUND, which is the one input that makes
# the scan look like a transcript with nothing in it.
CLASSIFIER_LIB="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/lib/boundary-classifier.cjs"
[ -n "$AGENT_TYPE" ] && exit 0

case "$HOOK_EVENT" in
  Stop) PRETOOL_MODE="" ;;
  PreToolUse) PRETOOL_MODE=1 ;;
  *) exit 0 ;;
esac
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0

# ---------------------------------------------------------------------------
# PreToolUse triage gate - prefilters. The full check lives after the shared
# transcript helpers it reuses (search "PreToolUse triage gate - full check").
#
# The Stop-side verdict demand refuses to acknowledge a head until the
# canonical triage table is published, but it only runs at turn end. A session
# that keeps calling tools never reaches a Stop event, so fixes and pushes can
# land BETWEEN the last lane completion and the verdict demand - the exact
# window the round discipline forbids. This branch closes it: once every lane
# spawned in the transcript has a completed notification and no triage table
# follows the last of them, every tool outside the read-only set is refused
# (exit 2) with a one-line reminder. The contract mirrors Pi's: the verdict
# is published as a TOOL-FREE message that ends the turn (a tool-free message
# is always persisted to the transcript, unlike one whose tool call this gate
# rejects), the Stop hook acknowledges it, and its fix directive drives the
# following turn.
#
# This branch never writes acks or round counters - those stay Stop-owned. It
# reads the bypass sentinel without consuming it (one-shot deletion is the
# Stop path's job).
# ---------------------------------------------------------------------------
PRETOOL_CLEAR_FILE=""
PRETOOL_COMPLETION_COUNT=""
if [ -n "$PRETOOL_MODE" ]; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
  case "$TOOL_NAME" in
    Read|TaskOutput|TaskGet|TaskList|Grep|Glob) exit 0 ;;
  esac
  # Investigation is what this window exists for. Judging a finding's validity
  # routinely needs more than a file read -- a reviewer's empirical claim can
  # only be settled by running the thing -- and an allowlist of Read alone
  # forced a choice between publishing an unverified table and defying the
  # gate. It also refused unrelated read-only work. The window should deny the
  # state changes that would spoil the round (a head minted or delivered before
  # triage, a lane relaunched) and let inspection through, which is the same
  # correction the capture hard block needed: deny what matters, not everything.
  #
  # The question is not "does this text contain a delivery verb" but "does this
  # shell run one", and only a shell-aware parse answers it. Three consecutive
  # regex revisions each closed the bypasses one review report named and left
  # the next set open, so the check now calls lib/boundary-classifier.cjs -- the
  # same parser the Stop path uses -- which tracks command position through
  # quoting, substitution, heredocs, env assignments, wrappers and their option
  # values, and paths. `grep "git push" file` is not a delivery to it;
  # `sudo -u me /usr/bin/git push` is.
  #
  # `git commit` counts here and not on the Stop path: a commit minted mid-window
  # becomes a head the round never covered.
  case "$TOOL_NAME" in
    Bash|mcp__*ctx_execute|mcp__*ctx_execute_file|mcp__*ctx_batch_execute)
      PRETOOL_CMD=$(echo "$INPUT" | jq -r '[.tool_input.command // "", .tool_input.code // "", ([.tool_input.commands[]?.command // ""] | join("\n"))] | join("\n")' 2>/dev/null) || PRETOOL_CMD=""
      # Fail closed on an unreadable payload. "No delivery verb seen" and "could
      # not look" are different answers, and collapsing them into allow is how a
      # malformed envelope would walk a push straight through the gate.
      if [ -n "$PRETOOL_CMD" ]; then
        case "$PRETOOL_CMD" in
          *run-review-lane.sh*) ;;
          *)
            PRETOOL_VERDICT=$(printf '%s' "$PRETOOL_CMD" | node -e '
              const { boundaryOf } = require(process.argv[1]);
              const event = boundaryOf(require("node:fs").readFileSync(0, "utf8"), { commit: true });
              process.stdout.write(event && event !== "-" ? "deliver" : "allow");
            ' "$CLASSIFIER_LIB" 2>/dev/null) || PRETOOL_VERDICT=""
            # An empty verdict means the classifier could not run, not that the
            # command is clean. Refuse, same as an unreadable payload above.
            [ "$PRETOOL_VERDICT" = "allow" ] && exit 0
            ;;
        esac
      fi
      ;;
  esac
  [ -f "${REVIEW_BYPASS_FILE:-/tmp/review-bypass}" ] && exit 0
  # Fingerprint cache: the gate's answer can only flip to "block" when a new
  # completed notification lands (a spawn alone cannot, and a published table
  # only flips it to "allow" - the state the cache records). The cache stores
  # "<count>:<byte offset>:<prefix fingerprint>" from the last allow; the
  # transcript is append-only, so counting completions in the appended bytes
  # alone decides whether the answer can have changed. Two guards keep that
  # assumption honest. The stored offset is rewound by the marker length, so a
  # marker split by a mid-write snapshot is always fully inside the next scan
  # window ("completed</status>" is never the file's final bytes - the
  # "</task-notification>" suffix follows - so the rewind cannot double-count
  # a settled tail). And the fingerprint of the first 4KiB detects a rewritten
  # or compacted transcript that kept the path and a plausible size; mismatch
  # discards the cache and takes the full pass. Sub-4KiB transcripts skip the
  # fingerprint ("small") - a full pass is already cheap there.
  PRETOOL_CLEAR_FILE="${TMPDIR:-/tmp}/sdd-pretool-triage-clear-$(printf '%s' "$TRANSCRIPT" | cksum | awk '{print $1}')"
  PRETOOL_SIZE=$(wc -c < "$TRANSCRIPT" 2>/dev/null) || PRETOOL_SIZE=0
  if [ "$PRETOOL_SIZE" -ge 4096 ] 2>/dev/null; then
    PRETOOL_PREFIX_CK=$(head -c 4096 "$TRANSCRIPT" 2>/dev/null | cksum | awk '{print $1}')
  else
    PRETOOL_PREFIX_CK=small
  fi
  if [ "$PRETOOL_SIZE" -gt 18 ] 2>/dev/null; then
    PRETOOL_WRITE_OFFSET=$((PRETOOL_SIZE - 18))
  else
    PRETOOL_WRITE_OFFSET=0
  fi
  PRETOOL_CACHE_STATE=$(cat "$PRETOOL_CLEAR_FILE" 2>/dev/null)
  PRETOOL_CACHED_COUNT=""
  PRETOOL_CACHED_OFFSET=""
  PRETOOL_CACHED_CK=""
  case "$PRETOOL_CACHE_STATE" in
    *:*:*)
      PRETOOL_CACHED_COUNT="${PRETOOL_CACHE_STATE%%:*}"
      PRETOOL_CACHED_CK="${PRETOOL_CACHE_STATE##*:}"
      PRETOOL_CACHED_OFFSET="${PRETOOL_CACHE_STATE#*:}"
      PRETOOL_CACHED_OFFSET="${PRETOOL_CACHED_OFFSET%%:*}"
      ;;
  esac
  case "$PRETOOL_CACHED_COUNT" in ''|*[!0-9]*) PRETOOL_CACHED_COUNT="" ;; esac
  case "$PRETOOL_CACHED_OFFSET" in ''|*[!0-9]*) PRETOOL_CACHED_OFFSET="" ;; esac
  if [ -n "$PRETOOL_CACHED_COUNT" ] && [ -n "$PRETOOL_CACHED_OFFSET" ] \
     && [ "$PRETOOL_CACHED_CK" = "$PRETOOL_PREFIX_CK" ] \
     && [ "$PRETOOL_SIZE" -ge "$PRETOOL_CACHED_OFFSET" ] 2>/dev/null; then
    # A cache entry exists only after a full pass proved lane spawns and an
    # allow outcome, so the spawn prefilter is already answered.
    PRETOOL_NEW=$(tail -c +$((PRETOOL_CACHED_OFFSET + 1)) "$TRANSCRIPT" 2>/dev/null | grep -cF 'completed</status>')
    PRETOOL_COMPLETION_COUNT=$((PRETOOL_CACHED_COUNT + PRETOOL_NEW))
    if [ "$PRETOOL_NEW" -eq 0 ] 2>/dev/null; then
      printf '%s:%s:%s\n' "$PRETOOL_COMPLETION_COUNT" "$PRETOOL_WRITE_OFFSET" "$PRETOOL_PREFIX_CK" > "$PRETOOL_CLEAR_FILE" 2>/dev/null || true
      exit 0
    fi
  else
    # First pass for this transcript (or a truncated/rotated one): full
    # fixed-string scans. No spawn signature or no completed notification
    # anywhere means the gate cannot apply.
    grep -qF -e 'run-review-lane.sh' \
      -e '"subagent_type":"code-reviewer"' \
      -e '"subagent_type":"spec-reviewer"' \
      -e '"subagent_type":"doc-updater"' "$TRANSCRIPT" 2>/dev/null || exit 0
    PRETOOL_COMPLETION_COUNT=$(grep -cF 'completed</status>' "$TRANSCRIPT" 2>/dev/null)
    [ "$PRETOOL_COMPLETION_COUNT" -gt 0 ] 2>/dev/null || exit 0
  fi
fi

# Stop-only candidate detection, gates, and bypass consumption. Deliberately
# not re-indented: the guard exists so a PreToolUse pass can reach the shared
# transcript helpers below without running push detection or consuming the
# one-shot bypass sentinel.
if [ -z "$PRETOOL_MODE" ]; then

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
# Layer 1 (CANDIDATE) - find tool_use lines whose effective shell command
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
# Candidate commands are executable `git` and `gh` commands; authoritative
# checked-out branch state below filters false positives and unchanged heads.
#
# Issue #319: prior to multi-tool scanning, `git push` made via ctx_execute
# or ctx_batch_execute was invisible to PUSH_LINE detection because the awk
# regex required `"name":"Bash"`. The review gate silently fell through
# (exit 0 - "no candidate") and unreviewed PR HEADs slipped past the
# Stop hook. The fix mirrors the multi-shape parsing already shipped in
# git-push-review-reminder.sh for issue #317.
#
# The structural parser recognizes command position across quoting, Git global
# options, shell lists/control words, and command substitutions. Quoted prose
# and heredoc bodies remain inert; authoritative Layer 2 still decides whether
# the parsed activity corresponds to an eligible PR boundary.
#
# Candidacy stays broad: any executable `git`/`gh` triggers enforcement, and
# Layer 2 decides eligibility. What narrowed is the COVERAGE anchor. Lane
# coverage is measured strictly after that anchor, and while it was the last
# candidate, one `git log` run between a lane spawn and the Stop event moved it
# past that spawn and the gate re-demanded a lane that had already returned.
# Measured on one session's transcript: 58 candidates against 8 real deliveries,
# with the anchor resolving to a `git diff` issued while diagnosing this.
#
# Marking the event here decides only WHERE a delivery happened. Layer 2
# (`gh pr view`) remains the sole authority on whether it is an open, eligible,
# unacknowledged PR head.
# ---------------------------------------------------------------------------
transcript_scan() {
  node - "$TRANSCRIPT" "$CLASSIFIER_LIB" <<'NODE'
const fs = require('node:fs');
const { boundaryOf } = require(process.argv[3]);
fs.readFileSync(process.argv[2], 'utf8').split(/\n/).forEach((raw, index) => {
  let entry; try { entry = JSON.parse(raw); } catch { return; }
  for (const call of entry?.message?.content?.filter?.((part) => part?.type === 'tool_use') || []) {
    const input = call.input || {}; let commands = [];
    if (call.name === 'Bash' && typeof input.command === 'string') commands = [input.command];
    else if (/ctx_execute$/.test(call.name) && input.language === 'shell' && typeof input.code === 'string') commands = [input.code];
    else if (/ctx_batch_execute$/.test(call.name) && Array.isArray(input.commands)) commands = input.commands.map((item) => item?.command).filter((value) => typeof value === 'string');
    // One line can hold several commands; a delivery event anywhere in it wins
    // over a plain candidate, so `git log && git push` is a boundary.
    let mark = '';
    for (const command of commands) {
      const result = boundaryOf(command);
      if (result && result !== '-') { mark = result; break; }
      if (result) mark = '-';
    }
    if (mark) { process.stdout.write(`${index + 1} ${mark}\n`); return; }
  }
});
NODE
}
# Two views over ONE parse: the transcript is walked once and both views filter
# the same output. Enforcement triggers on any git/gh activity, which is the
# long-standing contract; the coverage window narrows to a real delivery so a
# read-only call cannot move it past a round's own lane spawns.
# `transcript_scan` cannot distinguish "no delivery in the transcript" from
# "could not look", and the swallowed stderr below collapses them: an absent
# classifier leaves PUSH_LINE empty and the next line exits as "no candidate",
# which silently disables review enforcement altogether. Refuse the turn
# instead. This is the Stop-side twin of the gate's empty-verdict refusal, and
# it is checked here rather than at the assignment above so a session with no
# review activity is unaffected by a plugin it never reaches for.
if [ ! -r "$CLASSIFIER_LIB" ]; then
  printf '%s\n' "Review enforcement cannot run: $CLASSIFIER_LIB is missing or unreadable. Restore the codeflare-hooks plugin before pushing." >&2
  exit 2
fi
TRANSCRIPT_SCAN=$(transcript_scan 2>/dev/null)
candidate_line_numbers() { printf '%s\n' "$TRANSCRIPT_SCAN" | awk 'NF { print $1 }'; }
delivery_line_numbers() { printf '%s\n' "$TRANSCRIPT_SCAN" | awk 'NF && $2 != "-" { print $1 }'; }

PUSH_LINE=$(candidate_line_numbers | tail -1)
[ -n "$PUSH_LINE" ] || exit 0  # No candidate, no enforcement

# Anchor for lane coverage and retroactive acknowledgement. With no delivery in
# the transcript there is no round for a delivery to have opened, so every spawn
# present counts and the anchor is the start of the file. Anchoring on the last
# candidate instead would only subtract coverage that was legitimately earned,
# and would reinstate this fix's own bug whenever the delivery sits outside the
# file, which the rotation case at the top of this script describes.
COVERAGE_LINE=$(delivery_line_numbers | tail -1)
[ -n "$COVERAGE_LINE" ] || COVERAGE_LINE=1

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
_triage_init=$(test -f sdd/spec/.init-triage.md && echo sdd/spec/.init-triage.md || echo sdd/.init-triage.md)
if grep -q '^transition:[[:space:]]*true' "$_config_file" 2>/dev/null \
   && [ -f "$_triage_init" ] \
   && grep -qiE '^\*\*Status:\*\*[[:space:]]+open\b' "$_triage_init" 2>/dev/null; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Authoritative checked-out branch state
#
# Bypasses are evaluated only after this state is validated. An absent,
# acknowledged, closed, or merged PR cannot spend the user's one-shot sentinel.
# ---------------------------------------------------------------------------
[ -d .git ] || exit 0
GIT_DIR=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
[ -d "$GIT_DIR" ] || exit 0
CURRENT=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
LOCAL_HEAD=$(git rev-parse HEAD 2>/dev/null) || exit 0
command -v gh >/dev/null 2>&1 || exit 0
. "$(dirname "$0")/lib/gh-pr-state.sh" 2>/dev/null || exit 0
PR_INFO=$(gh_pr_state "$CURRENT") || exit 0
PR_STATE=$(printf '%s' "$PR_INFO" | jq -r '.state // empty' 2>/dev/null)
CURRENT_PR_HEAD=$(printf '%s' "$PR_INFO" | jq -r '.headRefOid // empty' 2>/dev/null)
BASE_REF=$(printf '%s' "$PR_INFO" | jq -r '.baseRefName // empty' 2>/dev/null)
PR_NUMBER=$(printf '%s' "$PR_INFO" | jq -r '.number // empty' 2>/dev/null)
case "$PR_STATE" in OPEN|CLOSED|MERGED) ;; *) exit 0 ;; esac
case "$BASE_REF" in main|master|develop) ;; *) exit 0 ;; esac
printf '%s' "$PR_NUMBER" | grep -Eq '^[0-9]+$' || exit 0
printf '%s' "$CURRENT_PR_HEAD" | grep -Eq '^[0-9a-f]{40}$' || exit 0
[ "$LOCAL_HEAD" = "$CURRENT_PR_HEAD" ] || exit 0
ACK_FILE="$GIT_DIR/sdd-review-ack-pr-$PR_NUMBER"
COUNT_FILE="$GIT_DIR/sdd-review-count-pr-$PR_NUMBER"
CLOSED_NOTICE_FILE="$GIT_DIR/sdd-review-closed-notified-pr-$PR_NUMBER"
LEGACY_ACK="$GIT_DIR/sdd-last-ack-pr-head"
LAST_ACK_PR_HEAD=""
if [ -f "$ACK_FILE" ]; then
  LAST_ACK_PR_HEAD=$(cat "$ACK_FILE" 2>/dev/null)
elif [ -f "$LEGACY_ACK" ]; then
  LAST_ACK_PR_HEAD=$(cat "$LEGACY_ACK" 2>/dev/null)
fi
case "$LAST_ACK_PR_HEAD" in
  *[!0-9a-f]*|"") LAST_ACK_PR_HEAD="" ;;
  *) [ "${#LAST_ACK_PR_HEAD}" -eq 40 ] || LAST_ACK_PR_HEAD="" ;;
esac

if [ "$PR_STATE" != "OPEN" ]; then
  if [ "$LAST_ACK_PR_HEAD" != "$CURRENT_PR_HEAD" ] \
     && [ "$(cat "$CLOSED_NOTICE_FILE" 2>/dev/null)" != "$CURRENT_PR_HEAD" ]; then
    printf '%s\n' "$CURRENT_PR_HEAD" > "$CLOSED_NOTICE_FILE" 2>/dev/null || true
    CLOSED_NOTICE="PR review - acknowledgement missing
Head: $CURRENT_PR_HEAD
PR state: $PR_STATE
Acknowledgement written: no
Review completion was not proven before the PR closed. This notice is visibility only; review the head manually if required."
    jq -n --arg message "$CLOSED_NOTICE" '{systemMessage:$message}' 2>/dev/null
  fi
  exit 0
fi

[ "$LAST_ACK_PR_HEAD" != "$CURRENT_PR_HEAD" ] || exit 0

# Bypass 1: a user-created one-shot sentinel applies only to this validated,
# open, unacknowledged PR head. The path is overridable for hermetic tests.
BYPASS_FILE="${REVIEW_BYPASS_FILE:-/tmp/review-bypass}"
if [ -f "$BYPASS_FILE" ]; then
  echo "$CURRENT_PR_HEAD" > "$ACK_FILE" 2>/dev/null || exit 0
  rm -f "$BYPASS_FILE" 2>/dev/null || true
  exit 0
fi

# Bypass 2: only a finalized user message after the latest candidate can skip
# enforcement. Unlike the sentinel, this path has no persistent state to spend.
if echo "$SINCE_PUSH" | grep '"type":"user"' | grep -v '"tool_result"' | grep -qiE '\bskip (the )?(review|verification)\b'; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Retroactive ack scan (v7) -- handles the fix-push cascade pattern.
#
# The classic flow at the bottom of this file advances LAST_ACK only when
# Stop fires for the CURRENT HEAD AND finds agents spawned-and-completed
# AFTER the most recent push line. In a cascade where the assistant does
# "push fix -> spawn agents -> agents complete -> apply more findings ->
# push again" all inside one turn, Stop fires only at turn-end -- by which
# time COVERAGE_LINE has already moved past the spawn lines for the EARLIER
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

fi # end Stop-only section - PreToolUse resumes here at the shared helpers

# Lane-spawn match contract, shared by every coverage / in-flight check below.
#
# A lane counts as spawned under EITHER transport:
#
#   (a) Agent subagent - an `Agent` tool_use whose `subagent_type` is the lane.
#   (b) Headless subprocess - a `Bash` tool_use invoking run-review-lane.sh with
#       `--lane <name>`. The lane runs as `claude -p` with a replaced system
#       prompt, which is what makes it affordable; it emits no subagent_type.
#
# Both conditions anchor on `"type":"tool_use"` so the substring match only
# fires on real tool_use envelopes, never on prose or tool_result text that
# happens to quote the same bytes. Detection is deliberately additive: shape (a)
# is unchanged, so the transport migration cannot narrow what the gate accepts.
# The awk half is only a CHEAP PREFILTER. It emits `<line>\t<kind>`; a `bash`
# kind is a candidate that must still survive structural verification in
# `bash_line_runs_lane`, because a substring match on the serialised envelope
# also fires on the runner path appearing INSIDE a command string. One
# `echo "... --lane code-reviewer --lane spec-reviewer --lane doc-updater"`
# would otherwise satisfy all three lanes and bypass the gate wholesale - the
# same class as matching `git push` inside `echo "git push later"`.
LANE_SPAWN_AWK='
function lane_spawn_kind(line, lane) {
  if (!index(line, "\"type\":\"tool_use\"")) return ""
  if (index(line, "\"name\":\"Agent\"") \
      && index(line, "\"subagent_type\":\"" lane "\"")) return "agent"
  if (index(line, "\"name\":\"Bash\"") \
      && index(line, "run-review-lane.sh") \
      && index(line, "--lane " lane)) return "bash"
  return ""
}
'

# Structural verification of a Bash lane-runner envelope. Parses the command out
# of the tool_use with jq (already a hard dependency of this hook) and requires
# the runner to sit in COMMAND position - start of line or after a shell
# separator - with `--lane <name>` among its arguments and no separator in
# between. Quoted mentions inside another command therefore never qualify.
bash_line_runs_lane() {
  local line_content="$1"
  local lane="$2"
  local cmd cmd_bare
  cmd=$(printf '%s' "$line_content" | jq -r '
    [ .message.content[]?
      | select(.type? == "tool_use" and .name? == "Bash")
      | .input.command? // empty ] | .[]
  ' 2>/dev/null) || return 1
  [ -n "$cmd" ] || return 1

  # Collapse quoted regions FIRST. Matching command position against the raw
  # string is unsound: a separator inside a quoted argument satisfies the
  # anchor, so `echo "step1; bash .../run-review-lane.sh --lane X"` reads as a
  # real invocation and silently credits a lane that never ran.
  #
  # A quoted region holding exactly one bare word is a quoted PATH
  # (`bash "$HOME/.../run-review-lane.sh"`, the normal defensive habit) and
  # collapses to that word. Any quoted region containing whitespace or a shell
  # separator is prose and is dropped entirely, so nothing inside a string can
  # ever open command position.
  cmd_bare=$(printf '%s' "$cmd" | awk '
    {
      out = ""; n = length($0); i = 1
      while (i <= n) {
        c = substr($0, i, 1)
        if (c == "\"" || c == "'"'"'") {
          q = c; j = i + 1; body = ""
          while (j <= n && substr($0, j, 1) != q) { body = body substr($0, j, 1); j++ }
          if (body ~ /^[^[:space:];&|]+$/) out = out body
          i = j + 1
        } else { out = out c; i++ }
      }
      print out
    }')

  # Only `--lane <name>` is accepted. The awk prefilter and the runner argument
  # parser both require the space form, so permitting `--lane=<name>` here would
  # be dead permissiveness that misdescribes the end-to-end contract.
  printf '%s' "$cmd_bare" | grep -qE \
    "(^|[;&|])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*(bash[[:space:]]+)?[^[:space:];&|]*run-review-lane\.sh([[:space:]]+[^;&|]*)?[[:space:]]--lane[[:space:]]+${lane}([[:space:]]|\$)"
}

# Verified lane-spawn line numbers, newest last. Optional $2/$3 bound the search
# to an exclusive (min, max) line window; omit or pass 0 for unbounded.
lane_spawn_lines() {
  local lane="$1"
  local min_line="${2:-0}"
  local max_line="${3:-0}"
  # The prefilter emits the candidate's own line alongside it, so verification
  # never re-scans the transcript. This runs per lane per window inside
  # retroactive_ack_scan, where a second full-file pass per candidate is a
  # visible Stop-hook stall on the long transcripts the staleness bound expects.
  local nr kind line_content
  awk -v a="$lane" -v p="$min_line" -v q="$max_line" "$LANE_SPAWN_AWK"'
    NR > p && (q == 0 || NR < q) {
      k = lane_spawn_kind($0, a)
      if (k != "") print NR "\t" k "\t" $0
    }
  ' "$TRANSCRIPT" | while IFS="$(printf '\t')" read -r nr kind line_content; do
    if [ "$kind" = "agent" ]; then
      printf '%s\n' "$nr"
    elif bash_line_runs_lane "$line_content" "$lane"; then
      printf '%s\n' "$nr"
    fi
  done
}


# Completion correlation for a spawned lane, shared by every check below.
#
# A lane completes under EITHER transport:
#
#   (a) Agent subagent - a background task notification carrying
#       `tool-use-id>ID<` together with `completed</status>`.
#   (b) Headless subprocess - launched as a BACKGROUND Bash call, which emits
#       the very same notification shape on completion.
#
# One contract therefore covers both transports, byte-for-byte the behaviour
# that predates the headless transport.
#
# A tool_result carrying `"tool_use_id":"ID"` is deliberately NOT accepted. Under
# `run_in_background`, which is how lanes are dispatched, the harness returns
# that envelope IMMEDIATELY as a start receipt holding a background shell id -
# it means "launched", never "finished". Treating it as completion would credit
# all three lanes the instant they launch and ack a head whose review is still
# running. That applies equally to a backgrounded Agent spawn, so no transport
# may use it.
tool_use_id_completed() {
  local spawn_line="$1"
  local tool_use_id="$2"
  awk -v s="$spawn_line" 'NR > s' "$TRANSCRIPT" \
    | grep -F "tool-use-id>${tool_use_id}<" \
    | grep -qF 'completed</status>'
}

# Terminal status for a spawned lane: the background task ENDED, successfully or
# not. `completed` credits the review; `failed` must not. But `failed` is just as
# terminal as `completed` -- a lane that died is not still running.
#
# Conflating the two is what wedged the checkpoint in practice: a lane whose
# subprocess exited non-zero read as "in flight" for the next 1200 transcript
# lines, so the gate waited on a process that was already dead, the head stayed
# un-acked, and the next push measured its range from the last ACKED head rather
# than the last reviewed one. One lost lane therefore widened every subsequent
# review permanently -- a measured 10-commit re-review where one commit was due.
# The tool_use id of a spawn line. Four call sites re-derived this verbatim.
tool_use_id_of_spawn() {
  awk -v L="$1" 'NR==L { print; exit }' "$TRANSCRIPT" \
    | grep -oE '"id"[[:space:]]*:[[:space:]]*"toolu_[^"]+"' | head -1 | grep -oE 'toolu_[^"]+'
}

tool_use_id_terminal() {
  local spawn_line="$1"
  local tool_use_id="$2"
  # Open set, not a closed one: `cancelled`, `killed`, `timed_out` and anything
  # else the harness adds are terminal too, and enumerating successes would make
  # each new status silently re-create the wedge this exists to close.
  awk -v s="$spawn_line" 'NR > s' "$TRANSCRIPT" \
    | grep -F "tool-use-id>${tool_use_id}<" \
    | grep -E '</status>' \
    | grep -qvE '<status>(in_progress|running|pending|queued)</status>'
}

# The triage table, byte-for-byte the shape Pi pins as REVIEW_TRIAGE_HEADER /
# REVIEW_TRIAGE_DIVIDER. It is a contract value, not prose: the gate reads it to
# decide whether the root actually consumed the lanes' findings.
REVIEW_TRIAGE_HEADER='| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |'
REVIEW_TRIAGE_DIVIDER='|---|---|---|---|---|'

# Transcript line of a spawn's successful completion notification, or empty.
# Needed because the triage table only counts if it came AFTER the last lane
# returned -- a table published earlier belongs to the previous round.
spawn_completion_line() {
  local spawn_line="$1"
  local tool_use_id
  tool_use_id=$(tool_use_id_of_spawn "$spawn_line")
  [ -n "$tool_use_id" ] || return 1
  awk -v s="$spawn_line" -v id="$tool_use_id" '
    NR > s && index($0, "tool-use-id>" id "<") && index($0, "completed</status>") { print NR; exit }
  ' "$TRANSCRIPT"
}

# An assistant message whose TEXT carries the triage table.
#
# Structural, not substring. The gate's own demand text quotes both constants,
# and a model restating a required format ("I'll publish <header> over
# <divider>") writes them too -- so a substring test acknowledges a head on a
# message that contains no verdict at all, inverting the gate. The header must
# be its own line and the divider the line immediately after it. Finding rows
# follow when findings exist; a fully clean round has no synthetic lane rows.
#
# The canonical flow is Pi's: the table is a TOOL-FREE message that ends the
# turn, which the harness always persists; the Stop hook then acknowledges it
# and its fix directive drives the following turn. Recognition here stays
# permissive - a table that arrived sharing a message with tool calls still
# counts when it persisted, because refusing it could only wedge the session.
# Only text blocks are extracted below, so nothing inside a tool_use envelope
# can fake the shape.
# The canonical stacked shape on stdin: header and divider on consecutive
# lines, followed only by actual finding rows when the round has findings.
stacked_table_in_stream() {
  awk -v h="$REVIEW_TRIAGE_HEADER" -v d="$REVIEW_TRIAGE_DIVIDER" '
    { line = $0; gsub(/^[ \t]+|[ \t]+$/, "", line); rows[++n] = line }
    END {
      for (i = 1; i <= n; i++) {
        if (rows[i] == h && rows[i + 1] == d) exit 0
      }
      exit 1
    }'
}

triage_published_after_line() {
  local min_line="$1"
  awk -v s="$min_line" '
    NR > s && index($0, "\"type\":\"assistant\"")
  ' "$TRANSCRIPT" \
    | jq -R -r 'fromjson? | [ .message.content[]? | select(.type? == "text") | .text? // empty ] | .[]' 2>/dev/null \
    | stacked_table_in_stream
}

# ---------------------------------------------------------------------------
# PreToolUse triage gate - full check (prefilters at the top of this file).
#
# The state this gate blocks on is completed-awaiting-triage: every lane
# spawned in this transcript has a completed notification, and no canonical
# triage table follows the last of them. A lane still in flight - or one that
# ended without success - is not that state; failed and missing lanes are the
# Stop hook's demand to make, not this one's. Every path here exits, so the
# Stop-only enforcement below this block never runs on a PreToolUse pass.
# ---------------------------------------------------------------------------
if [ -n "$PRETOOL_MODE" ]; then
  pretool_allow() {
    [ -n "$PRETOOL_CLEAR_FILE" ] \
      && printf '%s:%s:%s\n' "$PRETOOL_COMPLETION_COUNT" "$PRETOOL_WRITE_OFFSET" "$PRETOOL_PREFIX_CK" > "$PRETOOL_CLEAR_FILE" 2>/dev/null
    exit 0
  }
  PRETOOL_LAST_COMPLETION=0
  for PRETOOL_LANE in code-reviewer spec-reviewer doc-updater; do
    PRETOOL_SPAWN=$(lane_spawn_lines "$PRETOOL_LANE" | tail -1)
    [ -n "$PRETOOL_SPAWN" ] || continue
    PRETOOL_DONE=$(spawn_completion_line "$PRETOOL_SPAWN")
    [ -n "$PRETOOL_DONE" ] || pretool_allow
    [ "$PRETOOL_DONE" -gt "$PRETOOL_LAST_COMPLETION" ] 2>/dev/null \
      && PRETOOL_LAST_COMPLETION=$PRETOOL_DONE
  done
  [ "$PRETOOL_LAST_COMPLETION" -gt 0 ] 2>/dev/null || pretool_allow
  if triage_published_after_line "$PRETOOL_LAST_COMPLETION"; then
    pretool_allow
  fi
  # 5-strike breaker keyed on the completion line, mirroring the Stop-side
  # verdict breaker: a table the matcher cannot see must never wedge every
  # tool for the rest of the session. After five refused calls for the same
  # round, give up loudly and let the session proceed.
  PRETOOL_STRIKE_FILE="${TMPDIR:-/tmp}/sdd-pretool-triage-strikes-$(printf '%s' "$TRANSCRIPT" | cksum | awk '{print $1}')"
  PRETOOL_STRIKE_STATE=$(cat "$PRETOOL_STRIKE_FILE" 2>/dev/null)
  PRETOOL_STRIKE_LINE="${PRETOOL_STRIKE_STATE%%:*}"
  PRETOOL_STRIKES="${PRETOOL_STRIKE_STATE##*:}"
  case "$PRETOOL_STRIKES" in ''|*[!0-9]*) PRETOOL_STRIKES=0 ;; esac
  [ "$PRETOOL_STRIKE_LINE" = "$PRETOOL_LAST_COMPLETION" ] || PRETOOL_STRIKES=0
  PRETOOL_STRIKES=$((PRETOOL_STRIKES + 1))
  # An unwritable counter means the -gt 5 escape can never fire, which is the
  # permanent wedge the breaker exists to prevent - so a failed write fails
  # open, matching this hook's global fail-safe direction.
  printf '%s:%s\n' "$PRETOOL_LAST_COMPLETION" "$PRETOOL_STRIKES" > "$PRETOOL_STRIKE_FILE" 2>/dev/null || {
    echo "enforce-review-spawn: PreToolUse strike counter unwritable; failing open" >&2
    pretool_allow
  }
  if [ "$PRETOOL_STRIKES" -gt 5 ]; then
    echo "enforce-review-spawn: PreToolUse triage gate giving up after 5 refused calls for the same completed round; proceeding without a published triage table" >&2
    pretool_allow
  fi
  echo "Review reports are complete. Retrieve any lane report not yet visible with Read/TaskOutput first; only the final triage-table response is TOOL-FREE. Never defer an unread report to FIX. Then publish the table ('$REVIEW_TRIAGE_HEADER' over '$REVIEW_TRIAGE_DIVIDER', one row per finding) and end the turn." >&2
  exit 2
fi

retroactive_ack_scan() {
  [ -f "$TRANSCRIPT" ] || return
  local total
  total=$(wc -l < "$TRANSCRIPT" 2>/dev/null || echo 0)
  [ "$total" -gt 0 ] || return

  # Window BOUNDARIES come from TRANSCRIPT_SCAN, the script-wide snapshot taken
  # once near the top. Everything else here reads the live file: the wc -l above,
  # and the per-window awk that extracts each push's destination SHA. Mixing the
  # two is safe only because the transcript is append-only, so a line number from
  # the snapshot still addresses the same line in the live file; nothing may
  # renumber it. The [ -f "$TRANSCRIPT" ] guard above is a real check on those
  # live reads, not a freshness check on the snapshot.
  #
  # Windows are bounded by deliveries, not by any Git activity. This scan once
  # carried its own narrower matcher; #814 deleted it and repointed the scan at
  # the broad candidate list while leaving a comment claiming the two had always
  # been identical. Windows then ended at the next read-only Git call instead of
  # the next push, so a real push's window no longer contained its own lane
  # spawns, could not complete, and no head was retroactively acknowledged.
  # `delivery_line_numbers` is one view over the same parse that produces the
  # candidate list, so the two cannot drift apart again. Structural parsing also
  # keeps an Edit/Read envelope quoting `git push` (an edit to this hook, say)
  # from opening a window.
  local all_push_lines
  all_push_lines=$(delivery_line_numbers)
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
    local window_verdict_after=0
    for lane in $required_lanes; do
      local spawn_line
      spawn_line=$(lane_spawn_lines "$lane" "$start" "$end" | tail -1)
      if [ -z "$spawn_line" ]; then
        window_complete=0; break
      fi
      local tool_use_id
      tool_use_id=$(tool_use_id_of_spawn "$spawn_line")
      if [ -z "$tool_use_id" ]; then
        window_complete=0; break
      fi
      # Completion can land anywhere after the spawn (notifications may
      # arrive in a later turn).
      if ! tool_use_id_completed "$spawn_line" "$tool_use_id"; then
        window_complete=0; break
      fi
      local completion_line
      completion_line=$(spawn_completion_line "$spawn_line")
      if [ -n "$completion_line" ] && [ "$completion_line" -gt "$window_verdict_after" ] 2>/dev/null; then
        window_verdict_after="$completion_line"
      fi
    done

    # Same contract as the main gate. Without it this path acknowledges a head
    # on lane exit alone, which silently bypasses the verdict requirement and
    # swallows the FIX directive that acknowledgement is supposed to drive.
    if [ "$window_complete" = "1" ] && [ "$window_verdict_after" -gt 0 ] 2>/dev/null \
       && ! triage_published_after_line "$window_verdict_after"; then
      window_complete=0
    fi

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
# The scan recovers checkpoints for heads whose live enforcement was missed. It
# must never claim the CURRENT head: that one belongs to the live path below,
# and only the live path hands off to FIX. When the scan took it, two things
# followed in the same run. It advanced the checkpoint, and then the freshness
# guard below read the ack it had itself just written -- zero seconds old, so
# trivially under the 300s window -- and exited before the FIX directive. The
# round was acknowledged with no fix handoff and no counter touched, which is
# indistinguishable from the gate having never run. Excluding the current head
# costs the scan nothing: the live path acknowledges it in this same
# invocation, and does it with the handoff attached.
if [ -n "$RETRO_SHA" ] && [ "$RETRO_SHA" != "$LAST_ACK_PR_HEAD" ] \
   && [ "$RETRO_SHA" != "$CURRENT_PR_HEAD" ]; then
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

# ---------------------------------------------------------------------------
# Real un-acknowledged PR HEAD exists. Enforce.
#
# "Spawned after push" = appears later in the transcript than the push
# line. The transcript is append-only JSONL, so line number is the
# authoritative order. No timestamp parsing needed.
# ---------------------------------------------------------------------------

# Lane-envelope match contract (used by the lane-coverage and in-flight checks
# below) lives in `lane_spawn_lines` / `tool_use_id_completed` near the top of this
# script, so both transports are described in exactly one place. Every match
# anchors on `"type":"tool_use"` on the same line, so it only fires on real
# tool_use envelopes - not on prose / tool_result text / ctx_execute output that
# happens to quote the literal marker bytes (e.g. a diagnostic script printing
# hook JSON to the transcript). The JSONL transcript serialises each tool_use
# envelope on a single line, so the conjunctive match is reliable.

# 5-strike circuit breaker (keyed by CURRENT_PR_HEAD - unique per PR state)
#
# Counter format on disk: "<sha>:<count>" or "<sha>:GIVEUP".
# After the fifth block for the same SHA, the counter is set to GIVEUP
# rather than deleted -- this makes the give-up state sticky for that
# specific SHA. Without GIVEUP, deleting the file on the fifth strike
# would let the next Stop event start at 0 and block 5 more times,
# repeating forever. The counter resets only when CURRENT_PR_HEAD
# changes (next push lands).
read_count_from() {
  local file="$1"
  if [ -f "$file" ]; then
    local stored hash count
    stored=$(cat "$file" 2>/dev/null)
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

read_count() { read_count_from "$COUNT_FILE"; }

# The verdict demand gets its own head-keyed counter. Sharing the lane-demand
# counter meant a head that took five Stop events to launch its lanes arrived
# at the verdict check already at the limit, so the escape hatch fired on the
# FIRST pass -- acknowledging a head whose findings were never triaged, before
# a single verdict demand had been issued, while claiming five went unanswered.
VERDICT_COUNT_FILE="$GIT_DIR/sdd-review-verdict-count-pr-$PR_NUMBER"

# Native background completion is appended to the transcript before Claude is
# guaranteed to receive its task notification. On the first Stop that observes
# a newly complete round, record the completion line and allow the turn to end;
# the harness can then deliver every queued report. Only a later Stop may demand
# triage. Reuse the existing verdict counter file so this adds no new checkpoint.
completion_delivery_pending() {
  local completion_line="$1"
  local state
  state=$(cat "$VERDICT_COUNT_FILE" 2>/dev/null || true)
  if [ "$state" = "$CURRENT_PR_HEAD:DELIVERY:$completion_line" ]; then
    echo "$CURRENT_PR_HEAD:0" > "$VERDICT_COUNT_FILE" 2>/dev/null || true
    return 1
  fi
  case "$state" in
    "$CURRENT_PR_HEAD":*) return 1 ;;
  esac
  if echo "$CURRENT_PR_HEAD:DELIVERY:$completion_line" > "$VERDICT_COUNT_FILE" 2>/dev/null; then
    return 0
  fi
  # If the barrier cannot be persisted, fail safe toward delivery rather than
  # forcing a verdict from reports the root may not have received.
  echo "enforce-review-spawn: cannot persist reviewer-delivery barrier; allowing notification delivery" >&2
  return 0
}

write_acknowledgement() {
  echo "$CURRENT_PR_HEAD" > "$ACK_FILE" 2>/dev/null \
    && [ "$(cat "$ACK_FILE" 2>/dev/null)" = "$CURRENT_PR_HEAD" ]
}

reack_on_repeated_demand() {
  local strikes
  strikes=$(read_count_from "$VERDICT_COUNT_FILE")
  if [ "$strikes" = "GIVEUP" ] || { [ "$strikes" -ge 5 ] 2>/dev/null; }; then
    echo "$CURRENT_PR_HEAD" > "$ACK_FILE" 2>/dev/null || true
    rm -f "$VERDICT_COUNT_FILE" 2>/dev/null || true
    clear_counter
    echo "enforce-review-spawn: ${CURRENT_PR_HEAD:0:7} acknowledged after repeated unanswered verdict demands; its findings were never triaged" >&2
    return 0
  fi
  case "$strikes" in ''|*[!0-9]*) strikes=0 ;; esac
  echo "$CURRENT_PR_HEAD:$((strikes + 1))" > "$VERDICT_COUNT_FILE" 2>/dev/null || true
  return 1
}

clear_counter() {
  rm -f "$COUNT_FILE" 2>/dev/null || true
}

# The verdict demand has its own head-keyed breaker (reack_on_repeated_demand),
# so routing it through emit_block would gate it twice: a head that spent its
# lane-demand budget getting the lanes launched would find the shared counter
# already at GIVEUP and the verdict demand would exit SILENTLY -- the session
# is never told what to publish, while the verdict counter keeps recording
# demands that were never shown. One breaker per demand, on its own counter.
emit_block_uncounted() {
  jq -n --arg r "$1" '{decision:"block", reason:$r}' 2>/dev/null
  exit 0
}

emit_block() {
  local reason="$1"
  local current
  current=$(read_count)
  if [ "$current" = "GIVEUP" ]; then
    exit 0
  fi
  if [ "$current" -ge 5 ] 2>/dev/null; then
    echo "$CURRENT_PR_HEAD:GIVEUP" > "$COUNT_FILE" 2>/dev/null || true
    exit 0
  fi
  local new=$((current + 1))
  echo "$CURRENT_PR_HEAD:$new" > "$COUNT_FILE" 2>/dev/null || true
  jq -n --arg r "$reason" '{decision:"block", reason:$r}' 2>/dev/null
  exit 0
}

# ---------------------------------------------------------------------------
# Lane gating (v6) - only require lanes whose surface the push actually
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
# The RANGE ends at the resolved head, the ACK still records the gh head.
# Separating the two is what lets this agree with the nudge's classification
# without ever acking a commit the PR does not carry.
REVIEW_RANGE_HEAD=$(resolve_review_head "$CURRENT_PR_HEAD")
REQUIRED_LANES="code-reviewer spec-reviewer doc-updater"
if . "$(dirname "$0")/lib/lane-classifier.sh" 2>/dev/null; then
  REQUIRED_LANES=$(compute_required_lanes "$LAST_ACK_PR_HEAD" "$REVIEW_RANGE_HEAD")
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
# In-flight guard: do not re-summon (or block) while a review wave is still
# running. A lane is "in flight" when its MOST RECENT Agent spawn anywhere in
# the transcript has no `completed</status>` marker yet -- i.e. that subagent
# is still executing. Subagents always emit a completion marker on finish
# (success OR error), so "last spawn has no completion" reliably means
# "currently running", not "errored long ago".
#
# Without this guard, a push that lands while the prior wave is still running
# advances the PR HEAD past the in-flight spawn lines; the parallel block
# below then sees no spawn AFTER the new push line and emits a fresh spawn
# directive, producing the re-summon loop the user hit (issue: hook keeps
# demanding new reviewers every turn while the old wave is mid-run).
#
# Safety: this only SUPPRESSES the block (exit 0) -- it never advances the ack
# pointer. The PR HEAD stays un-acked until a real completion lands and a
# later Stop event runs the full pipeline check below. So an un-reviewed HEAD
# can never reach `main` through this path; the gate just stops nagging while
# reviewers work. Paired behavioural rule (rules/git-workflow.md): the agent
# must NOT push again or start a new wave while a wave is in flight.
#
# Stuck-open bound: a spawn that NEVER emits a completion marker (subagent
# crashed, session killed, transcript truncated) would otherwise suppress the
# gate forever for this PR HEAD. To prevent that, an in-flight spawn only
# counts as in-flight while it is RECENT -- within IN_FLIGHT_STALE_LINES of the
# transcript tail. A genuine review completes within a turn or two (a few
# hundred transcript lines); once an uncompleted spawn falls that far behind as
# the session keeps appending, it is treated as orphaned and enforcement
# re-fires (which then hits its own 5-strike breaker). The durable-review merge
# gate (REQ-AGENT-040 AC7) is the backstop either way.
IN_FLIGHT_STALE_LINES=1200
lane_in_flight() {
  local lane="$1"
  local spawn_line
  spawn_line=$(lane_spawn_lines "$lane" | tail -1)
  [ -n "$spawn_line" ] || return 1  # never spawned -> not in flight
  # Staleness bound: an uncompleted spawn far behind the transcript tail is
  # treated as orphaned (dead subagent), not in-flight, so the gate re-fires.
  local total
  total=$(wc -l < "$TRANSCRIPT" 2>/dev/null || echo 0)
  if [ "$((total - spawn_line))" -gt "$IN_FLIGHT_STALE_LINES" ] 2>/dev/null; then
    return 1
  fi
  local tool_use_id
  tool_use_id=$(tool_use_id_of_spawn "$spawn_line")
  [ -n "$tool_use_id" ] || return 1  # can't correlate -> treat as not in flight
  if tool_use_id_terminal "$spawn_line" "$tool_use_id"; then
    return 1  # ended (completed OR failed) -> not in flight, re-demand at once
  fi
  return 0  # spawned recently, no terminal status yet -> in flight
}

latest_lane_spawn_after_line() {
  local lane="$1"
  local min_line="$2"
  lane_spawn_lines "$lane" "$min_line" | tail -1
}

spawn_ended_unsuccessfully() {
  local spawn_line="$1"
  local tool_use_id
  tool_use_id=$(tool_use_id_of_spawn "$spawn_line")
  [ -n "$tool_use_id" ] || return 1
  tool_use_id_terminal "$spawn_line" "$tool_use_id" \
    && ! tool_use_id_completed "$spawn_line" "$tool_use_id"
}

spawn_completed() {
  local spawn_line="$1"
  local tool_use_id
  tool_use_id=$(tool_use_id_of_spawn "$spawn_line")
  [ -n "$tool_use_id" ] || return 1
  tool_use_id_completed "$spawn_line" "$tool_use_id"
}

lane_has_coverage_after_line() {
  local lane="$1"
  local min_line="$2"
  local spawn_line
  spawn_line=$(latest_lane_spawn_after_line "$lane" "$min_line")
  [ -n "$spawn_line" ] || return 1

  if spawn_completed "$spawn_line"; then
    return 0
  fi

  # Ended badly is not covered. Without this the staleness window below credits
  # a dead lane as covered, so it is never re-demanded -- which made the whole
  # failed-lane path dead code in exactly the case it was written for.
  if spawn_ended_unsuccessfully "$spawn_line"; then
    return 1
  fi

  local total
  total=$(wc -l < "$TRANSCRIPT" 2>/dev/null || echo 0)
  [ "$((total - spawn_line))" -le "$IN_FLIGHT_STALE_LINES" ] 2>/dev/null
}

# Latest completion across every required lane, i.e. the moment the round's
# evidence was complete. Empty if any required lane has not completed.
latest_required_completion_line() {
  local lane spawn_line line max=0
  for lane in $REQUIRED_LANES; do
    spawn_line=$(latest_lane_spawn_after_line "$lane" "$COVERAGE_LINE")
    [ -n "$spawn_line" ] || return 1
    line=$(spawn_completion_line "$spawn_line") || return 1
    [ -n "$line" ] || return 1
    [ "$line" -gt "$max" ] 2>/dev/null && max="$line"
  done
  [ "$max" -gt 0 ] 2>/dev/null || return 1
  printf '%s\n' "$max"
}

lane_completed_after_line() {
  local lane="$1"
  local min_line="$2"
  local spawn_line
  spawn_line=$(latest_lane_spawn_after_line "$lane" "$min_line")
  [ -n "$spawn_line" ] || return 1
  spawn_completed "$spawn_line"
}

lane_has_current_coverage() {
  lane_has_coverage_after_line "$1" "$COVERAGE_LINE"
}

lane_completed_for_current_head() {
  lane_completed_after_line "$1" "$COVERAGE_LINE"
}

all_required_lanes_completed_for_current_head() {
  local lane
  for lane in $REQUIRED_LANES; do
    lane_completed_for_current_head "$lane" || return 1
  done
  return 0
}

# In-flight suppression is applied PER-LANE at each demand site below: a lane
# is demanded only if it lacks current-head coverage AND is NOT currently in
# flight. The old blanket "any required lane in flight -> exit 0" loop was
# removed -- it masked the ENTIRE gate while a single slow lane (e.g. a
# long-running code-reviewer) was in flight, so another required lane's
# demand never fired. Per-lane guarding
# keeps the re-summon-loop fix (a lane already running is never re-demanded)
# while still letting an independent/sequential lane be demanded on schedule.

# ---------------------------------------------------------------------------
# Parallel block: code-reviewer + spec-reviewer + doc-updater are spawned together.
# All three review lanes are report-only and return structured findings to the root.
# Reviewers write no project, triage, or review-artifact files, so there is no ordering
# dependency or shared-write race. Only the lanes present in
# REQUIRED_LANES are demanded. A lane with fresh current-head coverage or an in-flight
# run is skipped (not re-summoned) but does not suppress the other lanes.
# ---------------------------------------------------------------------------
MISSING=""
if requires_lane "code-reviewer" && ! lane_has_current_coverage "code-reviewer" && ! lane_in_flight "code-reviewer"; then
  MISSING="$MISSING code-reviewer"
fi
if requires_lane "spec-reviewer" && ! lane_has_current_coverage "spec-reviewer" && ! lane_in_flight "spec-reviewer"; then
  MISSING="$MISSING spec-reviewer"
fi
if requires_lane "doc-updater" && ! lane_has_current_coverage "doc-updater" && ! lane_in_flight "doc-updater"; then
  MISSING="$MISSING doc-updater"
fi

# A lane that already ran for THIS head and ended without success is the case
# that used to disappear: its report may even have been readable, but the gate
# never credited it, so the head stayed un-acked and every later range widened.
# Name it in the demand so a lost lane is re-run rather than silently absorbed.
FAILED=""
for lane in $REQUIRED_LANES; do
  failed_spawn=$(latest_lane_spawn_after_line "$lane" "$COVERAGE_LINE")
  [ -n "$failed_spawn" ] || continue
  if spawn_ended_unsuccessfully "$failed_spawn"; then
    FAILED="$FAILED $lane"
  fi
done

# SCOPE THE DEMAND. Without --range the runner falls through to "Review the
# full PR diff" (run-review-lane.sh), and because both the inlined packet and
# the ownership short-circuit are gated on RANGE, a scopeless lane gets no
# packet, no short-circuit, and an instruction to run its own diff -- which is
# precisely the raw-scan blowup the packet CLI was built to end. The nudge has
# always passed a scope; this path never did, so every re-demand, failed-lane
# retry and post-compaction spawn ran the expensive way.
#
# Same resolution and same ancestry guard as the nudge, so the two agree: an
# incremental range only when the acked head is an ancestor of the head under
# review (equal counts), else the PR base, else nothing rather than a dangling
# flag.
if [ -n "$LAST_ACK_PR_HEAD" ] && [ -n "$REVIEW_RANGE_HEAD" ] \
   && [ "$LAST_ACK_PR_HEAD" != "$REVIEW_RANGE_HEAD" ] \
   && git merge-base --is-ancestor "$LAST_ACK_PR_HEAD" "$REVIEW_RANGE_HEAD" 2>/dev/null; then
  LANE_SCOPE=" --range $LAST_ACK_PR_HEAD..$REVIEW_RANGE_HEAD"
elif [ -n "$BASE_REF" ]; then
  LANE_SCOPE=" --base $BASE_REF"
else
  LANE_SCOPE=""
fi

if [ -n "$MISSING" ]; then
  REASON="PR #$CURRENT @ ${CURRENT_PR_HEAD:0:7}: run$MISSING in parallel. Run each lane as a BACKGROUND Bash call, all issued in one message: 'bash \${CLAUDE_CONFIG_DIR:-\$HOME/.claude}/plugins/codeflare-hooks/scripts/run-review-lane.sh --lane <name>$LANE_SCOPE' with run_in_background: true, so the main session stays usable. Reviewers return structured findings; the root alone writes project or triage files. USER-ONLY bypass: user types 'skip review' (agent must never self-bypass)."
  if [ -n "$FAILED" ]; then
    REASON="$REASON ATTENTION:$FAILED already ran for this head and ended WITHOUT success, so nothing was credited - re-run those lanes rather than treating their output as a completed round."
  fi
  emit_block "$REASON"
fi

# ---------------------------------------------------------------------------
# doc-updater is demanded in the parallel block above, alongside code-reviewer and
# spec-reviewer. The three review lanes return findings without writing files, so there
# is no ordering dependency between them.
#
# Advance the checkpoint only when EVERY required lane has a current-head completion
# marker. all_required_lanes_completed_for_current_head is stricter than the demand-side
# coverage check (it requires an actual completion, not just an in-flight spawn), so the
# ack never fires while any lane is still running.
# ---------------------------------------------------------------------------
# Acknowledgement means "this head's review was CONSUMED", not merely "the lanes
# exited". Those are different claims, and only the first is what a later range
# may safely be measured from. A round whose lanes returned into a session that
# never read them leaves findings unacted while the checkpoint advances past
# them -- so the gate requires the triage verdict, published after the last lane
# returned, exactly as the Pi enforcement path does.
#
# The FIX phase is then its own directive rather than something the session is
# trusted to remember: the head is already acknowledged when it fires, so fixing
# never relaunches review or CI for that head.
if all_required_lanes_completed_for_current_head; then
  ROUND_COMPLETE_LINE=$(latest_required_completion_line 2>/dev/null || true)
  if [ -n "$ROUND_COMPLETE_LINE" ] && triage_published_after_line "$ROUND_COMPLETE_LINE"; then
    if ! write_acknowledgement; then
      emit_block_uncounted "PR #$CURRENT @ ${CURRENT_PR_HEAD:0:7}: triage is complete but the acknowledgement could not be persisted. Do not enter FIX or push; repair the local checkpoint write first."
    fi
    rm -f "$VERDICT_COUNT_FILE" 2>/dev/null || true
    clear_counter
    # This directive owns the push. Stating the condition in a rule instead was
    # the weaker half of the same idea: a hook directive outranks a standing
    # rule, so with no order here the round simply stopped after the commit and
    # waited to be prodded.
    #
    # The CI wait is a gate, not a delay. An earlier wording said to push
    # "immediately afterwards" once the terminal line landed, which reads the
    # same for a pass and a failure and would deliver straight past a red head.
    # A failing CI_RESULT is a finding like any other: it is fixed in the same
    # commit, and only then does the push happen.
    emit_block "PR #$CURRENT @ ${CURRENT_PR_HEAD:0:7} — FIX phase. This head is ACKNOWLEDGED: do not relaunch review or CI for it. Apply the accepted MINIMAL DECISION rows only; rejected rows stay rejected, accepted rows are not deferred. Wait for this head's terminal CI_RESULT if it has not landed yet, skipping the wait when no monitor exists for this head or its log has not advanced since your last read. A failing CI_RESULT is a finding: fix it in the same commit, and never push a head whose CI failure you have not addressed. Then verify the focused static checks, commit, and push the checked-out PR branch WITHOUT asking. That push is the next delivery boundary and starts one incremental review wave and one CI monitor; end the turn immediately after it. Do not merge. If nothing was accepted and CI passed, commit and push nothing. State what you fixed and anything you deliberately left."
  fi
  if [ -n "$ROUND_COMPLETE_LINE" ] && completion_delivery_pending "$ROUND_COMPLETE_LINE"; then
    # The terminal records may have landed while the current model request was
    # already running. Ending this turn is what lets their native notifications
    # become root-visible before any verdict can be demanded.
    exit 0
  fi
  # The demand must never cost more than it protects. Five unanswered demands
  # would otherwise leave this head unacked forever, and a wedged checkpoint is
  # the exact failure this whole path exists to remove -- it re-measures every
  # later range from a stale head. Take the escape hatch the 5-strike breaker
  # already defines: acknowledge, and say plainly that no verdict backed it.
  if reack_on_repeated_demand; then
    exit 0
  fi
  emit_block_uncounted "PR #$CURRENT @ ${CURRENT_PR_HEAD:0:7}: every required lane has a terminal record and its notification-delivery turn has elapsed, but no triage verdict is published. If any report is still absent from visible context, retrieve it now with Read/TaskOutput; never publish or defer to FIX without reading every required report. After all reports are consumed, verify every finding against the reviewers' evidence. Finding validity and proposed-fix validity are separate decisions: a real issue can still carry an unnecessary or overengineered correction, and the smallest fix reusing an existing implementation path beats new machinery. Then publish ONE table in a TOOL-FREE response that ends the turn, one row per finding across all lanes, in exactly this shape: '$REVIEW_TRIAGE_HEADER' over '$REVIEW_TRIAGE_DIVIDER' A fully clean round publishes that empty table without synthetic clean-lane rows. VALIDITY records whether the finding is real, PROPORTIONALITY whether the proposed fix is minimal or overengineered, and MINIMAL DECISION the smallest correct action. The fix directive follows next turn once this head is acknowledged."
fi

exit 0
