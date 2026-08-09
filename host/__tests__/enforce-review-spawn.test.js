// Real behavioral tests for the SDD Stop hook.
//
// These tests spawn the actual bash script with stdin input and assert
// on exit code + stdout. They exercise the full hook logic against
// fixture transcripts and a fake `gh` binary on PATH.
//
// Each test uses a fresh temp directory as cwd so hook side-effects
// (.git/sdd-review-ack-pr-42, .git/sdd-review-count-pr-42, deleted
// /tmp/review-bypass sentinel) don't bleed between tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh',
);

function makeFixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'enforce-spawn-'));
  // Initialize a git repo so $(git rev-parse --git-common-dir) succeeds
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd });
  return cwd;
}

function withSdd(cwd) {
  mkdirSync(join(cwd, 'sdd'), { recursive: true });
  writeFileSync(join(cwd, 'sdd/README.md'), '# fixture\n');
}

function fakeGh(cwd, body) {
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'gh'), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(binDir, 'gh'), 0o755);
  return binDir;
}

// Exact-match fixtures (not substring): production hook calls
// `gh pr view <branch> --json number,state,headRefOid,baseRefName`. Anything
// else gets exit 99 + stderr noise so future refactors that change
// the CLI shape surface loudly instead of silently passing.
function ghReturning(state, headSha, base = 'main') {
  return `ARGS="$*"
HEAD_OID="${headSha}"
[[ "$HEAD_OID" =~ ^[0-9a-f]{40}$ ]] || HEAD_OID=$(git rev-parse HEAD)
if [[ "$ARGS" == "pr view "*" --json number,state,headRefOid,baseRefName" ]]; then
  printf '{"number":42,"state":"${state}","headRefOid":"%s","baseRefName":"${base}"}\\n' "$HEAD_OID"
  exit 0
fi
echo "FAKE_GH_UNEXPECTED_ARGS: $ARGS" >&2
exit 99`;
}

function ghNoPR() {
  return `ARGS="$*"
if [[ "$ARGS" == "pr view "*" --json number,state,headRefOid,baseRefName" ]]; then
  exit 1
fi
echo "FAKE_GH_UNEXPECTED_ARGS: $ARGS" >&2
exit 99`;
}

function ghPoison(cwd) {
  // Poison gh: any invocation fails loudly with exit 99 and stderr.
  // Use to assert that the cheap @{u} pre-check actually short-
  // circuited the gh round-trip.
  const binDir = join(cwd, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'gh'),
    `#!/usr/bin/env bash\necho "POISON_GH_CALLED: $*" >&2\nexit 99\n`,
  );
  chmodSync(join(binDir, 'gh'), 0o755);
  return binDir;
}

function writeTranscript(cwd, lines) {
  const path = join(cwd, 'transcript.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function runHook(cwd, { event = 'Stop', transcriptPath, binDir, bypassFile, toolName, tmpDir }) {
  const env = { ...process.env };
  if (binDir) env.PATH = `${binDir}:${process.env.PATH}`;
  // Per-test sentinel path keeps tests hermetic from production /tmp/review-bypass.
  if (bypassFile) env.REVIEW_BYPASS_FILE = bypassFile;
  // Per-test TMPDIR keeps the PreToolUse gate's strike/clear state hermetic.
  if (tmpDir) env.TMPDIR = tmpDir;
  // Prevent the hook from finding a real gh in PATH if we want it absent
  return spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify({
      hook_event_name: event,
      transcript_path: transcriptPath,
      ...(toolName ? { tool_name: toolName } : {}),
    }),
    encoding: 'utf-8',
    env,
  });
}

// Real Bash tool_use lines as the transcript would contain them
const COMMAND_LINE = (command, ts = '2026-05-03T12:00:00.000Z') =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command },
        },
      ],
    },
    timestamp: ts,
  });

const PUSH_LINE = (ts = '2026-05-03T12:00:00.000Z') => COMMAND_LINE('git push origin develop', ts);

const AGENT_LINE = (subagentType, ts, toolUseId = 'toolu_x') =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Agent',
          id: toolUseId,
          input: { subagent_type: subagentType, run_in_background: true },
        },
      ],
    },
    timestamp: ts,
  });

const STATUS_LINE = (toolUseId, status) =>
  `<task-notification><tool-use-id>${toolUseId}</tool-use-id><status>${status}</status></task-notification>`;

const DONE_LINE = (toolUseId) => STATUS_LINE(toolUseId, 'completed');

const SPEC_DONE_LINE = (toolUseId = 'toolu_sr1') => DONE_LINE(toolUseId);

// Headless transport: the lane runs as a Bash call to run-review-lane.sh rather
// than an Agent subagent, so it emits no subagent_type, and completes with the
// same background task notification a backgrounded Agent emits. The immediate
// tool_result is a launch receipt, not completion -- see START_RECEIPT_LINE.
const LANE_BASH_LINE = (lane, ts, toolUseId = 'toolu_b') =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          id: toolUseId,
          input: {
            command: `bash ~/.claude/plugins/codeflare-hooks/scripts/run-review-lane.sh --lane ${lane} --range aaa..bbb`,
          },
        },
      ],
    },
    timestamp: ts,
  });

// A backgrounded Bash lane completes with the SAME notification shape a
// backgrounded Agent uses, so one completion contract covers both transports.
const LANE_BASH_DONE_LINE = (toolUseId) => DONE_LINE(toolUseId);

// The triage verdict: an assistant message whose text carries the table
// (tool calls may share the message - the text is the checkpoint).
// The header/divider are contract values the gate matches on, the same two
// constants Pi pins -- not prose, and not assertable copy.
const TRIAGE_HEADER = '| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |';
const TRIAGE_LINE = () =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'text',
          text: `${TRIAGE_HEADER}\n|---|---|---|---|---|\n| a finding | valid | a fix | proportionate | fix |`,
        },
      ],
    },
  });

// A background call that exits non-zero. Same envelope, terminal status
// `failed`: the lane ENDED, but produced nothing the gate may credit.
const FAILED_LINE = (toolUseId) => STATUS_LINE(toolUseId, 'failed');

// The start receipt the harness returns the instant a background call is
// launched. It carries the tool_use_id but means "launched", not "finished".
const START_RECEIPT_LINE = (toolUseId) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId }] },
  });

// REQ-AGENT-036: PR-Boundary Review Trigger Conditions
// REQ-AGENT-040: PR-Boundary Lane Classification and Agent Dispatch
// REQ-AGENT-041: PR-Boundary Review Bypass Surfaces

describe('enforce-review-spawn.sh — vibe-coding gate', () => {
  it('exits 0 silently when sdd/ is missing', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('enforce-review-spawn.sh — event scoping', () => {
  it('exits 0 silently on SubagentStop (only Stop and PreToolUse are enforced)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { event: 'SubagentStop', transcriptPath: t });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

// REQ-AGENT-104 AC7: mid-turn triage gate. Once every spawned lane completed
// and no canonical table follows the last completion, every tool outside the
// read-only set is refused (exit 2 + stderr directive) until the table exists.
describe('enforce-review-spawn.sh — PreToolUse triage gate', () => {
  const completedRound = () => [
    AGENT_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_cr1'),
    DONE_LINE('toolu_cr1'),
    AGENT_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_sr1'),
    DONE_LINE('toolu_sr1'),
    AGENT_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_du1'),
    DONE_LINE('toolu_du1'),
  ];
  const pretool = (cwd, t, toolName) =>
    runHook(cwd, {
      event: 'PreToolUse',
      transcriptPath: t,
      toolName,
      tmpDir: cwd,
      bypassFile: join(cwd, 'absent-bypass'),
    });

  it('refuses a mutating tool once every spawned lane completed with no triage table after', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, completedRound());
    const r = pretool(cwd, t, 'Edit');
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(TRIAGE_HEADER), 'directive carries the canonical header contract');
    assert.equal(r.stdout, '');
    assert.equal(pretool(cwd, t, 'Write').status, 2,
      'Write carries no exemption while blocked');
  });

  it('allows read-only tools during the blocked window', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, completedRound());
    for (const tool of ['Read', 'TaskOutput']) {
      assert.equal(pretool(cwd, t, tool).status, 0, tool);
    }
  });

  it('allows once the triage table is published after the last completion', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, [...completedRound(), TRIAGE_LINE()]);
    assert.equal(pretool(cwd, t, 'Edit').status, 0);
  });

  it('allows while any lane is still in flight', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, completedRound().slice(0, 5));
    assert.equal(pretool(cwd, t, 'Edit').status, 0);
  });

  it('does not treat a failed lane as a completed round', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, [...completedRound().slice(0, 5), FAILED_LINE('toolu_du1')]);
    assert.equal(pretool(cwd, t, 'Edit').status, 0);
  });

  it('demands a fresh table when a lane re-runs after the previous round was triaged', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, [
      ...completedRound(),
      TRIAGE_LINE(),
      AGENT_LINE('spec-reviewer', '2026-05-03T12:10:00.000Z', 'toolu_sr2'),
      DONE_LINE('toolu_sr2'),
    ]);
    assert.equal(pretool(cwd, t, 'Bash').status, 2);
  });

  it('re-blocks after a cleared round when a new completion lands', () => {
    const cwd = makeFixture();
    const cleared = [...completedRound(), TRIAGE_LINE()];
    const t = writeTranscript(cwd, cleared);
    assert.equal(pretool(cwd, t, 'Edit').status, 0);
    writeTranscript(cwd, [
      ...cleared,
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:20:00.000Z', 'toolu_b9'),
      LANE_BASH_DONE_LINE('toolu_b9'),
    ]);
    assert.equal(pretool(cwd, t, 'Edit').status, 2);
  });

  it('covers the headless Bash lane transport', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, [
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
    ]);
    assert.equal(pretool(cwd, t, 'Edit').status, 2);
  });

  it('exits 0 for a transcript with no review lanes', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    assert.equal(pretool(cwd, t, 'Edit').status, 0);
  });

  it('honors the bypass sentinel without consuming it', () => {
    const cwd = makeFixture();
    const bypassFile = join(cwd, 'bypass');
    writeFileSync(bypassFile, '');
    const t = writeTranscript(cwd, completedRound());
    const r = runHook(cwd, {
      event: 'PreToolUse', transcriptPath: t, toolName: 'Edit', tmpDir: cwd, bypassFile,
    });
    assert.equal(r.status, 0);
    assert.equal(existsSync(bypassFile), true, 'PreToolUse never consumes the one-shot sentinel');
  });

  it('re-blocks a rewritten transcript whose size still covers the cached offset', () => {
    const cwd = makeFixture();
    const filler = (ch) => JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: ch.repeat(5000) }] },
    });
    const junk = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'z'.repeat(2500) }] },
    });
    const t = writeTranscript(cwd, [filler('a'), ...completedRound(), TRIAGE_LINE()]);
    assert.equal(pretool(cwd, t, 'Edit').status, 0);
    // History rewrite: different prefix, completions end BEFORE the cached
    // offset, trailing junk keeps the file at least as large - the appended-
    // bytes count alone would see nothing new and fail open.
    writeTranscript(cwd, [filler('b'), ...completedRound(), junk]);
    assert.equal(pretool(cwd, t, 'Edit').status, 2,
      'prefix fingerprint mismatch must force the full pass');
  });

  it('treats a legacy or malformed cache entry as no cache', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, completedRound());
    const key = spawnSync('bash', ['-c', 'printf %s "$1" | cksum', '_', t], { encoding: 'utf-8' })
      .stdout.trim().split(' ')[0];
    // Two-field legacy entry whose offset sits at EOF: honouring it would see
    // nothing appended and allow, so only the strict three-field guard blocks.
    // The one-field malformed shape keeps its own coverage alongside.
    for (const entry of ['3\n', `1:${statSync(t).size}\n`]) {
      writeFileSync(join(cwd, `sdd-pretool-triage-clear-${key}`), entry);
      assert.equal(pretool(cwd, t, 'Edit').status, 2,
        `entry ${JSON.stringify(entry)} must not be honoured as a cleared round`);
    }
  });

  it('rejects a table that appears only inside a tool_use envelope', () => {
    const cwd = makeFixture();
    const toolOnlyTable = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Edit',
            id: 'toolu_fake1',
            input: {
              new_string: `${TRIAGE_HEADER}\n|---|---|---|---|---|\n| a | v | f | p | fix |`,
            },
          },
        ],
      },
    });
    const t = writeTranscript(cwd, [...completedRound(), toolOnlyTable]);
    assert.equal(pretool(cwd, t, 'Edit').status, 2,
      'table text inside a tool_use input must not clear the checkpoint');
  });

  it('accepts a table sharing its message with the first fix tool call', () => {
    const cwd = makeFixture();
    const tableWithTool = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: `${TRIAGE_HEADER}\n|---|---|---|---|---|\n| a finding | valid | a fix | proportionate | fix |`,
          },
          { type: 'tool_use', name: 'Edit', id: 'toolu_fix1', input: {} },
        ],
      },
    });
    const t = writeTranscript(cwd, [...completedRound(), tableWithTool]);
    assert.equal(pretool(cwd, t, 'Edit').status, 0,
      'a tool-free message ends the turn, so the table must count alongside fixes');
  });

  it('gives up after five refused calls for the same round, then stays released', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, completedRound());
    const statuses = [];
    for (let index = 0; index < 7; index += 1) statuses.push(pretool(cwd, t, 'Edit').status);
    assert.deepEqual(statuses, [2, 2, 2, 2, 2, 0, 0]);
  });

  it('never writes the Stop-side acknowledgement from a PreToolUse pass', () => {
    const cwd = makeFixture();
    const t = writeTranscript(cwd, [...completedRound(), TRIAGE_LINE()]);
    pretool(cwd, t, 'Edit');
    assert.equal(existsSync(join(cwd, '.git/sdd-review-ack-pr-42')), false);
  });
});

describe('enforce-review-spawn.sh — bypass 1: sentinel file', () => {
  it('exits 0 and deletes the sentinel for an eligible open head (one-shot)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const bypassFile = join(cwd, 'review-bypass');
    writeFileSync(bypassFile, '');
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, {
      transcriptPath: t,
      bypassFile,
      binDir: fakeGh(cwd, ghReturning('OPEN', 'unackedSHA')),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(bypassFile), false,
      'sentinel must be deleted when it bypasses an eligible head');
  });

  it('preserves the sentinel when no PR exists for the current branch', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const bypassFile = join(cwd, 'review-bypass');
    writeFileSync(bypassFile, '');
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, {
      transcriptPath: t,
      bypassFile,
      binDir: fakeGh(cwd, ghNoPR()),
    });

    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(bypassFile), true,
      'an ineligible boundary must not waste the user-owned one-shot bypass');
  });
});

describe('enforce-review-spawn.sh — PR state gating', () => {
  it('exits 0 silently when no open PR exists for current branch', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghNoPR());
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('reports a merged unacknowledged head without consuming the bypass sentinel', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const bypassFile = join(cwd, 'review-bypass');
    writeFileSync(bypassFile, '');
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, {
      transcriptPath: t,
      bypassFile,
      binDir: fakeGh(cwd, ghReturning('MERGED', 'mergedSHA')),
    });
    const notice = JSON.parse(r.stdout);

    assert.equal(r.status, 0);
    assert.match(notice.systemMessage, /acknowledgement missing/i);
    assert.match(notice.systemMessage, /PR state: MERGED/);
    assert.equal(existsSync(bypassFile), true);
    assert.equal(existsSync(join(cwd, '.git/sdd-review-ack-pr-42')), false,
      'visibility must not fabricate acknowledgement after merge');

    const repeated = runHook(cwd, {
      transcriptPath: t,
      bypassFile,
      binDir: fakeGh(cwd, ghReturning('MERGED', 'mergedSHA')),
    });
    assert.equal(repeated.stdout, '', 'the same closed head emits its visibility notice only once');
  });

  it('keeps an acknowledged merged head silent and preserves the bypass sentinel', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(cwd, '.git/sdd-review-ack-pr-42'), `${headSha}\n`);
    const bypassFile = join(cwd, 'review-bypass');
    writeFileSync(bypassFile, '');
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, {
      transcriptPath: t,
      bypassFile,
      binDir: fakeGh(cwd, ghReturning('MERGED', headSha)),
    });

    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(bypassFile), true);
  });

  it('blocks when open PR targets develop with un-acked HEAD and no agents spawned', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'develop'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    assert.match(r.stdout, /code-reviewer/);
  });

  it('blocks when open PR targets main with un-acked HEAD and no agents spawned', () => {
    // Pins the positive-direction half of base gating: PR-to-main
    // with an un-acked HEAD continues to enforce as before.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [COMMAND_LINE('git status --short')]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /spec-reviewer/);
  });

  it('blocks when open PR targets master with un-acked HEAD and no agents spawned', () => {
    // master is treated identically to main.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'master'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('exits 0 silently when gh confirms PR HEAD matches LAST_ACK (no @{u})', () => {
    // No upstream tracking → cheap @{u} pre-check skipped → falls
    // through to gh → gh returns matching SHA → authoritative-path
    // exit 0. Pins the gh-path branch of the matched-ack semantics.
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const binDir = fakeGh(cwd, ghReturning('OPEN', headSha));
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    writeFileSync(join(cwd, gitCommonDir, 'sdd-review-ack-pr-42'), headSha);
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('enforce-review-spawn.sh — 5-strike circuit breaker / REQ-AGENT-044 (review-agent discipline enforcement)', () => {
  it('blocks 5 times then exits silently on the 6th attempt for same PR HEAD', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    // First five runs: block (no agents spawned)
    for (let i = 1; i <= 5; i++) {
      const r = runHook(cwd, { transcriptPath: t, binDir });
      assert.equal(r.status, 0, `run ${i} exit code`);
      assert.match(r.stdout, /"decision"\s*:\s*"block"/, `run ${i} must block`);
    }
    // Sixth run: counter exceeded, hook gives up and exits silently
    const r6 = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r6.status, 0);
    assert.equal(r6.stdout, '',
      '6th attempt for same un-acked PR HEAD must release the user (5-strike breaker)');
  });

  it('counter resets when PR HEAD advances (different SHA = new attempt window)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    // First push: block 5x, give up on 6th
    let binDir = fakeGh(cwd, ghReturning('OPEN', 'firstsha'));
    for (let i = 0; i < 6; i++) {
      runHook(cwd, { transcriptPath: t, binDir });
    }
    // New PR HEAD: counter resets, blocks again
    spawnSync('git', ['commit', '--allow-empty', '-m', 'next'], { cwd });
    binDir = fakeGh(cwd, ghReturning('OPEN', 'secondsha'));
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'new PR HEAD must reset the strike counter');
  });
});

describe('enforce-review-spawn.sh — agent-spawn enforcement', () => {
  it('blocks with both agent names when nothing is spawned post-push', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newshasinceack'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    // Must name BOTH missing agents in the reason — the directive
    // tells the assistant exactly what to spawn
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /spec-reviewer/);
  });

  it('suppresses an in-flight lane without masking missing peer lanes', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    const t = writeTranscript(cwd, [
      AGENT_LINE('code-reviewer', '2026-05-03T11:59:59.000Z', 'toolu_cr_inflight'),
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    assert.match(r.stdout, /spec-reviewer/,
      'the missing peer lane must still be demanded while code-reviewer is in flight');
    assert.match(r.stdout, /run_in_background: true/,
      'the emitted spawn directive must keep review dispatch in the background');
    assert.doesNotMatch(r.stdout, /code-reviewer/,
      'the in-flight code-reviewer lane must not be re-demanded');
  });

  it('re-demands an orphaned in-flight lane after the transcript recency bound', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    const filler = Array.from({ length: 1201 }, (_, i) => JSON.stringify({ type: 'user', message: { content: `filler ${i}` } }));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      AGENT_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_cr_orphaned'),
      ...filler,
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    assert.match(r.stdout, /code-reviewer/,
      'an uncompleted in-flight lane older than the recency bound must be demanded again');
    assert.match(r.stdout, /spec-reviewer/,
      'other missing peer lanes must still be demanded');
  });

  it('does not ack when a pre-push in-flight lane never gets current-head coverage', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = 'currentheadwithoutcode';
    const binDir = fakeGh(cwd, ghReturning('OPEN', headSha));
    const t = writeTranscript(cwd, [
      AGENT_LINE('code-reviewer', '2026-05-03T11:59:59.000Z', 'toolu_cr_previous_head'),
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      AGENT_LINE('spec-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_sr1'),
      SPEC_DONE_LINE('toolu_sr1'),
      AGENT_LINE('doc-updater', '2026-05-03T12:00:10.000Z', 'toolu_du1'),
      DONE_LINE('toolu_du1'),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const ackFile = join(cwd, gitCommonDir, 'sdd-review-ack-pr-42');
    assert.equal(existsSync(ackFile), false,
      'the checkpoint must not advance until every required lane has current-head completion');
  });

  it('does not ack while current-head lanes are still in flight', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = 'currentheadinflight';
    const binDir = fakeGh(cwd, ghReturning('OPEN', headSha));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      AGENT_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_cr1'),
      AGENT_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_sr1'),
      SPEC_DONE_LINE('toolu_sr1'),
      AGENT_LINE('doc-updater', '2026-05-03T12:00:10.000Z', 'toolu_du1'),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const ackFile = join(cwd, gitCommonDir, 'sdd-review-ack-pr-42');
    assert.equal(existsSync(ackFile), false,
      'the checkpoint must not advance while required current-head lanes are still running');
  });

  it('demands doc-updater in the initial parallel wave (no spec-reviewer dependency)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    // Nothing spawned yet: all three report-only lanes are demanded together — doc-updater
    // no longer waits for spec-reviewer to complete (disjoint write targets, no race).
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /spec-reviewer/);
    assert.match(r.stdout, /doc-updater/);
  });

  it('exits 0 + advances checkpoint when full pipeline completes', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const binDir = fakeGh(cwd, ghReturning('OPEN', headSha));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      AGENT_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_cr1'),
      DONE_LINE('toolu_cr1'),
      AGENT_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_sr1'),
      SPEC_DONE_LINE('toolu_sr1'),
      AGENT_LINE('doc-updater', '2026-05-03T12:00:10.000Z', 'toolu_du1'),
      DONE_LINE('toolu_du1'),
      // The verdict contract is transport-independent: an Agent round is read
      // or unread on the same terms a headless one is.
      TRIAGE_LINE(),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const ackFile = join(cwd, gitCommonDir, 'sdd-review-ack-pr-42');
    assert.equal(readFileSync(ackFile, 'utf-8').trim(), headSha,
      'checkpoint must advance to the just-acked PR HEAD SHA');
  });
});

// REQ-AGENT-102: reviewer lanes run as headless subprocesses. The gate accepts
// either transport, so migrating a lane cannot narrow what counts as reviewed.
describe('enforce-review-spawn.sh — headless lane transport', () => {
  const ackOf = (cwd) => {
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const ackFile = join(cwd, gitCommonDir, 'sdd-review-ack-pr-42');
    return existsSync(ackFile) ? readFileSync(ackFile, 'utf-8').trim() : '';
  };

  it('acks when every lane ran as a run-review-lane.sh Bash call', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const binDir = fakeGh(cwd, ghReturning('OPEN', headSha));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
      TRIAGE_LINE(),
    ]);
    runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(ackOf(cwd), headSha,
      'a fully headless round must advance the checkpoint exactly like a subagent round');
  });

  it('acks a round that mixes both transports', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const binDir = fakeGh(cwd, ghReturning('OPEN', headSha));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
      AGENT_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_sr1'),
      DONE_LINE('toolu_sr1'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
      TRIAGE_LINE(),
    ]);
    runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(ackOf(cwd), headSha);
  });

  it('still blocks when a headless lane started but never returned', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'incompletesha'));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      // doc-updater spawned, no tool_result -> lane never completed.
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
    ]);
    runHook(cwd, { transcriptPath: t, binDir });
    assert.notEqual(ackOf(cwd), 'incompletesha',
      'an unreturned lane must not advance the checkpoint');
  });

  // REQ-AGENT-102 AC6. The status set is OPEN: whitelisting end states is wrong
  // in the direction that wedges the checkpoint, because an end state the hook
  // has never heard of reads as "still running" forever. So the rule is
  // inverted -- a status is terminal unless it is a known RUNNING state. Both
  // directions are asserted, because either alone passes with a constant.
  it('treats an unrecognised end status as terminal and a running status as not', () => {
    const lanes = (codeStatus) => [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      STATUS_LINE('toolu_b1', codeStatus),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
      TRIAGE_LINE(),
    ];
    const drive = (status, headSha) => {
      const cwd = makeFixture();
      withSdd(cwd);
      const r = runHook(cwd, {
        transcriptPath: writeTranscript(cwd, lanes(status)),
        binDir: fakeGh(cwd, ghReturning('OPEN', headSha)),
      });
      return { cwd, r };
    };

    const running = drive('in_progress', 'runningsha');
    assert.doesNotMatch(running.r.stdout, /run code-reviewer/,
      'a lane still in_progress has not ended; re-demanding it duplicates a run that is still going');
    assert.notEqual(ackOf(running.cwd), 'runningsha',
      'and it cannot be credited either, so the checkpoint must not advance');

    const ended = drive('cancelled', 'cancelledsha');
    assert.match(ended.r.stdout, /run code-reviewer/,
      'an end status outside any known list must count as ended and be re-demanded, or a new harness status wedges the gate forever');
    assert.notEqual(ackOf(ended.cwd), 'cancelledsha',
      'ended-without-success is not coverage; the checkpoint may not advance over it');
  });

  // Acknowledgement is a claim about CONSUMPTION, not exit status. Lanes that
  // returned into a session that never read them leave findings unacted while
  // the checkpoint advances past them -- so the verdict, not the exit, is what
  // the gate keys on.
  it('withholds the ack until the triage verdict is published', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'notriagesha'));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
      // every lane returned, nothing published
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.notEqual(ackOf(cwd), 'notriagesha',
      'three exits are not a review; the checkpoint may not advance past unread findings');
    assert.match(r.stdout, /MINIMAL DECISION/,
      'the block must demand the verdict in the shape the gate matches');
  });

  it('drives the FIX phase once the verdict is published', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'fixphasesha'));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
      TRIAGE_LINE(),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(ackOf(cwd), 'fixphasesha');
    assert.match(r.stdout, /FIX phase/,
      'the ack alone does not apply anything; the fix phase must be driven, not remembered');
  });

  // A table from the PREVIOUS round sits earlier in the transcript. Accepting it
  // would acknowledge this head on the strength of a verdict about another one.
  it('ignores a verdict published before the lanes returned', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'staleverdictsha'));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      TRIAGE_LINE(),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
    ]);
    runHook(cwd, { transcriptPath: t, binDir });
    assert.notEqual(ackOf(cwd), 'staleverdictsha',
      'a verdict predating the evidence cannot be a verdict about it');
  });

  // REQ-AGENT-102 AC3 / REQ-AGENT-105. Without a scope the runner falls through
  // to "Review the full PR diff", and both the inlined packet and the ownership
  // short-circuit are gated on having a range -- so a scopeless demand spends a
  // full unscoped lane and skips every cost control at once. The nudge has
  // always carried a scope; this path is what every re-demand goes through.
  it('scopes the lanes it demands to the range under review', () => {
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      writeFileSync(join(cwd, 'src/thing.ts'), 'changed\n');
    });
    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE('2026-05-18T12:00:00.000Z')]);

    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.match(r.stdout, new RegExp(`--range ${baseSha}\\.\\.${tip}`),
      'the demand must carry the incremental range, or the lane reviews the whole PR with no packet');
  });

  // REQ-AGENT-104 AC6, the regression that made the first fix inert. The two
  // counters must be genuinely separate: a head that spent its LANE-demand
  // budget merely getting the lanes launched arrives at the verdict check with
  // that counter already exhausted, and if the escape hatch reads it, the head
  // is acknowledged before a single verdict demand was ever shown -- with a
  // stderr line claiming five went unanswered. Seeding one counter and
  // asserting on the other is the only shape that catches it; driving both from
  // zero moves them in lockstep and passes either way.
  it('does not spend the lane-demand budget on the verdict escape hatch', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'exhaustedsha'));
    const gcd = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf-8' })
      .stdout.trim();
    // This head already cost four Stop events to get its lanes running.
    writeFileSync(join(cwd, gcd, 'sdd-review-count-pr-42'), 'exhaustedsha:4\n');
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
    ]);

    for (let i = 0; i < 3; i += 1) {
      const r = runHook(cwd, { transcriptPath: t, binDir });
      assert.match(r.stdout, /no triage verdict was published/,
        'the verdict demand must keep being shown; a demand silenced by the lane breaker can never be answered');
      assert.notEqual(ackOf(cwd), 'exhaustedsha',
        'the lane-demand budget is not payment for the verdict hatch: these findings have still never been triaged');
    }
  });

  // REQ-AGENT-104 AC6. The escape hatch exists so a head is never wedged, but it
  // must be bought with VERDICT demands. Sharing the lane-demand counter meant a
  // head that took five Stops to launch its lanes was acknowledged on the first
  // pass, with its findings never triaged and a stderr line claiming otherwise.
  it('acknowledges after repeated unanswered demands instead of staying wedged', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'wedgedsha'));
    const lanes = [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
    ];
    const t = writeTranscript(cwd, lanes);

    runHook(cwd, { transcriptPath: t, binDir });
    assert.notEqual(ackOf(cwd), 'wedgedsha',
      'the very first unanswered demand must not acknowledge: no verdict has been asked for yet');

    let acked = false;
    for (let i = 0; i < 6 && !acked; i += 1) {
      runHook(cwd, { transcriptPath: t, binDir });
      acked = ackOf(cwd) === 'wedgedsha';
    }
    assert.equal(acked, true,
      'repeated unanswered demands must acknowledge; a permanently wedged checkpoint is the failure being removed');
  });

  // The third round-closing path: a graphify-out/-only diff requires no lanes,
  // so the checkpoint auto-acks without any spawn or verdict demand.
  it('auto-acks a graphify-out-only diff that requires no lanes', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
      assert.equal(r.status, 0, `git ${args[0]} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    const baseSha = git('rev-parse', 'HEAD');
    mkdirSync(join(cwd, 'graphify-out'), { recursive: true });
    writeFileSync(join(cwd, 'graphify-out/graph.json'), '{}\n');
    // Stage ONLY the graphify artifact: the fixture's uncommitted sdd/ and
    // fake-bin/ files must not leak into the diff, or the shape stops being
    // graphify-only and lanes are required again.
    git('add', 'graphify-out/graph.json');
    git('commit', '-q', '-m', 'graph');
    const headSha = git('rev-parse', 'HEAD');
    // Seed the previous round's ack so the classifier diffs base..head and
    // proves the graphify-out/-only shape that requires no lanes.
    writeFileSync(join(cwd, git('rev-parse', '--git-common-dir'), 'sdd-review-ack-pr-42'),
      `${baseSha}\n`);
    const binDir = fakeGh(cwd, ghReturning('OPEN', headSha));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    runHook(cwd, { transcriptPath: t, binDir, tmpDir: cwd });
    assert.equal(ackOf(cwd), headSha, 'a graphify-out-only diff must auto-ack with no lanes');
  });

  // REQ-AGENT-104 AC5.
  it('applies the verdict requirement on the retroactive scan path, not just the live path', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'retroactivesha'));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      LANE_BASH_DONE_LINE('toolu_b1'),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /no triage verdict was published/,
      'the requirement must be APPLIED here, not merely un-met: a crashed hook also leaves the ack alone');
    assert.notEqual(ackOf(cwd), 'retroactivesha',
      'the retroactive scan is a second acknowledgement path and must not bypass the verdict requirement');
  });

  // A background lane that exits non-zero terminates as `failed`, not
  // `completed`. It is just as ENDED as a successful one, and the difference
  // between "ended badly" and "still running" is what the checkpoint depends
  // on: treated as in-flight, the gate waits on a dead process, the head stays
  // un-acked, and every later range is measured from a stale checkpoint.
  it('re-demands a lane whose background run terminated as failed', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'failedlanesha'));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      LANE_BASH_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_b1'),
      FAILED_LINE('toolu_b1'),
      LANE_BASH_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_b2'),
      LANE_BASH_DONE_LINE('toolu_b2'),
      LANE_BASH_LINE('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_b3'),
      LANE_BASH_DONE_LINE('toolu_b3'),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.notEqual(ackOf(cwd), 'failedlanesha',
      'a failed lane produced no findings, so it must never advance the checkpoint');
    assert.match(r.stdout, /code-reviewer/,
      'the failed lane must be re-demanded immediately, not waited on as if it were still running');
    assert.match(r.stdout, /WITHOUT success/,
      'the demand must say the lane already ran and was not credited, or the round is silently lost');
    assert.doesNotMatch(r.stdout, /run spec-reviewer|run doc-updater/,
      'lanes that did complete must not be re-demanded');
  });

  // Both imposter shapes quote the runner path. The second also puts a shell
  // separator INSIDE the quotes, which satisfies a command-position anchor
  // applied to the raw string -- the more dangerous variant, and the one that
  // bypassed the gate for all three lanes at once.
  const IMPOSTERS = {
    'quotes the runner path':
      'echo "next: bash ~/.claude/plugins/codeflare-hooks/scripts/run-review-lane.sh --lane code-reviewer --lane spec-reviewer --lane doc-updater"',
    'hides a shell separator inside the quotes':
      'echo "step1; bash ~/.claude/plugins/codeflare-hooks/scripts/run-review-lane.sh --lane code-reviewer --lane spec-reviewer --lane doc-updater (planned)"',
  };
  for (const [label, command] of Object.entries(IMPOSTERS)) {
    it(`does not credit any lane from a command that ${label}`, () => {
      const cwd = makeFixture();
      withSdd(cwd);
      const binDir = fakeGh(cwd, ghReturning('OPEN', 'impostersha'));
      const imposter = JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_i1', input: { command } }],
        },
      });
      const t = writeTranscript(cwd, [
        PUSH_LINE('2026-05-03T12:00:00.000Z'),
        imposter,
        LANE_BASH_DONE_LINE('toolu_i1'),
      ]);
      const r = runHook(cwd, { transcriptPath: t, binDir });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /"decision"\s*:\s*"block"/,
        'the runner must be in command position, not quoted inside another command');
      assert.notEqual(ackOf(cwd), 'impostersha');
    });
  }

  // Lanes are dispatched with run_in_background, so the harness returns a
  // tool_result immediately holding a background shell id. Crediting that would
  // ack the head the instant the lanes launch, while they are still running.
  for (const [label, spawn] of [
    ['headless Bash', LANE_BASH_LINE],
    ['Agent subagent', AGENT_LINE],
  ]) {
    it(`does not treat a background ${label} start receipt as completion`, () => {
      const cwd = makeFixture();
      withSdd(cwd);
      const sha = 'inflightsha';
      const binDir = fakeGh(cwd, ghReturning('OPEN', sha));
      const t = writeTranscript(cwd, [
        PUSH_LINE('2026-05-03T12:00:00.000Z'),
        spawn('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_1'),
        START_RECEIPT_LINE('toolu_1'),
        spawn('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_2'),
        START_RECEIPT_LINE('toolu_2'),
        spawn('doc-updater', '2026-05-03T12:00:03.000Z', 'toolu_3'),
        START_RECEIPT_LINE('toolu_3'),
      ]);
      runHook(cwd, { transcriptPath: t, binDir });
      assert.notEqual(ackOf(cwd), sha,
        'a launch receipt must never advance the checkpoint');
    });
  }

  // Quoting the path is the normal defensive habit and $HOME invites it.
  it('credits a lane whose runner path is quoted', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const sha = 'quotedpathsha';
    const binDir = fakeGh(cwd, ghReturning('OPEN', sha));
    const quoted = (lane, id) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              id,
              input: {
                command: `bash "$HOME/.claude/plugins/codeflare-hooks/scripts/run-review-lane.sh" --lane ${lane} --range aaa..bbb`,
              },
            },
          ],
        },
      });
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      quoted('code-reviewer', 'toolu_q1'), DONE_LINE('toolu_q1'),
      quoted('spec-reviewer', 'toolu_q2'), DONE_LINE('toolu_q2'),
      quoted('doc-updater', 'toolu_q3'), DONE_LINE('toolu_q3'),
      TRIAGE_LINE(),
    ]);
    runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(ackOf(cwd), sha,
      'a quoted runner path is still a real lane invocation');
  });
});

describe('enforce-review-spawn.sh — bypass 2: magic phrase', () => {
  it('exits 0 when user message after push contains "skip review"', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    const t = writeTranscript(cwd, [
      PUSH_LINE(),
      JSON.stringify({
        type: 'user',
        message: { content: 'please skip review for this push' },
      }),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('exits 0 when user message contains "skip verification"', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    const t = writeTranscript(cwd, [
      PUSH_LINE(),
      JSON.stringify({
        type: 'user',
        message: { content: 'skip verification, this is urgent' },
      }),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('enforce-review-spawn.sh — fail-safe behavior', () => {
  it('classifies agents earlier in the transcript than the push as stale', () => {
    // Pins the post-push line-number ordering contract.
    // The transcript is append-only JSONL, so a subagent_type entry
    // that appears BEFORE the push line is definitionally pre-push
    // and must not satisfy enforcement.
    //
    // All three report-only lanes are demanded together in the single parallel block.
    // Every agent spawn here precedes the push, so none counts as current-head coverage
    // and all three are re-demanded.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [
      AGENT_LINE('code-reviewer', '2026-05-03T11:59:59Z', 'toolu_stale_cr'),
      AGENT_LINE('spec-reviewer', '2026-05-03T11:59:59Z', 'toolu_stale_sr'),
      AGENT_LINE('doc-updater', '2026-05-03T11:59:59Z', 'toolu_stale_du'),
      PUSH_LINE(),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'agents earlier in the transcript than the push must not count');
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /spec-reviewer/);
    assert.match(r.stdout, /doc-updater/);
  });

  it('does not match "git push" inside echo strings (regression for substring false-positive)', () => {
    // This test pins the fix for the PUSH_LINE substring bug.
    // A Bash command that mentions "git push" inside an echo (not as
    // a real command) must NOT trigger enforcement. With the old
    // `&& /git push/` substring grep, this was a false positive.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    const echoLine = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'echo "I will git push later"' } },
        ],
      },
      timestamp: '2026-05-03T12:00:00.000Z',
    });
    const t = writeTranscript(cwd, [echoLine]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'echo "git push" must not be classified as a real push');
  });

  it('detects chained pipelines like `git add && git push`', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    const chainedLine = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'git add . && git commit -m x && git push origin develop' },
          },
        ],
      },
      timestamp: '2026-05-03T12:00:00.000Z',
    });
    const t = writeTranscript(cwd, [chainedLine]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    // Real chained push → enforcement fires (no agents spawned → block)
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });
});

describe('enforce-review-spawn.sh — MCP shell tool input shapes (issue #319)', () => {
  // Regression for #319: when context-mode forces `git push` through
  // ctx_execute(language:"shell", code:"git push ...") or
  // ctx_batch_execute({commands:[{command:"git push ..."}]}), the
  // PUSH_LINE awk must classify those transcript entries as candidate
  // push events. Prior to the fix, the awk only matched `"name":"Bash"`
  // and the entire review gate fell through silently for MCP shell
  // routing — exactly the silent-bypass the Stop hook exists to prevent.

  const ctxExecPush = (
    ts = '2026-05-03T12:00:00.000Z',
    code = 'git push origin develop',
    language = 'shell',
  ) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'mcp__context-mode__ctx_execute',
            input: { language, code },
          },
        ],
      },
      timestamp: ts,
    });

  const ctxBatchPush = (
    ts = '2026-05-03T12:00:00.000Z',
    commands = [{ label: 'push', command: 'git push origin develop' }],
  ) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'mcp__context-mode__ctx_batch_execute',
            input: { commands, queries: ['noop'] },
          },
        ],
      },
      timestamp: ts,
    });

  it('blocks on ctx_execute(language=shell) with git push', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [ctxExecPush()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'ctx_execute shell git push must trigger PUSH_LINE detection');
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /spec-reviewer/);
  });

  it('blocks on ctx_batch_execute with git push in commands array', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [ctxBatchPush()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'ctx_batch_execute git push command must trigger PUSH_LINE detection');
  });

  it('does NOT classify ctx_execute(language=javascript) with code mentioning git push', () => {
    // language gate: only shell-language ctx_execute counts. A JS
    // analysis snippet that happens to string-match "git push" must
    // not fire the review gate.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    const t = writeTranscript(cwd, [
      ctxExecPush(
        '2026-05-03T12:00:00.000Z',
        'console.log("docs say: run git push origin develop")',
        'javascript',
      ),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'ctx_execute with language!=shell must not classify as a push trigger');
  });

  it('detects chained pipelines inside ctx_execute shell code', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [
      ctxExecPush(
        '2026-05-03T12:00:00.000Z',
        'git add . && git commit -m x && git push origin develop',
      ),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('detects chained pipelines inside any ctx_batch_execute command entry', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [
      ctxBatchPush('2026-05-03T12:00:00.000Z', [
        { label: 'status', command: 'git status' },
        { label: 'push', command: 'git add . && git push origin develop' },
      ]),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  // REQ-AGENT-021 AC7: gh pr merge must be recognised as a PUSH_LINE
  // trigger across all three tool surfaces. Server-side merges into
  // develop advance the develop->main PR HEAD without producing a local
  // git push line; without these matches the review pipeline silently
  // fails to arm. Spec-reviewer flagged the missing coverage as MEDIUM
  // because the named-incident behaviour was unverified by CI.
  const bashGhMerge = (
    ts = '2026-05-03T12:00:00.000Z',
    command = 'gh pr merge 394 --merge',
  ) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command },
          },
        ],
      },
      timestamp: ts,
    });

  it('blocks on Bash gh pr merge', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [bashGhMerge()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'Bash gh pr merge must trigger PUSH_LINE detection');
  });

  it('blocks on ctx_execute(language=shell) with gh pr merge', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [
      ctxExecPush('2026-05-03T12:00:00.000Z', 'gh pr merge 394 --merge'),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'ctx_execute shell gh pr merge must trigger PUSH_LINE detection');
  });

  it('blocks on ctx_batch_execute with gh pr merge in commands array', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [
      ctxBatchPush('2026-05-03T12:00:00.000Z', [
        { label: 'merge', command: 'gh pr merge 394 --merge' },
      ]),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'ctx_batch_execute gh pr merge must trigger PUSH_LINE detection');
  });

  it('detects chained gh pr merge inside ctx_execute shell code', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [
      ctxExecPush(
        '2026-05-03T12:00:00.000Z',
        'git fetch origin && gh pr merge 394 --merge',
      ),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('blocks on Bash gh pr edit protected-base retargets across flag forms', () => {
    for (const command of [
      'gh pr edit 394 --base main',
      'gh pr edit --base=master',
      'gh pr edit 394 -B main',
    ]) {
      const cwd = makeFixture();
      withSdd(cwd);
      const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
      const t = writeTranscript(cwd, [bashGhMerge('2026-05-03T12:00:00.000Z', command)]);
      const r = runHook(cwd, { transcriptPath: t, binDir });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /"decision"\s*:\s*"block"/, command);
    }
  });

  it('does NOT classify non-protected or metadata-only gh pr edit commands', () => {
    for (const command of [
      'gh pr edit 394 --base develop',
      'gh pr edit 394 --title metadata-only',
    ]) {
      const cwd = makeFixture();
      withSdd(cwd);
      const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
      const t = writeTranscript(cwd, [bashGhMerge('2026-05-03T12:00:00.000Z', command)]);
      const r = runHook(cwd, { transcriptPath: t, binDir });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', command);
    }
  });

  it('blocks on ctx_execute and ctx_batch_execute gh pr edit retargets', () => {
    const cases = [
      ctxExecPush('2026-05-03T12:00:00.000Z', 'gh pr edit 394 --base main'),
      ctxBatchPush('2026-05-03T12:00:00.000Z', [
        { label: 'retarget', command: 'gh pr edit 394 --base main' },
      ]),
    ];
    for (const line of cases) {
      const cwd = makeFixture();
      withSdd(cwd);
      const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
      const t = writeTranscript(cwd, [line]);
      const r = runHook(cwd, { transcriptPath: t, binDir });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    }
  });
});

// REQ-AGENT-092 + REQ-AGENT-047: while triage items remain open the entire review pipeline is suspended
describe('enforce-review-spawn.sh - SDD transition gate (REQ-AGENT-022)', () => {
  function withTransitionConfig(cwd, { transition = true } = {}) {
    writeFileSync(
      join(cwd, 'sdd/config.yml'),
      `mode: interactive\nenforce_tdd: false\n${transition ? 'transition: true' : '# transition: false'}\n`,
    );
  }

  function withTriage(cwd, body) {
    writeFileSync(join(cwd, 'sdd/.init-triage.md'), body);
  }

  it('exits 0 silently and never calls gh when transition + open triage', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    withTransitionConfig(cwd);
    withTriage(cwd, '## TRIAGE-001\n**Status:** open\n');
    const binDir = ghPoison(cwd); // gh must NOT be called during transition
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr || '', /POISON_GH_CALLED/,
      'transition gate must short-circuit before any gh round-trip');
  });

  it('exits 0 silently for mixed-case Status: Open (case-insensitive grep)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    withTransitionConfig(cwd);
    withTriage(cwd, '## TRIAGE-001\n**Status:**  Open\n');
    const binDir = ghPoison(cwd);
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('proceeds to enforcement when transition: true but no open items remain', () => {
    // Corrupted closure state: spec-reviewer is supposed to flag this.
    // The hook must NOT suppress so the run can reach spec-reviewer.
    const cwd = makeFixture();
    withSdd(cwd);
    withTransitionConfig(cwd);
    withTriage(cwd, '## TRIAGE-001\n**Status:** resolved\n## TRIAGE-002\n**Status:** lost\n');
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'no open items must let enforcement reach gh so spec-reviewer can flag the corrupted state');
  });

  it('proceeds to enforcement when .init-triage.md is missing entirely', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    // Normal project: no transition config, no triage file
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });

  it('proceeds to enforcement when transition: false even with open triage items', () => {
    // Conjunction guard: both transition: true AND open items required.
    const cwd = makeFixture();
    withSdd(cwd);
    withTransitionConfig(cwd, { transition: false });
    withTriage(cwd, '## TRIAGE-001\n**Status:** open\n');
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
  });
});

describe('enforce-review-spawn.sh - 5-strike circuit breaker GIVEUP state', () => {
  it('blocks 5 times for the same SHA, then sticks in GIVEUP and exits 0 forever', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'stuckSHA', 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);

    // First 5 calls: block
    for (let i = 0; i < 5; i++) {
      const r = runHook(cwd, { transcriptPath: t, binDir });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /"decision"\s*:\s*"block"/, `strike ${i + 1} should block`);
    }
    // Sixth call: counter must have flipped to GIVEUP, exit 0 silently
    const r6 = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r6.status, 0);
    assert.equal(r6.stdout, '',
      'after 5 strikes the counter is GIVEUP for this SHA; further Stop events exit 0');
    // Seventh call: still GIVEUP (sticky, not re-armed)
    const r7 = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r7.status, 0);
    assert.equal(r7.stdout, '',
      'GIVEUP is sticky for the same SHA - no re-arm on subsequent Stop events');
  });
});

// Variants of PUSH_LINE that carry transcript-side cwd hints. These pin
// the codeflare layout where the agent's invocation CWD is the parent
// of the cloned repo (e.g. /home/user/workspace/) rather than the repo
// itself. Without these hints the hook silently exits 0 from a non-repo
// CWD and bypasses the entire enforcement chain.
const PUSH_LINE_WITH_ENVELOPE_CWD = (repoDir, ts = '2026-05-16T12:00:00.000Z') =>
  JSON.stringify({
    type: 'assistant',
    cwd: repoDir,
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'git push origin develop' },
        },
      ],
    },
    timestamp: ts,
  });

const PUSH_LINE_WITH_CD_PREFIX = (repoDir, ts = '2026-05-16T12:00:00.000Z') =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: `cd ${repoDir} && git push origin develop` },
        },
      ],
    },
    timestamp: ts,
  });

describe('enforce-review-spawn.sh - repo-dir derivation from PUSH_LINE', () => {
  it('blocks when invoked from a non-repo CWD if PUSH_LINE envelope .cwd points at the repo', () => {
    // Codeflare layout: agent CWD = /home/user/workspace/ (no .git),
    // repo at /home/user/workspace/codeflare/. Hook must chdir into
    // the repo before evaluating gates.
    const repoDir = makeFixture();
    withSdd(repoDir);
    const binDir = fakeGh(repoDir, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(repoDir, [PUSH_LINE_WITH_ENVELOPE_CWD(repoDir)]);
    // Invoke hook from the PARENT directory (not a git repo).
    const parentCwd = resolve(repoDir, '..');
    const r = runHook(parentCwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'must derive repo from PUSH_LINE .cwd and enforce, not silently exit');
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /spec-reviewer/);
  });

  it('blocks when invoked from a non-repo CWD if PUSH_LINE command has `cd <repo> &&` prefix', () => {
    // Second derivation path: the command itself starts with
    // `cd /abs/path && git push ...`. This is the canonical shape
    // for ctx_execute/Bash calls that target a specific repo.
    const repoDir = makeFixture();
    withSdd(repoDir);
    const binDir = fakeGh(repoDir, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(repoDir, [PUSH_LINE_WITH_CD_PREFIX(repoDir)]);
    const parentCwd = resolve(repoDir, '..');
    const r = runHook(parentCwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'must derive repo from `cd <path>` command prefix and enforce');
  });

  it('exits 0 silently from non-repo CWD when PUSH_LINE has no derivable repo hint', () => {
    // Bare `git push` with no envelope .cwd and no cd-prefix: the
    // hook has no way to find the repo from the transcript. Must
    // fail-safe to silent exit 0 (do NOT block based on a guess).
    const repoDir = makeFixture();
    withSdd(repoDir);
    const binDir = fakeGh(repoDir, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(repoDir, [PUSH_LINE()]);  // no cwd hints
    const parentCwd = resolve(repoDir, '..');
    const r = runHook(parentCwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'no derivable repo hint must fail-safe to silent exit, not block on guess');
  });
});

// Tests for round-3 code-review findings on the Stop-hook restructure.

const PUSH_LINE_WITH_QUOTED_CD = (repoDir, ts = '2026-05-16T12:00:00.000Z') =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: `cd "${repoDir}" && git push origin develop` },
        },
      ],
    },
    timestamp: ts,
  });

const PUSH_LINE_WITH_SUBDIR_CD = (repoSubdir, ts = '2026-05-16T12:00:00.000Z') =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: `cd ${repoSubdir} && git push origin develop` },
        },
      ],
    },
    timestamp: ts,
  });

describe('enforce-review-spawn.sh - round-3 ordering and parser fixes', () => {
  it('H1: vibe-coding project does NOT consume the /tmp/review-bypass sentinel', () => {
    // The pre-fix shape ran bypass-1 (sentinel consumption) BEFORE the
    // vibe-coding gate. On a project without sdd/, a routine Stop event
    // would silently consume the user's one-shot bypass sentinel even
    // though no enforcement was going to fire. Post-fix, the gate runs
    // first and the sentinel is preserved.
    const repoDir = makeFixture();
    // Deliberately do NOT call withSdd(repoDir) - this is a vibe project.
    const bypassFile = join(repoDir, 'review-bypass');
    writeFileSync(bypassFile, '');
    const binDir = fakeGh(repoDir, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(repoDir, [PUSH_LINE_WITH_ENVELOPE_CWD(repoDir)]);
    const parentCwd = resolve(repoDir, '..');
    const r = runHook(parentCwd, { transcriptPath: t, binDir, bypassFile });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(bypassFile), true,
      'vibe-coding Stop event must NOT consume the bypass sentinel');
  });

  it('M2: cd into subdir of repo resolves to toplevel for vibe-gate evaluation', () => {
    // `cd src/foo && git push` candidate dir is /repo/src/foo. Without
    // show-toplevel resolution, the vibe-gate would check /repo/src/foo/sdd
    // and fail (sdd/ lives at /repo/sdd). Post-fix the gate evaluates
    // from the repo toplevel and enforcement proceeds correctly.
    const repoDir = makeFixture();
    withSdd(repoDir);
    mkdirSync(join(repoDir, 'src/foo'), { recursive: true });
    const binDir = fakeGh(repoDir, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(repoDir, [PUSH_LINE_WITH_SUBDIR_CD(join(repoDir, 'src/foo'))]);
    const parentCwd = resolve(repoDir, '..');
    const r = runHook(parentCwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'subdir candidate must resolve to repo toplevel so sdd/ gate passes');
  });

  it('M1: cd into a path with spaces (double-quoted) parses correctly', () => {
    // The pre-fix CD_PATH regex `[^[:space:]&;|"]+` stopped at the first
    // space, silently truncating quoted paths and falling through to
    // envelope cwd (or eventually fail-safe exit 0). Post-fix the
    // awk parser handles double-quoted paths.
    // Use a path that genuinely contains a space character.
    const parent = mkdtempSync(join(tmpdir(), 'enforce-spawn-spaces-'));
    const repoDir = join(parent, 'dir with spaces');
    mkdirSync(repoDir);
    spawnSync('git', ['init', '-q'], { cwd: repoDir });
    spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: repoDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repoDir });
    withSdd(repoDir);
    const binDir = fakeGh(repoDir, ghReturning('OPEN', 'unackedSHA', 'main'));
    const t = writeTranscript(repoDir, [PUSH_LINE_WITH_QUOTED_CD(repoDir)]);
    const r = runHook(parent, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'double-quoted cd path with spaces must parse correctly and enforce');
  });
});

// ---------------------------------------------------------------------------
// Lane gating (task #58): only require lanes whose surface the push actually
// touched. Each test builds a real git history so `git diff LAST_ACK CURRENT`
// returns a known file list, then asserts which lanes the hook demands.
// ---------------------------------------------------------------------------

function makeLaneFixture() {
  // Two real commits in a git repo so the diff between them is non-empty
  // and classification can act on real paths. Returns { cwd, baseSha }.
  const cwd = mkdtempSync(join(tmpdir(), 'enforce-spawn-lanes-'));
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'test@test'], { cwd });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd });
  mkdirSync(join(cwd, 'sdd'), { recursive: true });
  mkdirSync(join(cwd, 'documentation'), { recursive: true });
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'sdd/README.md'), '# fixture\n');
  writeFileSync(join(cwd, 'sdd/storage.md'), 'base\n');
  writeFileSync(join(cwd, 'documentation/architecture.md'), 'base\n');
  writeFileSync(join(cwd, 'src/foo.ts'), 'base\n');
  writeFileSync(join(cwd, 'README.md'), 'base\n');
  writeFileSync(join(cwd, 'CHANGELOG.md'), 'base\n');
  writeFileSync(join(cwd, 'CONTRIBUTING.md'), 'base\n');
  spawnSync('git', ['add', '-A'], { cwd });
  spawnSync('git', ['commit', '-q', '-m', 'base'], { cwd });
  const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd, encoding: 'utf-8',
  }).stdout.trim();
  return { cwd, baseSha };
}

function ackBase(cwd, sha) {
  const gcd = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd, encoding: 'utf-8',
  }).stdout.trim();
  writeFileSync(join(cwd, gcd, 'sdd-review-ack-pr-42'), sha);
}

function advanceWith(cwd, mutate) {
  // mutate is a function that performs filesystem changes; we then commit
  // and return the resulting HEAD SHA.
  mutate();
  spawnSync('git', ['add', '-A'], { cwd });
  spawnSync('git', ['commit', '-q', '-m', 'advance'], { cwd });
  return spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd, encoding: 'utf-8',
  }).stdout.trim();
}

// REQ-AGENT-037: each review agent self-limits fix rounds scoped to its own lane
describe('enforce-review-spawn.sh — lane gating (task #58)', () => {
  it('docs-only push: requires ONLY doc-updater (no code, no spec)', () => {
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      writeFileSync(join(cwd, 'documentation/architecture.md'), 'changed\n');
    });
    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    assert.match(r.stdout, /doc-updater/);
    assert.doesNotMatch(r.stdout, /code-reviewer/,
      'docs-only push must NOT demand code-reviewer');
    assert.doesNotMatch(r.stdout, /spec-reviewer/,
      'docs-only push must NOT demand spec-reviewer');
  });

  it('sdd-only push: requires spec-reviewer + doc-updater (no code-reviewer)', () => {
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      writeFileSync(join(cwd, 'sdd/storage.md'), 'changed\n');
    });
    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /spec-reviewer/);
    assert.match(r.stdout, /doc-updater/,
      'sdd-only push demands doc-updater in parallel with spec-reviewer (no spec->doc gate)');
    assert.doesNotMatch(r.stdout, /code-reviewer/,
      'sdd-only push must NOT demand code-reviewer');
  });

  it('behavioral push (src/): requires all three lanes', () => {
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      writeFileSync(join(cwd, 'src/foo.ts'), 'changed\n');
    });
    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /spec-reviewer/);
  });

  it('rename bypass attempt (src -> documentation) is REJECTED — still all three', () => {
    // Adversarial: a user might rename src/foo.ts -> documentation/poison.md
    // to make the diff look like a pure docs change and skip code-reviewer.
    // The hook MUST use --no-renames so both old and new paths appear, and
    // the source path triggers behavioral classification.
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      spawnSync('git', ['mv', 'src/foo.ts', 'documentation/poison.md'], { cwd });
    });
    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code-reviewer/,
      'cross-category rename must trigger code-reviewer (--no-renames defense)');
    assert.match(r.stdout, /spec-reviewer/);
  });

  it('force-push / unrelated lineage: merge-base guard falls through to all three', () => {
    // If LAST_ACK is no longer an ancestor of CURRENT (force-push, rebase,
    // branch swap), the diff classification cannot be trusted. The hook
    // must fall through to demanding all three lanes.
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    // Build an unrelated orphan branch and use its tip as the PR HEAD
    spawnSync('git', ['checkout', '-q', '--orphan', 'orphan'], { cwd });
    spawnSync('git', ['rm', '-rfq', '.'], { cwd });
    mkdirSync(join(cwd, 'sdd'), { recursive: true });
    writeFileSync(join(cwd, 'sdd/README.md'), '# orphan\n');
    writeFileSync(join(cwd, 'random.txt'), 'orphan\n');
    spawnSync('git', ['add', '-A'], { cwd });
    spawnSync('git', ['commit', '-q', '-m', 'orphan'], { cwd });
    const orphanSha = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const binDir = fakeGh(cwd, ghReturning('OPEN', orphanSha, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /spec-reviewer/);
  });

  it('root-doc files (CONTRIBUTING.md, SECURITY.md, LICENSE) classify as docs-only', () => {
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      writeFileSync(join(cwd, 'CONTRIBUTING.md'), 'changed\n');
    });
    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /doc-updater/);
    assert.doesNotMatch(r.stdout, /code-reviewer/);
  });

  it('mixed sdd + behavioral push: still requires all three', () => {
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      writeFileSync(join(cwd, 'sdd/storage.md'), 'changed\n');
      writeFileSync(join(cwd, 'src/foo.ts'), 'changed\n');
    });
    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code-reviewer/);
    assert.match(r.stdout, /spec-reviewer/);
  });

  it('tricky prefix "sddx.md" does NOT match sdd/* — classifies as behavioral', () => {
    // Defense against naive prefix-based bypasses: a file at repo root
    // whose name starts with "sdd" must not be mistaken for spec content.
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      writeFileSync(join(cwd, 'sddx.md'), 'tricky\n');
    });
    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /code-reviewer/,
      'sddx.md must be behavioral, not spec — sdd/* requires literal slash');
  });

  it('docs-only push: completing doc-updater advances the checkpoint', () => {
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      writeFileSync(join(cwd, 'documentation/architecture.md'), 'changed\n');
    });
    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-18T12:00:00.000Z'),
      AGENT_LINE('doc-updater', '2026-05-18T12:00:05.000Z', 'toolu_du1'),
      DONE_LINE('toolu_du1'),
      // A one-lane round is still a round: its findings are read or they are not.
      TRIAGE_LINE(),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /FIX phase/,
      'a docs-only round with its verdict published is complete, so the fix phase drives');
    assert.doesNotMatch(r.stdout, /run code-reviewer|run spec-reviewer/,
      'docs-only push must not demand the lanes it does not own');
    const gcd = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const ack = readFileSync(join(cwd, gcd, 'sdd-review-ack-pr-42'), 'utf-8').trim();
    assert.equal(ack, tip,
      'checkpoint must advance to current PR HEAD on docs-only pipeline completion');
  });

  // Regression guard for the HIGH-1 fail-safe direction fix shipped in
  // commit d6b3c39. Before the fix the Stop hook did `. lib/lane-classifier.sh
  // || exit 0`, so a partially-deployed install with a present gate hook
  // but a missing helper would silently bypass enforcement entirely. After
  // the fix REQUIRED_LANES is pre-seeded to the legacy all-three set and
  // the `if . source; then ...; fi` block only overrides it on successful
  // load. This test copies the hook to an isolated tmpdir whose lib/
  // contains gh-pr-state.sh (the hook also needs that helper) but NOT
  // lane-classifier.sh, then asserts the hook STILL blocks. Reverting the
  // change to `|| exit 0` would make this test see an empty stdout.
  it('fail-closed: missing lane-classifier.sh still blocks with all-three lanes', () => {
    const { cwd, baseSha } = makeLaneFixture();
    ackBase(cwd, baseSha);
    const tip = advanceWith(cwd, () => {
      // Diff is documentation-only - if the classifier loaded, it would
      // return only `doc-updater`. With the classifier missing, the
      // fail-closed fallback must demand all three lanes regardless.
      writeFileSync(join(cwd, 'documentation/architecture.md'), 'changed\n');
    });

    const isolatedDir = mkdtempSync(join(tmpdir(), 'enforce-spawn-no-classifier-'));
    const isolatedHook = join(isolatedDir, 'enforce-review-spawn.sh');
    const isolatedLib = join(isolatedDir, 'lib');
    mkdirSync(isolatedLib, { recursive: true });
    writeFileSync(isolatedHook, readFileSync(HOOK, 'utf-8'));
    chmodSync(isolatedHook, 0o755);
    // gh-pr-state.sh is required by the hook for the gh round-trip;
    // lane-classifier.sh is deliberately omitted to simulate a stale
    // install where the classifier file failed to deploy.
    const ghPrStateSrc = join(dirname(HOOK), 'lib/gh-pr-state.sh');
    writeFileSync(join(isolatedLib, 'gh-pr-state.sh'), readFileSync(ghPrStateSrc, 'utf-8'));

    const binDir = fakeGh(cwd, ghReturning('OPEN', tip, 'main'));
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
    const r = spawnSync('bash', [isolatedHook], {
      cwd,
      input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: t }),
      encoding: 'utf-8',
      env,
    });

    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/,
      'fail-closed: a missing lane-classifier.sh must still block, not silently exit 0');
    assert.match(r.stdout, /code-reviewer/,
      'fail-closed fallback must demand code-reviewer (all-three default)');
    assert.match(r.stdout, /spec-reviewer/,
      'fail-closed fallback must demand spec-reviewer');
    assert.match(r.stdout, /doc-updater/,
      'fail-closed fallback must demand doc-updater');
  });
});
