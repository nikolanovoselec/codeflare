#!/usr/bin/env bash
# PreToolUse hook: blocks local builds, test runs, type-checks, lints,
# and dev servers. The codeflare container has 1 vCPU; CPU-intensive
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
    CMD=$(echo "$INPUT" | jq -r '.tool_input.commands[]?.command // empty' 2>/dev/null | tr '\n' ';')
    ;;
  *)
    exit 0
    ;;
esac

[ -z "$CMD" ] && exit 0

# USER-only bypass sentinel. One-shot: consumed on use so the bypass
# is intentional and visible (re-running the command requires creating
# the sentinel again, which only the user can do).
BYPASS_FILE="${LOCAL_BUILD_BYPASS_FILE:-/tmp/local-build-bypass}"
if [ -f "$BYPASS_FILE" ]; then
  rm -f "$BYPASS_FILE" 2>/dev/null || true
  exit 0
fi

# Pattern table. Each ERE pattern represents one local-build/test/lint
# class. Anchored against `\b` word boundaries where reasonable so a
# variable named `tsc_output` does not match the `tsc` compiler.
#
# Keep this list literal-heavy and unambiguous. False positives in CI
# / git / scripts that happen to contain these words are filtered by
# the boundary anchors; if a future shape needs a carve-out, prefer
# tightening the pattern over adding a regex-based allow-list (which
# would inevitably drift).
PATTERNS=(
  # Test runners
  '(^|[^a-zA-Z0-9_/-])vitest($|[[:space:]])'
  '(^|[^a-zA-Z0-9_/-])jest($|[[:space:]])'
  '(^|[^a-zA-Z0-9_/-])mocha($|[[:space:]])'
  '(^|[^a-zA-Z0-9_/-])pytest($|[[:space:]])'
  '(^|[^a-zA-Z0-9_/-])playwright[[:space:]]+test'
  '(^|[^a-zA-Z0-9_/-])node[[:space:]]+--test'
  '(^|[^a-zA-Z0-9_/-])bun[[:space:]]+test'
  # npm / npx wrappers around test/build/dev/lint/typecheck
  'npx[[:space:]]+vitest'
  'npx[[:space:]]+jest'
  'npx[[:space:]]+mocha'
  'npx[[:space:]]+tsc'
  'npx[[:space:]]+oxlint'
  'npx[[:space:]]+eslint'
  'npx[[:space:]]+prettier'
  'npx[[:space:]]+playwright'
  'npx[[:space:]]+wrangler[[:space:]]+(dev|build|deploy)'
  'npm[[:space:]]+test([[:space:]]|$)'
  'npm[[:space:]]+run[[:space:]]+(test|build|dev|typecheck|lint|knip|check|e2e)'
  'pnpm[[:space:]]+test'
  'pnpm[[:space:]]+run[[:space:]]+(test|build|dev|typecheck|lint)'
  'yarn[[:space:]]+test'
  'yarn[[:space:]]+(build|dev|typecheck|lint)'
  # Direct compiler / linter / formatter binaries
  '(^|[^a-zA-Z0-9_/-])tsc($|[[:space:]])'
  '(^|[^a-zA-Z0-9_/-])oxlint($|[[:space:]])'
  '(^|[^a-zA-Z0-9_/-])eslint($|[[:space:]])'
  '(^|[^a-zA-Z0-9_/-])prettier($|[[:space:]])'
  # Wrangler dev/build/deploy (deploy goes through CI/Actions)
  'wrangler[[:space:]]+(dev|build|deploy)'
  # Cargo / Go builds and tests
  'cargo[[:space:]]+(test|build|check|run)'
  'go[[:space:]]+(test|build|run)'
)

for pat in "${PATTERNS[@]}"; do
  if echo "$CMD" | grep -qE "$pat"; then
    REASON="GO FUCK YOURSELF. No local builds, tests, type-checks, lints, or dev servers in this container -- 1 vCPU will freeze the session. Push to GitHub and let CI run. See ~/.claude/rules/no-local-builds.md. USER bypass: touch /tmp/local-build-bypass (one-shot, USER-only; the assistant must never create this)."
    jq -n --arg r "$REASON" '{decision:"block", reason:$r}' 2>/dev/null
    exit 0
  fi
done

exit 0
