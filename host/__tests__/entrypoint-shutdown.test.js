// Behavioral tests of entrypoint.sh's shutdown path for REQ-OPS-010
// (Graceful container shutdown preserves data).
//
// shutdown_handler and its shutdown_once re-entry guard are extracted from
// entrypoint.sh (the extractFunction pattern shared with
// entrypoint-runtime-behavior.test.js) and executed in a real bash with the
// side-effecting collaborators stubbed to an effect log: walk_kill,
// kill_pidfile_subtree, bisync_with_r2, kill, pgrep, sleep. Assertions read
// the observable effects — which sweeps ran in what order, whether the final
// bisync ran, how its exit code was classified, and that the EXIT-trap
// re-entry is a no-op — so gutting the handler fails these tests.
//
// Declarative wiring that cannot be executed (STOPSIGNAL in the Dockerfile,
// the trap registration line, bisync_with_r2's rclone flags) keeps small
// structural assertions.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');
const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');

function extractFunction(name) {
  const lines = entrypoint.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}\\(\\) \\{`).test(line));
  if (start === -1) throw new Error(`Could not locate ${name}() in entrypoint.sh`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  if (end === -1) throw new Error(`Could not locate the end of ${name}()`);
  return lines.slice(start, end + 1).join('\n');
}

/** Exercise the real baseline function with a controlled timeout result. */
function runBaselineTimeout() {
  const fixture = mkdtempSync(join(tmpdir(), 'baseline-timeout-'));
  const runtimeRoot = join(fixture, 'runtime');
  const syncRuntimeDir = join(runtimeRoot, 'sync');
  const recoveryFilter = join(syncRuntimeDir, 'recovery-filters.txt');
  mkdirSync(join(syncRuntimeDir, 'rclone'), { recursive: true });
  writeFileSync(recoveryFilter, '');

  const script = [
    'set -euo pipefail',
    `USER_HOME='${fixture}'`,
    "R2_BUCKET_NAME='bucket'",
    `RCLONE_CONFIG='${join(fixture, 'rclone.conf')}'`,
    `RECOVERY_FILTER_FILE='${recoveryFilter}'`,
    `CODEFLARE_RUNTIME_ROOT='${runtimeRoot}'`,
    `SYNC_RUNTIME_DIR='${syncRuntimeDir}'`,
    'RCLONE_FILTERS=()',
    'timeout() { return 124; }',
    'recover_vanished_files() { return 1; }',
    extractFunction('record_sync_disk_failure'),
    extractFunction('establish_bisync_baseline'),
    'establish_bisync_baseline',
  ].join('\n');

  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const sentinelExists = existsSync(join(syncRuntimeDir, 'bisync-initialized'));
  rmSync(fixture, { recursive: true, force: true });
  return { result, sentinelExists };
}

/**
 * Run shutdown_once -> shutdown_handler in a real bash with stubbed
 * collaborators, mirroring production trap wiring (the EXIT trap re-fires
 * shutdown_once when the handler's `exit 0` runs, exercising the guard on
 * every invocation). Returns the effect log lines and the handler's stdout.
 */
function runShutdown({ bisyncInitialized = true, bisyncRc = 0, rcloneStillRunning = false, initPid = '', terminalPid = '' } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'shutdown-'));
  const logFile = join(fixture, 'effects.log');
  const outFile = join(fixture, 'handler.out');
  const runtimeRoot = join(fixture, 'run');
  const bisyncSentinel = join(runtimeRoot, 'sync/bisync-initialized');
  writeFileSync(logFile, '');
  mkdirSync(dirname(bisyncSentinel), { recursive: true });

  if (bisyncInitialized) writeFileSync(bisyncSentinel, '');

  const script = [
    'exec > "$OUT_FILE" 2>&1',
    'LOG="$LOG_FILE"',
    'walk_kill() { echo "walk_kill:$1:$2" >> "$LOG"; }',
    'kill_pidfile_subtree() { echo "kill_pidfile_subtree:$1" >> "$LOG"; }',
    'bisync_with_r2() { echo "bisync_with_r2" >> "$LOG"; return "${BISYNC_RC_STUB:-0}"; }',
    // Stub kill so no real process is ever signalled; the watchdog subshell
    // then finishes on its own (sleeps are shortened below) and the handler's
    // real `wait` reaps it before the script exits.
    'kill() { echo "kill:$*" >> "$LOG"; }',
    'pgrep() { return "${PGREP_RC:-1}"; }',
    'sleep() { command sleep 0.01; }',
    `BISYNC_INIT_PID=${initPid ? `'${initPid}'` : "''"}`,
    `TERMINAL_PID=${terminalPid ? `'${terminalPid}'` : "''"}`,
    `CODEFLARE_RUNTIME_ROOT='${runtimeRoot}'`,
    extractFunction('shutdown_handler'),
    extractFunction('shutdown_once'),
    'SHUTDOWN_RAN=0',
    'trap shutdown_once EXIT',
    'shutdown_once',
  ].join('\n');

  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      OUT_FILE: outFile,
      LOG_FILE: logFile,
      BISYNC_RC_STUB: String(bisyncRc),
      PGREP_RC: rcloneStillRunning ? '0' : '1',
    },
  });

  const log = readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
    .map((line) => line.replaceAll(runtimeRoot, '/run/codeflare'));
  const out = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
  rmSync(fixture, { recursive: true, force: true });
  return { result, log, out };
}

// ---------------------------------------------------------------------------
// REQ-OPS-010: Graceful container shutdown preserves data
// ---------------------------------------------------------------------------

// REQ-SESSION-011: Graceful shutdown with final sync
// REQ-VAULT-005 / REQ-STOR-005: shutdown watchdog + daemon teardown

describe('REQ-OPS-010: Graceful container shutdown preserves data', () => {
  it('REQ-OPS-010 AC1: the container image declares STOPSIGNAL SIGINT', () => {
    assert.ok(
      dockerfile.includes('STOPSIGNAL SIGINT'),
      'Dockerfile must declare STOPSIGNAL SIGINT so the orchestrator sends SIGINT on container stop'
    );
  });

  it('REQ-OPS-010 AC2: the container entrypoint trap handler catches SIGINT/SIGTERM signals', () => {
    // Registering ONE function for a signal trap and for EXIT runs it twice per
    // shutdown: bash's re-entry guard is per-trap and the handler ends in
    // `exit 0`. So the trap must name a guarded wrapper, not the handler.
    const trap = entrypoint.match(/^trap (\S+) (.*)$/m);
    assert.ok(trap, 'entrypoint.sh must register a shutdown trap');
    for (const sig of ['SIGTERM', 'SIGINT', 'EXIT']) {
      assert.ok(trap[2].includes(sig), `the shutdown trap must cover ${sig}`);
    }
    assert.notEqual(
      trap[1],
      'shutdown_handler',
      'the handler is trapped directly on both a signal and EXIT, so it runs twice; trap a guarded wrapper instead'
    );

    // Behavioral: the EXIT trap re-fires shutdown_once when the handler's
    // `exit 0` runs. The guard must make that second entry a no-op — a second
    // handler pass would clear the bisync lock left by a SIGKILLed rclone and
    // start a FRESH sync inside the last seconds of the shutdown budget.
    const { log } = runShutdown({ bisyncInitialized: true });
    const bisyncRuns = log.filter((line) => line === 'bisync_with_r2');
    assert.equal(bisyncRuns.length, 1, `the guarded handler must run exactly once (saw ${bisyncRuns.length} bisync runs)`);
  });

  it('REQ-OPS-010 AC3 / REQ-OPS-048 AC1: trap handler kills services through protected runtime PID files', () => {
    const { log } = runShutdown({ initPid: '4242' });

    // The background init subshell dies FIRST (it would otherwise restart
    // supervisors after the sweep), then the pidfile sweep in its documented
    // order: sync daemon, vault monitor, SilverBullet, OpenVSCode generation
    // before the supervisor itself.
    const sweep = log.filter((line) => line.startsWith('walk_kill:') || line.startsWith('kill_pidfile_subtree:'));
    assert.deepEqual(sweep, [
      'walk_kill:TERM:4242',
      'kill_pidfile_subtree:/run/codeflare/sync/sync-daemon.pid',
      'kill_pidfile_subtree:/run/codeflare/services/vault-monitor.pid',
      'kill_pidfile_subtree:/run/codeflare/services/silverbullet.pid',
      'kill_pidfile_subtree:/run/codeflare/openvscode/generation.pid',
      'kill_pidfile_subtree:/run/codeflare/openvscode/supervisor.pid',
    ]);
  });

  it('REQ-OPS-010 AC4: final rclone bisync with --ignore-checksum --max-delete 100 runs to R2 before exit', () => {
    // The rclone flags live in bisync_with_r2 (stubbed in the harness), so
    // they stay structural assertions on the real function.
    assert.ok(entrypoint.includes('--ignore-checksum'), 'entrypoint.sh must pass --ignore-checksum to rclone bisync');
    assert.ok(entrypoint.includes('--max-delete 100'), 'entrypoint.sh must pass --max-delete 100 to rclone bisync');

    // Behavioral: with the baseline sentinel present, the handler runs the
    // final bisync and classifies a zero exit as success.
    const { log, out, result } = runShutdown({ bisyncInitialized: true, bisyncRc: 0 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(log.includes('bisync_with_r2'), 'shutdown_handler must invoke bisync_with_r2 for the final sync');
    assert.ok(out.includes('Final bisync completed successfully'), `success classification missing from handler output:\n${out}`);
  });

  it('REQ-OPS-010 AC5: bisync-initialized flag is touched on the timeout path to ensure final bisync runs', () => {
    const timeout = runBaselineTimeout();
    assert.equal(timeout.result.status, 0, timeout.result.stderr);
    assert.equal(timeout.sentinelExists, true, 'a baseline timeout must create the protected bisync sentinel');

    // Behavioral: the handler gates the final bisync on the sentinel — absent
    // sentinel means no bisync attempt and an explicit skip line.
    const skipped = runShutdown({ bisyncInitialized: false, terminalPid: '12345' });
    assert.ok(!skipped.log.includes('bisync_with_r2'), 'final bisync must NOT run when the baseline was never established');
    assert.ok(skipped.out.includes('Skipping final bisync'), `skip path missing from handler output:\n${skipped.out}`);
    // The rest of the teardown still happens on the skip path.
    assert.ok(skipped.log.includes('kill:12345'), 'terminal server must still be killed when the final bisync is skipped');
  });

  it('REQ-OPS-010 AC5: the final sync waits for the daemon rclone to exit before it starts', () => {
    // Regression guard for a silent data-loss path: walk_kill only sends TERM,
    // so without this wait bisync_with_r2 could start while the daemon's
    // rclone was still alive, see a live `rclone bisync` in its stale-lock
    // check, leave the .lck in place and fast-fail. With pgrep reporting a
    // live rclone for the whole capped wait, the handler must surface the
    // stale-lock warning BEFORE starting the final bisync — and still run it.
    const { log, out } = runShutdown({ bisyncInitialized: true, rcloneStillRunning: true });
    const warnIdx = out.indexOf('rclone bisync still running after 5s');
    const syncIdx = out.indexOf('Final bisync to R2');
    assert.notEqual(warnIdx, -1, `capped quiesce wait must warn when rclone never exits:\n${out}`);
    assert.notEqual(syncIdx, -1, 'final bisync must still start after the capped wait');
    assert.ok(warnIdx < syncIdx, 'the reap-wait (and its warning) must precede the final bisync');
    assert.ok(log.includes('bisync_with_r2'), 'the final bisync still runs after the capped wait');
  });

  it('REQ-OPS-010 AC6: terminal server is killed after the final sync completes', () => {
    const { log, out } = runShutdown({ bisyncInitialized: true, terminalPid: '12345' });
    const bisyncIdx = log.indexOf('bisync_with_r2');
    const killIdx = log.indexOf('kill:12345');
    assert.notEqual(bisyncIdx, -1, 'final bisync must run');
    assert.notEqual(killIdx, -1, 'shutdown_handler must kill $TERMINAL_PID');
    assert.ok(bisyncIdx < killIdx, 'the terminal server must be killed AFTER the final sync (it serves the session until data is safe)');
    assert.ok(out.includes('Shutdown complete'), 'handler must reach its completion line');
  });

  it('classifies a watchdog-killed final bisync (143/137) as a timeout, and other non-zero codes as failures', () => {
    // 143 = 128+SIGTERM from the watchdog's kill_subtree: the operator-visible
    // contract is a TIMED OUT line, not a generic failure.
    const timedOut = runShutdown({ bisyncInitialized: true, bisyncRc: 143 });
    assert.ok(timedOut.out.includes('Final bisync TIMED OUT'), `rc=143 must classify as timeout:\n${timedOut.out}`);

    const failed = runShutdown({ bisyncInitialized: true, bisyncRc: 7 });
    assert.ok(failed.out.includes('Final bisync failed with rc=7'), `rc=7 must classify as failure:\n${failed.out}`);
    assert.ok(!failed.out.includes('TIMED OUT'), 'a plain failure must not be reported as a timeout');
  });
});
