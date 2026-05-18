// REQ-STOR-005 backfill: graceful shutdown performs final sync.
//
// AC1 (SIGINT/SIGTERM handler -> final bisync) and AC4 (120s watchdog,
// 135s DO budget) are already covered in entrypoint-bisync-trigger.test.js.
// This file covers the AC2 (bisync-initialized flag gate) and AC3 (final
// bisync runs synchronously before exit) gaps. AC5 (DO destroy budget) is
// asserted in src/__tests__/container/index.test.ts where the destroy
// timeout constant lives.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

describe('entrypoint.sh shutdown handler (REQ-STOR-005 backfill)', () => {
  it('AC2: final bisync is gated on the /tmp/.bisync-initialized flag', () => {
    // Without this gate, a container that died before establishing the
    // bisync baseline would still attempt a final bisync — which fails
    // with no listing files and wastes the entire 120s budget on a
    // doomed --resync.
    assert.ok(
      /if \[ -f \/tmp\/\.bisync-initialized \]; then/.test(entrypoint),
      'shutdown_handler must gate the final bisync on -f /tmp/.bisync-initialized so it does not run before the baseline exists'
    );
  });

  it('AC2: the bisync-initialized flag is touched on baseline establishment', () => {
    // Counterpart of the gate above: if nothing ever touches the flag,
    // the gate would always be false and the final bisync would never
    // run, defeating the entire purpose of the shutdown handler.
    const touches = entrypoint.match(/touch \/tmp\/\.bisync-initialized/g) || [];
    assert.ok(
      touches.length >= 2,
      `entrypoint.sh must touch /tmp/.bisync-initialized after successful baseline (found ${touches.length} occurrences, expected >= 2 for both the success and timeout-but-baseline-ran paths)`
    );
  });

  it('AC3: shutdown_handler is registered via trap on SIGTERM, SIGINT, and EXIT', () => {
    // Without the trap registration the handler would never run and R2
    // would be missing the last 0-15 minutes of edits on every shutdown.
    // EXIT catches the normal-exit path too (e.g., main process returns).
    assert.ok(
      /trap shutdown_handler SIGTERM SIGINT EXIT/.test(entrypoint),
      'entrypoint.sh must trap SIGTERM + SIGINT + EXIT into shutdown_handler so all exit paths drain to R2'
    );
  });

  it('AC3: shutdown_handler waits on the bisync subshell PID synchronously', () => {
    // The bisync runs in a background subshell so the watchdog can kill
    // it on timeout, but the handler must block on its exit. Otherwise
    // the script falls through to the cleanup/exit lines while the
    // bisync child is still uploading — which is the bug AD57 fixed.
    assert.ok(
      /BISYNC_PID=\$!/.test(entrypoint),
      'shutdown_handler must capture the bisync subshell PID for the watchdog + wait pair'
    );
    // The wait must be on BISYNC_PID specifically (not just any pid).
    assert.ok(
      /wait "?\$BISYNC_PID"?/.test(entrypoint) || /wait \$BISYNC_PID/.test(entrypoint),
      'shutdown_handler must `wait` on $BISYNC_PID before exit so the final sync actually completes synchronously'
    );
  });

  it('AC3: the watchdog kills the rclone subtree, not just the wrapping subshell', () => {
    // History note in the entrypoint comment block makes this explicit:
    // killing only the wrapping bash subshell leaves rclone running and
    // half-uploaded files land in R2 anyway. The fix is kill_subtree.
    assert.ok(
      /kill_subtree\(\)/.test(entrypoint),
      'shutdown_handler must define kill_subtree to walk descendant PIDs (otherwise rclone outlives its parent and lands partial uploads)'
    );
    assert.ok(
      /pgrep -P "\$root"/.test(entrypoint),
      'kill_subtree must use pgrep -P to walk the descendant tree (parent-to-child traversal)'
    );
  });
});
