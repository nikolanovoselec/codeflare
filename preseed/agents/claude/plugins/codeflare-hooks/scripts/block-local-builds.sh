#!/usr/bin/env bash
# PreToolUse hook: blocks local builds, test runs, type-checks, lints,
# and dev servers. The codeflare container is resource-constrained; CPU-intensive
# tooling crashes the session. Tests/builds run in CI (GitHub Actions),
# not locally.
#
# Detection covers Bash, mcp__context-mode__ctx_execute (shell), and
# mcp__context-mode__ctx_batch_execute. Pattern matches against the
# command body, so chained pipelines (`prep && npm test`) and
# subshells (`bash -c "npm test"`) are both caught.
#
# Bypass methods (USER-ONLY -- the assistant MUST NEVER create the
# sentinel; doing so is itself a violation of the no-local-builds rule):
#
#   - touch /tmp/local-build-bypass     # one-shot, consumed on use
#   - LOCAL_BUILD_BYPASS_FILE=...       # per-test sentinel path override
#                                       # (used by the test harness so
#                                       # tests stay hermetic from any
#                                       # real /tmp/local-build-bypass)
#
# The block emits a JSON `{decision: "block", reason: ...}` per the
# Claude Code PreToolUse hook contract, which surfaces as a STOP with
# the supplied reason text and prevents the tool call from executing.

# Read the full stdin payload (Claude Code passes tool invocation JSON).
INPUT=$(cat)

# Identify the tool. We only care about shell-bearing tools.
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
[ -z "$TOOL_NAME" ] && exit 0

# Extract the command body. Different MCP tools carry it under
# different keys; we normalise to one string for pattern matching.
case "$TOOL_NAME" in
  Bash)
    CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
    ;;
  mcp__context-mode__ctx_execute|mcp__context-mode__ctx_execute_file)
    # Only shell invocations can be local builds. JavaScript / Python
    # / etc. payloads can mention these strings in inert ways.
    LANG=$(echo "$INPUT" | jq -r '.tool_input.language // empty' 2>/dev/null)
    if [ "$LANG" != "shell" ]; then
      exit 0
    fi
    CMD=$(echo "$INPUT" | jq -r '.tool_input.code // empty' 2>/dev/null)
    ;;
  mcp__context-mode__ctx_batch_execute)
    # Each entry has its own .command; concatenate so a single batch
    # cannot smuggle a build by hiding it among other commands.
    CMD=$(echo "$INPUT" | jq -r '.tool_input.commands[]?.command // empty' 2>/dev/null)
    ;;
  *)
    exit 0
    ;;
esac

[ -z "$CMD" ] && exit 0

# Strip shell comments before pattern matching. A comment like
# "# typecheck via tsc has been my CI failure" mentions a build-tool
# binary innocently; we must not block on that. Awk strips everything
# from the first whitespace-prefixed `#` to end of line, leaving
# real commands intact. (We do NOT attempt to strip string literals;
# `echo "npm test"` will still block, which is fine — anyone running
# that command in a real shell IS executing it.)
CMD=$(printf '%s\n' "$CMD" | awk '{ sub(/[[:space:]]+#.*$/, ""); sub(/^#.*$/, ""); print }')
[ -z "$CMD" ] && exit 0

# USER-only bypass sentinel. One-shot: consumed on use so the bypass
# is intentional and visible (re-running the command requires creating
# the sentinel again, which only the user can do).
BYPASS_FILE="${LOCAL_BUILD_BYPASS_FILE:-/tmp/local-build-bypass}"
if [ -f "$BYPASS_FILE" ]; then
  rm -f "$BYPASS_FILE" 2>/dev/null || true
  exit 0
fi

# Pattern table. Each ERE pattern matches a local-build/test/lint
# binary AT START-OF-LINE (after optional leading whitespace). This
# is a heuristic — TRUE command-position detection requires a shell
# parser to distinguish `cd /foo && npm test` (real invocation) from
# `echo "cd /foo && npm test"` (string literal). The line-start anchor
# is the cheapest reliable bound: it correctly handles all standalone
# commands and multi-line scripts, while accepting two known misses:
#
#   1. Same-line chained commands (`git add && npm test`) — won't fire.
#      User typically runs the build standalone anyway.
#   2. Build commands inside heredoc / multi-line string literals that
#      happen to start at column 0 — false positive. Rare; bypass
#      with `touch /tmp/local-build-bypass` if it bites.
#
# CMDPOS = start-of-line plus optional leading whitespace.
CMDPOS='(^|\n)[[:space:]]*'

PATTERNS=(
  # Test runners (binaries that are the first word of a command).
  "${CMDPOS}vitest([[:space:]]|$)"
  "${CMDPOS}jest([[:space:]]|$)"
  "${CMDPOS}mocha([[:space:]]|$)"
  "${CMDPOS}pytest([[:space:]]|$)"
  "${CMDPOS}playwright[[:space:]]+test"
  "${CMDPOS}node[[:space:]]+--test"
  "${CMDPOS}bun[[:space:]]+test"
  # npm / npx wrappers. The `npx` form must permit arbitrary flags
  # between `npx` and the tool name (e.g. `npx -y oxlint@1.66.0`,
  # `npx -p pkg vitest`, `npx --no-install vitest`) — earlier the
  # pattern required `npx <tool>` immediately adjacent and a `-y`
  # slipped past, letting the assistant run oxlint locally.
  #
  # NOTE: use `.*` (not `[^\n]*`). Inside a POSIX bracket expression
  # `\n` is the two literal characters backslash and `n`, not the
  # newline escape — `[^\n]*` would falsely reject any flag containing
  # the letter `n` (e.g. `--no-install`, `--include-node`). `grep -E`
  # matches per-line, so newlines never appear in the haystack
  # mid-match, making `.*` the correct primitive here.
  "${CMDPOS}npx[[:space:]]+(.*[[:space:]])?(vitest|jest|mocha|tsc|oxlint|eslint|prettier|playwright)([[:space:]@]|$)"
  "${CMDPOS}npx[[:space:]]+(.*[[:space:]])?wrangler[[:space:]]+(dev|build|deploy)"
  "${CMDPOS}npm[[:space:]]+test([[:space:]]|$)"
  "${CMDPOS}npm[[:space:]]+run[[:space:]]+(test|build|dev|typecheck|lint|knip|check|e2e)"
  "${CMDPOS}pnpm[[:space:]]+test"
  "${CMDPOS}pnpm[[:space:]]+run[[:space:]]+(test|build|dev|typecheck|lint)"
  "${CMDPOS}yarn[[:space:]]+test"
  "${CMDPOS}yarn[[:space:]]+(build|dev|typecheck|lint)"
  # Direct compiler / linter / formatter binaries
  "${CMDPOS}tsc([[:space:]]|$)"
  "${CMDPOS}oxlint([[:space:]]|$)"
  "${CMDPOS}eslint([[:space:]]|$)"
  "${CMDPOS}prettier([[:space:]]|$)"
  # Wrangler dev/build/deploy (deploy goes through CI/Actions)
  "${CMDPOS}wrangler[[:space:]]+(dev|build|deploy)"
  # Cargo / Go builds and tests
  "${CMDPOS}cargo[[:space:]]+(test|build|check|run)"
  "${CMDPOS}go[[:space:]]+(test|build|run)"
)

for pat in "${PATTERNS[@]}"; do
  if echo "$CMD" | grep -qE "$pat"; then
    REASON="BLOCKED. No local builds, tests, type-checks, lints, or dev servers in this container -- heavy CPU use will freeze the session. Push to GitHub and let CI run. See ~/.claude/rules/no-local-builds.md. USER bypass: touch /tmp/local-build-bypass (one-shot, USER-only; the assistant must never create this)."
    jq -n --arg r "$REASON" '{decision:"block", reason:$r}' 2>/dev/null
    exit 0
  fi
done

exit 0
