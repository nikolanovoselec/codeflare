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
# ("Cloning into 'foo'..." line). The Bash tool exposes stdout under
# .tool_response.stdout; MCP tools (ctx_execute, ctx_batch_execute)
# return their captured stdout inside a content array per MCP spec
# (.tool_response.content[] | .text). Without the content-array
# fallback, ctx_execute clones fail target-dir extraction and the
# hook misfires the "no graph" branch even when one is present.
RESPONSE=$(echo "$INPUT" | jq -r '
  .tool_response.stdout
  // .tool_response.output
  // .tool_response.stderr
  // ((try (.tool_response.content // [] | map(.text? // empty)) catch []) | join("\n"))
  // empty
' 2>/dev/null) || true

TARGET_DIR=$(echo "$RESPONSE" | grep -oE "Cloning into '[^']+'" 2>/dev/null | head -n 1 | sed "s/Cloning into '//; s/'$//")

# Resolve TARGET_DIR against the hook envelope's cwd when it is relative.
# Claude Code populates `.cwd` for every hook fire regardless of tool. A
# relative TARGET_DIR (e.g. "codeflare") would otherwise be checked
# against the hook process's cwd, which is not the agent's cwd at clone
# time - the existence check silently fails for the common case of
# `cd <parent> && git clone <repo>`.
HOOK_CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || true
if [ -n "$TARGET_DIR" ] && [ -n "$HOOK_CWD" ]; then
  case "$TARGET_DIR" in
    /*) ;; # already absolute
    *) TARGET_DIR="$HOOK_CWD/$TARGET_DIR" ;;
  esac
fi

# Belt-and-braces: if stdout parsing failed entirely (unusual MCP
# response shape, filtered output, or stderr-only clone log), derive the
# clone target from the command itself. Parse the repo name out of the
# URL or slug, skipping over CLI flags. Combined with HOOK_CWD this
# catches existing graphify-out/ detection for clone shapes that bypass
# the stdout extraction.
#
# Flag handling: `git clone --depth 1 https://x/y` (canonical shallow
# clone) and `git clone --branch foo --depth 1 ...` must NOT pick the
# flag value as the target. We strip everything after `clone` and then
# take the first non-flag positional token. Long-opt forms with `=`
# (e.g. `--depth=1`) work without special-casing; bare flag-then-value
# pairs (`--depth 1`) require skipping the next token, which awk does
# by treating any leading-dash token as "skip and continue".
if [ -z "$TARGET_DIR" ] && [ -n "$HOOK_CWD" ]; then
  # Everything after `git clone` / `gh repo clone`. Use sed because grep
  # -oE captures only the matched substring, not the trailing args.
  ARGS=$(printf '%s' "$COMMAND" | sed -nE 's/.*(git[[:space:]]+clone|gh[[:space:]]+repo[[:space:]]+clone)[[:space:]]+(.*)/\2/p' | head -n 1)
  if [ -n "$ARGS" ]; then
    # Pick the first token that does NOT start with `-` and is not the
    # value of a flag that takes an argument. We approximate by skipping
    # any token preceded by a `-`-prefixed token (covers `--depth 1`,
    # `-o key`, etc). Conservative: false positives only cost a missed
    # detection, never a wrong one.
    DERIVED=$(printf '%s\n' "$ARGS" | awk '{
      skip_next = 0
      for (i = 1; i <= NF; i++) {
        if (skip_next) { skip_next = 0; continue }
        if ($i ~ /^-/) {
          # If the flag has no `=`, the next token is its value
          if ($i !~ /=/) skip_next = 1
          continue
        }
        print $i
        exit
      }
    }')
    # Strip command separators that may ride along on the chosen token
    # when the command is chained without surrounding whitespace.
    DERIVED=${DERIVED%%[;&|]*}
  fi
  if [ -n "$DERIVED" ]; then
    case "$DERIVED" in
      *://*|*@*:*|*.git) DERIVED=$(basename "$DERIVED" .git) ;;
      */*)               DERIVED=$(basename "$DERIVED") ;;
    esac
    case "$DERIVED" in
      /*) TARGET_DIR="$DERIVED" ;;
      *)  TARGET_DIR="$HOOK_CWD/$DERIVED" ;;
    esac
  fi
fi

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
#
# Three candidate paths get inspected because the agent's cwd at hook
# fire time is unpredictable when the user chains `cd <dir> && clone`
# (HOOK_CWD = parent, TARGET_DIR = parent/<dir>) versus `clone && cd
# <dir>` (HOOK_CWD = parent/<dir>, TARGET_DIR may resolve to
# parent/<dir>/<dir>, which doesn't exist):
#
#   1. $TARGET_DIR/graphify-out/graph.json    (original resolution)
#   2. $HOOK_CWD/graphify-out/graph.json      (agent already cd'd in)
#   3. git -C "$candidate" ls-files graphify-out/graph.json on any
#      branch (covers default-branch checkouts of a repo where the
#      graph is only committed on a non-default branch — e.g. the user
#      clones main but the graph lives on develop and they're about
#      to `git checkout develop`).
EXISTING_GRAPH=""
graph_present_in() {
  local d="$1"
  [ -z "$d" ] && return 1
  [ -f "$d/graphify-out/graph.json" ] && return 0
  # Branch-agnostic check: is graphify-out/graph.json committed on ANY
  # ref in this repo? If so, the agent only needs `git checkout <ref>`
  # to surface it. `git -C` requires the dir to be a git work tree.
  if [ -d "$d/.git" ] || git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$d" rev-list --all --remotes -- graphify-out/graph.json 2>/dev/null \
      | head -n 1 | grep -q . && return 0
  fi
  return 1
}
if graph_present_in "$TARGET_DIR" || graph_present_in "$HOOK_CWD"; then
  EXISTING_GRAPH="yes"
fi

[ -z "$TARGET_DIR" ] && TARGET_DIR="the repo you just cloned"

if [ "$EXISTING_GRAPH" = "yes" ]; then
  jq -n --arg dir "$TARGET_DIR" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ("The user just cloned `" + $dir + "`, and a graphify knowledge graph already exists at " + $dir + "/graphify-out/graph.json. Do NOT prompt the user about building one - the SessionStart hook will surface it on the next session, and you can use the mcp__graphify__* tools against the existing graph right now. If the clone is recent enough that source files may have changed since the graph was built, run `bash /home/user/.claude/plugins/graphify/scripts/safe-graphify-update.sh .` from `" + $dir + "` to refresh the AST portion (free, no LLM cost; the wrapper caps memory so a runaway rebuild cannot OOM the session). Do not run a full `/graphify` rebuild unless the user explicitly asks for one.")
    }
  }' 2>/dev/null || true
else
  jq -n --arg dir "$TARGET_DIR" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ("The user just cloned `" + $dir + "`. No graphify knowledge graph is present in the cloned tree. Before doing anything else with this repo, ask the user via AskUserQuestion a single YES/NO question: \"Build a graphify knowledge graph for `" + $dir + "`?\". Two options only: (a) Yes — invoke /graphify (Recommended for repos with more than 50 files; the graph gives you structural awareness and saves Grep tokens on every later architecture question). (b) No — proceed without it. DO NOT ask about build mode (AST-only vs Full) here — the graphify skill itself asks that question after it loads (see graphify SKILL.md note #8). Asking mode twice is a duplicate-question bug. If the user accepts, cd into `" + $dir + "` and invoke /graphify; the skill will surface the mode choice with the right corpus stats in context.")
    }
  }' 2>/dev/null || true
fi

exit 0
