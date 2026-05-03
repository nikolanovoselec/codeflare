// Real behavioral tests for the SDD Stop hook.
//
// These tests spawn the actual bash script with stdin input and assert
// on exit code + stdout. They exercise the full hook logic against
// fixture transcripts and a fake `gh` binary on PATH.
//
// Each test uses a fresh temp directory as cwd so hook side-effects
// (.git/sdd-last-ack-pr-head, .git/sdd-review-block-count, deleted
// sdd/.skip-next-review sentinel) don't bleed between tests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, readFileSync } from 'node:fs';
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

function ghReturning(state, headSha) {
  return `case "$*" in
  *"pr view"*"--json state,headRefOid"*)
    echo '{"state":"${state}","headRefOid":"${headSha}"}'
    exit 0
    ;;
  *) exit 0 ;;
esac`;
}

function ghNoPR() {
  return `case "$*" in
  *"pr view"*) exit 1 ;;
  *) exit 0 ;;
esac`;
}

function writeTranscript(cwd, lines) {
  const path = join(cwd, 'transcript.jsonl');
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function runHook(cwd, { event = 'Stop', transcriptPath, binDir }) {
  const env = { ...process.env };
  if (binDir) env.PATH = `${binDir}:${process.env.PATH}`;
  // Prevent the hook from finding a real gh in PATH if we want it absent
  return spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify({
      hook_event_name: event,
      transcript_path: transcriptPath,
    }),
    encoding: 'utf-8',
    env,
  });
}

// Real Bash tool_use lines as the transcript would contain them
const PUSH_LINE = (ts = '2026-05-03T12:00:00.000Z') =>
  JSON.stringify({
    type: 'assistant',
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

const AGENT_LINE = (subagentType, ts, toolUseId = 'toolu_x') =>
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Task',
          id: toolUseId,
          input: { subagent_type: subagentType },
        },
      ],
    },
    timestamp: ts,
  });

const SPEC_DONE_LINE = (toolUseId = 'toolu_sr1') =>
  `<task-notification><tool-use-id>${toolUseId}</tool-use-id><status>completed</status></task-notification>`;

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
  it('exits 0 silently on SubagentStop (only Stop is enforced)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { event: 'SubagentStop', transcriptPath: t });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('enforce-review-spawn.sh — bypass 1: sentinel file', () => {
  it('exits 0 and deletes the sentinel file (one-shot)', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    writeFileSync(join(cwd, 'sdd/.skip-next-review'), '');
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(join(cwd, 'sdd/.skip-next-review')), false,
      'sentinel must be deleted on use (one-shot semantics)');
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

  it('exits 0 silently when PR HEAD matches LAST_ACK checkpoint', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = 'abc123def456';
    const binDir = fakeGh(cwd, ghReturning('OPEN', headSha));
    // Pre-seed the checkpoint so the cheap pre-check OR the gh-result check matches
    const r1 = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd, encoding: 'utf-8' });
    const ackFile = join(cwd, r1.stdout.trim(), 'sdd-last-ack-pr-head');
    writeFileSync(ackFile, headSha);
    const t = writeTranscript(cwd, [PUSH_LINE()]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
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

  it('blocks demanding doc-updater after spec-reviewer completes', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    const t = writeTranscript(cwd, [
      PUSH_LINE('2026-05-03T12:00:00.000Z'),
      AGENT_LINE('code-reviewer', '2026-05-03T12:00:01.000Z', 'toolu_cr1'),
      AGENT_LINE('spec-reviewer', '2026-05-03T12:00:02.000Z', 'toolu_sr1'),
      SPEC_DONE_LINE('toolu_sr1'),
    ]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision"\s*:\s*"block"/);
    assert.match(r.stdout, /doc-updater/);
  });

  it('exits 0 + advances checkpoint when full pipeline completes', () => {
    const cwd = makeFixture();
    withSdd(cwd);
    const headSha = 'fullpipelinesha';
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
    assert.equal(r.stdout, '');
    const gitCommonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd, encoding: 'utf-8',
    }).stdout.trim();
    const ackFile = join(cwd, gitCommonDir, 'sdd-last-ack-pr-head');
    assert.equal(readFileSync(ackFile, 'utf-8').trim(), headSha,
      'checkpoint must advance to the just-acked PR HEAD SHA');
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
  it('exits 0 silently when timestamp extraction fails (regression for fail-open bug)', () => {
    // This test pins the fix for the awk `ts > ""` fail-open bug.
    // A push line with no extractable timestamp must NOT silently
    // skip enforcement via awk's string-compare semantics — it must
    // hit the explicit empty-PUSH_TS guard and exit 0.
    const cwd = makeFixture();
    withSdd(cwd);
    const binDir = fakeGh(cwd, ghReturning('OPEN', 'newsha'));
    // Bash command line with NO timestamp field
    const pushLineNoTs = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'git push origin develop' } },
        ],
      },
    });
    const t = writeTranscript(cwd, [pushLineNoTs]);
    const r = runHook(cwd, { transcriptPath: t, binDir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'missing timestamp must short-circuit before the spawned_after_push helper, ' +
      'not silently disable enforcement via awk string comparison');
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
