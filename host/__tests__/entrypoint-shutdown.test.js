// Structural audit of entrypoint.sh for REQ-OPS-010
// (Graceful container shutdown preserves data).
//
// SCOPE: Verifies the SHAPE of the shutdown_handler — trap registration,
// PID-file reference, bisync flags, sentinel touches, TERMINAL_PID kill.
// These are declarative shell constructs whose runtime behavior is exercised
// by REAL behavioral tests:
//
//   - REQ-OPS-010 AC4 daemon-side bisync (cadence + SIGUSR1 + recovery):
//       host/__tests__/entrypoint-bisync-behavior.test.js (real bash spawn)
//   - REQ-OPS-010 AC2/AC6 DO-side destroy() SIGTERM + poll + super.destroy:
//       src/__tests__/container/index.test.ts (destroy describe)
//
// Spawning shutdown_handler in isolation requires extracting the function
// into its own sourceable file because entrypoint.sh runs side-effects at
// top-level. Tracked in the /sdd clean follow-up issue.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');

/**
 * The body of shutdown_handler, bounded by the function's own closing brace.
 *
 * Both assertions below used to slice a fixed 2000/3000 characters from the
 * definition. That window silently stops covering the tail as the handler
 * grows: adding the background-init kill and its rationale pushed
 * `kill "$TERMINAL_PID"` past 3000 characters, and the test failed while the
 * behaviour it checks was intact. A byte count is not a scope.
 */
function shutdownHandlerBody() {
  const start = entrypoint.indexOf('shutdown_handler()');
  if (start === -1) return '';
  const end = entrypoint.indexOf('\n}', start);
  return entrypoint.slice(start, end === -1 ? undefined : end);
}
const dockerfile = readFileSync(resolve(repoRoot, 'Dockerfile'), 'utf8');

// ---------------------------------------------------------------------------
// REQ-OPS-010: Graceful container shutdown preserves data
// ---------------------------------------------------------------------------

// REQ-SESSION-011: Graceful shutdown with final sync

describe('REQ-OPS-010: Graceful container shutdown preserves data', () => {
  it('REQ-OPS-010 AC1: the container image declares STOPSIGNAL SIGINT', () => {
    assert.ok(
      dockerfile.includes('STOPSIGNAL SIGINT'),
      'Dockerfile must declare STOPSIGNAL SIGINT so the orchestrator sends SIGINT on container stop'
    );
  });

  it('REQ-OPS-010 AC2: the container entrypoint trap handler catches SIGINT/SIGTERM signals', () => {
    // This asserted `includes('trap shutdown_handler SIGTERM SIGINT EXIT')` —
    // pinning as the contract a line that was defective. Registering ONE
    // function for a signal trap and for EXIT runs it twice per shutdown, since
    // bash's re-entry guard is per-trap and the handler ends in `exit 0`; the
    // second pass could clear the bisync lock left by the first pass's SIGKILLed
    // rclone and start a fresh R2 sync inside the last 15s of the budget.
    //
    // Assert the two properties that matter instead of the literal line: a trap
    // covering all three signals, and re-entry protection.
    const trap = entrypoint.match(/^trap (\S+) (.*)$/m);
    assert.ok(trap, 'entrypoint.sh must register a shutdown trap');
    for (const sig of ['SIGTERM', 'SIGINT', 'EXIT']) {
      assert.ok(trap[2].includes(sig), `the shutdown trap must cover ${sig}`);
    }
    assert.ok(
      entrypoint.includes('shutdown_handler()'),
      'entrypoint.sh must define a shutdown_handler function'
    );

    // The trapped function must not be able to run its body twice. Either it is
    // a guarded wrapper, or the guard lives in the handler itself.
    const trapped = trap[1];
    const guardSource = trapped === 'shutdown_handler'
      ? entrypoint.slice(entrypoint.indexOf('shutdown_handler()'))
      : entrypoint.slice(entrypoint.indexOf(`${trapped}()`));
    assert.match(
      guardSource.slice(0, 600),
      /SHUTDOWN_RAN|already|return 0/,
      `${trapped} is trapped on both a signal and EXIT, so it must guard against running twice`
    );
  });

  it('REQ-OPS-010 AC3: trap handler kills the sync daemon via PID file at /tmp/sync-daemon.pid', () => {
    // The PID file is the sole mechanism - direct kill of SYNC_DAEMON_PID is not used
    assert.ok(
      entrypoint.includes('/tmp/sync-daemon.pid'),
      'entrypoint.sh shutdown_handler must reference /tmp/sync-daemon.pid as the sync daemon PID file'
    );
    // kill_pidfile_subtree (or equivalent) must be called with this PID file inside shutdown_handler
    assert.notEqual(entrypoint.indexOf('shutdown_handler()'), -1, 'shutdown_handler must be defined');
    const handlerBlock = shutdownHandlerBody();
    assert.ok(
      handlerBlock.includes('/tmp/sync-daemon.pid'),
      'shutdown_handler body must reference /tmp/sync-daemon.pid to kill the sync daemon'
    );
  });

  it('REQ-OPS-010 AC4: final rclone bisync with --ignore-checksum --max-delete 100 runs to R2 before exit', () => {
    // The bisync_with_r2 function (called inside shutdown_handler) must use these flags.
    // Both flags appear in the periodic bisync AND the final bisync path.
    assert.ok(
      entrypoint.includes('--ignore-checksum'),
      'entrypoint.sh must pass --ignore-checksum to rclone bisync'
    );
    assert.ok(
      entrypoint.includes('--max-delete 100'),
      'entrypoint.sh must pass --max-delete 100 to rclone bisync'
    );
    // The shutdown handler must actually invoke a bisync (not just the daemon)
    const handlerIdx = entrypoint.indexOf('shutdown_handler()');
    const handlerBlock = entrypoint.slice(handlerIdx, handlerIdx + 3000);
    assert.ok(
      handlerBlock.includes('bisync') || handlerBlock.includes('bisync_with_r2'),
      'shutdown_handler must invoke bisync/bisync_with_r2 for the final sync to R2'
    );
  });

  it('REQ-OPS-010 AC5: bisync-initialized flag is touched on the timeout path to ensure final bisync runs', () => {
    // The flag must be touched in two places: success path AND timeout/error path of establish_bisync_baseline
    const allTouches = [...entrypoint.matchAll(/touch \/tmp\/\.bisync-initialized/g)];
    assert.ok(
      allTouches.length >= 2,
      'entrypoint.sh must touch /tmp/.bisync-initialized on both the success path and the timeout/error path'
    );
    // The shutdown_handler must gate the final bisync on this flag existing
    const handlerIdx = entrypoint.indexOf('shutdown_handler()');
    const handlerBlock = entrypoint.slice(handlerIdx, handlerIdx + 3000);
    assert.ok(
      handlerBlock.includes('/tmp/.bisync-initialized'),
      'shutdown_handler must check /tmp/.bisync-initialized before running the final bisync'
    );
  });

  it('REQ-OPS-010 AC6: terminal server is killed after the final sync completes', () => {
    // TERMINAL_PID must be killed inside shutdown_handler (after bisync)
    assert.notEqual(entrypoint.indexOf('shutdown_handler()'), -1, 'shutdown_handler must be defined');
    const handlerBlock = shutdownHandlerBody();
    assert.ok(
      handlerBlock.includes('TERMINAL_PID'),
      'shutdown_handler must reference TERMINAL_PID to kill the terminal server after the final sync'
    );
    assert.ok(
      /kill\s+["\$]?\$?TERMINAL_PID/.test(handlerBlock) || handlerBlock.includes('kill "$TERMINAL_PID"'),
      'shutdown_handler must call kill $TERMINAL_PID to stop the terminal server'
    );
  });
});
