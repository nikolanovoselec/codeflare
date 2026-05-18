// REQ-STOR-003 backfill: bidirectional sync every 15 minutes + manual triggers.
//
// Static structural test. Reads entrypoint.sh and pattern-matches on the
// daemon body. Behavioural verification of SIGUSR1 wake lives in
// entrypoint-sigusr1.test.js; this file covers the cadence + recovery +
// fallback semantics that nothing else asserts on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

describe('entrypoint.sh bisync daemon cadence (REQ-STOR-003)', () => {
  it('AC1: periodic bisync uses a 15-minute sleep', () => {
    // 900 seconds = 15 minutes. The daemon body must contain the cadence
    // sleep wrapped in the bash backgrounded-sleep + wait pattern so the
    // trap can interrupt it (see AC2).
    assert.ok(
      /sleep 900 &/.test(entrypoint),
      'entrypoint.sh must call `sleep 900 &` (15-min cadence backgrounded so the SIGUSR1 trap can wake it)'
    );
  });

  it('AC2: periodic sleep is signal-interruptible via wait builtin', () => {
    // bash trap semantics: a foreground `sleep` blocks until it returns,
    // so the trap queues until then. The `wait` builtin IS interruptible
    // and is the correct pattern. We must see all three pieces inside
    // the cadence block: backgrounded sleep, wait on PID, kill leftover.
    assert.ok(
      /SYNC_SLEEP_PID=\$!/.test(entrypoint),
      'entrypoint.sh must capture the backgrounded sleep PID into SYNC_SLEEP_PID'
    );
    assert.ok(
      /wait "\$SYNC_SLEEP_PID" 2>\/dev\/null \|\| true/.test(entrypoint),
      'entrypoint.sh must use `wait $SYNC_SLEEP_PID` (the builtin -- foreground sleeps do not return on trap)'
    );
    assert.ok(
      /kill "\$SYNC_SLEEP_PID" 2>\/dev\/null \|\| true/.test(entrypoint),
      'entrypoint.sh must kill the still-running sleep after wait returns (otherwise one sleep child leaks per trigger)'
    );
  });

  it('AC3: bisync uses --conflict-resolve newer', () => {
    // The newest-file-wins flag must be present on the periodic bisync
    // command line, not just the initial --resync baseline. Look for at
    // least two occurrences (--resync baseline + periodic bisync).
    const matches = entrypoint.match(/--conflict-resolve newer/g) || [];
    assert.ok(
      matches.length >= 2,
      `entrypoint.sh must pass --conflict-resolve newer to BOTH the --resync baseline and the periodic bisync (found ${matches.length})`
    );
  });

  it('AC3 constraints: required rclone flags are all present', () => {
    // The constraint block on REQ-STOR-003 mandates these flags. Each
    // must appear on the periodic bisync command line.
    const required = [
      '--ignore-checksum',
      '--max-delete 100',
      '--check-sync=false',
      '--min-size 1B',
    ];
    for (const flag of required) {
      // At least 2 occurrences -- baseline + periodic bisync.
      const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'g');
      const count = (entrypoint.match(re) || []).length;
      assert.ok(
        count >= 2,
        `entrypoint.sh must pass ${flag} (found ${count} occurrences, expected >= 2 across baseline + periodic)`
      );
    }
  });

  it('AC5: vanishing-file recovery is invoked on bisync failure', () => {
    // On failure we must (a) parse error output via recover_vanished_files,
    // (b) clear the rclone lock files (.lck) before retry, (c) attempt one
    // immediate retry, (d) only count the failure if recovery doesn't help.
    assert.ok(
      /recover_vanished_files "\$\(cat \/tmp\/last-bisync-output\.txt 2>\/dev\/null\)"/.test(entrypoint),
      'entrypoint.sh must call recover_vanished_files with the captured last-bisync-output before counting a failure'
    );
    assert.ok(
      /rm -f "\$HOME\/.cache\/rclone\/bisync"\/\*\.lck/.test(entrypoint),
      'entrypoint.sh must clear rclone .lck lock files before the recovery retry'
    );
  });

  it('AC4 + AC6: failure counter tracks consecutive failures and resync fallback at 3', () => {
    // AC4: transient retry continues the cycle. AC6: after 3 consecutive
    // unrecoverable failures the daemon falls back to --resync.
    assert.ok(
      /CONSECUTIVE_FAILURES=0/.test(entrypoint),
      'entrypoint.sh must initialise CONSECUTIVE_FAILURES=0'
    );
    assert.ok(
      /CONSECUTIVE_FAILURES=\$\(\(CONSECUTIVE_FAILURES \+ 1\)\)/.test(entrypoint),
      'entrypoint.sh must increment CONSECUTIVE_FAILURES on each unrecoverable failure'
    );
    assert.ok(
      /if \[ \$CONSECUTIVE_FAILURES -ge 3 \]; then/.test(entrypoint),
      'entrypoint.sh must guard the --resync fallback on CONSECUTIVE_FAILURES >= 3'
    );
    assert.ok(
      /establish_bisync_baseline/.test(entrypoint),
      'entrypoint.sh must call establish_bisync_baseline (the --resync path) as the fallback recovery'
    );
  });

  it('AC6 fast-path: missing listing files trigger immediate --resync without waiting for 3 failures', () => {
    // Exit code 7 + no listing files = no prior bisync state. The daemon
    // must short-circuit to the --resync fallback by setting the failure
    // counter to 3 directly.
    assert.ok(
      /if \[ "\$HAS_LISTINGS" = "false" \] && \[ \$SYNC_RESULT -eq 7 \]; then/.test(entrypoint),
      'entrypoint.sh must short-circuit to --resync when exit code 7 + no listing files (no prior bisync state)'
    );
    assert.ok(
      /CONSECUTIVE_FAILURES=3\s*#\s*force resync path below/i.test(entrypoint),
      'entrypoint.sh must set CONSECUTIVE_FAILURES=3 in the no-listings fast-path to force the resync fallback'
    );
  });
});
