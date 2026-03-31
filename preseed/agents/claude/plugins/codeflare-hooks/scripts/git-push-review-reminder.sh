#!/usr/bin/env bash
# PreToolUse hook — reminds agent to run review agents before/after git push
set -e

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true

# Only check Bash tool
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

# Extract command
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true

# Only trigger on git push commands
if [[ ! "$COMMAND" =~ git.*push ]]; then
  exit 0
fi

# Build reminder based on what exists
REMINDER="IMPORTANT: git-workflow rule requires running review agents in parallel with this push. Launch these background agents NOW (in this same response, alongside the push):"
REMINDER="$REMINDER 1) code-reviewer agent on the changes being pushed."
REMINDER="$REMINDER 2) doc-updater agent to check if documentation/ needs updates."

# Check if sdd/ exists for conditional 3rd agent
if [ -d "sdd" ] || [ -d "$HOME/workspace/*/sdd" ] 2>/dev/null; then
  REMINDER="$REMINDER 3) spec-reviewer agent to update sdd/ if code changes affect requirements."
fi

REMINDER="$REMINDER Also start CI monitoring in background after push completes."

jq -n --arg ctx "$REMINDER" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
exit 0
