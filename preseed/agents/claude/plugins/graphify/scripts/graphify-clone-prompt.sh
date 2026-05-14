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
# Idempotency: marker file under /tmp/codeflare-graphify-prompted-<session_id>/
# keyed on the cloned directory. Truly per-session - the marker dir is
# scoped by the session_id from the hook envelope, so a fresh session
# (or container restart) wipes the prompt state and the agent triages
# clones again. session_id falls back to PPID if absent (degraded but
# still bounded to a single shell tree).
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
# tokens, not inside echo strings. Allowed positions: start of string
# (with optional leading whitespace), or after shell separators
# (; && || | &). Trailing whitespace OR end-of-input accepted - covers
# commands with args and commands joined at end of a ctx_batch_execute
# command list.
if ! echo "$COMMAND" | grep -qE '(^\s*|[;&|]\s*)(git\s+clone|gh\s+repo\s+clone)(\s|$)' 2>/dev/null; then
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

# Idempotency marker keyed on the target directory. Only write the marker
# when we successfully extracted a real path - otherwise repeated clones
# that fail extraction would share the placeholder marker and go silent.
# Marker dir is session-scoped via session_id from the hook envelope so
# state does not persist across sessions or container restarts.
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION_ID" ] && SESSION_ID="ppid-$PPID"
MARKER_DIR="/tmp/codeflare-graphify-prompted-$SESSION_ID"
if [ -n "$TARGET_DIR" ]; then
  mkdir -p "$MARKER_DIR" 2>/dev/null || true
  MARKER="$MARKER_DIR/$(echo "$TARGET_DIR" | tr '/ ' '__')"
  if [ -f "$MARKER" ]; then
    exit 0
  fi
  : > "$MARKER" 2>/dev/null || true
fi

# Graph-presence branching. The cloned directory might already carry a
# graphify-out/graph.json from a prior session (R2 bisync round-trip, or
# upstream repo committed graphify-out/). In that case, skip the
# AskUserQuestion triage and tell the agent to refresh with the cheap
# AST-only `graphify update .` instead of a full /graphify rebuild.
EXISTING_GRAPH=""
if [ -n "$TARGET_DIR" ] && [ -f "$TARGET_DIR/graphify-out/graph.json" ]; then
  EXISTING_GRAPH="yes"
fi

[ -z "$TARGET_DIR" ] && TARGET_DIR="the repo you just cloned"

if [ "$EXISTING_GRAPH" = "yes" ]; then
  jq -n --arg dir "$TARGET_DIR" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ("The user just cloned `" + $dir + "`, and a graphify knowledge graph already exists at " + $dir + "/graphify-out/graph.json. Do NOT prompt the user about building one - the SessionStart hook will surface it on the next session, and you can use the mcp__graphify__* tools against the existing graph right now. If the clone is recent enough that source files may have changed since the graph was built, run `graphify update .` from `" + $dir + "` to refresh the AST portion (free, no LLM cost). Do not run a full `/graphify` rebuild unless the user explicitly asks for one.")
    }
  }' 2>/dev/null || true
else
  jq -n --arg dir "$TARGET_DIR" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ("The user just cloned `" + $dir + "`. No graphify knowledge graph is present in the cloned tree. Before doing anything else with this repo, ask the user via AskUserQuestion whether to build one. Recommend YES for repos with more than 50 files: the graph gives you structural awareness and saves Grep tokens on every later architecture question. If the user agrees, cd into `" + $dir + "` and run `/graphify` (or `graphify .` from the CLI). For repos larger than 2000 files, suggest `graphify cluster-only . --no-viz` (AST-only, no LLM extraction). If the user declines, proceed without it.")
    }
  }' 2>/dev/null || true
fi

exit 0
