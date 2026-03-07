#!/usr/bin/env bash
# PreToolUse hook - blocks git commits/PRs with Claude attribution
set -e

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true

# Only check Bash tool
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

# Extract command
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true

# Check if this is a git commit or gh pr create command
if [[ ! "$COMMAND" =~ git.*commit ]] && [[ ! "$COMMAND" =~ gh.*pr.*create ]]; then
  exit 0
fi

# Check for attribution patterns (case insensitive)
if echo "$COMMAND" | grep -Eiq "(co-authored-by|noreply@anthropic|claude sonnet|claude opus|claude haiku|claude code|generated with.*claude|generated with.*\[claude)"; then
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Attribution detected. Retry the commit without Co-Authored-By, AI attribution, emoji, or Generated with Claude Code lines. Use a plain commit message."
    }
  }'
  exit 0
fi

exit 0
