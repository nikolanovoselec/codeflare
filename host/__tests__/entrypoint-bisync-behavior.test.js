// Real behavioral tests for the bisync daemon in entrypoint.sh.
//
// The previous static text-matching tests (entrypoint-bisync-cadence,
// entrypoint-bisync-trigger, entrypoint-shutdown-budget, vault-r2-sync,
// sync-fanout-static, pro-mode-gating-static) asserted the script
// contained specific substrings — they passed even if the
// implementation was replaced with a no-op. Per tdd-discipline they
// have been deleted; this file is their behavioral replacement.
//
// Strategy: extract the `start_sync_daemon` body from entrypoint.sh at
// test time, patch `sleep 900` -> `sleep 1` so iterations complete in
// seconds, stub its dependencies with bash functions that log their
// invocations to disk, and spawn the daemon in a bash subshell. Assert
// on observable side effects: the log file (which records which stubs
// fired with which args), the exit code, and the timing of SIGUSR1
// wake-up vs the patched cadence.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

// Extract just the `start_sync_daemon` function body (from header to
// matching close brace at column zero). Done at module load time so
// every test gets the current entrypoint.sh source.
function extractDaemonBody() {
  const src = readFileSync(ENTRYPOINT, 'utf8');
  const lines = src.split('\n');
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^start_sync_daemon\(\) \{/.test(lines[i])) {
      start = i;
    } else if (start !== -1 && /^\}$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    throw new Error('Could not locate start_sync_daemon() in entrypoint.sh');
  }
  return lines.slice(start, end + 1).join('\n');
}

// Build a self-contained harness script for one test. Provides:
//   - A logfile path (HARNESS_LOG)
//   - Stubs for daemon dependencies that append their invocation to
//     HARNESS_LOG with a tag, so the test can assert on call shape.
//   - The patched daemon body (sleep 900 -> sleep 1).
//   - A trailing line that runs `start_sync_daemon &`, captures PID,
//     and sets up an exit trap so the daemon dies cleanly.
function buildHarness({
  daemonBody,
  logFile,
  bisyncBehavior = 'success',
  recoveryReturns = 1, // default: no vanished-file recovery
  resyncBehavior = 'success',
  blockReleaseFile, // for bisyncBehavior='block-until-released'
}) {
  // Patch the daemon body: shrink cadence so tests finish in <2s.
  const patched = daemonBody
    // Match any `sleep <N>` (where N is a positive integer) in case a
    // future cadence change replaces the literal 900. If no match is
    // found the harness will time out via the waitFor budgets below,
    // surfacing the regression rather than silently running the real
    // 15-minute sleep.
    .replace(/sleep [0-9]+(?!\d)/g, 'sleep 1')
    // Also remove the log-rotation block (depends on /tmp/sync.log
    // size that we control separately) — it touches /tmp paths we
    // don't want to mutate from the harness.
    .replace(/if \[ -f \/tmp\/sync\.log \].*?fi$/ms, ':');

  // Stub bodies, indexed by behavior selector.
  const bisyncStub =
    bisyncBehavior === 'success'
      ? `BISYNC_CALL_COUNT=0
         bisync_with_r2() {
          BISYNC_CALL_COUNT=$((BISYNC_CALL_COUNT + 1))
          echo "BISYNC_CALLED n=$BISYNC_CALL_COUNT args=$*" >> "${logFile}"
          return 0
        }`
      : bisyncBehavior === 'failure'
        ? `bisync_with_r2() {
            echo "BISYNC_CALLED args=$*" >> "${logFile}"
            return 7
          }`
        : bisyncBehavior === 'block-until-released'
          ? // First call blocks on a sentinel file until the test
            // writes it, so SIGUSR1 has time to land while
            // BISYNC_IN_FLIGHT=1 (the RERUN_REQUESTED branch). All
            // subsequent calls return immediately so the rerun cycle
            // visibly completes.
            `BISYNC_CALL_COUNT=0
             bisync_with_r2() {
              BISYNC_CALL_COUNT=$((BISYNC_CALL_COUNT + 1))
              echo "BISYNC_CALLED n=$BISYNC_CALL_COUNT args=$*" >> "${logFile}"
              if [ $BISYNC_CALL_COUNT -eq 1 ]; then
                # Block until the test creates the release sentinel.
                # Upper-bound the poll so a forgotten release file fails
                # fast with a clear log line instead of hanging until the
                # harness's outer timeout fires (code-reviewer flagged
                # the unbounded poll as a flake/debug-time risk).
                BISYNC_WAIT_COUNT=0
                while [ ! -f "${blockReleaseFile}" ]; do
                  sleep 0.05
                  BISYNC_WAIT_COUNT=$((BISYNC_WAIT_COUNT + 1))
                  if [ $BISYNC_WAIT_COUNT -gt 200 ]; then
                    echo "BISYNC_RELEASE_TIMEOUT after ~10s waiting on ${blockReleaseFile}" >> "${logFile}"
                    break
                  fi
                done
              fi
              return 0
            }`
          : // recover-then-success: first call fails (vanished file), second succeeds
            `BISYNC_CALL_COUNT=0
             bisync_with_r2() {
              BISYNC_CALL_COUNT=$((BISYNC_CALL_COUNT + 1))
              echo "BISYNC_CALLED n=$BISYNC_CALL_COUNT args=$*" >> "${logFile}"
              if [ $BISYNC_CALL_COUNT -eq 1 ]; then return 7; else return 0; fi
            }`;

  const resyncStub =
    resyncBehavior === 'success'
      ? `establish_bisync_baseline() {
          echo "RESYNC_CALLED" >> "${logFile}"
          return 0
        }`
      : `establish_bisync_baseline() {
          echo "RESYNC_CALLED_AND_FAILED" >> "${logFile}"
          return 1
        }`;

  return `#!/usr/bin/env bash
# Test harness: stubs + patched daemon body + launch.
set +e
${bisyncStub}
recover_vanished_files() {
  echo "RECOVER_CALLED" >> "${logFile}"
  return ${recoveryReturns}
}
${resyncStub}
cleanup_old_transcripts() { : ; }
update_sync_status() {
  echo "STATUS status=$1 err=$2" >> "${logFile}"
}
# A minimal R2_BUCKET_NAME is referenced by the listing-glob block.
R2_BUCKET_NAME=test-bucket
HOME=/tmp/harness-home-$$
mkdir -p "$HOME/.cache/rclone/bisync"
touch /tmp/last-bisync-output.txt

${patched}

# Run the daemon in the background. Tests send signals + wait.
start_sync_daemon &
DAEMON_PID=$!
echo "DAEMON_PID=$DAEMON_PID" >> "${logFile}"
# Print PID on stdout so the parent test process can capture it.
echo "$DAEMON_PID"
# Block on the daemon (tests kill it externally).
wait $DAEMON_PID 2>/dev/null
echo "DAEMON_EXITED" >> "${logFile}"
`;
}

// Spawn a harness, return { pid, scriptPath, logFile, child } so tests
// can send signals and assert on observable behavior.
function spawnHarness(opts) {
  const dir = mkdtempSync(join(tmpdir(), 'bisync-harness-'));
  const logFile = join(dir, 'log.txt');
  const scriptPath = join(dir, 'harness.sh');
  writeFileSync(scriptPath, buildHarness({ logFile, ...opts }));
  // Run the harness; the script's first line of stdout is the daemon PID.
  const child = spawn('bash', [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  return { child, logFile, scriptPath, dir };
}

// Helper: wait up to `timeoutMs` for `predicate(readLog())` to return true.
async function waitFor(logFile, predicate, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    if (predicate(log)) return log;
    await new Promise((r) => setTimeout(r, 50));
  }
  return existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
}

// Read daemon PID from the harness child's stdout (first line). The
// shell script echoes the PID and then blocks on `wait`.
async function readDaemonPid(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const newline = buf.indexOf('\n');
      if (newline >= 0) {
        child.stdout.off('data', onData);
        const pid = parseInt(buf.slice(0, newline).trim(), 10);
        if (Number.isNaN(pid)) {
          reject(new Error(`Could not parse daemon PID from harness output: ${buf}`));
        } else {
          resolve(pid);
        }
      }
    };
    child.stdout.on('data', onData);
    setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error('Timeout waiting for daemon PID from harness'));
    }, 2000);
  });
}

function killHarness(child, daemonPid) {
  // Kill the daemon (the subshell running start_sync_daemon) then the
  // wrapper shell. Errors are ignored — both may already be gone.
  try { process.kill(daemonPid, 'SIGKILL'); } catch {}
  try { child.kill('SIGKILL'); } catch {}
}

const daemonBody = extractDaemonBody();

describe('entrypoint.sh bisync daemon behavior (real) / REQ-STOR-002 (file persistence) / REQ-STOR-004 (initial sync) / REQ-STOR-005 (graceful shutdown final sync) / REQ-SESSION-003 AC3 (entrypoint initial rclone sync) + AC4 (bisync daemon + SIGUSR1) / REQ-SESSION-011 (graceful shutdown with final sync) / REQ-VAULT-006 (shutdown bisync vault writes) / REQ-OPS-010 (graceful container shutdown) / REQ-MEM-004 (memory dirs in bisync filter)', () => {
  // REQ-MEM-004 AC4: bisync fires on three triggers - cadence (this test),
  // SIGUSR1 from Sync-now button (next test), and final shutdown bisync
  // (REQ-STOR-005 / REQ-VAULT-006, covered in entrypoint-vault.audit.js).
  it('runs bisync within one cadence tick of starting (REQ-STOR-003 AC1 / REQ-STOR-002 AC1 / REQ-MEM-004 AC4: cadence trigger)', async () => {
    // REQ-STOR-003 AC1: periodic rclone bisync runs within the cadence window
    const h = spawnHarness({ daemonBody, bisyncBehavior: 'success' });
    const pid = await readDaemonPid(h.child);
    try {
      // With sleep patched to 1s, the daemon should call bisync_with_r2
      // within ~2s of launching. We give 4s of headroom for slow CI.
      const log = await waitFor(h.logFile, (s) => /BISYNC_CALLED/.test(s), 4000);
      assert.match(log, /BISYNC_CALLED/, 'bisync_with_r2 must be called after the cadence sleep');
      assert.match(log, /STATUS status=success/, 'success path must invoke update_sync_status with "success"');
    } finally {
      killHarness(h.child, pid);
    }
  });

  // REQ-MEM-004 AC4: SIGUSR1 trigger (Sync-now button).
  it('SIGUSR1 interrupts the cadence sleep and triggers bisync immediately (REQ-STOR-003 AC2 / REQ-STOR-015 AC5 / REQ-MEM-004 AC4: SIGUSR1 trigger)', async () => {
    // REQ-STOR-003 AC2: sleep is interruptible by an external signal
    // Use sleep 10 in the patched daemon to make the test deterministic:
    // without SIGUSR1, bisync would not fire for 10s; with SIGUSR1, the
    // `wait $SYNC_SLEEP_PID` returns >128 within ~50ms.
    const slowerBody = daemonBody.replace(/sleep [0-9]+(?!\d)/g, 'sleep 10');
    const h = spawnHarness({ daemonBody: slowerBody, bisyncBehavior: 'success' });
    const pid = await readDaemonPid(h.child);
    try {
      // Wait briefly for the trap to install + the daemon to enter sleep.
      await new Promise((r) => setTimeout(r, 300));
      // Send SIGUSR1 — daemon should interrupt and bisync within ~1s.
      process.kill(pid, 'SIGUSR1');
      const log = await waitFor(h.logFile, (s) => /BISYNC_CALLED/.test(s), 3000);
      assert.match(log, /BISYNC_CALLED/,
        'SIGUSR1 must interrupt the 10s sleep and fire bisync within ~1s');
    } finally {
      killHarness(h.child, pid);
    }
  });

  it('N SIGUSR1s arriving mid-flight coalesce into exactly one rerun (REQ-STOR-003 AC2 / REQ-STOR-015 AC5: in-flight coalesce branch)', async () => {
    // REQ-STOR-003 AC2: signals delivered while a bisync is mid-flight coalesce into exactly one rerun
    // The spec wording for AC5 is: "a SIGUSR1 sent to the bisync daemon
    // while a bisync is already in flight causes exactly one rerun
    // after the current cycle completes (N concurrent signals coalesce
    // to one rerun, not N)." The sleep-interrupt test above only
    // covers the BISYNC_REQUESTED=1 branch; this test covers the
    // BISYNC_RERUN_REQUESTED=1 branch (entrypoint.sh:646 trap, with
    // BISYNC_IN_FLIGHT=1 active).
    //
    // Mechanism: bisync_with_r2 blocks on a sentinel file the test
    // controls. Daemon enters the in-flight state. Test fires 5
    // SIGUSR1s while bisync is blocked. Test releases the block.
    // The daemon must run EXACTLY ONE additional bisync (n=2), not 5.
    const releaseFile = join(tmpdir(), `bisync-release-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const h = spawnHarness({
      daemonBody,
      bisyncBehavior: 'block-until-released',
      blockReleaseFile: releaseFile,
    });
    const pid = await readDaemonPid(h.child);
    try {
      // Wait until the daemon enters the first bisync (now blocked).
      await waitFor(h.logFile, (s) => /BISYNC_CALLED n=1/.test(s), 4000);
      // Fire 5 SIGUSR1s mid-flight. BISYNC_IN_FLIGHT=1, so each trap
      // call sets BISYNC_RERUN_REQUESTED=1 (idempotent — N signals
      // collapse to one rerun, not N).
      for (let i = 0; i < 5; i++) {
        process.kill(pid, 'SIGUSR1');
      }
      // Release the in-flight bisync. The daemon now finishes cycle 1,
      // sees BISYNC_RERUN_REQUESTED=1, runs ONE rerun (cycle 2), then
      // continues to the next sleep.
      writeFileSync(releaseFile, '');
      // Wait for the rerun (n=2) to appear.
      await waitFor(h.logFile, (s) => /BISYNC_CALLED n=2/.test(s), 5000);
      // Sleep long enough to be sure no n=3 ever appears. With patched
      // 1s cadence, 3 full cycles is the smallest window that catches a
      // runaway rerun while staying within CI's per-test budget. Tuned up
      // from 2s after code-reviewer flagged the original as flake-prone
      // on the resource-constrained CI runner.
      await new Promise((r) => setTimeout(r, 3500));
      const finalLog = readFileSync(h.logFile, 'utf8');
      const matches = finalLog.match(/BISYNC_CALLED n=\d+/g) || [];
      // Count distinct n=1, n=2 occurrences. The bisync stub increments
      // its counter once per invocation, so n=3 appearing means 5
      // SIGUSR1s produced 4 reruns instead of 1.
      const ns = matches.map((m) => m.match(/n=(\d+)/)[1]);
      assert.equal(ns.includes('1'), true, 'cycle 1 must be logged');
      assert.equal(ns.includes('2'), true, 'cycle 2 (the rerun) must be logged');
      assert.equal(ns.includes('3'), false,
        `5 SIGUSR1s mid-flight must coalesce into exactly one rerun, not multiple. Saw ns=[${ns.join(',')}]`);
    } finally {
      // Make sure the daemon never hangs the test cleanup.
      try { writeFileSync(releaseFile, ''); } catch { /* ignore */ }
      killHarness(h.child, pid);
    }
  });

  it('daemon retries after transient failure and continues the cycle (REQ-STOR-003 AC4)', async () => {
    // REQ-STOR-003 AC4: the daemon retries on transient failure and continues the 15-minute cycle.
    // A single failure (recover_vanished_files returns non-zero = nothing recovered) must NOT
    // stop the daemon - it must increment CONSECUTIVE_FAILURES and loop to the next cadence sleep.
    const h = spawnHarness({
      daemonBody,
      bisyncBehavior: 'failure',
      recoveryReturns: 1, // nothing to recover -> CONSECUTIVE_FAILURES increments
      resyncBehavior: 'success',
    });
    const pid = await readDaemonPid(h.child);
    try {
      // Wait for at least two BISYNC_CALLED entries to confirm the daemon
      // looped rather than exiting after the first failure.
      const log = await waitFor(h.logFile, (s) => (s.match(/BISYNC_CALLED args=/g) || []).length >= 2, 6000);
      const callCount = (log.match(/BISYNC_CALLED args=/g) || []).length;
      assert.ok(
        callCount >= 2,
        `daemon must continue the cycle after transient failure; got ${callCount} bisync call(s)`
      );
      // Status must have been updated to "failed" (not "success") on the failed cycle
      assert.match(log, /STATUS status=failed/, 'failure path must call update_sync_status with "failed"');
    } finally {
      killHarness(h.child, pid);
    }
  });

  it('failure + vanishing-file recovery retries bisync and clears CONSECUTIVE_FAILURES (REQ-STOR-003 AC5)', async () => {
    const h = spawnHarness({
      daemonBody,
      bisyncBehavior: 'recover-then-success',
      recoveryReturns: 0, // recover_vanished_files returns success -> retry
    });
    const pid = await readDaemonPid(h.child);
    try {
      // Wait for the second BISYNC_CALLED (n=2), proving the recovery
      // retry path executed.
      const log = await waitFor(h.logFile, (s) => /BISYNC_CALLED n=2/.test(s), 5000);
      assert.match(log, /BISYNC_CALLED n=1/, 'first bisync attempt must run and fail');
      assert.match(log, /RECOVER_CALLED/, 'recover_vanished_files must be invoked after a failure');
      assert.match(log, /BISYNC_CALLED n=2/, 'second bisync must run after recovery returns success');
    } finally {
      killHarness(h.child, pid);
    }
  });

  it('three consecutive failures trigger --resync fallback (REQ-STOR-003 AC6 / REQ-STOR-002 AC1: resync re-establishes baseline so next sync can persist files)', async () => {
    // REQ-STOR-003 AC6: after 3 consecutive unrecoverable failures, daemon falls back to --resync
    // bisync always fails (return 7), recover_vanished_files returns 1
    // (no recovery), so CONSECUTIVE_FAILURES accumulates and the resync
    // fallback fires on the third iteration.
    const h = spawnHarness({
      daemonBody,
      bisyncBehavior: 'failure',
      recoveryReturns: 1,
      resyncBehavior: 'success',
    });
    const pid = await readDaemonPid(h.child);
    try {
      const log = await waitFor(h.logFile, (s) => /RESYNC_CALLED/.test(s), 8000);
      assert.match(log, /RESYNC_CALLED/,
        'three consecutive failures must invoke establish_bisync_baseline (the --resync fallback)');
      // Also verify the status was updated to "failed" before the resync.
      assert.match(log, /STATUS status=failed/,
        'failure path must call update_sync_status with "failed" before the resync fallback');
    } finally {
      killHarness(h.child, pid);
    }
  });
});
