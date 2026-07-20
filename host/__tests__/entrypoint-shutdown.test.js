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

    // The trapped function must not be able to run its body twice. This asserts
    // the STRUCTURE of the guard, not the presence of a token: the previous
    // version scanned 600 characters for /SHUTDOWN_RAN|already|return 0/, and
    // the nested walk_kill helper begins with `[ -z "$root" ] && return 0`
    // inside that window — so it stayed green through the exact
    // `trap shutdown_handler SIGTERM SIGINT EXIT` revert it was written to catch.
    // Every top-level trap, not just the first. A non-global match binds to the
    // first `trap` line only, so a SECOND registration added later — e.g.
    // `trap shutdown_handler EXIT` — would overwrite the EXIT slot with the
    // unguarded function and reintroduce the double-run, while every assertion
    // here still passed against the first line.
    const allTraps = [...entrypoint.matchAll(/^trap (\S+) (.*)$/gm)];
    assert.equal(
      allTraps.length,
      1,
      `entrypoint.sh registers ${allTraps.length} top-level traps; a second one can silently overwrite the guarded slot`
    );
    for (const [, fn] of allTraps) {
      assert.notEqual(
        fn,
        'shutdown_handler',
        'the handler is trapped directly on both a signal and EXIT, so it runs twice; trap a guarded wrapper instead'
      );
    }

    const trapped = trap[1];

    const wrapper = entrypoint.match(new RegExp(`^${trapped}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'));
    assert.ok(wrapper, `${trapped} must be defined at the top level`);

    const sentinel = wrapper[0].match(/if \[ "\$([A-Z_]+)" = "1" \]/);
    assert.ok(sentinel, `${trapped} must short-circuit on a sentinel variable`);

    // Strip comments before locating the call: a plain substring scan finds
    // `shutdown_handler` inside a comment too, which produced a confidently
    // wrong "sets the sentinel after invoking the handler" failure.
    const wrapperCode = wrapper[0]
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const setIdx = wrapperCode.indexOf(`${sentinel[1]}=1`);
    const callIdx = wrapperCode.search(/^\s*shutdown_handler\s*$/m);
    assert.ok(setIdx !== -1, `${trapped} must set ${sentinel[1]}=1`);
    assert.ok(callIdx !== -1, `${trapped} must call shutdown_handler`);
    assert.ok(
      setIdx < callIdx,
      `${trapped} sets ${sentinel[1]} after invoking the handler, so a second signal re-enters before the guard is armed`
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
    // The shutdown handler must actually invoke a bisync (not just the daemon).
    // Matches the CALL, not the substring 'bisync': the handler also mentions
    // bisync in comments and greps for a running `rclone bisync`, so a loose
    // match stayed green with the final-sync call deleted.
    const handlerBlock = shutdownHandlerBody();
    assert.ok(
      /^\s*\(?\s*bisync_with_r2\b/m.test(handlerBlock),
      'shutdown_handler must invoke bisync_with_r2 for the final sync to R2'
    );
  });

  it('REQ-OPS-010 AC5: bisync-initialized flag is touched on the timeout path to ensure final bisync runs', () => {
    // The flag must be touched in two places: success path AND timeout/error path of establish_bisync_baseline
    const allTouches = [...entrypoint.matchAll(/touch \/tmp\/\.bisync-initialized/g)];
    assert.ok(
      allTouches.length >= 2,
      'entrypoint.sh must touch /tmp/.bisync-initialized on both the success path and the timeout/error path'
    );
    // The shutdown_handler must gate the final bisync on this flag existing.
    // Scoped to the actual function body, not a fixed byte window: a 3000-byte
    // slice made this assertion a proximity check, so adding a dozen lines
    // anywhere earlier in the handler failed it while the gate was untouched.
    const handlerBlock = shutdownHandlerBody();
    assert.ok(
      handlerBlock.includes('/tmp/.bisync-initialized'),
      'shutdown_handler must check /tmp/.bisync-initialized before running the final bisync'
    );
  });

  it('REQ-OPS-010 AC5: the final sync waits for the daemon rclone to exit before it starts', () => {
    // Regression guard for a silent data-loss path: walk_kill only sends TERM,
    // so without this wait bisync_with_r2 could start while the daemon's rclone
    // was still alive, see a live `rclone bisync` in its stale-lock check,
    // leave the .lck in place and fast-fail — dropping the final sync and up to
    // one full cadence of user work. The wait must come BEFORE the sync, so
    // this asserts the ordering, not merely that both strings are present.
    const body = shutdownHandlerBody();
    const waitIdx = body.search(/pgrep -f "rclone bisync"/);
    const syncIdx = body.search(/^\s*\(?\s*bisync_with_r2\b/m);
    assert.notEqual(waitIdx, -1, 'shutdown_handler must wait for the daemon rclone bisync to exit');
    assert.notEqual(syncIdx, -1, 'shutdown_handler must invoke bisync_with_r2');
    assert.ok(
      waitIdx < syncIdx,
      'the reap-wait must precede the final bisync; after it, the stale-lock guard has already lost the race'
    );
  });

  it('REQ-OPS-010: the quiesce wait is taken out of the shutdown budget, not added to it', () => {
    // The ordering test above stays green if the wait is unbounded or if the
    // watchdog goes back to a flat `sleep 108` — i.e. it does not cover the
    // regression the fix was for. The invariant is that quiesce + watchdog is
    // constant, so that AD57's 15s clean-exit buffer against the DO's 135s hard
    // kill survives. Derive both numbers from the source and check the sum.
    const body = shutdownHandlerBody();

    const bound = body.match(/QUIESCE_DECIS"?\s*-lt\s+(\d+)/);
    assert.ok(bound, 'the quiesce loop must have a literal iteration bound');
    const maxQuiesceSecs = Math.ceil(Number(bound[1]) / 10);

    const watchdog = body.match(/sleep \$\(\(\s*(\d+)\s*-\s*QUIESCE_SECS\s*\)\)/);
    assert.ok(
      watchdog,
      'the watchdog SIGTERM sleep must subtract QUIESCE_SECS; a bare `sleep 108` adds the wait to the budget instead of taking it from it'
    );

    const grace = body.match(/kill_subtree TERM[\s\S]*?sleep (\d+)/);
    assert.ok(grace, 'the watchdog must sleep between SIGTERM and SIGKILL');

    // The bound has to be load-bearing on its own. Writing the sum as
    // quiesce + (watchdog - quiesce) + grace cancels the quiesce term
    // algebraically, so widening the loop to e.g. 1200 deciseconds would still
    // total 120 while `sleep $((108 - 120))` errored out at runtime, skipping
    // both kill_subtree calls and letting the final bisync run unbounded into
    // the DO's hard kill — the failure AD57's budget exists to prevent.
    assert.ok(
      maxQuiesceSecs < Number(watchdog[1]),
      `the quiesce bound is ${maxQuiesceSecs}s but the watchdog is ${watchdog[1]}s; sleep $(( ${watchdog[1]} - QUIESCE_SECS )) would go negative and the watchdog would never fire`
    );

    const total = Number(watchdog[1]) + Number(grace[1]);
    assert.equal(
      total,
      120,
      `worst-case shutdown is ${total}s, not the 120s AD57 budgets against the DO's 135s hard kill`
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
