#!/usr/bin/env bash
# SessionStart/PostToolUse hook: marker-aware automatic-delivery or consent ingress for root sessions.
set +e

INPUT=$(cat 2>/dev/null) || exit 0
EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
AGENT_TYPE=$(printf '%s' "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null)
[ -z "$AGENT_TYPE" ] || exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
STATE_HELPER="$SCRIPT_DIR/lib/review-completion-state.mjs"
CLASSIFIER="$SCRIPT_DIR/lib/boundary-classifier.cjs"
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // .transcript_path // "root"' 2>/dev/null)
SESSION_KEY=$(printf '%s' "$SESSION_ID" | cksum | awk '{print $1}')
TOOL_USE_ID=$(printf '%s' "$INPUT" | jq -r '.tool_use_id // .toolUseId // empty' 2>/dev/null)
TOOL_KEY=$(printf '%s' "$SESSION_ID:$TOOL_USE_ID" | cksum | awk '{print $1}')
SESSION_DIR="${CODEFLARE_REVIEW_SESSION_DIR:-/run/codeflare/review-session}"
OFFSET_FILE="$SESSION_DIR/$SESSION_KEY.offset"
PRUNE_SENTINEL="$SESSION_DIR/root-pruned"
MERGE_STATE_FILE="$SESSION_DIR/$TOOL_KEY.merge-before.json"

command_text() {
  printf '%s' "$INPUT" | jq -r '
    if (.tool_input.command // "") != "" then .tool_input.command
    elif (.tool_input.language // "") == "shell" and (.tool_input.code // "") != "" then .tool_input.code
    elif (.tool_input.commands | type? == "array") then [.tool_input.commands[]?.command // empty] | join("; ")
    else empty end
  ' 2>/dev/null
}

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] || CWD=$PWD
REPO_CWD="$CWD"
BOUNDARY_KIND="startup"
case "$EVENT" in
  PreToolUse)
    COMMAND=$(command_text)
    [ -n "$COMMAND" ] && [ -n "$TOOL_USE_ID" ] || exit 0
    IS_MERGE=$(node -e '
      const { isReviewMergeCommand } = require(process.argv[1]);
      process.stdout.write(isReviewMergeCommand(process.argv[2]) ? "true" : "false");
    ' "$CLASSIFIER" "$COMMAND" 2>/dev/null) || exit 0
    [ "$IS_MERGE" = "true" ] || exit 0
    REPO=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
    BRANCH=$(git -C "$REPO" symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
    HEAD=$(git -C "$REPO" rev-parse HEAD 2>/dev/null) || exit 0
    mkdir -p "$SESSION_DIR" 2>/dev/null || exit 0
    TEMP_STATE="$MERGE_STATE_FILE.$$.tmp"
    jq -cn --arg repo "$REPO" --arg branch "$BRANCH" --arg head "$HEAD" \
      '{repo:$repo,branch:$branch,head:$head}' > "$TEMP_STATE" 2>/dev/null || exit 0
    mv "$TEMP_STATE" "$MERGE_STATE_FILE" 2>/dev/null || rm -f "$TEMP_STATE"
    exit 0
    ;;
  PostToolUseFailure)
    [ -n "$TOOL_USE_ID" ] && rm -f "$MERGE_STATE_FILE"
    exit 0
    ;;
  SessionStart)
    mkdir -p "$SESSION_DIR" 2>/dev/null || true
    OFFSET=0
    if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
      OFFSET=$(wc -c < "$TRANSCRIPT" 2>/dev/null) || OFFSET=0
    fi
    printf '%s\n' "$OFFSET" > "$OFFSET_FILE" 2>/dev/null || true
    if [ ! -f "$PRUNE_SENTINEL" ]; then
      node "$STATE_HELPER" prune >/dev/null 2>&1 || exit 0
      : > "$PRUNE_SENTINEL" 2>/dev/null || true
    fi
    ;;
  PostToolUse)
    COMMAND=$(command_text)
    [ -n "$COMMAND" ] || exit 0
    BOUNDARY_KIND=$(node -e '
      const { boundaryOf } = require(process.argv[1]);
      process.stdout.write(boundaryOf(process.argv[2]) || "-");
    ' "$CLASSIFIER" "$COMMAND" 2>/dev/null) || exit 0
    case "$BOUNDARY_KIND" in
      clone|switch|checkout|pr-checkout|pull|push|pr-create)
        rm -f "$MERGE_STATE_FILE"
        ;;
      *)
        [ -n "$TOOL_USE_ID" ] && [ -f "$MERGE_STATE_FILE" ] || exit 0
        BEFORE_REPO=$(jq -r '.repo // empty' "$MERGE_STATE_FILE" 2>/dev/null)
        BEFORE_BRANCH=$(jq -r '.branch // empty' "$MERGE_STATE_FILE" 2>/dev/null)
        BEFORE_HEAD=$(jq -r '.head // empty' "$MERGE_STATE_FILE" 2>/dev/null)
        rm -f "$MERGE_STATE_FILE"
        REPO_CWD=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
        AFTER_BRANCH=$(git -C "$REPO_CWD" symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
        AFTER_HEAD=$(git -C "$REPO_CWD" rev-parse HEAD 2>/dev/null) || exit 0
        [ "$BEFORE_REPO" != "$REPO_CWD" ] || [ "$BEFORE_BRANCH" != "$AFTER_BRANCH" ] || [ "$BEFORE_HEAD" != "$AFTER_HEAD" ] || exit 0
        BOUNDARY_KIND="merge"
        ;;
    esac
    if [ "$BOUNDARY_KIND" = "clone" ]; then
      REPO_CWD=$(node -e '
        const { cloneTargetPath } = require(process.argv[1]);
        process.stdout.write(cloneTargetPath(process.argv[2], process.argv[3]) || "");
      ' "$CLASSIFIER" "$COMMAND" "$CWD" 2>/dev/null) || exit 0
      [ -n "$REPO_CWD" ] || exit 0
    fi
    ;;
  *) exit 0 ;;
esac

REPO=$(git -C "$REPO_CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$REPO/sdd/README.md" ] || exit 0
CONFIG="$REPO/sdd/config.yml"
TRIAGE="$REPO/sdd/.init-triage.md"
[ -f "$REPO/sdd/spec/config.yml" ] && CONFIG="$REPO/sdd/spec/config.yml"
[ -f "$REPO/sdd/spec/.init-triage.md" ] && TRIAGE="$REPO/sdd/spec/.init-triage.md"
if grep -q '^transition:[[:space:]]*true' "$CONFIG" 2>/dev/null \
  && grep -qiE '^\*\*Status:\*\*[[:space:]]+open\b' "$TRIAGE" 2>/dev/null; then
  exit 0
fi

targets_current() {
  node -e '
    const { exposureTargetsCheckedOutBranch } = require(process.argv[1]);
    const identity = JSON.parse(process.argv[3]);
    process.stdout.write(exposureTargetsCheckedOutBranch(process.argv[2], identity) ? "true" : "false");
  ' "$CLASSIFIER" "$COMMAND" "$(jq -cn --arg branch "$1" --argjson pr "$2" --arg repository "$3" '{branch:$branch,pr:$pr,repository:$repository}')" 2>/dev/null
}

STATUS=""
case "$BOUNDARY_KIND" in
  push|pr-create)
    for RETRY_DELAY in 0 1 3 5 10 15; do
      [ "$RETRY_DELAY" = 0 ] || sleep "$RETRY_DELAY"
      STATUS=$(node "$STATE_HELPER" status --cwd "$REPO" 2>/dev/null) || exit 0
      if [ "$EVENT" = "PostToolUse" ]; then
        CANDIDATE_PR=$(printf '%s' "$STATUS" | jq -r '.identity.pr // empty' 2>/dev/null)
        CANDIDATE_BRANCH=$(printf '%s' "$STATUS" | jq -r '.identity.branch // empty' 2>/dev/null)
        CANDIDATE_REPOSITORY=$(printf '%s' "$STATUS" | jq -r '.identity.repository // empty' 2>/dev/null)
        if printf '%s' "$CANDIDATE_PR" | grep -Eq '^[0-9]+$' && [ -n "$CANDIDATE_BRANCH" ] && [ -n "$CANDIDATE_REPOSITORY" ]; then
          [ "$(targets_current "$CANDIDATE_BRANCH" "$CANDIDATE_PR" "$CANDIDATE_REPOSITORY")" = "true" ] || exit 0
        fi
      fi
      [ "$(printf '%s' "$STATUS" | jq -r '.eligible // false' 2>/dev/null)" != "true" ] || break
      [ "$(printf '%s' "$STATUS" | jq -r '.retryable // false' 2>/dev/null)" = "true" ] || break
      REMOTE_HEAD=$(printf '%s' "$STATUS" | jq -r '.identity.head // empty' 2>/dev/null)
      LOCAL_HEAD=$(printf '%s' "$STATUS" | jq -r '.localHead // empty' 2>/dev/null)
      git -C "$REPO" merge-base --is-ancestor "$REMOTE_HEAD" "$LOCAL_HEAD" 2>/dev/null || break
    done
    ;;
  *) STATUS=$(node "$STATE_HELPER" status --cwd "$REPO" 2>/dev/null) || exit 0 ;;
esac
[ "$(printf '%s' "$STATUS" | jq -r '.eligible // false' 2>/dev/null)" = "true" ] || exit 0
MARKER_STATUS=$(printf '%s' "$STATUS" | jq -r '.completion.status // "missing"' 2>/dev/null)
[ "$MARKER_STATUS" != "complete" ] || exit 0
PR_NUMBER=$(printf '%s' "$STATUS" | jq -r '.identity.pr // empty' 2>/dev/null)
BRANCH=$(printf '%s' "$STATUS" | jq -r '.identity.branch // empty' 2>/dev/null)
BASE=$(printf '%s' "$STATUS" | jq -r '.identity.base // empty' 2>/dev/null)
HEAD=$(printf '%s' "$STATUS" | jq -r '.identity.head // empty' 2>/dev/null)
REPOSITORY=$(printf '%s' "$STATUS" | jq -r '.identity.repository // empty' 2>/dev/null)
ANCESTOR=$(printf '%s' "$STATUS" | jq -r '.ancestor.head // empty' 2>/dev/null)
printf '%s' "$PR_NUMBER" | grep -Eq '^[0-9]+$' || exit 0
printf '%s' "$HEAD" | grep -Eq '^[0-9a-f]{40}$' || exit 0

# An exact current-session round suppresses duplicate consent. Old transcript
# bytes are ignored by the ephemeral SessionStart offset.
OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null)
case "$OFFSET" in ''|*[!0-9]*) OFFSET=0 ;; esac
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  ACTIVE=$(node -e '
    const { currentRoundVisible } = require(process.argv[1]);
    process.stdout.write(currentRoundVisible(process.argv[2], Number(process.argv[3]), Number(process.argv[4]), process.argv[5]) ? "true" : "false");
  ' "$CLASSIFIER" "$TRANSCRIPT" "$OFFSET" "$PR_NUMBER" "$HEAD" 2>/dev/null) || ACTIVE=false
  [ "$ACTIVE" != "true" ] || exit 0
fi

case "$MARKER_STATUS" in
  expired) REASON="saved completion expired after 30 days" ;;
  changed) REASON="branch changed since its last saved completion" ;;
  *) REASON="no saved completion" ;;
esac

. "$SCRIPT_DIR/lib/lane-classifier.sh" 2>/dev/null || exit 0
REQUIRED_LANES=$(compute_required_lanes "$ANCESTOR" "$HEAD")
RUNNER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/codeflare-hooks/scripts/run-review-lane.sh"
if [ -n "$ANCESTOR" ] && git -C "$REPO" merge-base --is-ancestor "$ANCESTOR" "$HEAD" 2>/dev/null; then
  LANE_SCOPE="--range $ANCESTOR..$HEAD"
else
  LANE_SCOPE="--base $BASE"
fi

LANE_COMMANDS=""
for LANE in $REQUIRED_LANES; do
  OUTPUT_FILE="/tmp/codeflare-pr-$PR_NUMBER-${HEAD:0:12}-$LANE.md"
  LANE_COMMANDS="$LANE_COMMANDS\n- CODEFLARE_REVIEW_CI=$BOUNDARY_KIND CODEFLARE_REVIEW_HEAD=$HEAD bash $RUNNER --lane $LANE --boundary-pr $PR_NUMBER $LANE_SCOPE > $OUTPUT_FILE 2>&1 (background)"
done
CI_DIRECTIVE=""
case "$BOUNDARY_KIND" in
  push|pr-create)
    CI_PROMPT=$(jq -cn --arg repo "$REPOSITORY" --argjson pr "$PR_NUMBER" --arg head "$HEAD" --arg cwd "$REPO" '{repo:$repo,pr:$pr,head:$head,cwd:$cwd}') || exit 0
    CI_DIRECTIVE="Immediately after reviewer launches, launch public ci-monitor in background with inherit_context=false and prompt $CI_PROMPT. Do not wait for reviewers first."
    ;;
esac

if [ -z "$REQUIRED_LANES" ]; then
  case "$BOUNDARY_KIND" in
    push|pr-create)
      node "$STATE_HELPER" mark --cwd "$REPO" >/dev/null 2>&1 || true
      ROUND_DIRECTIVE="No reviewer launch or triage is required. Start only exact-head CI.
$CI_DIRECTIVE"
      ;;
    *) ROUND_DIRECTIVE="No reviewer launch is required. Mark this generated-only completion with: node $STATE_HELPER mark --cwd $REPO" ;;
  esac
else
  ROUND_DIRECTIVE=$(cat <<EOF
Do not reuse prior results:
$LANE_COMMANDS
$CI_DIRECTIVE
Issue all required reviewer calls together. Each command is background. After final launch, end turn. Wait for all required reviewers and exact-head CI to reach terminal evidence, then publish exactly one canonical triage table:
| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |
|---|---|---|---|---|
CI failure or timeout uses FINDING Exact-head CI and PROPOSED FIX CI_RESULT failure or CI_RESULT timeout.
For every finding:
- verify that it is evidence-backed and in scope
- judge the finding separately from its proposed fix
- reject unsupported or overengineered proposals
- prefer the smallest correction that reuses existing machinery
Make no mutations in triage turn. Stop hook revalidates identity, writes completion, then emits separate FIX reminder regardless of whether terminal CI succeeded, failed, or timed out.
EOF
  )
fi

case "$BOUNDARY_KIND" in
  push|pr-create)
    DIRECTIVE=$(cat <<EOF
Review completion is missing for ${REPOSITORY##*/}:$BRANCH.
Reason: $REASON.

Successful $BOUNDARY_KIND is a delivery boundary. Execute this fresh contextual round now without asking for consent.
$ROUND_DIRECTIVE
EOF
)
    ;;
  *)
    DIRECTIVE=$(cat <<EOF
Review completion is missing for ${REPOSITORY##*/}:$BRANCH.
Reason: $REASON.

Use AskUserQuestion once with exactly these neutral choices:
- Mark review complete
- Launch review

Cancellation writes nothing and ends this handling. Do not choose for user.

If user chooses Mark review complete, run exactly:
node $STATE_HELPER mark --cwd $REPO
Treat eligible=false or written failure as unacknowledged.

If user chooses Launch review, start this fresh contextual round.
$ROUND_DIRECTIVE
EOF
)
    ;;
esac

jq -n --arg ctx "$DIRECTIVE" '{hookSpecificOutput:{hookEventName:"'"$EVENT"'",additionalContext:$ctx}}' 2>/dev/null || exit 0
exit 0
