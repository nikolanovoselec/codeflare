#!/usr/bin/env bash
# PreToolUse hook — reminds agent to run review agents alongside git push,
# but ONLY on projects that have opted into SDD by running /sdd init.
#
# This script is gated by `"if": "Bash(git push*)"` in settings.json, so it
# only runs for actual git push commands — no need to re-check inside.
#
# Vibe-coding mode: if sdd/ does not exist in the project, this hook emits
# nothing. The push proceeds without any review agents. SDD opt-in is binary:
# either the project has an sdd/ folder (full review workflow: code-reviewer +
# spec-reviewer FIRST + doc-updater SECOND) or it doesn't (zero friction).
set -e

# Vibe-coding gate: if the project is not SDD-bootstrapped, emit nothing.
# The push proceeds without any review agents. No reminder means the assistant
# does not spawn code-reviewer, spec-reviewer, or doc-updater for this push.
if [ ! -d "sdd" ] || [ ! -f "sdd/README.md" ]; then
  exit 0
fi

# SDD-bootstrapped project: emit the full three-agent reminder.
# Execution order:
#   1. code-reviewer runs in parallel (own lane: source code).
#   2. spec-reviewer FIRST among the docs/spec agents (it may move REQs).
#   3. doc-updater SECOND, sequentially AFTER spec-reviewer completes — they
#      share files across sdd/+documentation/ so parallel runs would race on
#      shared filesystem state and produce dangling cross-links.
REMINDER="IMPORTANT: git-workflow rule requires running review agents alongside this push. The project has an sdd/ folder, so the full three-agent workflow applies. Launch these background agents NOW (in this same response):"
REMINDER="$REMINDER 1) code-reviewer agent on the changes being pushed (runs in parallel — own lane: source code)."
REMINDER="$REMINDER 2) spec-reviewer agent FIRST to update sdd/."
REMINDER="$REMINDER 3) doc-updater agent SECOND, AFTER spec-reviewer completes — they share files in sdd/+documentation/ so they MUST run sequentially, never in parallel."
REMINDER="$REMINDER Also start CI monitoring in background after push completes."

jq -n --arg ctx "$REMINDER" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
exit 0
