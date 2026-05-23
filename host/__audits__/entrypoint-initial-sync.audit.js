// Structural audit for REQ-STOR-003 (bisync constraint flags), REQ-STOR-004 (initial
// sync on container start), and REQ-STOR-005 (graceful shutdown final sync).
//
// This is a code-presence audit. It reads entrypoint.sh at test time and asserts that
// the specific markers each AC depends on are present. Breaking any of these assertions
// indicates a regression in the sync pipeline. The audit does NOT boot a container or
// exercise rclone at runtime - behavioural coverage for the daemon loop lives in
// host/__tests__/entrypoint-bisync-behavior.test.js.
//
// Located under host/__audits__/ so it does NOT run as part of `npm test` and does
// not count toward unit coverage. Run on demand with:
//     node --test host/__audits__/*.audit.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');

// ============================================================================
// REQ-STOR-003: Bidirectional Sync Every 15 Minutes (constraint flags)
// ============================================================================

describe('bisync constraint flags (REQ-STOR-003 constraints)', () => {
  // REQ-STOR-003 AC3 - conflict resolution uses newest-file-wins
  it('bisync_with_r2 uses --conflict-resolve newer (REQ-STOR-003 AC3)', () => {
    // The spec mandates newest-file-wins so that the most recent change
    // (local or R2-side) always wins when both sides modified a file in the
    // same 15-minute window.
    const funcStart = entrypoint.indexOf('bisync_with_r2()');
    assert.notEqual(funcStart, -1, 'bisync_with_r2 function must exist');
    const funcBody = entrypoint.slice(funcStart, funcStart + 3000);
    assert.ok(
      funcBody.includes('--conflict-resolve newer'),
      'bisync_with_r2 must pass --conflict-resolve newer to rclone bisync'
    );
  });

  // REQ-STOR-003 constraint: --ignore-checksum
  it('bisync_with_r2 uses --ignore-checksum (REQ-STOR-003 constraints)', () => {
    const funcStart = entrypoint.indexOf('bisync_with_r2()');
    const funcBody = entrypoint.slice(funcStart, funcStart + 3000);
    assert.ok(
      funcBody.includes('--ignore-checksum'),
      'bisync_with_r2 must pass --ignore-checksum (prevents false hash-mismatch aborts)'
    );
  });

  // REQ-STOR-003 constraint: --max-delete 100
  it('bisync_with_r2 uses --max-delete 100 (REQ-STOR-003 constraints)', () => {
    const funcStart = entrypoint.indexOf('bisync_with_r2()');
    const funcBody = entrypoint.slice(funcStart, funcStart + 3000);
    assert.ok(
      funcBody.includes('--max-delete 100'),
      'bisync_with_r2 must pass --max-delete 100 (allows bulk workspace deletions to propagate)'
    );
  });

  // REQ-STOR-003 constraint: --check-sync=false
  it('bisync_with_r2 uses --check-sync=false (REQ-STOR-003 constraints)', () => {
    const funcStart = entrypoint.indexOf('bisync_with_r2()');
    const funcBody = entrypoint.slice(funcStart, funcStart + 3000);
    assert.ok(
      funcBody.includes('--check-sync=false'),
      'bisync_with_r2 must pass --check-sync=false (prevents post-sync listing failures when R2 changes during sync)'
    );
  });

  // REQ-STOR-003 constraint: --min-size 1B
  it('bisync_with_r2 uses --min-size 1B (REQ-STOR-003 constraints)', () => {
    const funcStart = entrypoint.indexOf('bisync_with_r2()');
    const funcBody = entrypoint.slice(funcStart, funcStart + 3000);
    assert.ok(
      funcBody.includes('--min-size 1B'),
      'bisync_with_r2 must pass --min-size 1B (R2 SSE-C fails on empty objects)'
    );
  });
});

// ============================================================================
// REQ-STOR-004: Initial Sync Restores Files on Container Start
// ============================================================================

describe('initial sync on container start (REQ-STOR-004)', () => {
  // REQ-STOR-004 AC1 - one-way rclone sync from R2 to local
  it('defines initial_sync_from_r2 using rclone sync (not bisync) R2->local (REQ-STOR-004 AC1)', () => {
    // AC1 mandates a one-way sync (not bidirectional). rclone sync is the
    // correct command; rclone bisync would clobber R2 with an empty container.
    const funcStart = entrypoint.indexOf('initial_sync_from_r2()');
    assert.notEqual(funcStart, -1, 'initial_sync_from_r2 function must exist');
    const funcBody = entrypoint.slice(funcStart, funcStart + 2000);
    assert.ok(
      /rclone sync\b/.test(funcBody),
      'initial_sync_from_r2 must call rclone sync (one-way, R2->local)'
    );
    // Verify direction: source is r2:, destination is local
    assert.ok(
      /rclone sync "r2:/.test(funcBody),
      'initial_sync_from_r2 must sync FROM r2: (not to r2:)'
    );
  });

  // REQ-STOR-004 AC2 - sync times out within 120 seconds
  it('initial_sync_from_r2 enforces a 120-second timeout (REQ-STOR-004 AC2)', () => {
    const funcStart = entrypoint.indexOf('initial_sync_from_r2()');
    const funcBody = entrypoint.slice(funcStart, funcStart + 2000);
    assert.ok(
      /SYNC_TIMEOUT=120/.test(funcBody),
      'initial_sync_from_r2 must set SYNC_TIMEOUT=120'
    );
    assert.ok(
      /timeout \$SYNC_TIMEOUT rclone sync/.test(funcBody),
      'initial_sync_from_r2 must wrap rclone sync with timeout $SYNC_TIMEOUT'
    );
  });

  // REQ-STOR-004 AC3 - agent config modifications happen after initial sync, before baseline
  // The call order in entrypoint.sh: initial_sync_from_r2 -> configure_* -> establish_bisync_baseline
  it('agent config modifications run after initial sync and before bisync baseline (REQ-STOR-004 AC3)', () => {
    // Line 1905 comment: "Runs AFTER all file modifications ... to avoid hash mismatches"
    const commentIdx = entrypoint.indexOf('Runs AFTER all file modifications');
    assert.notEqual(commentIdx, -1, 'comment confirming ordering must exist near the baseline call');

    // Verify ordering: initial_sync called -> config writes -> establish_bisync_baseline
    const initialSyncCallIdx = entrypoint.indexOf('initial_sync_from_r2 &');
    const codexWriteIdx = entrypoint.indexOf('dismissed_version":"999.0.0"');
    const baselineCallIdx = entrypoint.indexOf('establish_bisync_baseline');

    assert.ok(initialSyncCallIdx > 0, 'initial_sync_from_r2 must be called from the main body');
    assert.ok(codexWriteIdx > 0, 'codex version.json write must exist');
    assert.ok(baselineCallIdx > 0, 'establish_bisync_baseline must be called');
    assert.ok(
      codexWriteIdx > initialSyncCallIdx,
      'config writes must come after initial_sync_from_r2 call'
    );
    assert.ok(
      baselineCallIdx > codexWriteIdx,
      'establish_bisync_baseline must come after config writes'
    );
  });

  // REQ-STOR-004 AC4 - bisync baseline uses --resync
  it('establish_bisync_baseline uses --resync flag (REQ-STOR-004 AC4)', () => {
    const funcStart = entrypoint.indexOf('establish_bisync_baseline()');
    assert.notEqual(funcStart, -1, 'establish_bisync_baseline function must exist');
    const funcBody = entrypoint.slice(funcStart, funcStart + 3000);
    assert.ok(
      funcBody.includes('--resync'),
      'establish_bisync_baseline must pass --resync to rclone bisync'
    );
  });

  // REQ-STOR-004 AC5 - vanishing-file recovery with /tmp/rclone-recovery-filters.txt + max 3 retries
  it('establish_bisync_baseline retries up to 3 times on vanishing-file failure (REQ-STOR-004 AC5)', () => {
    const funcStart = entrypoint.indexOf('establish_bisync_baseline()');
    const funcBody = entrypoint.slice(funcStart, funcStart + 3000);
    assert.ok(
      /MAX_RECOVERY=3/.test(funcBody),
      'establish_bisync_baseline must set MAX_RECOVERY=3'
    );
    assert.ok(
      funcBody.includes('recover_vanished_files'),
      'establish_bisync_baseline must call recover_vanished_files on failure'
    );
    assert.ok(
      funcBody.includes('RECOVERY_FILTER_FILE') || funcBody.includes('rclone-recovery-filters'),
      'establish_bisync_baseline must reference the recovery filter file'
    );
  });

  // REQ-STOR-004 AC5 - workspace files trigger plain retry, not exclusion
  it('recover_vanished_files treats workspace/* files as retry-only, not auto-excluded (REQ-STOR-004 AC5)', () => {
    const funcStart = entrypoint.indexOf('recover_vanished_files()');
    assert.notEqual(funcStart, -1, 'recover_vanished_files function must exist');
    const funcBody = entrypoint.slice(funcStart, funcStart + 2000);
    assert.ok(
      /workspace\/\*/.test(funcBody),
      'recover_vanished_files must special-case workspace/* files'
    );
    // Workspace files should set recovered=1 without adding to RECOVERY_FILTER_FILE
    // (the "continue" after the workspace branch skips the "- $file_path" >> line)
    assert.ok(
      /workspace.*continue/.test(funcBody.replace(/\n/g, ' ')),
      'workspace vanished files must skip the filter-file append (plain retry only)'
    );
  });

  // REQ-STOR-004 AC6 - MCP config files statically excluded from all sync
  it('RCLONE_FILTERS_COMMON statically excludes .claude/mcp-*.json ephemeral files (REQ-STOR-004 AC6)', () => {
    assert.ok(
      entrypoint.includes('--filter "- .claude/mcp-*.json"'),
      'RCLONE_FILTERS_COMMON must statically exclude .claude/mcp-*.json (ephemeral MCP auth cache)'
    );
  });

  // REQ-STOR-004 AC7 - bisync daemon starts unconditionally even if baseline fails
  it('start_sync_daemon is called even when establish_bisync_baseline fails (REQ-STOR-004 AC7)', () => {
    // The entrypoint always calls start_sync_daemon after the baseline block,
    // regardless of whether baseline succeeded or failed. The comment at line
    // 1922 says "Always start daemons - even if baseline failed."
    assert.ok(
      entrypoint.includes('start_sync_daemon anyway') ||
        entrypoint.includes('starting daemon anyway') ||
        /WARNING.*Bisync baseline failed.*starting daemon anyway/.test(entrypoint),
      'entrypoint must log that it starts the daemon even when baseline failed'
    );
    // Verify the unconditional call site exists outside the if/else baseline block
    assert.ok(
      entrypoint.includes('# Always start daemons') ||
        entrypoint.includes('Always start daemons'),
      'entrypoint must have a comment confirming unconditional daemon start'
    );
  });

  // REQ-STOR-004 constraint - bisync-initialized flag set even on timeout path
  it('establish_bisync_baseline sets /tmp/.bisync-initialized on the timeout path too (REQ-STOR-004 constraint)', () => {
    const funcStart = entrypoint.indexOf('establish_bisync_baseline()');
    const funcBody = entrypoint.slice(funcStart, funcStart + 3000);
    // Count occurrences of "touch /tmp/.bisync-initialized" - must appear at least twice
    // (once on success path, once on timeout path)
    const matches = funcBody.match(/touch \/tmp\/\.bisync-initialized/g) || [];
    assert.ok(
      matches.length >= 2,
      'establish_bisync_baseline must touch /tmp/.bisync-initialized on BOTH success and timeout paths (2+ occurrences)'
    );
  });
});

// ============================================================================
// REQ-STOR-005: Graceful Shutdown Performs Final Sync
// ============================================================================

describe('graceful shutdown final sync (REQ-STOR-005)', () => {
  // REQ-STOR-005 AC1 - SIGTERM/SIGINT trap triggers shutdown handler
  it('shutdown_handler is registered as SIGTERM and SIGINT trap (REQ-STOR-005 AC1)', () => {
    assert.ok(
      /trap shutdown_handler SIGTERM SIGINT/.test(entrypoint),
      'entrypoint must register shutdown_handler for SIGTERM and SIGINT'
    );
    assert.ok(
      /^shutdown_handler\(\)/m.test(entrypoint),
      'shutdown_handler function must be defined'
    );
    // Verify it calls bisync_with_r2 inside
    const shutdownStart = entrypoint.indexOf('shutdown_handler()');
    const shutdownBody = entrypoint.slice(shutdownStart, shutdownStart + 4000);
    assert.ok(
      shutdownBody.includes('bisync_with_r2'),
      'shutdown_handler must invoke bisync_with_r2 for the final sync'
    );
  });

  // REQ-STOR-005 AC2 - final bisync only runs if bisync-initialized flag is set
  it('shutdown_handler skips final bisync when /tmp/.bisync-initialized is absent (REQ-STOR-005 AC2)', () => {
    const shutdownStart = entrypoint.indexOf('shutdown_handler()');
    const shutdownBody = entrypoint.slice(shutdownStart, shutdownStart + 4000);
    assert.ok(
      shutdownBody.includes('[ -f /tmp/.bisync-initialized ]'),
      'shutdown_handler must gate final bisync on presence of /tmp/.bisync-initialized'
    );
    assert.ok(
      shutdownBody.includes('Skipping final bisync'),
      'shutdown_handler must log that it is skipping bisync when flag is absent'
    );
  });

  // REQ-STOR-005 AC4 - 120-second hard watchdog on final bisync
  it('shutdown_handler wraps final bisync in a 120-second watchdog (REQ-STOR-005 AC4)', () => {
    const shutdownStart = entrypoint.indexOf('shutdown_handler()');
    const shutdownBody = entrypoint.slice(shutdownStart, shutdownStart + 4000);
    // Pattern: background bisync subshell + watchdog (108s SIGTERM + 12s SIGKILL = 120s total)
    assert.ok(
      /sleep 108[\s\S]{0,200}kill_subtree TERM/.test(shutdownBody),
      'watchdog must send SIGTERM after 108s'
    );
    assert.ok(
      /sleep 12[\s\S]{0,200}kill_subtree KILL/.test(shutdownBody),
      'watchdog must send SIGKILL 12s after SIGTERM (total 120s)'
    );
    assert.ok(
      shutdownBody.includes('TIMED OUT after 120s'),
      'shutdown_handler must log a 120s timeout message when the watchdog fires'
    );
  });

  // REQ-STOR-005 AC5 - destroy budget is 135s (120s bisync + 15s exit)
  it('DO destroy() budget of 135s is documented in shutdown_handler (REQ-STOR-005 AC5)', () => {
    const shutdownStart = entrypoint.indexOf('shutdown_handler()');
    const shutdownBody = entrypoint.slice(shutdownStart, shutdownStart + 4000);
    assert.ok(
      shutdownBody.includes('135s') || shutdownBody.includes('135'),
      'shutdown_handler must reference the 135s DO destroy() budget'
    );
  });

  // REQ-STOR-005 constraint - final bisync uses same flags as periodic bisync
  it('shutdown_handler final bisync reuses bisync_with_r2 (same flags as periodic bisync) (REQ-STOR-005 constraint)', () => {
    // The shutdown handler calls the same bisync_with_r2 function as the daemon,
    // so it inherits --ignore-checksum, --max-delete 100, --check-sync=false automatically.
    const shutdownStart = entrypoint.indexOf('shutdown_handler()');
    const shutdownBody = entrypoint.slice(shutdownStart, shutdownStart + 4000);
    assert.ok(
      shutdownBody.includes('bisync_with_r2'),
      'shutdown_handler must call bisync_with_r2 (inherits the periodic-bisync flags)'
    );
  });
});
