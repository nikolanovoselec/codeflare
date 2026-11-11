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
// Declarative wiring that cannot be executed (STOPSIGNAL in the Dockerfile
// and the trap registration line) keeps small structural assertions. Rclone
// flags run through the real sync functions with an argv-recording stub.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');
const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');

function syncCompositionFixture() {
  const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../entrypoint.sh'), 'utf8');
  const functions = source.slice(source.indexOf('prepare_managed_resource_filter() {'), source.indexOf('# Step 1: One-way sync FROM R2 TO local'));
  return `${functions}
MANAGED_RESOURCE_FILTER_FILE="$CODEFLARE_RUNTIME_ROOT/sync/managed.filter"
RECOVERY_FILTER_FILE="$CODEFLARE_RUNTIME_ROOT/sync/recovery-filters.txt"
: > "$RECOVERY_FILTER_FILE"
`;
}

function extractFunction(name) {
  const lines = entrypoint.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^${name}\\(\\) \\{`).test(line));
  if (start === -1) throw new Error(`Could not locate ${name}() in entrypoint.sh`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  if (end === -1) throw new Error(`Could not locate the end of ${name}()`);
  const body = lines.slice(start, end + 1).join('\n');
  if (['initial_sync_from_r2', 'establish_bisync_baseline', 'bisync_with_r2'].includes(name)) {
    return `${syncCompositionFixture()}\nsource ${JSON.stringify(resolve(repoRoot, 'scripts/rclone-conflict-cleanup.sh'))}\n${body}`;
  }
  return body;
}

/** Execute a real sync function with rclone stubbed to record its argv. */
function runRcloneArgs(functionName) {
  const fixture = mkdtempSync(join(tmpdir(), 'rclone-args-'));
  const runtimeRoot = join(fixture, 'runtime');
  const syncRuntimeDir = join(runtimeRoot, 'sync');
  const recoveryFilter = join(syncRuntimeDir, 'recovery-filters.txt');
  const argsFile = join(fixture, 'rclone.args');
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
    `RCLONE_ARGS_FILE='${argsFile}'`,
    'RCLONE_FILTERS=()',
    'rclone() { case "$1" in sync|bisync) printf "%s\\n" "$@" > "$RCLONE_ARGS_FILE";; delete|deletefile) return 0;; *) return 1;; esac; }',
    'timeout() { shift; "$@"; }',
    'pgrep() { return 1; }',
    'cleanup_main_transcripts() { :; }',
    'cleanup_remote_pi_transcript_conflicts() { :; }',
    'record_sync_disk_failure() { :; }',
    'repair_hook_exec_bits() { :; }',
    'recover_vanished_files() { return 1; }',
    extractFunction(functionName),
    `${functionName} ''`,
  ].join('\n');

  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const args = existsSync(argsFile) ? readFileSync(argsFile, 'utf8').split('\n').filter(Boolean) : [];
  rmSync(fixture, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return args;
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
    'rclone() { case "$1" in delete) return 0;; *) return 1;; esac; }',
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
function runShutdown({ bisyncInitialized = true, bisyncRc = 0, rcloneStillRunning = false, rclonePolls = 0, initPid = '', terminalPid = '', operator = false, receiptRoot = null } = {}) {
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
    receiptRoot
      ? extractFunction('drain_operator_sync_shutdown').replace('local receipt_root="/home/user/.codeflare/operators"', `local receipt_root=${JSON.stringify(receiptRoot)}`)
      : 'drain_operator_sync_shutdown() { echo "drain_operator_sync_shutdown" >> "$LOG"; return 0; }',
    // Stub kill so no real process is ever signalled; the watchdog subshell
    // then finishes on its own (sleeps are shortened below) and the handler's
    // real `wait` reaps it before the script exits.
    'kill() { echo "kill:$*" >> "$LOG"; }',
    `RCLONE_POLLS=${rclonePolls}`,
    'pgrep() { if [ "$RCLONE_POLLS" -gt 0 ]; then RCLONE_POLLS=$((RCLONE_POLLS - 1)); return 0; fi; return "${PGREP_RC:-1}"; }',
    `sleep() { ${receiptRoot ? 'touch "$LOG.waiting";' : ''} command sleep 0.01; }`,
    `BISYNC_INIT_PID=${initPid ? `'${initPid}'` : "''"}`,
    `TERMINAL_PID=${terminalPid ? `'${terminalPid}'` : "''"}`,
    `CODEFLARE_RUNTIME_ROOT='${runtimeRoot}'`,
    `CODEFLARE_OPERATOR_SESSION='${operator ? 'true' : ''}'`,
    extractFunction('shutdown_handler'),
    extractFunction('shutdown_once'),
    'SHUTDOWN_RAN=0',
    'trap shutdown_once EXIT',
    'shutdown_once',
  ].join('\n');

  if (receiptRoot) {
    const child = spawn('bash', ['-c', script], {
      env: { ...process.env, OUT_FILE: outFile, LOG_FILE: logFile },
      stdio: 'ignore',
    });
    return { child, logFile, fixture };
  }

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

  it('REQ-OPS-010 AC4 / REQ-STOR-003 AC6: final, periodic, and baseline bisync preserve the 100-percent deletion policy', () => {
    for (const functionName of ['establish_bisync_baseline', 'bisync_with_r2']) {
      const args = runRcloneArgs(functionName);
      const maxDelete = args.indexOf('--max-delete');
      assert.notEqual(maxDelete, -1, `${functionName} must pass --max-delete to rclone`);
      // Intentional argv contract: bisync interprets this as a percentage, not
      // an absolute file cap. v1.75.2 clamped the former 5000 argument to 100.
      assert.equal(args[maxDelete + 1], '100', `${functionName} must preserve the effective 100-percent deletion policy`);
      assert.ok(!args.includes('--force'), `${functionName} must not bypass bisync safety checks`);
      assert.ok(args.includes('--ignore-checksum'), `${functionName} must pass --ignore-checksum to rclone`);
    }

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

  it('REQ-OPS-010 constraint3: final sync never races an unsettled daemon', () => {
    const { log, result } = runShutdown({ bisyncInitialized: true, rcloneStillRunning: true, terminalPid: '12345' });
    assert.equal(result.status, 1);
    assert.ok(!log.includes('bisync_with_r2'));
    assert.ok(log.includes('kill:12345'));
  });

  it('REQ-OPS-010 constraint3: daemon completion beyond five seconds permits final sync', () => {
    const { log, result, out } = runShutdown({ bisyncInitialized: true, rclonePolls: 60 });
    assert.equal(result.status, 0, out);
    assert.ok(log.includes('bisync_with_r2'));
    assert.ok(out.includes('Final bisync completed successfully'));
  });

  it('REQ-OPERATOR-022: restricted shutdown drains only accepted explicit upload and never starts bisync', () => {
    const { log, out } = runShutdown({ operator: true, bisyncInitialized: true, terminalPid: '12345' });
    assert.ok(log.includes('drain_operator_sync_shutdown'));
    assert.ok(!log.includes('bisync_with_r2'));
    assert.ok(log.includes('kill:12345'));
    assert.ok(out.includes('Restricted operator shutdown'));
  });

  it('REQ-OPERATOR-022: real shutdown waits for accepted upload settlement or authority expiry', { timeout: 30_000 }, async (t) => {
    const { OperatorSyncService } = await import('../dist/operator-sync.js');
    let now = 0;
    t.mock.method(Date, 'now', () => now);
    for (const expiry of ['none', 'before-drain', 'during-drain']) {
      const expires = expiry !== 'none';
      now = 0;
      const root = mkdtempSync(join(tmpdir(), 'shutdown-upload-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const receipts = join(root, 'activity-1/.codeflare/sync-receipts');
      mkdirSync(receipts, { recursive: true });
      const receiptFile = join(receipts, 'sync-1.json');
      const objects = new Map();
      const bytes = Buffer.from('accepted output');
      let release, uploading;
      const blocked = new Promise(resolve => { release = resolve; });
      const started = new Promise(resolve => { uploading = resolve; });
      const service = new OperatorSyncService({
        activityId: 'activity-1', sessionId: 'session-1', policyDigest: 'b'.repeat(64),
        root, filePrefix: 'Operators/', manifestPrefix: '.codeflare/operators/activity-1/', deadline: 1000,
        store: {
          async load() { return existsSync(receiptFile) ? JSON.parse(readFileSync(receiptFile, 'utf8')) : null; },
          async save(receipt) { writeFileSync(receiptFile, JSON.stringify(receipt)); },
        },
        files: { async read() { return bytes; } },
        uploader: { async put(_id, key, value) {
          if (key === 'Operators/output.txt') { uploading(); await blocked; }
          objects.set(key, Buffer.from(value));
        } },
      });
      const request = { operationId: 'sync-1', requestDigest: 'a'.repeat(64), files: [
        { path: 'output.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      ] };
      const upload = service.upload(request).then(value => ({ value }), error => ({ error }));
      await started;
      assert.equal(JSON.parse(readFileSync(receiptFile, 'utf8')).status, 'uploading');
      if (expiry === 'before-drain') now = 1000;
      const run = runShutdown({ operator: true, terminalPid: '12345', receiptRoot: root });
      const exited = once(run.child, 'exit');
      t.after(() => { if (run.child.exitCode === null) run.child.kill(); rmSync(run.fixture, { recursive: true, force: true }); });
      try {
        for (let attempt = 0; attempt < 200 && !existsSync(`${run.logFile}.waiting`); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(existsSync(`${run.logFile}.waiting`), true, 'real drain must reach its pending-receipt wait');
        assert.equal(run.child.exitCode, null);
        assert.doesNotMatch(readFileSync(run.logFile, 'utf8'), /kill:12345|bisync_with_r2/,
          'host must stay alive while the accepted upload is unresolved');
        if (expiry === 'during-drain') now = 1000;
        release();
        const outcome = await upload;
        const [code] = await Promise.race([exited, new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('shutdown did not drain')), 5000);
          timer.unref();
        })]);
        assert.equal(code, 0);
        const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
        assert.equal(receipt.status, expires ? 'unknown' : 'uploaded');
        const manifest = objects.get('.codeflare/operators/activity-1/sync-1/manifest.json');
        if (expires) {
          assert.match(outcome.error.message, /outcome is unknown/);
          assert.equal(manifest, undefined, 'expired authority cannot publish the completion manifest');
        } else {
          assert.equal(outcome.value.status, 'uploaded');
          assert.deepEqual(JSON.parse(manifest).files, request.files);
          assert.deepEqual(objects.get('Operators/output.txt'), bytes);
        }
        const effects = readFileSync(run.logFile, 'utf8');
        assert.match(effects, /kill:12345/);
        assert.doesNotMatch(effects, /bisync_with_r2/);
      } finally {
        release();
        if (run.child.exitCode === null) run.child.kill();
      }
    }
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
