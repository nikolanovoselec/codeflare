// Verifies REQ-STOR-015 AC5: the bisync daemon installs a SIGUSR1 trap
// inside its subshell, manages in-flight + rerun-requested coalescing
// flags, and writes its PID atomically to /tmp/sync-daemon.pid so the
// host /internal/bisync-trigger endpoint can signal it.
//
// Static structural test: reads entrypoint.sh and asserts on patterns.
// Behavioural verification (signal -> wake) lives in
// entrypoint-sigusr1.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

describe('entrypoint.sh bisync daemon SIGUSR1 trigger plumbing (REQ-STOR-015)', () => {
  it('AC5: installs a SIGUSR1 trap inside the daemon subshell', () => {
    // The trap must be installed via the first-iteration guard so it
    // takes effect inside the `while ... done &` subshell (parent-shell
    // traps are reset to default in subshells).
    assert.ok(
      entrypoint.includes("trap 'if [ -n \"$BISYNC_IN_FLIGHT\" ]; then BISYNC_RERUN_REQUESTED=1; else BISYNC_REQUESTED=1; fi' USR1"),
      'entrypoint.sh must install a SIGUSR1 trap that toggles BISYNC_REQUESTED (idle) or BISYNC_RERUN_REQUESTED (mid-flight) coalescing flags'
    );
  });

  it('AC5: initialises the three coalescing flags', () => {
    assert.ok(/BISYNC_REQUESTED=0/.test(entrypoint),
      'entrypoint.sh must initialise BISYNC_REQUESTED=0');
    assert.ok(/BISYNC_RERUN_REQUESTED=0/.test(entrypoint),
      'entrypoint.sh must initialise BISYNC_RERUN_REQUESTED=0');
    assert.ok(/BISYNC_IN_FLIGHT=\s*$/m.test(entrypoint) || /BISYNC_IN_FLIGHT=\n/.test(entrypoint),
      'entrypoint.sh must initialise BISYNC_IN_FLIGHT to empty');
  });

  it('AC5: gates the periodic sleep on the coalescing flags', () => {
    // If either flag is set when entering the sleep check, we skip
    // the sleep entirely and run an immediate bisync.
    assert.ok(
      /if \[ "\$BISYNC_REQUESTED" = "0" \] && \[ "\$BISYNC_RERUN_REQUESTED" = "0" \]; then/.test(entrypoint),
      'entrypoint.sh must gate `sleep 60` on both BISYNC_REQUESTED=0 AND BISYNC_RERUN_REQUESTED=0'
    );
  });

  it('AC5: sets BISYNC_IN_FLIGHT before bisync and clears it after each cycle', () => {
    // Search for the set + clear pair in the daemon body.
    const sets = entrypoint.match(/BISYNC_IN_FLIGHT=1/g) || [];
    assert.ok(sets.length >= 1, 'entrypoint.sh must set BISYNC_IN_FLIGHT=1 before each bisync attempt');
    // Two clears: one before the recovery-success `continue`, one at
    // end-of-cycle. Both classify subsequent signals correctly.
    const clears = entrypoint.match(/BISYNC_IN_FLIGHT=\s*$/gm) || [];
    assert.ok(
      clears.length >= 3, // includes the init line + 2 clears
      `entrypoint.sh must clear BISYNC_IN_FLIGHT at end-of-cycle and before recovery continue (found ${clears.length} matches, expected >= 3)`
    );
  });

  it('AC1: writes daemon PID to /tmp/sync-daemon.pid for the host trigger endpoint', () => {
    assert.ok(
      entrypoint.includes('echo "$SYNC_DAEMON_PID" > /tmp/sync-daemon.pid'),
      'entrypoint.sh must write the daemon PID to /tmp/sync-daemon.pid so /internal/bisync-trigger can signal it'
    );
  });

  it('AC5: documents hibernation-ephemeral semantics of the flags', () => {
    // Header comment must warn that the flags live in daemon memory
    // and that the wake-time baseline (REQ-STOR-004 AC4) absorbs any
    // lost trigger - so we never promote these to DO storage or KV.
    assert.ok(
      /Hibernation note/.test(entrypoint) && /REQ-STOR-004 AC4/.test(entrypoint),
      'entrypoint.sh sync daemon header must document hibernation-ephemeral semantics and reference REQ-STOR-004 AC4'
    );
  });
});

describe('entrypoint.sh shutdown budget (REQ-STOR-005, AD57)', () => {
  it('AC4: final-bisync watchdog uses 108s + 12s = 120s budget', () => {
    // Look for the SIGTERM + SIGKILL sleep pair in shutdown_handler.
    assert.ok(
      /\( sleep 108\s+kill_subtree TERM "\$BISYNC_PID"\s+sleep 12\s+kill_subtree KILL "\$BISYNC_PID"/.test(entrypoint),
      'entrypoint.sh shutdown watchdog must use 108s SIGTERM + 12s SIGKILL (120s total) per AD57'
    );
  });

  it('AC4: shutdown log strings advertise the 120s budget', () => {
    assert.ok(
      entrypoint.includes('Final bisync to R2 (120s budget)'),
      'entrypoint.sh must announce the 120s budget in its shutdown log line'
    );
    assert.ok(
      entrypoint.includes('Final bisync TIMED OUT after 120s'),
      'entrypoint.sh timeout-path log line must reference 120s'
    );
  });
});
