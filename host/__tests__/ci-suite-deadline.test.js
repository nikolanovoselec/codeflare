import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BOUNDED_SUITE = join(ROOT, 'scripts/ci/run-bounded-suite.sh');
const REPORT_GATE = join(ROOT, 'scripts/ci/check-vitest-report.mjs');
const TEARDOWN_CRASH = '[vitest-pool]: Worker cloudflare-pool emitted error.\n';

// Linux CI can retain killed, orphaned children briefly as zombies. Those are
// dead (and cannot hold stdio open), even though kill(pid, 0) still succeeds.
function processState(pid) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    return { state: fields[0], started: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined;
    throw error;
  }
}

function ownedProcess(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
}

function killOwnedProcess(record) {
  if (!Number.isInteger(record?.pid) || !record.started || processState(record.pid)?.started !== record.started) return;
  try {
    process.kill(record.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

// Both processes ignore TERM, emit heartbeats, and retain stdout/stderr. The
// parent records its child immediately after spawning so failure cleanup also
// owns a child that has not reached its first heartbeat yet.
const RESISTANT_COMMAND = `
  const { spawn } = require('node:child_process');
  const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
  const { join } = require('node:path');
  const root = process.argv[1];
  const role = process.argv[2] || 'parent';
  process.on('SIGTERM', () => {});
  function identity(pid) {
    const fields = readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ').at(-1).split(' ');
    return { pid, started: fields[19] };
  }
  if (role === 'parent') writeFileSync(join(root, role + '.pid.json'), JSON.stringify(identity(process.pid)));
  function heartbeat() {
    appendFileSync(join(root, role + '.heartbeat'), 'tick\\n');
    process.stdout.write(role + ' stdout tick\\n');
    process.stderr.write(role + ' stderr tick\\n');
  }
  if (role === 'parent') {
    const child = spawn(process.execPath, ['-e', process.env.RESISTANT_COMMAND, root, 'child'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    writeFileSync(join(root, 'child.pid.json'), JSON.stringify(identity(child.pid)));
  }
  heartbeat();
  setInterval(heartbeat, 25);
`;

describe('CI suite deadline and report-gate behavior', () => {
  it('preserves command status and complete combined logs; suppression changes only the live copy', () => {
    const work = mkdtempSync(join(tmpdir(), 'ci-suite-output-'));
    try {
      for (const status of [0, 23]) {
        for (const consoleOutput of ['/dev/stdout', '/dev/null']) {
          const log = join(work, 'captured log.txt');
          const result = spawnSync('bash', [
            BOUNDED_SUITE, '5s', log, consoleOutput,
            'bash', '-c', 'printf "%s\\n" "$1"; printf "%s" "$2" >&2; exit "$3"',
            'fixture', 'stdout with spaces\nsecond stdout line', 'stderr without final newline', String(status),
          ], { encoding: 'utf8', timeout: 7_000, killSignal: 'SIGKILL' });
          const expected = 'stdout with spaces\nsecond stdout line\nstderr without final newline';
          assert.equal(result.error, undefined);
          assert.equal(result.status, status, result.stderr);
          assert.equal(readFileSync(log, 'utf8'), expected);
          assert.equal(result.stdout, consoleOutput === '/dev/null' ? '' : expected);
          assert.equal(result.stderr, '');
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('accepts duration boundaries and rejects invalid budgets before running the command', () => {
    const work = mkdtempSync(join(tmpdir(), 'ci-suite-duration-'));
    try {
      const marker = join(work, 'command-ran');
      for (const duration of ['1s', '150s', '0s', '151s', '1.5s', '1m', '-1s', '']) {
        rmSync(marker, { force: true });
        const valid = duration === '1s' || duration === '150s';
        const result = spawnSync('bash', [
          BOUNDED_SUITE, duration, join(work, 'run.log'), '/dev/null',
          'bash', '-c', 'printf ran > "$1"', 'fixture', marker,
        ], { encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL' });
        assert.equal(result.error, undefined);
        assert.equal(result.status, valid ? 0 : 2, `duration ${JSON.stringify(duration)}: ${result.stderr}`);
        assert.equal(existsSync(marker), valid, 'an invalid budget must not start the command');
        if (!valid) assert.match(result.stderr, /duration|budget/i);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('kills a TERM-resistant command and its stdio-holding child within the whole-pipeline deadline', async () => {
    const work = mkdtempSync(join(tmpdir(), 'ci-suite-deadline-'));
    const log = join(work, 'captured.log');
    const started = performance.now();
    // Match the action's shell caller: an exec'ed timeout may itself receive
    // KILL, which bash exposes to the report gate as exit status 137.
    const runner = spawn('bash', [
      '-c', 'bash "$@"; exit "$?"', 'bounded-suite-test',
      BOUNDED_SUITE, '1s', log, '/dev/stdout', process.execPath, '-e', RESISTANT_COMMAND, work,
    ], {
      detached: true,
      env: { ...process.env, RESISTANT_COMMAND },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runnerIdentity = { pid: runner.pid, started: processState(runner.pid)?.started };
    let stdout = '';
    let stderr = '';
    runner.stdout.on('data', chunk => { stdout += chunk; });
    runner.stderr.on('data', chunk => { stderr += chunk; });
    const closed = new Promise((resolveClose, reject) => {
      runner.once('error', reject);
      runner.once('close', (code, signal) => resolveClose({ code, signal }));
    });
    // Attach a handler immediately, including when startup fails before await.
    closed.catch(() => {});
    let watchdog;
    let cancelled = false;
    const overdue = new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error(`suite pipeline did not close within 4s: ${stderr}`)), 4_000);
    });
    try {
      await Promise.race([(async () => {
        const heartbeatPaths = ['parent', 'child'].map(role => join(work, `${role}.heartbeat`));
        while (!heartbeatPaths.every(existsSync)) {
          if (cancelled) return;
          await delay(10);
        }
        const records = ['parent', 'child'].map(role => ownedProcess(join(work, `${role}.pid.json`)));
        const beforeTerm = heartbeatPaths.map(path => readFileSync(path, 'utf8'));
        for (const record of records) process.kill(record.pid, 'SIGTERM');
        await delay(100);
        for (const [index, path] of heartbeatPaths.entries()) {
          assert.ok(readFileSync(path, 'utf8').length > beforeTerm[index].length,
            'the fixture must keep running after TERM, not exit cooperatively');
        }
        const result = await closed;
        assert.deepEqual(result, { code: 137, signal: null }, stderr);
        assert.ok(performance.now() - started < 4_000, 'deadline must bound command and tee completion');
        const captured = readFileSync(log, 'utf8');
        for (const role of ['parent', 'child']) {
          for (const stream of ['stdout', 'stderr']) {
            assert.ok(stdout.includes(`${role} ${stream} tick\n`));
            assert.ok(captured.includes(`${role} ${stream} tick\n`), 'the deadline must retain the raw artifact');
          }
        }
        const stopped = [...heartbeatPaths, log].map(path => readFileSync(path, 'utf8'));
        await delay(200);
        assert.deepEqual([...heartbeatPaths, log].map(path => readFileSync(path, 'utf8')), stopped,
          'no descendant may keep writing after the suite returns');
        for (const record of records) {
          const current = processState(record.pid);
          assert.ok(!current || current.started !== record.started || ['Z', 'X'].includes(current.state),
            'the command and stdio-holding child must both be dead');
        }
      })(), overdue]);
    } finally {
      cancelled = true;
      clearTimeout(watchdog);
      for (const role of ['parent', 'child']) killOwnedProcess(ownedProcess(join(work, `${role}.pid.json`)));
      // This detached group belongs solely to this invocation. Check its
      // leader's identity before signalling, avoiding any recycled PID.
      if (runnerIdentity.started && processState(runner.pid)?.started === runnerIdentity.started) {
        try { process.kill(-runner.pid, 'SIGKILL'); } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      runner.stdout.destroy();
      runner.stderr.destroy();
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('rejects watchdog exits 124 and 137 despite passing JSON and tolerated teardown evidence', () => {
    const work = mkdtempSync(join(tmpdir(), 'ci-suite-watchdog-gate-'));
    try {
      const report = join(work, 'report.json');
      const log = join(work, 'run.log');
      writeFileSync(report, JSON.stringify({
        numTotalTests: 1,
        numFailedTests: 0,
        numFailedTestSuites: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: [{
          name: join(work, 'example.test.ts'),
          assertionResults: [{ status: 'passed' }],
        }],
      }));
      writeFileSync(log, TEARDOWN_CRASH);
      // The exit-1 control proves this is valid passing evidence and that the
      // known teardown carve-out still works, rather than a malformed fixture
      // causing the watchdog cases to fail for an unrelated reason.
      for (const [status, expected] of [[1, 0], [124, 1], [137, 1]]) {
        const result = spawnSync(process.execPath, [REPORT_GATE, String(status), report, log, 'true'], {
          encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL',
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, expected, `exit ${status}: ${result.stdout}${result.stderr}`);
        if (status === 124 || status === 137) {
          assert.match(result.stderr, /interrupt|terminat|deadline|tim(?:e|ed)[ -]?out|watchdog/i);
          assert.ok(result.stderr.includes(String(status)), 'the rejection must identify the watchdog status');
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
