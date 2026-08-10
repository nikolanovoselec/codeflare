#!/usr/bin/env bash
# PostToolUse hook — triggers the review lanes at the PR boundary.
# ONLY on projects that have opted into SDD by running /sdd init.
#
# Trigger model: every executable `git` or `gh` command is a cheap candidate.
# The existing structural tokenizer marks `git push` and `gh pr create` for
# automatic delivery; other commands require explicit user confirmation.
# Eligibility comes only from authoritative state: the normal checkout's current
# branch must have an open main/master/develop PR whose full head equals local
# HEAD and differs from that PR's checkpoint. Detached HEAD, nonstandard
# worktrees, unsynchronized heads, and unchanged acknowledged heads are inert.
#
# No sentinel-file bypass here. The sibling enforce-review-spawn.sh hook owns
# the one-shot /tmp/review-bypass sentinel so bypass semantics stay centralized.
#
# PostToolUse (not PreToolUse) so the directive arrives in the SAME
# turn as the push/create result, and the assistant acts on it immediately.
#
# The round is user-visible AND blocking: the directive requires an overview
# before the lanes run, then an immediate end of turn, then a triage result
# once every lane has returned. It previously required silence, which
# contradicted the constitution's review-result handoff gate and made an
# autofix look like an unexplained edit. The end-of-turn is what keeps the
# round legible: a lane result landing in the middle of unrelated work gets
# interleaved with it, and the user loses the thread of what was reviewed.
#
# The triage table is Pi's shape verbatim (REVIEW_TRIAGE_HEADER/DIVIDER in
# extensions/review-helpers.ts), so both runtimes publish one comparable
# artifact. Both runtimes end the triage turn without mutations; Pi settled
# enforcement and Claude's Stop hook then inject the separate FIX follow-up.
#
# Vibe-coding mode: if sdd/ does not exist, emits nothing. Zero friction.
#
# Fail-safe: any unexpected error → exit 0 (never lock users out).
set +e

INPUT=$(cat 2>/dev/null) || exit 0

# Extract the command(s) from any of three supported tool-input shapes:
#
#   1. Bash tool             → .tool_input.command           (string)
#   2. mcp__*__ctx_execute   → .tool_input.code              (string, only when
#                              .tool_input.language == "shell")
#   3. mcp__*__ctx_batch_execute → .tool_input.commands[].command (array of
#                              objects; concatenated with `; ` for one structural pass)
#
# Issue #317: when context-mode's enforce-ctx-mode.sh denies `gh pr create` /
# `gh pr merge` in Bash, agents retry through MCP shell tools. Without this
# multi-shape parsing, candidate parsing was applied to a JSON shape that has
# no `.tool_input.command` field, COMMAND was empty, and the review-pipeline
# directive silently never fired for the redirected invocation.
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

# Any structurally executable git or gh command is a candidate. Command syntax
# never decides eligibility; the checked-out branch and GitHub PR state do.
BOUNDARY_KIND=$(node - "$COMMAND" <<'NODE'
const text = process.argv[2];
const controls = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{']);
const prefixes = new Set(['command', 'builtin', 'exec', 'sudo', 'time', 'env']);
function heredocDeclarations(line) {
  const declarations = [];
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index] || '';
    if (quote) {
      if (char === '\\' && quote === '"') index++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === '\\') { index++; continue; }
    if (char !== '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue;
    let cursor = index + 2;
    const stripTabs = line[cursor] === '-';
    if (stripTabs) cursor++;
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor++;
    let delimiter = '', delimiterQuote = '';
    while (cursor < line.length) {
      const token = line[cursor] || '';
      if (delimiterQuote) {
        if (token === delimiterQuote) delimiterQuote = '';
        else if (token === '\\' && delimiterQuote === '"' && cursor + 1 < line.length) delimiter += line[++cursor] || '';
        else delimiter += token;
      } else if (token === "'" || token === '"') delimiterQuote = token;
      else if (token === '\\' && cursor + 1 < line.length) delimiter += line[++cursor] || '';
      else if (/\s/.test(token) || ';&|<>'.includes(token)) break;
      else delimiter += token;
      cursor++;
    }
    if (delimiter) declarations.push({ delimiter, stripTabs });
    index = cursor - 1;
  }
  return declarations;
}
function stripHeredocs(value) {
  const out = [], pending = [];
  for (const line of value.split(/\r?\n/)) {
    if (pending.length) {
      const active = pending[0];
      const candidate = active.stripTabs ? line.replace(/^\t+/, '') : line;
      if (candidate === active.delimiter) pending.shift();
      continue;
    }
    out.push(line);
    pending.push(...heredocDeclarations(line));
  }
  return out.join('\n');
}
let found = false;
let kind = 'none';
function classify(tool, args) {
  const takesValue = tool === 'git'
    ? new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix'])
    : new Set(['-R', '--repo', '--hostname', '--config']);
  let index = 0;
  while (index < args.length) {
    const value = args[index] || '';
    if (value === '--') { index++; break; }
    if (!value.startsWith('-')) break;
    if (takesValue.has(value) && !value.includes('=')) index++;
    index++;
  }
  const command = args.slice(index);
  const next = tool === 'git' && command[0] === 'push'
    ? 'push'
    : tool === 'gh' && command[0] === 'pr' && command[1] === 'create'
      ? 'pr-create'
      : 'prompt';
  if (next !== 'prompt' || kind === 'none') kind = next;
}
function scan(source) {
  let word = '', command = true, prefix = false, tool = '', args = [];
  const finish = () => {
    if (!word) return;
    const value = word; word = '';
    if (!command) {
      if (tool) args.push(value);
      return;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value) || controls.has(value)) return;
    if (value === 'git' || value === 'gh') { found = true; tool = value; command = false; return; }
    if (prefix && value.startsWith('-')) return;
    prefix = prefixes.has(value); command = prefix;
  };
  const boundary = () => {
    finish();
    if (tool) classify(tool, args);
    command = true; prefix = false; tool = ''; args = [];
  };
  function substitution(start) {
    let depth = 1, quote = '', escaped = false;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\' && quote !== "'") { escaped = true; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) { scan(source.slice(start, i)); return i; }
    }
    return source.length;
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "'") { for (i++; i < source.length && source[i] !== "'"; i++) word += source[i]; continue; }
    if (c === '"') {
      for (i++; i < source.length && source[i] !== '"'; i++) {
        if (source[i] === '\\') word += source[++i] || '';
        else if (source[i] === '$' && source[i + 1] === '(') i = substitution(i + 2);
        else if (source[i] === '`') { const end = source.indexOf('`', i + 1); if (end < 0) break; scan(source.slice(i + 1, end)); i = end; }
        else word += source[i];
      }
      continue;
    }
    if (c === '\\') { word += source[++i] || ''; continue; }
    if (c === '$' && source[i + 1] === '(') { i = substitution(i + 2); continue; }
    if (c === '`') { const end = source.indexOf('`', i + 1); if (end < 0) break; scan(source.slice(i + 1, end)); i = end; continue; }
    if (/\s/.test(c) || ';&|(){}'.includes(c)) { finish(); if (';&|(){}\n\r'.includes(c)) boundary(); continue; }
    word += c;
  }
  boundary();
}
scan(stripHeredocs(text));
console.log(kind);
process.exit(found ? 0 : 1);
NODE
) || exit 0
[ "$BOUNDARY_KIND" != "none" ] || exit 0

[ -d sdd ] && [ -f sdd/README.md ] || exit 0
[ -d .git ] || exit 0

_config_file=$(test -f sdd/spec/config.yml && echo sdd/spec/config.yml || echo sdd/config.yml)
_triage_init=$(test -f sdd/spec/.init-triage.md && echo sdd/spec/.init-triage.md || echo sdd/.init-triage.md)
if grep -q '^transition:[[:space:]]*true' "$_config_file" 2>/dev/null \
   && [ -f "$_triage_init" ] \
   && grep -qiE '^\*\*Status:\*\*[[:space:]]+open\b' "$_triage_init" 2>/dev/null; then
  exit 0
fi

CURRENT=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
LOCAL_HEAD=$(git rev-parse HEAD 2>/dev/null) || exit 0
. "$(dirname "$0")/lib/gh-pr-state.sh" 2>/dev/null || exit 0
PR_INFO=$(gh_pr_state "$CURRENT") || exit 0
PR_STATE=$(printf '%s' "$PR_INFO" | jq -r '.state // empty' 2>/dev/null)
PR_BASE=$(printf '%s' "$PR_INFO" | jq -r '.baseRefName // empty' 2>/dev/null)
PR_NUMBER=$(printf '%s' "$PR_INFO" | jq -r '.number // empty' 2>/dev/null)
CURRENT_PR_HEAD=$(printf '%s' "$PR_INFO" | jq -r '.headRefOid // empty' 2>/dev/null)
[ "$PR_STATE" = "OPEN" ] || exit 0
case "$PR_BASE" in main|master|develop) ;; *) exit 0 ;; esac
printf '%s' "$PR_NUMBER" | grep -Eq '^[0-9]+$' || exit 0
printf '%s' "$CURRENT_PR_HEAD" | grep -Eq '^[0-9a-f]{40}$' || exit 0
[ "$LOCAL_HEAD" = "$CURRENT_PR_HEAD" ] || exit 0
GIT_DIR=$(git rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
[ -d "$GIT_DIR" ] || exit 0
ACK_FILE="$GIT_DIR/sdd-review-ack-pr-$PR_NUMBER"
LAST_ACK_PR_HEAD=""
if [ -f "$ACK_FILE" ]; then
  LAST_ACK_PR_HEAD=$(cat "$ACK_FILE" 2>/dev/null)
elif [ -f "$GIT_DIR/sdd-last-ack-pr-head" ]; then
  LAST_ACK_PR_HEAD=$(cat "$GIT_DIR/sdd-last-ack-pr-head" 2>/dev/null)
fi
case "$LAST_ACK_PR_HEAD" in
  *[!0-9a-f]*|"") LAST_ACK_PR_HEAD="" ;;
  *) [ "${#LAST_ACK_PR_HEAD}" -eq 40 ] || LAST_ACK_PR_HEAD="" ;;
esac
[ "$LAST_ACK_PR_HEAD" != "$CURRENT_PR_HEAD" ] || exit 0
PLAN_FILE="$GIT_DIR/sdd-review-plan-pr-$PR_NUMBER"
[ "$(cat "$PLAN_FILE" 2>/dev/null)" != "$CURRENT_PR_HEAD" ] || exit 0

# ---------------------------------------------------------------------------
# Lane classification - emit a directive naming ONLY the required lanes
# instead of always demanding code+spec+doc. The classifier is the same
# function the Stop hook uses, so the in-turn nudge and the turn-end gate
# agree on which agents are needed. Without this, a doc-only push made
# the nudge tell the agent to spawn all three even though the Stop hook
# would silently exclude code-reviewer and spec-reviewer - wasted tokens
# on the lane mismatch. See lib/lane-classifier.sh for the contract.
#
# Source the helper; bail out of lane-aware emission if it's missing
# (defensive: fail back to the legacy "all three" directive so a stale
# install never silently produces an under-specified directive).
# ---------------------------------------------------------------------------
LANE_CLASSIFIER_LOADED=0
. "$(dirname "$0")/lib/lane-classifier.sh" 2>/dev/null && LANE_CLASSIFIER_LOADED=1
REQUIRED_LANES="code-reviewer spec-reviewer doc-updater"
if [ "$LANE_CLASSIFIER_LOADED" = "1" ]; then
  REQUIRED_LANES=$(compute_required_lanes "$LAST_ACK_PR_HEAD" "$CURRENT_PR_HEAD")
fi

# No lanes required - diff between LAST_ACK and CURRENT_PR_HEAD is empty
# under the classifier's rules (typically: same SHA already acked).
# Skip emission entirely; the Stop hook will likewise short-circuit at
# turn end.
[ -z "$REQUIRED_LANES" ] && exit 0

# ---------------------------------------------------------------------------
# Emit silent directive — assistant must act WITHOUT user-facing output.
# ---------------------------------------------------------------------------
CONTEXT="authoritative state change on checked-out PR branch"

needs_code=0; needs_spec=0; needs_doc=0
case " $REQUIRED_LANES " in *" code-reviewer "*) needs_code=1 ;; esac
case " $REQUIRED_LANES " in *" spec-reviewer "*) needs_spec=1 ;; esac
case " $REQUIRED_LANES " in *" doc-updater "*) needs_doc=1 ;; esac

if [ "$BOUNDARY_KIND" = "prompt" ]; then
  DIRECTIVE="SDD $CONTEXT detected outside a push or PR creation. FIRST use AskUserQuestion to ask whether the user wants review and CI for PR #$PR_NUMBER at exact head $CURRENT_PR_HEAD. Offer 'Launch review' and 'Acknowledge without review'. If the question is cancelled, ask it again until the user explicitly chooses; cancellation neither launches nor acknowledges. If the user chooses acknowledge, create the existing /tmp/review-bypass sentinel and end the turn; the Stop hook will revalidate and acknowledge this exact head. If the user chooses launch, continue with the review instructions below."
else
  DIRECTIVE="SDD $CONTEXT detected after $BOUNDARY_KIND. Execute NOW, and keep the user informed as described at the end of this directive."
fi

# Lane-aware composition. All review lanes are report-only and return findings to the
# root session, so they run in parallel without shared-file writes or ordering dependency.
# Pure doc-only or spec-only pushes simply demand fewer lanes.
if [ "$needs_code" = "1" ] && [ "$needs_spec" = "1" ] && [ "$needs_doc" = "1" ]; then
  DIRECTIVE="$DIRECTIVE Lanes: code-reviewer (source lane), spec-reviewer (sdd/ lane), doc-updater (docs/ lane) - all three."
elif [ "$needs_spec" = "1" ] && [ "$needs_doc" = "1" ]; then
  DIRECTIVE="$DIRECTIVE Lanes: spec-reviewer (sdd/ lane) and doc-updater (docs/ lane) - both. Code lane silently excluded by Stop hook (no source files in diff)."
elif [ "$needs_doc" = "1" ] && [ "$needs_code" = "0" ] && [ "$needs_spec" = "0" ]; then
  DIRECTIVE="$DIRECTIVE Lanes: doc-updater (docs/ lane) only. Code and spec lanes silently excluded by Stop hook (diff is documentation-only)."
elif [ "$needs_code" = "1" ] && [ "$needs_doc" = "1" ] && [ "$needs_spec" = "0" ]; then
  DIRECTIVE="$DIRECTIVE Lanes: code-reviewer (source lane) and doc-updater (docs/ lane) - both. Spec lane silently excluded by Stop hook (no sdd/ file changed and no @impl anchor there cites a changed file, so that lane owns nothing in this diff)."
elif [ "$needs_code" = "1" ] && [ "$needs_spec" = "1" ] && [ "$needs_doc" = "0" ]; then
  DIRECTIVE="$DIRECTIVE Lanes: code-reviewer (source lane) and spec-reviewer (sdd/ lane) - both. Doc lane silently excluded by Stop hook (no documentation/ file changed and no @impl anchor there cites a changed file)."
elif [ "$needs_code" = "1" ] && [ "$needs_spec" = "0" ] && [ "$needs_doc" = "0" ]; then
  DIRECTIVE="$DIRECTIVE Lanes: code-reviewer (source lane) only. Spec and doc lanes silently excluded by Stop hook (neither surface changed and no @impl anchor in either tree cites a changed file, so both lanes would open, find nothing they own, and exit)."
else
  # Defensive: any unexpected combination falls back to the all-three parallel directive.
  # The Stop hook is still the source of truth and will correct any over-spawn by silently
  # acking the SHA when the required lanes' agents are spawned.
  DIRECTIVE="$DIRECTIVE Lanes: code-reviewer (source lane), spec-reviewer (sdd/ lane), doc-updater (docs/ lane) - all three."
fi

# Transport: each lane runs as a headless `claude -p` subprocess, NOT as an Agent
# subagent. A subagent inherits CLAUDE.md, every ~/.claude/rules/*.md, MEMORY.md
# and the SessionStart blocks with no per-agent way to exclude them - a measured
# 20,513-token floor before the lane does any work. run-review-lane.sh replaces
# the system prompt and prunes the tool schemas, which the CLI supports and
# subagent frontmatter does not, taking that floor to ~1,533. The Stop hook
# accepts either transport, so a lane spawned the old way still acks.
# Must agree with run-review-lane.sh's own resolution: it honours
# CLAUDE_CONFIG_DIR, so hardcoding $HOME/.claude here would emit a directive
# pointing at a path that does not exist under a relocated config, every lane
# would exit non-zero, and the Bash envelope would still satisfy the gate's
# spawn match - acking a head whose review never ran.
RUNNER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/codeflare-hooks/scripts/run-review-lane.sh"
if [ -n "$LAST_ACK_PR_HEAD" ] && [ -n "$CURRENT_PR_HEAD" ] && git merge-base --is-ancestor "$LAST_ACK_PR_HEAD" "$CURRENT_PR_HEAD" 2>/dev/null; then
  LANE_SCOPE="--range $LAST_ACK_PR_HEAD..$CURRENT_PR_HEAD"
  DIRECTIVE="$DIRECTIVE Each lane reviews ONLY the incremental diff since the last reviewed head ($LAST_ACK_PR_HEAD..$CURRENT_PR_HEAD), not the full PR diff."
elif [ -n "$PR_BASE" ]; then
  LANE_SCOPE="--base $PR_BASE"
  DIRECTIVE="$DIRECTIVE Each lane reviews the full PR diff against origin/$PR_BASE (no prior review base)."
else
  # PR_BASE is allowed to be empty upstream (it fails open to enforcement).
  # Emitting `--base ` with no value would hand the runner a dangling flag.
  LANE_SCOPE=""
  DIRECTIVE="$DIRECTIVE Each lane reviews the full PR diff against its default base (base branch unresolved)."
fi
DIRECTIVE="$DIRECTIVE Run each required lane as a BACKGROUND Bash call, all lanes issued in ONE message so they execute concurrently: 'bash $RUNNER --lane <name> $LANE_SCOPE' with run_in_background: true. Foreground Bash calls are serialised by the harness, which would make the lanes sequential and trebles wall-clock. Collect each lane's structured report from its background output when it completes. Do NOT spawn review subagents and do NOT paste diffs into the command - the lane gathers its own evidence."
DIRECTIVE="$DIRECTIVE Immediately after launching reviewers, invoke the existing ci-monitoring skill exactly once for branch $CURRENT at exact head $CURRENT_PR_HEAD; its detached monitor is independent of review acknowledgement and is the final launch."
DIRECTIVE="$DIRECTIVE Reviewers do not write project or triage files. The root evaluates findings, persists reports, and applies only legitimate fixes."
# VISIBILITY. This replaces an earlier instruction to run the round silently.
# That instruction also contradicted the constitution's review-result handoff
# gate, which has always required a user-facing summary; the round is the
# user's to see, and a silent round makes an autofix look like an unexplained
# edit. Lane names are deliberately not written here: several emission tests
# assert the directive carries no lane literal outside its Lanes: line.
DIRECTIVE="$DIRECTIVE VISIBILITY AND SEQUENCING (binding). BEFORE launching, print a short overview for the user: which lanes are about to run, why each other lane was excluded, and the exact range under review. Issue the lane calls in that same message. Immediately after those calls, launch CI as the final launch. Once CI is launched, END YOUR TURN. While the lanes and CI are running do NOTHING else: no further tool calls, no unrelated edits, no other task started. WAIT until every required lane has returned, then publish ONE triage table in exactly this shape, same columns and same order: '| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |' over '|---|---|---|---|---|'. One row per finding across all lanes. A fully clean round publishes the header and divider with no synthetic clean-lane rows; lane completion already proves the round happened and the Stop hook can acknowledge that empty finding table. For every finding: verify it is evidence-backed and in scope; judge the finding separately from its proposed fix; reject unsupported or overengineered proposals; prefer the smallest correction that reuses existing machinery. A rejected row states its cause in VALIDITY - never a deferral. After publishing the table, make no file or Git changes and end the turn immediately. The Stop hook acknowledges this head and injects the separate FIX directive next turn."

printf '%s\n' "$CURRENT_PR_HEAD" > "$PLAN_FILE" 2>/dev/null || true
jq -n --arg ctx "$DIRECTIVE" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
exit 0
