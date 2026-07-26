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
while [ $# -gt 0 ]; do
  case "$1" in
    --lane)  LANE="${2:-}"; shift 2 ;;
    --range) RANGE="${2:-}"; shift 2 ;;
    --base)  BASE="${2:-}"; shift 2 ;;
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
GUARDS=""
for guard in block-local-builds.sh block-attributed-commits.sh; do
  [ -f "$HOOK_DIR/$guard" ] || continue
  GUARDS="$GUARDS${GUARDS:+,}$(printf '{"type":"command","command":"bash %s"}' "$HOOK_DIR/$guard")"
done
printf '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[%s]}]}}\n' "$GUARDS" > "$GUARD_SETTINGS"

if [ -n "$RANGE" ]; then
  SCOPE="Review ONLY the incremental diff: 'git diff $RANGE'. Do not review the full PR diff."
elif [ -n "$BASE" ]; then
  SCOPE="Review the full PR diff: 'git diff origin/$BASE...HEAD'."
else
  SCOPE="Review the full PR diff: 'git diff origin/main...HEAD'."
fi

TASK="PR-boundary review, $LANE lane. $SCOPE Gather your own evidence with Bash. Return your structured report as your final message; write no files."

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

RAW="$(claude "$@" 2>/dev/null)"
STATUS=$?
if [ $STATUS -ne 0 ] || [ -z "$RAW" ]; then
  echo "run-review-lane: $LANE lane failed to produce a report (exit $STATUS)" >&2
  exit 4
fi

# Emit the report body only. The root session consumes this as the lane's
# findings, so a raw JSON envelope here would cost it the whole usage block.
printf '%s' "$RAW" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let parsed;
    try { parsed = JSON.parse(s); } catch { process.stderr.write("run-review-lane: unparseable CLI output\n"); process.exit(4); }
    if (parsed.is_error) { process.stderr.write("run-review-lane: lane reported an error\n"); process.exit(4); }
    process.stdout.write(String(parsed.result ?? ""));
  });
'
