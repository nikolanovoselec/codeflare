#!/usr/bin/env bash
# Run one PR-boundary review lane as a headless `claude -p` subprocess.
#
# WHY THIS EXISTS (measured, not assumed)
#
# An in-session subagent cannot be made cheap. Claude Code injects CLAUDE.md,
# every `~/.claude/rules/*.md`, MEMORY.md, the SessionStart hook blocks and the
# environment preamble into EVERY subagent, and exposes no per-agent frontmatter
# field to exclude any of it. Measured floor for a no-op subagent whose agent
# document is near-empty: 20,513 prompt tokens. Granting `tools: ["Bash"]`
# instead of the full toolset moves that by ~1,200 tokens, because tool schemas
# are already deferred -- the toolset is not where the cost is.
#
# The three flags that DO collapse it are CLI-only, so the lane has to be a
# subprocess rather than a subagent:
#
#   headless, default ............................ 41,389
#   + --setting-sources ""  (no CLAUDE.md/rules) . 21,034
#   + --system-prompt       (replaces the base) .. 17,598
#   + --tools Bash          (prunes the schemas) .  1,533
#
# A lane therefore pays its own agent document and ~1.5k of harness, instead of
# ~20.5k of inherited context it cannot use. The reviewers already carry their
# enforcement policy embedded (they are bash-only and read nothing to find it),
# so dropping the inherited rules costs no enforcement coverage.
#
# WHAT IS DELIBERATELY RE-INJECTED
#
# `--setting-sources ""` also drops hooks, which would let a reviewer run the
# test suite and freeze this container. The container guards are passed back in
# explicitly via --settings. They must be invoked as `bash <script>` -- the
# seeded hook scripts are not executable and a bare command path silently
# no-ops, which reads as "not blocked".
#
# Usage: run-review-lane.sh --lane <name> [--range <base>..<head>] [--base <ref>]
#
# `--lane <name>` is load-bearing beyond argument parsing: enforce-review-spawn.sh
# matches this exact token in the Bash tool_use envelope to decide that the lane
# ran. Renaming the flag silently disables the review gate.
set -uo pipefail

LANE=""
RANGE=""
BASE=""
# Set only when the classifier runs below, but referenced afterwards to seed
# triage and the packet; initialised here because this script runs under `set -u`.
REQUIRED=""
RANGE_FULL=""
# `shift 2` with only one argument left FAILS and does not shift, and this script
# runs without `set -e`, so a trailing valueless flag would spin the loop
# forever. A hung lane inside the review gate wedges the turn, so every flag
# asserts it has a value before shifting.
need_value() {
  [ "$1" -ge 2 ] || { echo "run-review-lane: $2 requires a value" >&2; exit 2; }
}
while [ $# -gt 0 ]; do
  case "$1" in
    --lane)  need_value $# --lane;  LANE="$2";  shift 2 ;;
    --range) need_value $# --range; RANGE="$2"; shift 2 ;;
    --base)  need_value $# --base;  BASE="$2";  shift 2 ;;
    *) echo "run-review-lane: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

case "$LANE" in
  code-reviewer|spec-reviewer|doc-updater) ;;
  *) echo "run-review-lane: --lane must be one of code-reviewer|spec-reviewer|doc-updater (got '${LANE:-}')" >&2; exit 2 ;;
esac

CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
AGENT_DOC="$CLAUDE_HOME/agents/$LANE.md"
if [ ! -f "$AGENT_DOC" ]; then
  echo "run-review-lane: missing agent document $AGENT_DOC" >&2
  exit 3
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "run-review-lane: 'claude' CLI not on PATH" >&2
  exit 3
fi

# Strip the YAML frontmatter: it configures a subagent, and a raw --system-prompt
# would otherwise show the model its own `tools:`/`model:` keys as instructions.
strip_frontmatter() {
  awk 'BEGIN { seen = 0 }
       /^---$/ { seen++; if (seen <= 2) next }
       seen >= 2 { print }' "$1"
}

frontmatter_value() {
  awk -v key="$2" '
    BEGIN { seen = 0 }
    /^---$/ { seen++; if (seen >= 2) exit; next }
    seen == 1 && $0 ~ "^" key ":" {
      sub("^" key ":[[:space:]]*", "")
      gsub(/^["'"'"']|["'"'"']$/, "")
      print
      exit
    }' "$1"
}

SYSTEM_PROMPT="$(strip_frontmatter "$AGENT_DOC")"
if [ -z "$SYSTEM_PROMPT" ]; then
  echo "run-review-lane: $AGENT_DOC has no body after frontmatter" >&2
  exit 3
fi

# Preserve the per-lane model/effort the agent document already declares, so the
# transport change does not silently re-tier a lane.
LANE_MODEL="$(frontmatter_value "$AGENT_DOC" model)"
LANE_EFFORT="$(frontmatter_value "$AGENT_DOC" effort)"

# Re-inject only the container guards. `bash <path>` is required: these scripts
# ship non-executable.
HOOK_DIR="$CLAUDE_HOME/plugins/codeflare-hooks/scripts"
GUARD_SETTINGS="$(mktemp -t review-lane-guards.XXXXXX.json)"
trap 'rm -f "$GUARD_SETTINGS"' EXIT
# Fail CLOSED. A missing guard would otherwise yield an empty hook list and run
# the lane with bypassPermissions and no protection at all -- the same
# silently-inert failure this block exists to prevent.
# jq is load-bearing here, not a convenience: it is what builds the guard
# settings. Absent, the redirection below still creates an empty file, the lane
# starts with an empty hook list, and it runs with bypassPermissions and no
# protection -- the same silently-inert outcome the missing-guard check exists
# to prevent. Check it explicitly rather than discovering it as "no guard fired".
if ! command -v jq >/dev/null 2>&1; then
  echo "run-review-lane: jq is required to build the guard settings; refusing to run unguarded" >&2
  exit 3
fi
GUARD_CMDS=()
for guard in block-local-builds.sh block-attributed-commits.sh; do
  if [ ! -f "$HOOK_DIR/$guard" ]; then
    echo "run-review-lane: required guard $HOOK_DIR/$guard is missing; refusing to run unguarded" >&2
    exit 3
  fi
  GUARD_CMDS+=("$HOOK_DIR/$guard")
done
# jq builds the JSON so a quote or backslash in CLAUDE_CONFIG_DIR/$HOME cannot
# produce a malformed settings file.
#
# The expansion MUST stay quoted as an array. Unquoted, a CLAUDE_CONFIG_DIR
# containing a space word-splits into fragments, and jq happily emits perfectly
# valid JSON whose hook commands point at paths that do not exist. That fails
# silently -- the lane runs unguarded and every check reports "not blocked" --
# whereas the malformed-JSON case this comment used to describe at least fails
# loudly. Quoting converts the dangerous failure back into the safe one.
jq -n --args '{hooks:{PreToolUse:[{matcher:"Bash",hooks:[$ARGS.positional[]|{type:"command",command:("bash "+.)}]}]}}' \
  "${GUARD_CMDS[@]}" > "$GUARD_SETTINGS"
if [ ! -s "$GUARD_SETTINGS" ]; then
  echo "run-review-lane: guard settings file is empty; refusing to run unguarded" >&2
  exit 3
fi

# NO-OP SHORT-CIRCUIT.
#
# Every turn re-sends the whole prompt, so a lane's floor is paid per turn, not
# once. Measured: an empty range still took 7 turns and 67,609 prompt tokens for
# the model to gather evidence and conclude there was nothing to review. That is
# the most expensive possible way to answer a question Git answers for free.
#
# The classifier already decides lane ownership at round level; this is the same
# question asked again at zero cost, and it also covers a lane invoked directly.
# It only ever declines work the classifier would also have declined, and any
# uncertainty (unreadable range, missing classifier, unresolved root) falls
# through to the model rather than silently skipping a review.
if [ -n "$RANGE" ]; then
  LANE_CLASSIFIER="$(dirname "$0")/lib/lane-classifier.sh"
  if [ -f "$LANE_CLASSIFIER" ] && command -v git >/dev/null 2>&1; then
    RANGE_BASE="${RANGE%%..*}"
    RANGE_HEAD="${RANGE##*..}"
    if [ -n "$RANGE_BASE" ] && [ -n "$RANGE_HEAD" ] \
        && git rev-parse --verify --quiet "$RANGE_BASE" >/dev/null 2>&1 \
        && git rev-parse --verify --quiet "$RANGE_HEAD" >/dev/null 2>&1; then
      # The packet CLI validates that its range is two FULL 40-char SHAs and
      # throws otherwise. A lane invoked with abbreviated SHAs would therefore
      # get no inlined packet AND fail to build one, silently falling back to
      # raw greps -- the exact evidence blowup the packet exists to prevent.
      # Resolve once, here, where both endpoints are already verified.
      FULL_BASE="$(git rev-parse "$RANGE_BASE" 2>/dev/null || true)"
      FULL_HEAD="$(git rev-parse "$RANGE_HEAD" 2>/dev/null || true)"
      if [ -n "$FULL_BASE" ] && [ -n "$FULL_HEAD" ]; then
        RANGE_FULL="$FULL_BASE..$FULL_HEAD"
      fi
      # shellcheck source=/dev/null
      . "$LANE_CLASSIFIER" 2>/dev/null || true
      if command -v compute_required_lanes >/dev/null 2>&1; then
        REQUIRED=$(compute_required_lanes "$RANGE_BASE" "$RANGE_HEAD" 2>/dev/null || echo "")
        case " $REQUIRED " in
          *" $LANE "*) ;;
          *)
            printf '## %s — NO-OP\n\n**Range:** `%s`\n\nThis lane owns no changed file in the range, so there is nothing to review. Determined from the diff without invoking a model.\n' \
              "$LANE" "$RANGE"
            echo "run-review-lane: lane=$LANE prompt_tokens=0 output_tokens=0 turns=0 cost_usd=0.0000 (short-circuited: lane owns nothing in range)" >&2
            exit 0
            ;;
        esac
      fi
    fi
  fi
  SCOPE="Review ONLY the incremental diff \`$RANGE\`. Do not review the full PR diff."
elif [ -n "$BASE" ]; then
  SCOPE="Review the full PR diff: 'git diff origin/$BASE...HEAD'."
else
  SCOPE="Review the full PR diff: 'git diff origin/main...HEAD'."
fi

# PHASE 0 AND EVIDENCE, PRE-COMPUTED.
#
# Both are inlined into the opening prompt rather than fetched by the lane.
#
# Phase 0 was six sequential Bash calls -- bootstrap, layout, config,
# transition, round counter, bulk-op audit -- and therefore six turns, measured
# at ~3,945 tokens per lane before any reviewing started. None of it needs a
# model. Worse, triage output is the most expensive evidence a lane can hold:
# arriving first, it is re-read on every turn that follows.
#
# The packet moves for the same reason plus one more. Fetched by the lane it
# costs a turn AND lands mid-conversation as a fresh cache write; inlined it is
# part of the initial prefix, written once and read at cache rates thereafter.
#
# Both are best-effort: a failure here degrades to the lane gathering its own
# evidence, exactly as before, never to a skipped review.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
TRIAGE_JSON=""
TRIAGE_SCRIPT="$(dirname "$0")/lib/lane-triage.mjs"
if [ -n "$REPO_ROOT" ] && [ -f "$TRIAGE_SCRIPT" ] && command -v node >/dev/null 2>&1; then
  TRIAGE_JSON="$(node "$TRIAGE_SCRIPT" --repo "$REPO_ROOT" --lane "$LANE" \
    ${RANGE:+--range "$RANGE"} ${REQUIRED:+--required-lanes "$REQUIRED"} 2>/dev/null || true)"
  # A decisive no-op costs zero tokens, same contract as the ownership
  # short-circuit above. Only the three conditions the reviewer prose already
  # defines as no-ops can produce this, and each is proven positively.
  case "$TRIAGE_JSON" in
    *'"decision": "exit-no-op"'*)
      TRIAGE_REASON="$(printf '%s' "$TRIAGE_JSON" \
        | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).reason??""))}catch{}})' 2>/dev/null)"
      printf '## %s — NO-OP\n\n**Range:** `%s`\n\nTriage resolved this lane to a no-op before any model ran: %s.\n' \
        "$LANE" "${RANGE:-full PR diff}" "${TRIAGE_REASON:-lane suspended by triage}"
      echo "run-review-lane: lane=$LANE prompt_tokens=0 fresh_input=0 cache_write=0 cache_read=0 output_tokens=0 turns=0 cost_usd=0.0000 (short-circuited: ${TRIAGE_REASON:-triage no-op})" >&2
      exit 0
      ;;
  esac
fi

PACKET_JSON=""
PACKET_SCRIPT="$CLAUDE_HOME/skills/review-scope/scripts/build-review-packet.mjs"
# Inline only a packet small enough that carrying it beats fetching it. Above
# the cap the lane builds its own, so a very large diff cannot force a huge
# prompt onto a lane that might have exited early anyway.
PACKET_MAX_BYTES="${REVIEW_LANE_PACKET_MAX_BYTES:-131072}"
case "$PACKET_MAX_BYTES" in ''|*[!0-9]*|0) PACKET_MAX_BYTES=131072 ;; esac
if [ -n "$REPO_ROOT" ] && [ -n "$RANGE" ] && [ -f "$PACKET_SCRIPT" ] && command -v node >/dev/null 2>&1; then
  CANDIDATE="$(node "$PACKET_SCRIPT" --repo "$REPO_ROOT" --scope diff --range "${RANGE_FULL:-$RANGE}" --lane "$LANE" 2>/dev/null || true)"
  if [ -n "$CANDIDATE" ] && [ "${#CANDIDATE}" -le "$PACKET_MAX_BYTES" ]; then
    PACKET_JSON="$CANDIDATE"
  fi
fi

TASK="PR-boundary review, $LANE lane. $SCOPE"
if [ -n "$TRIAGE_JSON" ]; then
  TASK="$TASK

Your Phase 0 triage is already resolved. Treat this block as authoritative and do NOT re-derive any of it — no bootstrap probe, no layout detection, no config read, no round-counter walk, no bulk-op audit. Report every finding it lists as your own.

<triage>
$TRIAGE_JSON
</triage>"
fi
if [ -n "$PACKET_JSON" ]; then
  TASK="$TASK

Your lane packet is already built. Do NOT rebuild it and do NOT re-read the diff.

<packet>
$PACKET_JSON
</packet>"
fi
TASK="$TASK

Evidence budget: you have at most 4 Bash calls. Triage and the packet are already above, so spend them only on leads the packet names — resolving an anchor, checking whether a cited symbol still exists, reading the bounded lines around a hunk. Batch aggressively: one compound command, not one command per question. Every extra call re-sends this entire prompt, so a call you did not need is the most expensive thing you can do. If you reach the budget, report what you have.

Return your structured report as your final message. Write no files."

set -- \
  -p "$TASK" \
  --output-format json \
  --setting-sources "" \
  --strict-mcp-config \
  --settings "$GUARD_SETTINGS" \
  --system-prompt "$SYSTEM_PROMPT" \
  --tools Bash \
  --permission-mode bypassPermissions
[ -n "$LANE_MODEL" ] && set -- "$@" --model "$LANE_MODEL"
[ -n "$LANE_EFFORT" ] && set -- "$@" --effort "$LANE_EFFORT"

# Keep stderr. The lane runs backgrounded and non-interactively, so this is the
# only diagnostic an operator ever sees; discarding it collapses auth failure,
# rate limiting, a bad --model and an unreadable --settings file into one
# indistinguishable exit code.
LANE_STDERR="$(mktemp -t review-lane-stderr.XXXXXX)"
trap 'rm -f "$GUARD_SETTINGS" "$LANE_STDERR"' EXIT
# Bounded. The argument parsing above is hardened precisely because a hung lane
# inside the review gate wedges the turn, and an auth prompt, a network stall or
# rate-limit backoff hangs just as hard. The Stop hook's staleness bound only
# re-classifies an orphaned spawn; it never reaps the process.
#
# The bound is validated, not just defaulted. `timeout 0` means "no timeout at
# all", so an empty, non-numeric, or explicitly-zero REVIEW_LANE_TIMEOUT would
# silently remove the very bound this block exists to impose. Anything that is
# not a positive integer falls back to the default instead of disabling it.
LANE_TIMEOUT="${REVIEW_LANE_TIMEOUT:-1800}"
case "$LANE_TIMEOUT" in
  ''|*[!0-9]*|0) LANE_TIMEOUT=1800 ;;
esac
# -k escalates to SIGKILL 30s after SIGTERM. Plain `timeout` sends only TERM,
# which a process wedged in an uninterruptible auth prompt or a tight retry loop
# can ignore -- leaving exactly the hung lane the bound was meant to reap.
RAW="$(timeout -k 30 "$LANE_TIMEOUT" claude "$@" 2>"$LANE_STDERR")"
STATUS=$?
if [ $STATUS -ne 0 ] || [ -z "$RAW" ]; then
  echo "run-review-lane: $LANE lane failed to produce a report (exit $STATUS)" >&2
  if [ "$STATUS" -eq 124 ] || [ "$STATUS" -eq 137 ]; then
    echo "run-review-lane: the lane exceeded its ${LANE_TIMEOUT}s bound and was reaped" >&2
  fi
  if [ -s "$LANE_STDERR" ]; then
    echo "run-review-lane: last stderr from the lane:" >&2
    tail -n 20 "$LANE_STDERR" >&2
  fi
  # A non-zero exit does not mean stdout was empty: the CLI reports quota,
  # auth and model errors as a JSON envelope on stdout while still exiting
  # non-zero. Discarding it left "exit 1" with no stderr and no explanation,
  # which is indistinguishable from a crash. Surface it, bounded.
  if [ -n "$RAW" ]; then
    echo "run-review-lane: first 500 bytes of lane stdout:" >&2
    printf '%.500s\n' "$RAW" >&2
  else
    echo "run-review-lane: the lane produced no stdout at all" >&2
  fi
  exit 4
fi

# Emit the report body on stdout and the cost line on stderr. The root session
# consumes stdout as the lane's findings, so a raw JSON envelope there would
# charge it the whole usage block; the cost line goes to stderr so a round stays
# measurable after the fact without entering the root's context as report text.
printf '%s' "$RAW" | LANE="$LANE" node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let parsed;
    try { parsed = JSON.parse(s); } catch { process.stderr.write("run-review-lane: unparseable CLI output\n"); process.exit(4); }
    if (parsed.is_error) { process.stderr.write("run-review-lane: lane reported an error\n"); process.exit(4); }
    const u = parsed.usage || {};
    // Broken out, not summed: these four are billed at wildly different rates
    // (cache writes above base input, cache reads far below it, output highest
    // of all), so a single prompt_tokens figure cannot tell you which lever to
    // pull. A lane that is expensive because of turn count looks identical to
    // one that is expensive because of evidence volume until they are split.
    const fresh = u.input_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const prompt = fresh + cacheWrite + cacheRead;
    process.stderr.write(
      `run-review-lane: lane=${process.env.LANE} prompt_tokens=${prompt} ` +
      `fresh_input=${fresh} cache_write=${cacheWrite} cache_read=${cacheRead} ` +
      `output_tokens=${u.output_tokens || 0} turns=${parsed.num_turns || 0} ` +
      `cost_usd=${(parsed.total_cost_usd || 0).toFixed(4)}\n`,
    );
    process.stdout.write(String(parsed.result ?? ""));
  });
'
