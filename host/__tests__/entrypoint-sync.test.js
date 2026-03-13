import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Helper: extract a bash function body from entrypoint.sh
function extractFunction(name) {
  // Match function_name() { ... } with brace-counting
  const start = entrypoint.indexOf(`${name}() {`);
  if (start === -1) return null;
  let depth = 0;
  let i = entrypoint.indexOf('{', start);
  const begin = i;
  for (; i < entrypoint.length; i++) {
    if (entrypoint[i] === '{') depth++;
    else if (entrypoint[i] === '}') depth--;
    if (depth === 0) break;
  }
  return entrypoint.slice(begin, i + 1);
}

// Helper: extract the MAIN EXECUTION section (everything after function definitions)
function extractMainExecution() {
  const marker = '# MAIN EXECUTION';
  const idx = entrypoint.indexOf(marker);
  if (idx === -1) return null;
  return entrypoint.slice(idx);
}

// ============================================================================
// Test: --ignore-checksum flag on all bisync commands
// ============================================================================
describe('bisync --ignore-checksum flag', () => {
  it('establish_bisync_baseline() includes --ignore-checksum', () => {
    const body = extractFunction('establish_bisync_baseline');
    assert.ok(body, 'establish_bisync_baseline function should exist');
    assert.ok(
      body.includes('--ignore-checksum'),
      'establish_bisync_baseline should include --ignore-checksum flag'
    );
    // Also verify it still has --resync (baseline-specific)
    assert.ok(body.includes('--resync'), 'establish_bisync_baseline should include --resync');
  });

  it('bisync_with_r2() includes --ignore-checksum', () => {
    const body = extractFunction('bisync_with_r2');
    assert.ok(body, 'bisync_with_r2 function should exist');
    assert.ok(
      body.includes('--ignore-checksum'),
      'bisync_with_r2 should include --ignore-checksum'
    );
  });
});

// ============================================================================
// Test: --s3-upload-cutoff 0 to force multipart (prevents BadDigest TOCTOU race)
// ============================================================================
describe('bisync --s3-upload-cutoff 0 flag', () => {
  it('establish_bisync_baseline() includes --s3-upload-cutoff 0', () => {
    const body = extractFunction('establish_bisync_baseline');
    assert.ok(body, 'establish_bisync_baseline function should exist');
    assert.ok(
      body.includes('--s3-upload-cutoff 0'),
      'establish_bisync_baseline should force multipart uploads to prevent BadDigest on actively-written files'
    );
  });

  it('bisync_with_r2() includes --s3-upload-cutoff 0', () => {
    const body = extractFunction('bisync_with_r2');
    assert.ok(body, 'bisync_with_r2 function should exist');
    assert.ok(
      body.includes('--s3-upload-cutoff 0'),
      'bisync_with_r2 should force multipart uploads to prevent BadDigest on actively-written files'
    );
  });
});

// ============================================================================
// Test: startup ordering — file modifications before bisync baseline
// ============================================================================
describe('startup ordering: file modifications before bisync baseline', () => {
  it('all file modifications occur before bisync baseline launch in main execution', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    // These file-modifying operations must appear BEFORE the bisync baseline launch
    const claudeJsonIdx = main.indexOf('bypassPermissionsModeAccepted');
    const settingsJsonIdx = main.indexOf('Claude Code settings configured');
    const geminiIdx = main.indexOf('enableAutoUpdate');
    const codexIdx = main.indexOf('dismissed_version');
    const tabAutostartIdx = main.indexOf('configure_tab_autostart');
    const bisyncBaselineIdx = main.indexOf('establish_bisync_baseline');

    assert.ok(claudeJsonIdx > -1, '.claude.json modification should exist in main execution');
    assert.ok(settingsJsonIdx > -1, '.claude/settings.json hooks merge should exist in main execution');
    assert.ok(geminiIdx > -1, '.gemini/settings.json modification should exist in main execution');
    assert.ok(codexIdx > -1, '.codex/version.json modification should exist in main execution');
    assert.ok(tabAutostartIdx > -1, 'configure_tab_autostart should exist in main execution');
    assert.ok(bisyncBaselineIdx > -1, 'establish_bisync_baseline should exist in main execution');

    assert.ok(
      claudeJsonIdx < bisyncBaselineIdx,
      '.claude.json modification must run before bisync baseline'
    );
    assert.ok(
      settingsJsonIdx < bisyncBaselineIdx,
      '.claude/settings.json hooks merge must run before bisync baseline'
    );
    assert.ok(
      geminiIdx < bisyncBaselineIdx,
      '.gemini/settings.json modification must run before bisync baseline'
    );
    assert.ok(
      codexIdx < bisyncBaselineIdx,
      '.codex/version.json modification must run before bisync baseline'
    );
    assert.ok(
      tabAutostartIdx < bisyncBaselineIdx,
      'configure_tab_autostart must run before bisync baseline'
    );
  });
});

// ============================================================================
// Test: RCLONE_FILTERS array construction for each SYNC_MODE
// ============================================================================
describe('RCLONE_FILTERS construction by SYNC_MODE', () => {
  it('common filters exclude .bashrc, .npm, .cache, .config/rclone, node_modules', () => {
    assert.ok(entrypoint.includes('--filter "- .bashrc"'), 'should exclude .bashrc');
    assert.ok(entrypoint.includes('--filter "- .npm/**"'), 'should exclude .npm');
    assert.ok(entrypoint.includes('--filter "- .cache/**"'), 'should exclude .cache');
    assert.ok(entrypoint.includes('--filter "- .config/rclone/**"'), 'should exclude .config/rclone');
    assert.ok(entrypoint.includes('--filter "- **/node_modules/**"'), 'should exclude node_modules');
  });

  it('SYNC_MODE=metadata includes workspace CLAUDE.md and .claude/ but excludes rest', () => {
    // Check the metadata block exists with the expected filters
    const metadataBlock = entrypoint.match(
      /if \[ "\$SYNC_MODE" = "metadata" \]; then[\s\S]*?elif/
    );
    assert.ok(metadataBlock, 'metadata SYNC_MODE block should exist');
    const block = metadataBlock[0];
    assert.ok(block.includes('workspace/**/CLAUDE.md'), 'metadata should include CLAUDE.md');
    assert.ok(block.includes('workspace/**/.claude/**'), 'metadata should include .claude dirs');
    assert.ok(block.includes('--filter "- workspace/**"'), 'metadata should exclude other workspace files');
  });

  it('SYNC_MODE=none excludes workspace entirely', () => {
    const noneBlock = entrypoint.match(
      /elif \[ "\$SYNC_MODE" = "none" \]; then[\s\S]*?else/
    );
    assert.ok(noneBlock, 'none SYNC_MODE block should exist');
    const block = noneBlock[0];
    assert.ok(block.includes('--filter "- workspace/"'), 'none mode should exclude workspace/');
    assert.ok(block.includes('--filter "- workspace/**"'), 'none mode should exclude workspace/**');
  });

  it('SYNC_MODE=full (else branch) uses only common filters', () => {
    // The else branch for full mode just uses RCLONE_FILTERS_COMMON
    const fullBlock = entrypoint.match(
      /else\s+RCLONE_FILTERS=\(\s+"\$\{RCLONE_FILTERS_COMMON\[@\]\}"\s+\)/
    );
    assert.ok(fullBlock, 'full SYNC_MODE (else branch) should only use common filters');
  });

  it('SYNC_MODE defaults to "none"', () => {
    assert.ok(
      entrypoint.includes('SYNC_MODE="${SYNC_MODE:-none}"'),
      'SYNC_MODE should default to "none"'
    );
  });
});

// ============================================================================
// Test: --max-delete flag on bisync commands
// ============================================================================
describe('bisync --max-delete flag', () => {
  it('establish_bisync_baseline() includes --max-delete 100', () => {
    const body = extractFunction('establish_bisync_baseline');
    assert.ok(body.includes('--max-delete'), 'should include --max-delete flag');
    assert.ok(body.includes('--max-delete 100'), 'should set --max-delete to 100');
  });
  it('bisync_with_r2() includes --max-delete 100', () => {
    const body = extractFunction('bisync_with_r2');
    assert.ok(body.includes('--max-delete 100'), 'should include --max-delete 100');
  });
});

// ============================================================================
// Test: bisync_with_r2 --resync fallback removed
// ============================================================================
describe('bisync_with_r2 --resync fallback removed', () => {
  it('bisync_with_r2() does not contain --resync', () => {
    const body = extractFunction('bisync_with_r2');
    assert.ok(!body.includes('--resync'), 'bisync_with_r2 should not contain --resync fallback');
  });
});

// ============================================================================
// Test: establish_bisync_baseline exit code capture
// ============================================================================
describe('establish_bisync_baseline exit code capture', () => {
  it('does not pipe rclone output through tee (which swallows exit code)', () => {
    const body = extractFunction('establish_bisync_baseline');
    const hasPipeTee = /rclone bisync[^;]*\|\s*tee/.test(body);
    assert.ok(!hasPipeTee, 'should not pipe rclone through tee (swallows exit code)');
  });
});

// ============================================================================
// Test: R2 sync exclusion filters — native binary removed, new exclusions added
// ============================================================================
describe('R2 sync exclusion filters', () => {
  it('common filters include .local/share/claude/** exclusion', () => {
    assert.ok(
      entrypoint.includes('--filter "- .local/share/claude/**"'),
      'should exclude .local/share/claude/** (native installer version binaries)'
    );
  });

  it('common filters include .copilot/logs/** exclusion', () => {
    assert.ok(
      entrypoint.includes('--filter "- .copilot/logs/**"'),
      'should exclude .copilot/logs/** (session logs)'
    );
  });

  it('common filters include .copilot/pkg/** exclusion', () => {
    assert.ok(
      entrypoint.includes('--filter "- .copilot/pkg/**"'),
      'should exclude .copilot/pkg/** (auto-update binary download)'
    );
  });

  it('common filters include .codex/sessions/** exclusion', () => {
    assert.ok(
      entrypoint.includes('--filter "- .codex/sessions/**"'),
      'should exclude .codex/sessions/** (TUI session recordings)'
    );
  });

  it('common filters include .copilot/session-state/** exclusion', () => {
    assert.ok(
      entrypoint.includes('--filter "- .copilot/session-state/**"'),
      'should exclude .copilot/session-state/** (per-session checkpoints)'
    );
  });

  it('common filters include .codex/state*.sqlite-shm exclusion', () => {
    assert.ok(
      entrypoint.includes('--filter "- .codex/state*.sqlite-shm"'),
      'should exclude .codex/state*.sqlite-shm (SQLite shared memory)'
    );
  });

  it('common filters include .codex/state*.sqlite-wal exclusion', () => {
    assert.ok(
      entrypoint.includes('--filter "- .codex/state*.sqlite-wal"'),
      'should exclude .codex/state*.sqlite-wal (SQLite WAL)'
    );
  });

  it('common filters include .cpan/** exclusion', () => {
    assert.ok(
      entrypoint.includes('--filter "- .cpan/**"'),
      'should exclude .cpan/** (Perl CPAN cache)'
    );
  });

  it('common filters include .claude/plugins/marketplaces/**/.git/** exclusion', () => {
    assert.ok(
      entrypoint.includes('--filter "- .claude/plugins/marketplaces/**/.git/**"'),
      'should exclude marketplace git clones (reinstalled from remote)'
    );
  });

  it('common filters do NOT include .local/bin/** exclusion', () => {
    assert.ok(
      !entrypoint.includes('--filter "- .local/bin/**"'),
      'should NOT exclude .local/bin/** (filter removed with native binary)'
    );
  });

  it('common filters do NOT include .claude/downloads/** exclusion', () => {
    assert.ok(
      !entrypoint.includes('--filter "- .claude/downloads/**"'),
      'should NOT exclude .claude/downloads/** (filter removed with native binary)'
    );
  });
});

// ============================================================================
// Test: shutdown_handler PID management
// ============================================================================
describe('shutdown_handler PID management', () => {
  it('uses PID file to kill daemon, not shell variable', () => {
    const body = extractFunction('shutdown_handler');
    assert.ok(body.includes('sync-daemon.pid'), 'should use PID file');
    assert.ok(!body.includes('SYNC_DAEMON_PID'), 'should not reference SYNC_DAEMON_PID variable');
  });
});

// ============================================================================
// Test: trap includes EXIT signal for crash recovery
// ============================================================================
describe('trap signal handling', () => {
  it('trap includes EXIT signal for crash recovery', () => {
    assert.ok(
      entrypoint.includes('trap shutdown_handler SIGTERM SIGINT EXIT'),
      'trap should include EXIT signal alongside SIGTERM and SIGINT'
    );
  });
});

// ============================================================================
// Test: bisync_with_r2 uses array expansion for verbose flag
// ============================================================================
describe('bisync_with_r2 verbose flag handling', () => {
  it('bisync_with_r2 uses array expansion for verbose flag', () => {
    const body = extractFunction('bisync_with_r2');
    assert.ok(body, 'bisync_with_r2 function should exist');
    // Should use verbose_args array pattern
    assert.ok(
      body.includes('verbose_args'),
      'bisync_with_r2 should use verbose_args array pattern'
    );
    assert.ok(
      body.includes('"${verbose_args[@]}"'),
      'bisync_with_r2 should use "${verbose_args[@]}" array expansion'
    );
    // Should NOT have bare $VERBOSE in the rclone command line
    // (the local assignment and conditional check are fine, but it shouldn't be passed directly to rclone)
    const rcloneCmd = body.match(/rclone bisync[\s\S]*?;/);
    if (rcloneCmd) {
      assert.ok(
        !rcloneCmd[0].includes('$VERBOSE'),
        'rclone bisync command should not use bare $VERBOSE'
      );
    }
  });
});

// ============================================================================
// Test: Memory merge functions
// ============================================================================
describe('Memory merge functions', () => {
  it('merge_memory_files() function exists', () => {
    const body = extractFunction('merge_memory_files');
    assert.ok(body, 'merge_memory_files function should exist');
  });

  it('cleanup_old_memory_files() function exists', () => {
    const body = extractFunction('cleanup_old_memory_files');
    assert.ok(body, 'cleanup_old_memory_files function should exist');
  });

  it('Creates .memory dir', () => {
    const body = extractFunction('merge_memory_files');
    assert.ok(body.includes('mkdir -p'), 'merge should use mkdir -p');
    assert.ok(body.includes('.memory'), 'merge should reference .memory directory');
  });

  it('Uses SESSION_ID in filename', () => {
    const body = extractFunction('merge_memory_files');
    assert.ok(
      /session-\$\{?SESSION_ID\}?/.test(body),
      'merge should use session-${SESSION_ID} in filename'
    );
    assert.ok(body.includes('.jsonl'), 'merge should use .jsonl extension');
  });

  it('Uses Node.js for dedup', () => {
    const body = extractFunction('merge_memory_files');
    assert.ok(body.includes('node -e'), 'merge should use node -e for inline script');
    assert.ok(body.includes('entities'), 'merge should reference entities for dedup');
  });

  it('Atomic write via .tmp + mv', () => {
    const body = extractFunction('merge_memory_files');
    assert.ok(body.includes('.tmp'), 'merge should write to .tmp file first');
    assert.ok(body.includes('mv '), 'merge should use mv for atomic rename');
  });

  it('Merge does NOT delete old files', () => {
    const body = extractFunction('merge_memory_files');
    assert.ok(!body.includes('rm -f'), 'merge_memory_files should NOT delete files (that is cleanup\'s job)');
  });

  it('Cleanup keeps 3 newest and deletes the rest', () => {
    const body = extractFunction('cleanup_old_memory_files');
    assert.ok(body.includes('rm -f'), 'cleanup should delete old session files');
    assert.ok(body.includes('KEEP=3'), 'cleanup should keep 3 newest files');
    assert.ok(body.includes('sort -rn'), 'cleanup should sort by mtime descending');
  });
});

// ============================================================================
// Test: Memory merge ordering
// ============================================================================
describe('Memory merge ordering', () => {
  it('Merge runs after sync, before baseline', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    const syncCompleteIdx = main.indexOf('Step 1 complete');
    const mergeIdx = main.indexOf('merge_memory_files');
    const bisyncBaselineIdx = main.indexOf('establish_bisync_baseline');

    assert.ok(mergeIdx > -1, 'merge_memory_files should exist in main execution');
    assert.ok(syncCompleteIdx > -1 || main.indexOf('STEP1_RESULT') > -1,
      'sync completion should exist in main execution');
    assert.ok(bisyncBaselineIdx > -1, 'establish_bisync_baseline should exist in main execution');

    assert.ok(
      mergeIdx > main.indexOf('STEP1_RESULT'),
      'merge_memory_files must run after sync completion check'
    );
    assert.ok(
      mergeIdx < bisyncBaselineIdx,
      'merge_memory_files must run before bisync baseline'
    );
  });

  it('Cleanup runs AFTER bisync baseline', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    const bisyncBaselineIdx = main.indexOf('establish_bisync_baseline');
    const cleanupIdx = main.indexOf('cleanup_old_memory_files');

    assert.ok(bisyncBaselineIdx > -1, 'establish_bisync_baseline should exist');
    assert.ok(cleanupIdx > -1, 'cleanup_old_memory_files should exist');
    assert.ok(
      cleanupIdx > bisyncBaselineIdx,
      'cleanup_old_memory_files must run after establish_bisync_baseline'
    );
  });
});

// ============================================================================
// Test: Memory MCP configuration
// ============================================================================
describe('Memory MCP configuration', () => {
  it('MCP config references server-memory', () => {
    assert.ok(
      entrypoint.includes('server-memory'),
      'entrypoint should reference server-memory MCP server'
    );
    assert.ok(
      entrypoint.includes('MEMORY_FILE_PATH'),
      'entrypoint should reference MEMORY_FILE_PATH for memory server config'
    );
  });

  it('.memory/** NOT in rclone exclusions (only .memory/counter/** is excluded)', () => {
    // Find the RCLONE_FILTERS_COMMON block
    const filtersStart = entrypoint.indexOf('RCLONE_FILTERS_COMMON=(');
    const filtersEnd = entrypoint.indexOf(')', filtersStart);
    assert.ok(filtersStart > -1, 'RCLONE_FILTERS_COMMON should exist');
    const filtersBlock = entrypoint.slice(filtersStart, filtersEnd);
    // .memory/counter/** should be excluded (ephemeral per-session counters)
    assert.ok(
      filtersBlock.includes('.memory/counter/**'),
      '.memory/counter/** should be excluded (ephemeral counters)'
    );
    // .memory/** as a whole should NOT be excluded (JSONL files must sync)
    assert.ok(
      !filtersBlock.includes('"- .memory/**"'),
      '.memory/** should NOT be broadly excluded (memory JSONL files must sync to R2)'
    );
  });
});

// ============================================================================
// Test: --check-sync=false flag on bisync commands
// ============================================================================
describe('bisync --check-sync=false flag', () => {
  it('establish_bisync_baseline() includes --check-sync=false', () => {
    const body = extractFunction('establish_bisync_baseline');
    assert.ok(body, 'establish_bisync_baseline function should exist');
    assert.ok(
      body.includes('--check-sync=false'),
      'establish_bisync_baseline should include --check-sync=false'
    );
  });

  it('bisync_with_r2() includes --check-sync=false', () => {
    const body = extractFunction('bisync_with_r2');
    assert.ok(body, 'bisync_with_r2 function should exist');
    assert.ok(
      body.includes('--check-sync=false'),
      'bisync_with_r2 should include --check-sync=false'
    );
  });
});

// ============================================================================
// Test: --retries flag on bisync commands
// ============================================================================
describe('bisync --retries flag', () => {
  it('establish_bisync_baseline() includes --retries 3 --retries-sleep 10s', () => {
    const body = extractFunction('establish_bisync_baseline');
    assert.ok(body, 'establish_bisync_baseline function should exist');
    assert.ok(
      body.includes('--retries 3'),
      'establish_bisync_baseline should include --retries 3'
    );
    assert.ok(
      body.includes('--retries-sleep 10s'),
      'establish_bisync_baseline should include --retries-sleep 10s'
    );
  });

  it('bisync_with_r2() includes --retries 3 --retries-sleep 10s', () => {
    const body = extractFunction('bisync_with_r2');
    assert.ok(body, 'bisync_with_r2 function should exist');
    assert.ok(
      body.includes('--retries 3'),
      'bisync_with_r2 should include --retries 3'
    );
    assert.ok(
      body.includes('--retries-sleep 10s'),
      'bisync_with_r2 should include --retries-sleep 10s'
    );
  });
});

// ============================================================================
// Test: bisync output redirect order (> file 2>&1, not 2>&1 > file)
// ============================================================================
describe('bisync output redirect order', () => {
  it('establish_bisync_baseline() uses correct redirect order (> file 2>&1)', () => {
    const body = extractFunction('establish_bisync_baseline');
    assert.ok(body, 'establish_bisync_baseline function should exist');
    assert.ok(
      body.includes('> "$BASELINE_OUTPUT" 2>&1'),
      'establish_bisync_baseline should use > "$BASELINE_OUTPUT" 2>&1'
    );
    assert.ok(
      !body.includes('2>&1 > "$BASELINE_OUTPUT"'),
      'establish_bisync_baseline should NOT use 2>&1 > "$BASELINE_OUTPUT" (wrong order)'
    );
  });

  it('bisync_with_r2() uses correct redirect order (> file 2>&1)', () => {
    const body = extractFunction('bisync_with_r2');
    assert.ok(body, 'bisync_with_r2 function should exist');
    assert.ok(
      body.includes('> "$SYNC_OUTPUT" 2>&1'),
      'bisync_with_r2 should use > "$SYNC_OUTPUT" 2>&1'
    );
    assert.ok(
      !body.includes('2>&1 > "$SYNC_OUTPUT"'),
      'bisync_with_r2 should NOT use 2>&1 > "$SYNC_OUTPUT" (wrong order)'
    );
  });
});

// ============================================================================
// Test: sync daemon consecutive failure counter + resync fallback
// ============================================================================
describe('sync daemon consecutive failure recovery', () => {
  it('start_sync_daemon() tracks consecutive failures', () => {
    const body = extractFunction('start_sync_daemon');
    assert.ok(body, 'start_sync_daemon function should exist');
    assert.ok(
      body.includes('CONSECUTIVE_FAILURES'),
      'start_sync_daemon should track CONSECUTIVE_FAILURES'
    );
  });

  it('start_sync_daemon() resets counter on success', () => {
    const body = extractFunction('start_sync_daemon');
    assert.ok(body, 'start_sync_daemon function should exist');
    // After a successful sync (SYNC_RESULT -eq 0), counter resets
    assert.ok(
      body.includes('CONSECUTIVE_FAILURES=0'),
      'start_sync_daemon should reset CONSECUTIVE_FAILURES to 0 on success'
    );
  });

  it('start_sync_daemon() falls back to --resync after 3 consecutive failures', () => {
    const body = extractFunction('start_sync_daemon');
    assert.ok(body, 'start_sync_daemon function should exist');
    assert.ok(
      body.includes('CONSECUTIVE_FAILURES -ge 3'),
      'start_sync_daemon should check for >= 3 consecutive failures'
    );
    assert.ok(
      body.includes('establish_bisync_baseline'),
      'start_sync_daemon should call establish_bisync_baseline as resync fallback'
    );
    assert.ok(
      body.includes('resync'),
      'start_sync_daemon should mention resync in a log message'
    );
  });

  it('start_sync_daemon() only resets counter when resync succeeds', () => {
    const body = extractFunction('start_sync_daemon');
    assert.ok(body, 'start_sync_daemon function should exist');
    // The resync is wrapped in an if — counter resets only on success
    assert.ok(
      body.includes('if establish_bisync_baseline'),
      'establish_bisync_baseline should be called inside an if (check return value)'
    );
    // On success: reset to 0
    const geBlock = body.slice(body.indexOf('CONSECUTIVE_FAILURES -ge 3'));
    assert.ok(geBlock, 'should have the >= 3 consecutive failures block');
    assert.ok(
      geBlock.includes('CONSECUTIVE_FAILURES=0'),
      'CONSECUTIVE_FAILURES=0 should appear in the >= 3 block (success path)'
    );
    // On failure: set to 2 (retry resync after 1 more failure)
    assert.ok(
      geBlock.includes('CONSECUTIVE_FAILURES=2'),
      'CONSECUTIVE_FAILURES=2 should appear in the >= 3 block (failure path — retry sooner)'
    );
  });

  it('start_sync_daemon() immediately resyncs when listing files are missing', () => {
    const body = extractFunction('start_sync_daemon');
    assert.ok(body, 'start_sync_daemon function should exist');
    // Should detect missing listing files and force immediate resync
    assert.ok(
      body.includes('No listing files found'),
      'start_sync_daemon should detect missing listing files'
    );
    assert.ok(
      body.includes('CONSECUTIVE_FAILURES=3'),
      'start_sync_daemon should force CONSECUTIVE_FAILURES=3 when listings are missing'
    );
  });
});
