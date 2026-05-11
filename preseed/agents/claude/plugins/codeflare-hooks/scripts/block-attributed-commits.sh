#!/usr/bin/env bash
# PreToolUse hook - blocks git commits / GitHub surfaces with Claude attribution.
#
# Registered in settings.json on three matchers:
#   1. Bash                                    (with `"if": "Bash(git *)"` /
#                                               `"if": "Bash(gh *)"` predicates)
#   2. mcp__context-mode__ctx_execute          (ctx-mode shell tool)
#   3. mcp__context-mode__ctx_batch_execute    (ctx-mode batch shell tool)
#
# Within those, it further narrows to commands that can introduce attribution
# into a git object or a GitHub surface (commit messages, merge messages, tag
# annotations, notes, PR titles/bodies/comments/reviews, issue titles/bodies/
# comments, release titles/notes). Read-only commands (git status, git log,
# gh run view, gh auth status, etc.) early-exit for free.
#
# Companion to issue #317 (git-push-review-reminder.sh) and issue #319
# (enforce-review-spawn.sh): when context-mode's enforce-ctx-mode.sh denies
# `gh pr create` / `gh pr edit` in Bash, agents retry through MCP shell tools.
# Without the multi-shape parsing below, COMMAND was empty for those calls
# and attribution lines could land via ctx_execute / ctx_batch_execute.
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

# Accept Bash and the MCP shell tools. Anything else exits silently.
case "$TOOL_NAME" in
  Bash) ;;
  mcp__*ctx_execute) ;;
  mcp__*ctx_batch_execute) ;;
  *) exit 0 ;;
esac

# Extract the command(s) from any of three supported tool-input shapes:
#
#   1. Bash tool                  → .tool_input.command          (string)
#   2. mcp__*__ctx_execute        → .tool_input.code             (string, only
#                                   when .tool_input.language == "shell")
#   3. mcp__*__ctx_batch_execute  → .tool_input.commands[].command (array of
#                                   objects; concatenated with `; ` so the
#                                   existing per-command regex matches each)
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
