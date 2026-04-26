#!/usr/bin/env bash
# PostToolUse hook — silently triggers review agents after git push completes.
# ONLY on projects that have opted into SDD by running /sdd init.
#
# PostToolUse (not PreToolUse) so the directive arrives in the SAME turn as the
# push result, not one turn late. The assistant acts on it immediately without
# needing to announce or acknowledge it to the user.
#
# Fires on every Bash call (no settings.json `if:` prefix gate — that would
# silently skip chained pipelines like `git add . && git push`, see #243).
# The case statement below is the canonical command-pattern filter.
#
# Vibe-coding mode: if sdd/ does not exist, emits nothing. Zero friction.
set -e

# Command gate — settings.json if-gate has a known bug (#20334) where
# PostToolUse matcher fires for unrelated tools. Filter in-script as workaround.
# Match `git push` anywhere in the command (not only at the start) so chained
# pipelines like `git add . && git commit -m '...' && git push` trigger
# enforcement too — they were silently bypassed by the prefix-only match (#243).
INPUT=$(cat)
# Cheap pre-filter: if the raw input doesn't even mention "git push" as a
# substring, skip without forking jq. PostToolUse fires on every Bash call,
# so avoiding the jq cold-start (~30-80ms on a 1-vCPU container) here saves
# seconds of cumulative blocking time over a long session.
case "$INPUT" in
  *"git push"*) ;; # candidate — fall through to precise jq parse
  *) exit 0 ;;     # not a push — skip
esac
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || true
case "$COMMAND" in
  *"git push"*) ;; # confirmed — continue
  *) exit 0 ;;     # raw match was inside a different field — skip
esac

# Vibe-coding gate.
if [ ! -d "sdd" ] || [ ! -f "sdd/README.md" ]; then
  exit 0
fi

# Silent directive — the assistant must act on this WITHOUT any user-facing
# output. No "launching agents", no "standing by", no acknowledgment. Just
# spawn the agents in the background and continue the conversation.
DIRECTIVE="[silent] SDD push detected. Execute NOW without user-facing output:"
DIRECTIVE="$DIRECTIVE 1) code-reviewer in background (parallel, source lane)."
DIRECTIVE="$DIRECTIVE 2) spec-reviewer in background FIRST (sdd/ lane)."
DIRECTIVE="$DIRECTIVE 3) doc-updater in background SECOND, after spec-reviewer (docs/ lane)."
DIRECTIVE="$DIRECTIVE Each agent fetches the full pushed diff itself via 'git diff origin/main...HEAD' — do NOT paste diffs into the prompt; just give a one-line task framing."
DIRECTIVE="$DIRECTIVE Do NOT mention these agents to the user. Do NOT print status updates about them."

jq -n --arg ctx "$DIRECTIVE" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
exit 0
