import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  monitorCi,
  resolveCiMonitorRequest,
  runCommand,
} from '../../preseed/agents/pi/skills/ci-monitoring/scripts/monitor-ci.mjs';

const REPO = 'codeflare/codeflare';
const PR = 123;
const HEAD = 'ef819ed35e9cc57d66209d1330bc8a87519736df';
const NEXT_HEAD = '0123456789abcdef0123456789abcdef01234567';
const POLL_MS = 15_000;
const REQUEST_CWD = '/tmp/codeflare-request-repo';

function commandResult(value, exitCode = 0) {
  return {
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: exitCode === 0 ? '' : 'gh returned a nonzero status',
    exitCode,
  };
}

function openPr(patch = {}) {
  return {
    number: PR,
    state: 'OPEN',
    baseRefName: 'main',
    headRefOid: HEAD,
    ...patch,
  };
}

function hasInvalidRepoScopedPrView(args) {
  if (args[0] !== 'pr' || args[1] !== 'view' || !args.includes('--repo')) return false;

  const valueFlags = new Set(['--repo', '--json', '--jq', '--template']);
  for (let index = 2; index < args.length; index += 1) {
    if (valueFlags.has(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith('-')) return false;
  }
  return true;
}

function check(name, bucket, patch = {}) {
  return {
    name,
    workflow: `${name} workflow`,
    bucket,
    state: bucket === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
    link: `https://github.test/${REPO}/actions/runs/${name}`,
    ...patch,
  };
}

function expectedRequest() {
  return {
    subagent_type: 'ci-monitor',
    description: `Monitor PR #${PR} CI`,
    prompt: `repo=${REPO} pr=${PR} head=${HEAD}`,
    run_in_background: true,
    inherit_context: false,
  };
}

function fakeClock() {
  let time = 0;
  const sleeps = [];
  return {
    clock: { now: () => time },
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
    elapsed: () => time,
    sleeps,
  };
}

function monitorRunner({ heads = [HEAD], checks = [], fallbackChecks = [] } = {}) {
  let headCalls = 0;
  let checkCalls = 0;

  const runner = async (_command, args) => {
    if (args.includes('view')) {
      const headRefOid = heads[Math.min(headCalls, heads.length - 1)] ?? HEAD;
      headCalls += 1;
      return commandResult({ headRefOid });
    }
    if (args.includes('checks')) {
      const value = checks[Math.min(checkCalls, checks.length - 1)] ?? fallbackChecks;
      checkCalls += 1;
      if (value instanceof Error) throw value;
      return value && Object.hasOwn(value, 'stdout') ? value : commandResult(value);
    }
    throw new Error(`unexpected gh operation: ${args.join(' ')}`);
  };

  return {
    runner,
    headCalls: () => headCalls,
    checkCalls: () => checkCalls,
  };
}

async function runMonitor(options = {}) {
  const time = fakeClock();
  const github = monitorRunner(options);
  const output = await monitorCi({
    repo: REPO,
    pr: PR,
    head: HEAD,
    runner: github.runner,
    clock: time.clock,
    sleep: time.sleep,
  });
  return { output, github, time };
}

function assertResult(output, status) {
  const lines = output.trimEnd().split('\n');
  assert.equal(lines[0], `CI_RESULT ${status}`);
  assert.equal(lines.filter((line) => line.startsWith('CI_RESULT ')).length, 1);
  assert.match(output, new RegExp(`pr=${PR}(?:\\s|$)`));
  assert.match(output, new RegExp(`head=${HEAD}(?:\\s|$)`));
  return lines;
}

test('REQ-AGENT-068 AC7: command execution is bounded when a provider hangs', async () => {
  const result = await runCommand(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 200)'],
    { timeout: 20 },
  );

  assert.equal(result.exitCode, 1);
});

test('REQ-AGENT-068 AC1: eligible push resolves the affected PR exactly once', async () => {
  const requests = [];
  let lookupArgs;
  const request = await resolveCiMonitorRequest({
    event: 'push',
    changed: true,
    repo: REPO,
    pr: PR,
    cwd: REQUEST_CWD,
    reviewState: 'launched',
    runner: async (_command, args) => {
      lookupArgs = args;
      return commandResult(openPr());
    },
  });
  if (request) requests.push(request);

  assert.deepEqual(requests, [expectedRequest()]);
  assert.deepEqual(lookupArgs, [
    'pr', 'view', String(PR), '--repo', REPO,
    '--json', 'number,state,baseRefName,headRefOid',
  ]);
});

test('REQ-AGENT-068 AC1: eligible PR creation uses the affected repository cwd', async () => {
  const requests = [];
  let lookupCwd;
  const request = await resolveCiMonitorRequest({
    event: 'pr-create',
    changed: true,
    repo: REPO,
    pr: PR,
    cwd: REQUEST_CWD,
    reviewState: 'launched',
    runner: async (_command, args, options) => {
      lookupCwd = options.cwd;
      return hasInvalidRepoScopedPrView(args) ? commandResult('', 1) : commandResult(openPr());
    },
  });
  if (request) requests.push(request);

  assert.deepEqual(requests, [expectedRequest()]);
  assert.equal(lookupCwd, REQUEST_CWD);
});

test('REQ-AGENT-068 AC1: CI request requires explicit review launch state and repository cwd', async () => {
  const base = { event: 'pr-create', changed: true, repo: REPO, pr: PR, runner: async () => commandResult(openPr()) };

  assert.equal(await resolveCiMonitorRequest({ ...base, cwd: REQUEST_CWD }), null);
  assert.equal(await resolveCiMonitorRequest({ ...base, reviewState: 'launched' }), null);
  assert.equal(await resolveCiMonitorRequest({ ...base, cwd: REQUEST_CWD, reviewState: 'pending' }), null);
});

test('REQ-AGENT-068 AC1: missing or malformed affected PR numbers fail closed', async () => {
  let calls = 0;
  const base = {
    event: 'push',
    changed: true,
    repo: REPO,
    cwd: REQUEST_CWD,
    reviewState: 'launched',
    runner: async () => {
      calls += 1;
      return commandResult(openPr());
    },
  };

  for (const pr of [undefined, 0, -1, Number.NaN, '42']) {
    assert.equal(await resolveCiMonitorRequest({ ...base, pr }), null);
  }
  assert.equal(calls, 0);
});

test('REQ-AGENT-068 AC1: unsupported, unchanged, missing, closed, and integration PR events return no request', async () => {
  const cases = [
    ['unsupported event', { event: 'review', changed: true }, openPr()],
    ['unchanged push', { event: 'push', changed: false }, openPr()],
    ['no PR', { event: 'push', changed: true }, null],
    ['closed PR', { event: 'push', changed: true }, openPr({ state: 'CLOSED' })],
    ['integration base', { event: 'push', changed: true }, openPr({ baseRefName: 'develop' })],
  ];

  for (const [name, event, pr] of cases) {
    const request = await resolveCiMonitorRequest({
      ...event,
      repo: REPO,
      pr: PR,
      cwd: REQUEST_CWD,
      reviewState: 'launched',
      runner: async () => commandResult(pr),
    });
    assert.equal(request, null, name);
  }
});

test('REQ-AGENT-068 AC2: empty check rows retry and time out after five minutes without success', async () => {
  const { output, github, time } = await runMonitor({ fallbackChecks: [] });

  assertResult(output, 'timeout');
  assert.doesNotMatch(output, /^CI_RESULT success/m);
  assert.ok(github.checkCalls() > 1);
  assert.ok(time.elapsed() >= 5 * 60_000);
  assert.ok(time.elapsed() < 5 * 60_000 + POLL_MS);
});

test('REQ-AGENT-068 AC2: valid check JSON is parsed despite gh exit statuses 1 and 8', async () => {
  const rows = [check('portable-provider', 'pass')];
  const { output, github } = await runMonitor({
    checks: [commandResult(rows, 1), commandResult(rows, 8)],
  });

  assertResult(output, 'success');
  assert.equal(github.checkCalls(), 2);
});

test('REQ-AGENT-068 AC2/AC3: pending checks wait for a stable pass and skipping fingerprint', async () => {
  const terminal = [
    check('lint / linux', 'pass', { workflow: 'Buildkite mirror' }),
    check('license scan', 'skipping', { workflow: 'External compliance' }),
  ];
  const { output, github } = await runMonitor({
    checks: [[check('lint / linux', 'pending')], terminal, [...terminal].reverse()],
  });

  const lines = assertResult(output, 'success');
  assert.equal(github.checkCalls(), 3);
  assert.match(output, /name=lint \/ linux/);
  assert.match(output, /workflow=Buildkite mirror/);
  assert.match(output, /name=license scan/);
  assert.match(output, /state=COMPLETED/);
  assert.ok(lines.length <= 8, 'result should remain concise');
});

test('REQ-AGENT-068 AC3: a changed terminal fingerprint resets the stability requirement', async () => {
  const first = [check('unit', 'pass')];
  const changed = [check('unit', 'pass'), check('security', 'pass')];
  const { output, github } = await runMonitor({ checks: [first, changed, changed] });

  assertResult(output, 'success');
  assert.equal(github.checkCalls(), 3);
});

test('REQ-AGENT-068 AC5: failed and cancelled arbitrary providers report failure with links', async () => {
  const failed = check('Vendor A / shard 9', 'fail', { workflow: 'Provider Alpha', state: 'FAILURE' });
  const cancelled = check('queue-check', 'cancel', { workflow: 'Provider Beta', state: 'CANCELLED' });
  const { output, github } = await runMonitor({ checks: [[failed, cancelled]] });

  assertResult(output, 'failure');
  assert.equal(github.checkCalls(), 1);
  for (const row of [failed, cancelled]) {
    assert.match(output, new RegExp(`name=${row.name.replace('/', '\\/')}`));
    assert.match(output, new RegExp(`workflow=${row.workflow}`));
    assert.match(output, new RegExp(`state=${row.state}`));
    assert.match(output, new RegExp(row.link.replaceAll('/', '\\/')));
  }
});

test('REQ-AGENT-090 AC1: one appended head character is corrected only against the authoritative PR head', async () => {
  const time = fakeClock();
  const github = monitorRunner({
    checks: [[check('unit', 'pass')], [check('unit', 'pass')]],
  });
  const output = await monitorCi({
    repo: REPO,
    pr: PR,
    head: `${HEAD}f`,
    runner: github.runner,
    clock: time.clock,
    sleep: time.sleep,
  });

  assertResult(output, 'success');
  assert.equal(github.checkCalls(), 2);
});

test('REQ-AGENT-090 AC2: unrelated malformed heads remain invalid', async () => {
  const time = fakeClock();
  const github = monitorRunner();
  const malformed = `f${HEAD}`;
  const output = await monitorCi({
    repo: REPO,
    pr: PR,
    head: malformed,
    runner: github.runner,
    clock: time.clock,
    sleep: time.sleep,
  });

  assert.match(output, /^CI_RESULT timeout/m);
  assert.match(output, /invalid_request/);
  assert.match(output, new RegExp(`head=${malformed}`));
  assert.equal(github.checkCalls(), 0);
});

test('REQ-AGENT-068 AC7: malformed and transient GitHub responses never become success', async () => {
  const { output, time } = await runMonitor({
    checks: [commandResult('{not-json', 1), new Error('temporary network failure')],
    fallbackChecks: [check('still-running', 'pending')],
  });

  assertResult(output, 'timeout');
  assert.doesNotMatch(output, /^CI_RESULT success/m);
  assert.ok(time.elapsed() >= 30 * 60_000);
});

test('REQ-AGENT-068 AC7: pending checks enforce the thirty-minute total timeout', async () => {
  const { output, time } = await runMonitor({
    fallbackChecks: [check('long-running', 'pending')],
  });

  assertResult(output, 'timeout');
  assert.ok(time.elapsed() >= 30 * 60_000);
  assert.ok(time.elapsed() < 30 * 60_000 + POLL_MS);
});

test('REQ-AGENT-068 AC4: a superseded head stops before checks are queried', async () => {
  const { output, github } = await runMonitor({ heads: [NEXT_HEAD] });

  assertResult(output, 'timeout');
  assert.match(output, /superseded/);
  assert.match(output, new RegExp(`current_head=${NEXT_HEAD}`));
  assert.equal(github.checkCalls(), 0);
});

test('REQ-AGENT-068 AC4: a superseded head prevents terminal success', async () => {
  const passing = [check('unit', 'pass')];
  const { output, github } = await runMonitor({
    heads: [HEAD, HEAD, HEAD, NEXT_HEAD],
    checks: [passing, passing],
  });

  assertResult(output, 'timeout');
  assert.match(output, /superseded/);
  assert.doesNotMatch(output, /^CI_RESULT success/m);
  assert.equal(github.checkCalls(), 2);
});

test('REQ-AGENT-068 AC4/AC5: a superseded head prevents terminal failure', async () => {
  const { output, github } = await runMonitor({
    heads: [HEAD, NEXT_HEAD],
    checks: [[check('unit', 'fail')]],
  });

  assertResult(output, 'timeout');
  assert.match(output, /superseded/);
  assert.doesNotMatch(output, /^CI_RESULT failure/m);
  assert.equal(github.checkCalls(), 1);
});

test('REQ-AGENT-068 AC6: monitoring creates no Codeflare state, log, or PID files', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'pi-ci-monitor-'));
  const time = fakeClock();
  const github = monitorRunner({
    checks: [[check('unit', 'pass')], [check('unit', 'pass')]],
  });

  try {
    const before = readdirSync(repo, { recursive: true });
    const output = await monitorCi({
      repo: REPO,
      cwd: repo,
      pr: PR,
      head: HEAD,
      runner: github.runner,
      clock: time.clock,
      sleep: time.sleep,
    });
    const after = readdirSync(repo, { recursive: true });

    assertResult(output, 'success');
    assert.deepEqual(after, before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
