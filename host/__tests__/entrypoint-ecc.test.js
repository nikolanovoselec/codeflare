import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Helper: extract the RCLONE_FILTERS_COMMON block
function extractRcloneFilters() {
  const start = entrypoint.indexOf('RCLONE_FILTERS_COMMON=(');
  const end = entrypoint.indexOf(')', start);
  if (start === -1 || end === -1) return null;
  return entrypoint.slice(start, end);
}

// Helper: extract the MAIN EXECUTION section
function extractMainExecution() {
  const marker = '# MAIN EXECUTION';
  const idx = entrypoint.indexOf(marker);
  if (idx === -1) return null;
  return entrypoint.slice(idx);
}

// ============================================================================
// Test: rclone filters do NOT exclude .claude/plugins/cache/
// ============================================================================
describe('ECC plugin cache persistence', () => {
  it('rclone filters do NOT exclude .claude/plugins/cache/', () => {
    const filters = extractRcloneFilters();
    assert.ok(filters, 'RCLONE_FILTERS_COMMON should exist');
    assert.ok(
      !filters.includes('.claude/plugins/cache'),
      'rclone filters must NOT exclude .claude/plugins/cache/ — ECC plugin must persist via R2'
    );
  });

  it('still excludes other .claude/ ephemeral data', () => {
    const filters = extractRcloneFilters();
    assert.ok(filters, 'RCLONE_FILTERS_COMMON should exist');
    assert.ok(
      filters.includes('.claude/cache/**'),
      'should still exclude .claude/cache/**'
    );
    assert.ok(
      filters.includes('.claude/debug/**'),
      'should still exclude .claude/debug/**'
    );
  });
});

// ============================================================================
// Test: settings.json merge includes enabledPlugins for ECC
// ============================================================================
describe('ECC enabledPlugins configuration', () => {
  it('settings.json merge includes enabledPlugins for ECC', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('enabledPlugins'),
      'entrypoint should configure enabledPlugins in settings.json'
    );
    assert.ok(
      main.includes('everything-claude-code'),
      'enabledPlugins should reference everything-claude-code plugin'
    );
  });

  it('ECC plugin enablement is gated to advanced mode (checks for rules/common)', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('rules/common'),
      'ECC plugin enablement should check for presence of rules/common directory'
    );
  });

  it('uses jq recursive merge for enabledPlugins', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    // Should use jq '. * $ecc' pattern
    assert.ok(
      main.includes('. * $ecc'),
      'should use jq recursive merge for ECC enabledPlugins'
    );
  });
});

// ============================================================================
// Test: ECC_DISABLED_HOOKS env var
// ============================================================================
describe('ECC_DISABLED_HOOKS environment variable', () => {
  it('exports ECC_DISABLED_HOOKS with 3 CPU-heavy hooks', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('ECC_DISABLED_HOOKS'),
      'should export ECC_DISABLED_HOOKS env var'
    );
    assert.ok(
      main.includes('post:edit:format'),
      'should disable post:edit:format hook'
    );
    assert.ok(
      main.includes('post:edit:typecheck'),
      'should disable post:edit:typecheck hook'
    );
    assert.ok(
      main.includes('post:quality-gate'),
      'should disable post:quality-gate hook'
    );
  });
});

// ============================================================================
// Test: settings.json merge preserves existing hooks and permissions
// ============================================================================
describe('ECC configuration preserves existing settings', () => {
  it('ECC enabledPlugins merge runs after hooks merge', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    const hooksIdx = main.indexOf('HOOKS_CONFIG=');
    const eccIdx = main.indexOf('ECC_PLUGINS=');

    assert.ok(hooksIdx > -1, 'HOOKS_CONFIG should exist in main execution');
    assert.ok(eccIdx > -1, 'ECC_PLUGINS should exist in main execution');
    assert.ok(
      hooksIdx < eccIdx,
      'hooks merge must run before ECC enabledPlugins merge'
    );
  });

  it('ECC enabledPlugins merge runs before bisync baseline', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    const eccIdx = main.indexOf('ECC_PLUGINS=');
    const bisyncIdx = main.indexOf('establish_bisync_baseline');

    assert.ok(eccIdx > -1, 'ECC_PLUGINS should exist');
    assert.ok(bisyncIdx > -1, 'establish_bisync_baseline should exist');
    assert.ok(
      eccIdx < bisyncIdx,
      'ECC enabledPlugins merge must run before bisync baseline'
    );
  });
});
