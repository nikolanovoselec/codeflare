#!/usr/bin/env bash
# PreToolUse hook - blocks git commits / GitHub surfaces carrying AI attribution.
#
# Registered in settings.json on two matcher entries covering three tool names:
#   1. matcher "Bash"                          (with `"if": "Bash(git *)"` /
#                                               `"if": "Bash(gh *)"` predicates)
#   2. matcher "mcp__context-mode__ctx_execute|mcp__context-mode__ctx_batch_execute"
#      (pipe-alternated regex covering both ctx-mode shell and batch tools)
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
#   1. Bash tool                  -> .tool_input.command          (string)
#   2. mcp__*__ctx_execute        -> .tool_input.code             (string, only
#                                   when .tool_input.language == "shell";
#                                   defense in depth - the MCP server enforces
#                                   language as a required schema field, so a
#                                   missing language field silently exits this
#                                   branch and the hook allows the call. If
#                                   the upstream schema ever stops requiring
#                                   language, this gate falls open and so does
#                                   the matching gate in enforce-review-spawn.sh.)
#   3. mcp__*__ctx_batch_execute  -> .tool_input.commands[].command (array of
#                                   objects; concatenated with `"; "` so the
#                                   existing per-command regex matches each.
#                                   The separator is load-bearing: changing it
#                                   could let a single regex span two entries
#                                   and produce a false-positive across an
#                                   entry boundary - test fixtures in
#                                   host/__tests__/block-attributed-commits.test.js
#                                   pin the current join semantics.)
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
# Anything not in this set is read-only or harmless - exit immediately.
#
# Covered:
#   git commit[.*]          -- all commit forms (--amend, -F, -m, etc.)
#   git merge [.*]-m[.*]    -- merge with a -m message flag
#   git tag [.*]-[am]       -- annotated tag with message
#   git notes add[.*]       -- commit notes
#   gh pr create|edit|comment|review|merge
#   gh issue create|edit|comment
#   gh release create|edit
if ! node - "$COMMAND" <<'NODE'
const source = process.argv[2];
const commands = [];
let words = [], word = '', quote = '', escaped = false;
const finishWord = () => { if (word) { words.push(word); word = ''; } };
const finishCommand = () => { finishWord(); if (words.length) commands.push(words); words = []; };
for (let index = 0; index < source.length; index++) {
  const char = source[index];
  if (escaped) { word += char; escaped = false; continue; }
  if (char === '\\' && quote !== "'") { escaped = true; continue; }
  if (quote) { if (char === quote) quote = ''; else word += char; continue; }
  if (char === "'" || char === '"') { quote = char; continue; }
  if (char === '\n' || char === '\r') { finishCommand(); continue; }
  if (/\s/.test(char)) { finishWord(); continue; }
  if (';&|(){}'.includes(char)) {
    finishCommand();
    if ((char === '&' || char === '|') && source[index + 1] === char) index++;
    continue;
  }
  word += char;
}
finishCommand();
const prefixes = new Set(['command', 'builtin', 'exec', 'sudo', 'time', 'env']);
const executableIndex = (argv, executable) => {
  let index = 0;
  while (index < argv.length) {
    const value = argv[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value)) { index++; continue; }
    if (value === executable) return index;
    if (!prefixes.has(value)) return -1;
    index++;
    while ((argv[index] || '').startsWith('-')) index++;
  }
  return -1;
};
const operation = (argv, executable) => {
  const executableAt = executableIndex(argv, executable);
  if (executableAt < 0) return { name: undefined, index: -1 };
  const takesValue = executable === 'git'
    ? new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix'])
    : new Set(['-R', '--repo', '--hostname', '--config']);
  let index = executableAt + 1;
  while (index < argv.length) {
    const value = argv[index];
    if (value === '--') return { name: argv[index + 1], index: index + 1 };
    if (!value.startsWith('-')) return { name: value, index };
    if (takesValue.has(value) && !value.includes('=')) index++;
    index++;
  }
  return { name: undefined, index: -1 };
};
const guarded = commands.some((argv) => {
  const git = operation(argv, 'git');
  if (git.name === 'commit') return true;
  if (git.name === 'merge') return argv.slice(git.index + 1).some((value) => value === '-m' || /^-m.+/.test(value) || value.startsWith('--message='));
  if (git.name === 'tag') return argv.slice(git.index + 1).some((value) => value === '-a' || value === '-m' || /^-m.+/.test(value) || value === '--annotate' || value.startsWith('--message='));
  if (git.name === 'notes') return argv[git.index + 1] === 'add';
  const gh = operation(argv, 'gh');
  const subcommand = argv[gh.index + 1];
  return (gh.name === 'pr' && ['create', 'edit', 'comment', 'review', 'merge'].includes(subcommand))
    || (gh.name === 'issue' && ['create', 'edit', 'comment'].includes(subcommand))
    || (gh.name === 'release' && ['create', 'edit'].includes(subcommand));
});
process.exit(guarded ? 0 : 1);
NODE
then
  exit 0
fi

# Check for attribution SIGNATURES (case insensitive). Match only genuine
# attribution markers - a co-author trailer, the bot noreply email, a
# "generated with ... claude" footer, or attribution emoji. Deliberately NOT
# bare model/product names ("claude code", "claude opus"): those false-positive
# on legitimate prose (a PR titled "... Claude Code parity ...") and on git/gh
# commands that name preseed/agents/claude/ paths.
if echo "$COMMAND" | grep -Eiq "(co-authored-by|noreply@anthropic|generated with.*claude|🤖)"; then
  jq -n '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Attribution detected. Retry without Co-Authored-By, a bot noreply email, a generated-with footer, or attribution emoji. Use a plain message/title/body."
    }
  }'
  exit 0
fi

exit 0
