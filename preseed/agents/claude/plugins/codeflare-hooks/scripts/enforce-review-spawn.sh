#!/usr/bin/env bash
# Stop hook: stamp exact completion after current-session terminal review + triage.
set +e

INPUT=$(cat 2>/dev/null) || exit 0
[ "$(printf '%s' "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)" = "Stop" ] || exit 0
[ -z "$(printf '%s' "$INPUT" | jq -r '.agent_type // empty' 2>/dev/null)" ] || exit 0
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
[ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ] || exit 0
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] || CWD=$PWD
REPO=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -f "$REPO/sdd/README.md" ] || exit 0

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
STATE_HELPER="$SCRIPT_DIR/lib/review-completion-state.mjs"
STATUS=$(node "$STATE_HELPER" status --cwd "$REPO" 2>/dev/null) || exit 0
[ "$(printf '%s' "$STATUS" | jq -r '.eligible // false' 2>/dev/null)" = "true" ] || exit 0
[ "$(printf '%s' "$STATUS" | jq -r '.completion.status // "missing"' 2>/dev/null)" != "complete" ] || exit 0
PR_NUMBER=$(printf '%s' "$STATUS" | jq -r '.identity.pr // empty' 2>/dev/null)
HEAD=$(printf '%s' "$STATUS" | jq -r '.identity.head // empty' 2>/dev/null)
REPOSITORY=$(printf '%s' "$STATUS" | jq -r '.identity.repository // empty' 2>/dev/null)
ANCESTOR=$(printf '%s' "$STATUS" | jq -r '.ancestor.head // empty' 2>/dev/null)
printf '%s' "$PR_NUMBER" | grep -Eq '^[0-9]+$' || exit 0
printf '%s' "$HEAD" | grep -Eq '^[0-9a-f]{40}$' || exit 0
. "$SCRIPT_DIR/lib/lane-classifier.sh" 2>/dev/null || exit 0
REQUIRED_LANES=$(compute_required_lanes "$ANCESTOR" "$HEAD")
[ -n "$REQUIRED_LANES" ] || REQUIRED_LANES="code-reviewer spec-reviewer doc-updater"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // .sessionId // .transcript_path // "root"' 2>/dev/null)
SESSION_KEY=$(printf '%s' "$SESSION_ID" | cksum | awk '{print $1}')
SESSION_DIR="${CODEFLARE_REVIEW_SESSION_DIR:-/run/codeflare/review-session}"
OFFSET_FILE="$SESSION_DIR/$SESSION_KEY.offset"
OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null)
case "$OFFSET" in ''|*[!0-9]*) exit 0 ;; esac

ANALYSIS=$(node - "$TRANSCRIPT" "$OFFSET" "$PR_NUMBER" "$HEAD" "$REPOSITORY" "$REQUIRED_LANES" <<'NODE'
const fs = require('node:fs');
const [file, offsetText, pr, head, repository, requiredText] = process.argv.slice(2);
const offset = Number(offsetText);
const data = fs.readFileSync(file).subarray(offset).toString('utf8');
const entries = data.split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const triageHeader = '| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |';
const triageDivider = '|---|---|---|---|---|';
const textOf = (value) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.values(value).map(textOf).join('\n');
};
const calls = [];
entries.forEach((entry, index) => {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (part?.type !== 'tool_use' && part?.type !== 'toolCall') continue;
    const command = part?.input?.command ?? part?.arguments?.command ?? '';
    calls.push({ id: part.id, command, index });
  }
});
const launches = calls.filter(({ command }) => command.includes('run-review-lane.sh')
  && command.includes(`--boundary-pr ${pr}`));
if (launches.length === 0) {
  process.stdout.write(JSON.stringify({ state: 'none' }));
  process.exit(0);
}
const terminal = (id) => entries.map((entry, index) => ({ index, text: textOf(entry) }))
  .filter(({ text }) => text.includes(`<tool-use-id>${id}</tool-use-id>`))
  .map(({ index, text }) => {
    const status = /<status>([^<]+)<\/status>/i.exec(text)?.[1]?.trim().toLowerCase();
    return status && !['running', 'pending', 'in_progress'].includes(status)
      ? { index, ok: ['done', 'completed', 'success'].includes(status), text }
      : undefined;
  }).filter(Boolean).at(-1);
const laneNames = requiredText.split(/\s+/).filter(Boolean);
const laneLaunches = laneNames.map((lane) => ({
  lane,
  launch: launches.filter(({ command }) => command.includes(`--lane ${lane}`)).at(-1),
}));
if (laneLaunches.some(({ launch }) => !launch)) {
  process.stdout.write(JSON.stringify({ state: 'running' }));
  process.exit(0);
}
const results = laneLaunches.map(({ lane, launch }) => ({ lane, ...terminal(launch.id) }));
if (results.some((result) => result.index !== undefined && !result.ok)) {
  process.stdout.write(JSON.stringify({ state: 'failed' }));
  process.exit(0);
}
if (results.length !== laneLaunches.length || results.some((result) => result.index === undefined)) {
  process.stdout.write(JSON.stringify({ state: 'running' }));
  process.exit(0);
}
const ciRequired = launches.some(({ command }) => /CODEFLARE_REVIEW_CI=(?:push|pr-create)\b/.test(command));
let ciResult;
let ciIndex = -1;
if (ciRequired) {
  for (const call of calls) {
    const all = textOf(entries[call.index]);
    if (!all.includes('ci-monitor') || !all.includes(head) || !all.includes(repository)) continue;
    const result = terminal(call.id);
    const value = /CI_RESULT\s+(success|failure|timeout)\b/.exec(result?.text ?? '')?.[1];
    if (result?.ok && value && result.text.includes(`pr=${pr} head=${head} repo=${repository}`)) {
      ciResult = value;
      ciIndex = result.index;
    }
  }
  if (!ciResult) {
    process.stdout.write(JSON.stringify({ state: 'running' }));
    process.exit(0);
  }
}
const completionIndex = Math.max(ciIndex, ...results.map((result) => result.index));
const triage = entries.slice(completionIndex + 1).find((entry) => {
  const content = entry?.message?.content;
  if (entry?.message?.role !== 'assistant' || !Array.isArray(content)) return false;
  const hasTool = content.some((part) => part?.type === 'tool_use' || part?.type === 'toolCall');
  const text = content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
  if (hasTool || !text.includes(`${triageHeader}\n${triageDivider}`)) return false;
  if (ciResult !== 'failure' && ciResult !== 'timeout') return true;
  return text.split('\n').some((line) => {
    const cells = line.startsWith('|') && line.endsWith('|')
      ? line.slice(1, -1).split('|').map((cell) => cell.trim())
      : [];
    const proposedFix = /^`([^`]*)`$/.exec(cells[2] ?? '')?.[1] ?? cells[2];
    return cells.length === 5 && cells[0] === 'Exact-head CI' && proposedFix === `CI_RESULT ${ciResult}`;
  });
});
process.stdout.write(JSON.stringify({ state: triage ? 'triaged' : 'awaiting-triage' }));
NODE
) || exit 0
STATE=$(printf '%s' "$ANALYSIS" | jq -r '.state // "none"' 2>/dev/null)
if [ "$STATE" = "failed" ]; then
  wc -c < "$TRANSCRIPT" 2>/dev/null > "$OFFSET_FILE" || true
  exit 0
fi
[ "$STATE" = "triaged" ] || exit 0

node "$STATE_HELPER" mark --cwd "$REPO" >/dev/null 2>&1 || exit 0
VERIFY=$(node "$STATE_HELPER" status --cwd "$REPO" 2>/dev/null) || exit 0
[ "$(printf '%s' "$VERIFY" | jq -r '.completion.status // "missing"' 2>/dev/null)" = "complete" ] || exit 0

printf '%s\n' "Review complete for ${REPOSITORY##*/}:$(printf '%s' "$STATUS" | jq -r '.identity.branch'). FIX: apply only accepted minimal decisions from canonical triage; do not relaunch completed review." >&2
exit 2
