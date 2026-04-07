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
# Execution order: code-reviewer in parallel with the others (lane: source code).
# spec-reviewer FIRST among docs/spec agents (only if sdd/ exists).
# doc-updater SECOND, AFTER spec-reviewer completes (sequential because they share files).
REMINDER="IMPORTANT: git-workflow rule requires running review agents alongside this push. Launch these background agents NOW (in this same response):"
REMINDER="$REMINDER 1) code-reviewer agent on the changes being pushed (runs in parallel — own lane: source code)."

# Check if sdd/ exists for conditional spec-reviewer + sequential doc-updater
if [ -d "sdd" ]; then
  REMINDER="$REMINDER 2) spec-reviewer agent FIRST to update sdd/ (only if sdd/ exists)."
  REMINDER="$REMINDER 3) doc-updater agent SECOND, AFTER spec-reviewer completes — they share files in sdd/+documentation/ so they MUST run sequentially, never in parallel."
else
  REMINDER="$REMINDER 2) doc-updater agent to check if documentation/ needs updates."
fi

REMINDER="$REMINDER Also start CI monitoring in background after push completes."

jq -n --arg ctx "$REMINDER" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
exit 0
