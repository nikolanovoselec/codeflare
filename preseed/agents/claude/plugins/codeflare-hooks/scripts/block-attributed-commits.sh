#!/usr/bin/env bash
# PreToolUse hook - blocks git commits / GitHub surfaces with Claude attribution.
#
# Gated in settings.json by `"if": "Bash(git *)"` + `"if": "Bash(gh *)"` so this
# script only runs for git and gh commands, never for unrelated Bash calls.
# Within those, it further narrows to commands that can introduce attribution
# into a git object or a GitHub surface (commit messages, merge messages, tag
# annotations, notes, PR titles/bodies/comments/reviews, issue titles/bodies/
# comments, release titles/notes). Read-only commands (git status, git log,
# gh run view, gh auth status, etc.) early-exit for free.
#
# Commands NOT covered (by design):
#   - git push            -- pushes existing commits; attribution was caught at
#                            the commit step
#   - git rebase -i,      -- editor-based, the hook only sees CLI args
#     git commit -e,
#     git cherry-pick -e
#   - direct API calls    -- if the user calls the GitHub API via curl, this
#                            hook cannot see or block it
set -e

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true

# Only check Bash tool
[[ "$TOOL_NAME" != "Bash" ]] && exit 0

# Extract command
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true

# Narrow to commands that can introduce attribution into git or GitHub.
# Anything not in this set is read-only or harmless — exit immediately.
#
# Covered:
#   git commit[.*]          -- all commit forms (--amend, -F, -m, etc.)
#   git merge [.*]-m[.*]    -- merge with a -m message flag
#   git tag [.*]-[am]       -- annotated tag with message
#   git notes add[.*]       -- commit notes
#   gh pr create|edit|comment|review|merge
#   gh issue create|edit|comment
#   gh release create|edit
MATCHED=0
if [[ "$COMMAND" =~ git[[:space:]]+commit ]]; then MATCHED=1; fi
if [[ "$COMMAND" =~ git[[:space:]]+merge.*-m ]]; then MATCHED=1; fi
if [[ "$COMMAND" =~ git[[:space:]]+tag.*-[am] ]]; then MATCHED=1; fi
if [[ "$COMMAND" =~ git[[:space:]]+notes[[:space:]]+add ]]; then MATCHED=1; fi
if [[ "$COMMAND" =~ gh[[:space:]]+pr[[:space:]]+(create|edit|comment|review|merge) ]]; then MATCHED=1; fi
if [[ "$COMMAND" =~ gh[[:space:]]+issue[[:space:]]+(create|edit|comment) ]]; then MATCHED=1; fi
if [[ "$COMMAND" =~ gh[[:space:]]+release[[:space:]]+(create|edit) ]]; then MATCHED=1; fi

if [[ "$MATCHED" -eq 0 ]]; then
  exit 0
fi

# Check for attribution patterns (case insensitive)
if echo "$COMMAND" | grep -Eiq "(co-authored-by|noreply@anthropic|claude sonnet|claude opus|claude haiku|claude code|generated with.*claude|generated with.*\[claude)"; then
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Attribution detected. Retry without Co-Authored-By, AI attribution, emoji, or Generated with Claude Code lines. Use a plain message/title/body."
    }
  }'
  exit 0
fi

exit 0
