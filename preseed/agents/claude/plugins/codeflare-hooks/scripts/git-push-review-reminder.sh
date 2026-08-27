#!/usr/bin/env bash
# SessionStart/PostToolUse hook: marker-or-dialog review ingress for root sessions.
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
SESSION_DIR="${CODEFLARE_REVIEW_SESSION_DIR:-/run/codeflare/review-session}"
OFFSET_FILE="$SESSION_DIR/$SESSION_KEY.offset"

command_text() {
  printf '%s' "$INPUT" | jq -r '
    if (.tool_input.command // "") != "" then .tool_input.command
    elif (.tool_input.language // "") == "shell" and (.tool_input.code // "") != "" then .tool_input.code
    elif (.tool_input.commands | type? == "array") then [.tool_input.commands[]?.command // empty] | join("; ")
    else empty end
  ' 2>/dev/null
}

BOUNDARY_KIND="startup"
case "$EVENT" in
  SessionStart)
    mkdir -p "$SESSION_DIR" 2>/dev/null || true
    OFFSET=0
    if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
      OFFSET=$(wc -c < "$TRANSCRIPT" 2>/dev/null) || OFFSET=0
    fi
    printf '%s\n' "$OFFSET" > "$OFFSET_FILE" 2>/dev/null || true
    CHANGED=$(node "$STATE_HELPER" prune 2>/dev/null | jq -r '.changed // false' 2>/dev/null)
    ;;
  PostToolUse)
    COMMAND=$(command_text)
    [ -n "$COMMAND" ] || exit 0
    BOUNDARY_KIND=$(node -e '
      const { boundaryOf } = require(process.argv[1]);
      process.stdout.write(boundaryOf(process.argv[2]) || "-");
    ' "$CLASSIFIER" "$COMMAND" 2>/dev/null) || exit 0
    case "$BOUNDARY_KIND" in clone|switch|checkout|pr-checkout|pull|push|pr-create) ;; *) exit 0 ;; esac
    ;;
  *) exit 0 ;;
esac

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] || CWD=$PWD
REPO=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$REPO/sdd/README.md" ] || exit 0
CONFIG="$REPO/sdd/config.yml"
TRIAGE="$REPO/sdd/.init-triage.md"
[ -f "$REPO/sdd/spec/config.yml" ] && CONFIG="$REPO/sdd/spec/config.yml"
[ -f "$REPO/sdd/spec/.init-triage.md" ] && TRIAGE="$REPO/sdd/spec/.init-triage.md"
if grep -q '^transition:[[:space:]]*true' "$CONFIG" 2>/dev/null \
  && grep -qiE '^\*\*Status:\*\*[[:space:]]+open\b' "$TRIAGE" 2>/dev/null; then
  exit 0
fi

STATUS=$(node "$STATE_HELPER" status --cwd "$REPO" 2>/dev/null) || exit 0
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
  tail -c +$((OFFSET + 1)) "$TRANSCRIPT" 2>/dev/null \
    | grep -qF -- "--boundary-pr $PR_NUMBER" && exit 0
fi

case "$MARKER_STATUS" in
  expired) REASON="saved completion expired after 30 days" ;;
  changed) REASON="branch changed since its last saved completion" ;;
  *) REASON="no saved completion" ;;
esac

. "$SCRIPT_DIR/lib/lane-classifier.sh" 2>/dev/null || exit 0
REQUIRED_LANES=$(compute_required_lanes "$ANCESTOR" "$HEAD")
[ -n "$REQUIRED_LANES" ] || REQUIRED_LANES="code-reviewer spec-reviewer doc-updater"
RUNNER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/codeflare-hooks/scripts/run-review-lane.sh"
if [ -n "$ANCESTOR" ] && git -C "$REPO" merge-base --is-ancestor "$ANCESTOR" "$HEAD" 2>/dev/null; then
  LANE_SCOPE="--range $ANCESTOR..$HEAD"
else
  LANE_SCOPE="--base $BASE"
fi

LANE_COMMANDS=""
for LANE in $REQUIRED_LANES; do
  OUTPUT_FILE="/tmp/codeflare-pr-$PR_NUMBER-${HEAD:0:12}-$LANE.md"
  LANE_COMMANDS="$LANE_COMMANDS\n- CODEFLARE_REVIEW_CI=$BOUNDARY_KIND bash $RUNNER --lane $LANE --boundary-pr $PR_NUMBER $LANE_SCOPE > $OUTPUT_FILE 2>&1 (background)"
done
CI_DIRECTIVE=""
case "$BOUNDARY_KIND" in
  push|pr-create)
    CI_PROMPT=$(jq -cn --arg repo "$REPOSITORY" --argjson pr "$PR_NUMBER" --arg head "$HEAD" --arg cwd "$REPO" '{repo:$repo,pr:$pr,head:$head,cwd:$cwd}') || exit 0
    CI_DIRECTIVE="Immediately after reviewer launches, launch public ci-monitor in background with inherit_context=false and prompt $CI_PROMPT. Do not wait for reviewers first."
    ;;
esac

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

If user chooses Launch review, start this fresh contextual round. Do not reuse prior results:
$LANE_COMMANDS
$CI_DIRECTIVE
Issue all required reviewer calls together. Each command is background. After final launch, end turn. Wait for terminal evidence, then publish exactly one canonical triage table:
| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |
|---|---|---|---|---|
CI failure or timeout uses FINDING Exact-head CI and PROPOSED FIX CI_RESULT failure or CI_RESULT timeout. Make no mutations in triage turn. Stop hook writes completion immediately before separate FIX reminder.
EOF
)

jq -n --arg ctx "$DIRECTIVE" '{hookSpecificOutput:{hookEventName:"'"$EVENT"'",additionalContext:$ctx}}' 2>/dev/null || exit 0
exit 0
