#!/usr/bin/env bash
# PostToolUse hook - after `git clone` or `gh repo clone`, inject a
# directive telling the agent to ask the user via AskUserQuestion
# whether to build a graphify knowledge graph for the cloned repo.
# Implements REQ-AGENT-023 AC4.
#
# Matcher coverage (registered in entrypoint.sh):
#   - Bash
#   - mcp__context-mode__ctx_execute
#   - mcp__context-mode__ctx_batch_execute
#
# Multi-shape parsing mirrors codeflare-hooks/git-push-review-reminder.sh
# (issue #317): when enforce-ctx-mode.sh denies a Bash invocation, the
# agent retries through the MCP shell tools; we need to catch both.
#
# Anchored-token regex (not substring) rejects echoed false positives
# like `echo "git clone foo"`.
#
# Idempotency: marker file at ~/.cache/codeflare-hooks/graphify-prompted/
# keyed on the cloned directory. Repeated clones in the same dir within a
# session do not re-prompt.
#
# Fail-safe: any unexpected error -> exit 0 with no output.
set +e

INPUT=$(cat 2>/dev/null) || exit 0

# Cheap pre-filter (PostToolUse fires on every matching tool call).
case "$INPUT" in
  *clone*) ;;
  *) exit 0 ;;
esac

# Extract command across the three supported tool-input shapes.
COMMAND=$(echo "$INPUT" | jq -r '
  if (.tool_input.command // "") != "" then
    .tool_input.command
  elif (.tool_input.language // "") == "shell" and (.tool_input.code // "") != "" then
    .tool_input.code
  elif (.tool_input.commands | type? == "array") then
    [.tool_input.commands[]?.command // empty] | join("; ")
  else
    empty
  end
' 2>/dev/null) || true

[ -z "$COMMAND" ] && exit 0

# Anchored token match: git clone / gh repo clone as actual command
# tokens, not inside echo strings. Allowed positions: start of string,
# or after shell separators (; && || | &).
if ! echo "$COMMAND" | grep -qE '(^|[;&|]\s*)(git\s+clone|gh\s+repo\s+clone)\s' 2>/dev/null; then
  exit 0
fi

# Extract the cloned target directory from tool_response stdout
# ("Cloning into 'foo'..." line).
RESPONSE=$(echo "$INPUT" | jq -r '
  .tool_response.stdout
  // .tool_response.output
  // .tool_response.stderr
  // empty
' 2>/dev/null) || true

TARGET_DIR=$(echo "$RESPONSE" | grep -oE "Cloning into '[^']+'" 2>/dev/null | head -n 1 | sed "s/Cloning into '//; s/'$//")
[ -z "$TARGET_DIR" ] && TARGET_DIR="the repo you just cloned"

# Idempotency marker keyed on the target directory.
MARKER_DIR="${HOME:-/root}/.cache/codeflare-hooks/graphify-prompted"
mkdir -p "$MARKER_DIR" 2>/dev/null || true
MARKER="$MARKER_DIR/$(echo "$TARGET_DIR" | tr '/ ' '__')"
if [ -f "$MARKER" ]; then
  exit 0
fi
: > "$MARKER" 2>/dev/null || true

# Inject directive.
jq -n --arg dir "$TARGET_DIR" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: ("The user just cloned `" + $dir + "`. Before doing anything else with this repo, ask the user via AskUserQuestion whether to build a graphify knowledge graph for it. Recommend YES for repos with more than 50 files: the graph gives you structural awareness and saves Grep tokens on every later architecture question. If the user agrees, cd into `" + $dir + "` and run `/graphify` (or `graphify .` from the CLI). For repos larger than 2000 files, suggest `graphify cluster-only . --no-viz` (AST-only, no LLM extraction). If the user declines, proceed without it.")
  }
}' 2>/dev/null || true

exit 0
