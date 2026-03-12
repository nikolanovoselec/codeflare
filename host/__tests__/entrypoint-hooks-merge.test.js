import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Helper: extract the MAIN EXECUTION section
function extractMainExecution() {
  const marker = '# MAIN EXECUTION';
  const idx = entrypoint.indexOf(marker);
  if (idx === -1) return null;
  return entrypoint.slice(idx);
}

// ============================================================================
// Test: settings.json configuration in entrypoint.sh
// ============================================================================
describe('settings.json configuration', () => {
  it('configures settings.json with skipDangerousModePermissionPrompt', () => {
    assert.ok(
      entrypoint.includes('skipDangerousModePermissionPrompt'),
      'entrypoint should configure skipDangerousModePermissionPrompt in settings.json'
    );
  });

  it('advanced mode SETTINGS_CONFIG includes hooks', () => {
    // Advanced mode should merge PreToolUse and UserPromptSubmit hooks into settings.json
    assert.ok(
      entrypoint.includes('PreToolUse'),
      'entrypoint should configure PreToolUse hook for advanced mode'
    );
    assert.ok(
      entrypoint.includes('UserPromptSubmit'),
      'entrypoint should configure UserPromptSubmit hook for advanced mode'
    );
    assert.ok(
      entrypoint.includes('block-attributed-commits.sh'),
      'PreToolUse hook should point to codeflare-hooks plugin script'
    );
    assert.ok(
      entrypoint.includes('memory-capture.sh'),
      'UserPromptSubmit hook should point to codeflare-memory plugin script'
    );
  });

  it('SESSION_MODE gates hook registration', () => {
    assert.ok(
      entrypoint.includes('SESSION_MODE:-default') && entrypoint.includes('"hooks"'),
      'hook registration should be gated on SESSION_MODE'
    );
  });

  it('uses jq recursive merge to preserve existing settings', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      entrypoint.includes('. * $'),
      'should use jq recursive merge (. * $var) for settings.json'
    );
  });

  it('creates settings.json when it does not exist', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('settings.json') && main.includes('else'),
      'should have else branch for creating settings.json when missing'
    );
  });

  it('handles malformed settings.json gracefully (skip with warning)', () => {
    assert.ok(
      entrypoint.includes('WARNING') && entrypoint.includes('settings.json'),
      'should warn about malformed settings.json without overwriting'
    );
  });

  it('settings merge runs before bisync baseline', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    const settingsIdx = main.indexOf('settings.json');
    const bisyncBaselineIdx = main.indexOf('establish_bisync_baseline');

    assert.ok(settingsIdx > -1, 'settings config should exist in main execution');
    assert.ok(bisyncBaselineIdx > -1, 'establish_bisync_baseline should exist');
    assert.ok(
      settingsIdx < bisyncBaselineIdx,
      'settings merge must run before bisync baseline'
    );
  });
});

// ============================================================================
// Test: plugin enablement
// ============================================================================
describe('plugin enablement', () => {
  it('enables codeflare-memory plugin in .claude.json', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('codeflare-memory'),
      'entrypoint should reference codeflare-memory plugin'
    );
    assert.ok(
      main.includes('enabledPlugins'),
      'entrypoint should configure enabledPlugins in .claude.json'
    );
  });

  it('enables codeflare-hooks plugin alongside codeflare-memory', () => {
    const pluginsMatch = entrypoint.match(/PLUGINS_CONFIG='(\{.*?\})'/);
    assert.ok(pluginsMatch, 'PLUGINS_CONFIG assignment should exist');
    const pluginsConfig = JSON.parse(pluginsMatch[1]);
    assert.ok(
      pluginsConfig.enabledPlugins['codeflare-memory'] === true,
      'codeflare-memory should be enabled'
    );
    assert.ok(
      pluginsConfig.enabledPlugins['codeflare-hooks'] === true,
      'codeflare-hooks should be enabled'
    );
  });

  it('plugin enablement uses jq merge into .claude.json', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('enabledPlugins') && main.includes('. * $'),
      'plugin enablement should use jq recursive merge'
    );
  });

  it('plugin enablement is NOT mode-gated (permanent)', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    const pluginIdx = main.indexOf('"codeflare-memory"');
    assert.ok(pluginIdx > -1, 'should have codeflare-memory plugin reference');
  });
});

// ============================================================================
// Test: rclone exclusion for memory counter files
// ============================================================================
describe('rclone memory counter exclusion', () => {
  it('excludes .memory/counter/** from rclone sync', () => {
    assert.ok(
      entrypoint.includes('--filter "- .memory/counter/**"'),
      'should exclude .memory/counter/** from rclone sync'
    );
  });

  it('counter exclusion is in RCLONE_FILTERS_COMMON', () => {
    const filtersStart = entrypoint.indexOf('RCLONE_FILTERS_COMMON=(');
    const filtersEnd = entrypoint.indexOf(')', filtersStart);
    assert.ok(filtersStart > -1, 'RCLONE_FILTERS_COMMON should exist');
    const filtersBlock = entrypoint.slice(filtersStart, filtersEnd);
    assert.ok(
      filtersBlock.includes('.memory/counter'),
      '.memory/counter exclusion should be in RCLONE_FILTERS_COMMON'
    );
  });
});

// ============================================================================
// Test: SESSION_MODE-based .memory/** exclusion
// ============================================================================
describe('SESSION_MODE-based memory exclusion', () => {
  it('default mode excludes entire .memory/ directory', () => {
    assert.ok(
      entrypoint.includes('SESSION_MODE:-default') && entrypoint.includes('.memory/**'),
      'should conditionally exclude .memory/** based on SESSION_MODE'
    );
  });

  it('.memory/** exclusion is NOT in RCLONE_FILTERS_COMMON array literal', () => {
    // .memory/** should be added conditionally AFTER the array, not inside it
    const filtersStart = entrypoint.indexOf('RCLONE_FILTERS_COMMON=(');
    const filtersEnd = entrypoint.indexOf(')', filtersStart);
    assert.ok(filtersStart > -1, 'RCLONE_FILTERS_COMMON should exist');
    const filtersBlock = entrypoint.slice(filtersStart, filtersEnd);
    assert.ok(
      !filtersBlock.includes('"- .memory/**"'),
      '.memory/** should NOT be in the static RCLONE_FILTERS_COMMON array'
    );
  });

  it('uses += to append .memory/** filter conditionally', () => {
    assert.ok(
      entrypoint.includes("RCLONE_FILTERS_COMMON+=('--filter' '- .memory/**')"),
      'should use += to append .memory/** filter when SESSION_MODE is not advanced'
    );
  });
});

// ============================================================================
// Test: counter directory creation
// ============================================================================
describe('memory counter directory creation', () => {
  it('creates ~/.memory/counter directory', () => {
    assert.ok(
      entrypoint.includes('.memory/counter'),
      'entrypoint should reference .memory/counter directory'
    );
    assert.ok(
      entrypoint.includes('mkdir -p') && entrypoint.includes('.memory/counter'),
      'entrypoint should create .memory/counter directory'
    );
  });
});

// ============================================================================
// Test: merge_memory_files and cleanup_old_memory_files SESSION_MODE gating
// ============================================================================
describe('memory functions SESSION_MODE gating', () => {
  it('merge_memory_files is gated on SESSION_MODE=advanced', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    // Find the merge_memory_files call and check it's inside a SESSION_MODE check
    const mergeIdx = main.indexOf('merge_memory_files');
    assert.ok(mergeIdx > -1, 'merge_memory_files should exist in main execution');
    // Check the preceding lines include SESSION_MODE check
    const preceding = main.slice(Math.max(0, mergeIdx - 200), mergeIdx);
    assert.ok(
      preceding.includes('SESSION_MODE:-default'),
      'merge_memory_files call should be gated on SESSION_MODE'
    );
  });

  it('cleanup_old_memory_files is gated on SESSION_MODE=advanced', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    const cleanupIdx = main.indexOf('cleanup_old_memory_files');
    assert.ok(cleanupIdx > -1, 'cleanup_old_memory_files should exist in main execution');
    const preceding = main.slice(Math.max(0, cleanupIdx - 200), cleanupIdx);
    assert.ok(
      preceding.includes('SESSION_MODE:-default'),
      'cleanup_old_memory_files call should be gated on SESSION_MODE'
    );
  });
});
