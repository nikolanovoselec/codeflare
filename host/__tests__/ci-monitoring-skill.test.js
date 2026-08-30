import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { monitorCi } from '../../preseed/agents/claude/skills/ci-monitoring/scripts/monitor-ci.mjs';

const REPO = 'owner/repo';
const PR = 42;
const HEAD = 'ef819ed35e9cc57d66209d1330bc8a87519736df';

function result(value, exitCode = 0) {
  return { stdout: JSON.stringify(value), stderr: '', exitCode };
}

function run(conclusion, patch = {}) {
  return {
    databaseId: 1,
    workflowName: 'PR Checks',
    headSha: HEAD,
    status: conclusion ? 'completed' : 'in_progress',
    conclusion: conclusion ?? '',
    event: 'pull_request',
    url: 'https://github.test/owner/repo/actions/runs/1',
    ...patch,
  };
}

function fakeClock() {
  let time = 0;
  return {
    clock: { now: () => time },
    sleep: async (milliseconds) => { time += milliseconds; },
    elapsed: () => time,
  };
}

async function drive(runRows, { unavailable = false } = {}) {
  let calls = 0;
  const time = fakeClock();
  const output = await monitorCi({
    repo: REPO,
    pr: PR,
    head: HEAD,
    clock: time.clock,
    sleep: time.sleep,
    runner: async (_command, args) => {
      assert.deepEqual(args.slice(0, 7), ['run', 'list', '--repo', REPO, '--commit', HEAD, '--limit']);
      if (unavailable) throw new Error('gh unavailable');
      const rows = runRows[Math.min(calls, runRows.length - 1)];
      calls += 1;
      return result(rows);
    },
  });
  return { output, calls, elapsed: time.elapsed() };
}

function assertIdentity(output, status) {
  assert.match(output, new RegExp(`^CI_RESULT ${status}\\n`));
  assert.match(output, new RegExp(`pr=${PR}(?:\\s|$)`));
  assert.match(output, new RegExp(`head=${HEAD}(?:\\s|$)`));
  assert.match(output, new RegExp(`repo=${REPO}(?:\\s|$)`));
}

test('REQ-AGENT-070 AC3/AC4: Claude attached CI monitor returns correlated success only after a stable terminal fingerprint', async () => {
  const monitored = await drive([[run('success')], [run('success')]]);

  assert.equal(monitored.calls, 2);
  assertIdentity(monitored.output, 'success');
});

test('REQ-AGENT-070 AC5: Claude waits for all workflows and reports every failed row together', async () => {
  const firstFailure = run('failure');
  const secondFailure = run('cancelled', {
    databaseId: 2,
    workflowName: 'Container Image',
    url: 'https://github.test/owner/repo/actions/runs/2',
  });
  const pending = run(null, {
    databaseId: 2,
    workflowName: 'Container Image',
    url: 'https://github.test/owner/repo/actions/runs/2',
  });
  const terminal = [firstFailure, secondFailure];
  const monitored = await drive([
    [firstFailure, pending],
    terminal,
    [...terminal].reverse(),
  ]);

  assert.equal(monitored.calls, 3);
  assertIdentity(monitored.output, 'failure');
  assert.match(monitored.output, /link=https:\/\/github\.test\/owner\/repo\/actions\/runs\/1/);
  assert.match(monitored.output, /link=https:\/\/github\.test\/owner\/repo\/actions\/runs\/2/);
});

test('REQ-AGENT-070 AC6: Claude attached CI monitor reports unavailable GitHub access as timeout', async () => {
  const monitored = await drive([], { unavailable: true });

  assert.equal(monitored.calls, 0);
  assert.equal(monitored.elapsed, 8 * 60_000,
    'monitor deadline must remain below the Agent Bash timeout');
  assertIdentity(monitored.output, 'timeout');
  assert.match(monitored.output, /deadline_exceeded/);
});

test('REQ-AGENT-070 AC6: Claude attached CI monitor rejects valid-looking output from a failed gh command', async () => {
  const time = fakeClock();
  const output = await monitorCi({
    repo: REPO,
    pr: PR,
    head: HEAD,
    clock: time.clock,
    sleep: time.sleep,
    runner: async () => result([run('success')], 1),
  });

  assertIdentity(output, 'timeout');
  assert.match(output, /deadline_exceeded/);
});

test('REQ-OPS-049 AC4: attached Claude CI monitoring creates no script, PID, or result-log artifact', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'claude-attached-ci-'));
  try {
    const before = readdirSync(cwd);
    const time = fakeClock();
    const output = await monitorCi({
      repo: REPO,
      pr: PR,
      head: HEAD,
      cwd,
      clock: time.clock,
      sleep: time.sleep,
      runner: async () => result([run('failure')]),
    });
    assertIdentity(output, 'failure');
    assert.deepEqual(readdirSync(cwd), before);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
