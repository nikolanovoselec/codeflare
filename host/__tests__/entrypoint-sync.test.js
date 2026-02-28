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
// Test: startup ordering — file modifications before bisync baseline
// ============================================================================
describe('startup ordering: file modifications before bisync baseline', () => {
  it('all file modifications occur before bisync baseline launch in main execution', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    // These file-modifying operations must appear BEFORE the bisync baseline launch
    const claudeJsonIdx = main.indexOf('bypassPermissionsModeAccepted');
    const geminiIdx = main.indexOf('enableAutoUpdate');
    const codexIdx = main.indexOf('dismissed_version');
    const tabAutostartIdx = main.indexOf('configure_tab_autostart');
    const bisyncBaselineIdx = main.indexOf('establish_bisync_baseline');

    assert.ok(claudeJsonIdx > -1, '.claude.json modification should exist in main execution');
    assert.ok(geminiIdx > -1, '.gemini/settings.json modification should exist in main execution');
    assert.ok(codexIdx > -1, '.codex/version.json modification should exist in main execution');
    assert.ok(tabAutostartIdx > -1, 'configure_tab_autostart should exist in main execution');
    assert.ok(bisyncBaselineIdx > -1, 'establish_bisync_baseline should exist in main execution');

    assert.ok(
      claudeJsonIdx < bisyncBaselineIdx,
      '.claude.json modification must run before bisync baseline'
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
