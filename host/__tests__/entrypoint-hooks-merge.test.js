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
// Test: settings.json hooks merge in entrypoint.sh
// ============================================================================
describe('settings.json hooks merge', () => {
  it('merges hook config into ~/.claude/settings.json', () => {
    assert.ok(
      entrypoint.includes('settings.json'),
      'entrypoint should reference settings.json'
    );
    assert.ok(
      entrypoint.includes('hooks'),
      'entrypoint should configure hooks'
    );
  });

  it('configures UserPromptSubmit hook for memory-capture.sh', () => {
    assert.ok(
      entrypoint.includes('memory-capture.sh'),
      'entrypoint should reference memory-capture.sh hook script'
    );
    assert.ok(
      entrypoint.includes('UserPromptSubmit'),
      'entrypoint should configure UserPromptSubmit hook event'
    );
  });

  it('configures PreToolUse hook for block-attributed-commits.sh', () => {
    assert.ok(
      entrypoint.includes('block-attributed-commits.sh'),
      'entrypoint should reference block-attributed-commits.sh hook script'
    );
    assert.ok(
      entrypoint.includes('PreToolUse'),
      'entrypoint should configure PreToolUse hook event'
    );
  });

  it('does not mark memory-capture hook as async', () => {
    // UserPromptSubmit hooks deliver additionalContext via exit 0 — async is not needed
    // Check that the hooks config block does not contain "async"
    const hooksStart = entrypoint.indexOf('"hooks":{');
    const hooksEnd = entrypoint.indexOf('}}\'\n', hooksStart);
    const hooksBlock = entrypoint.slice(hooksStart, hooksEnd);
    assert.ok(
      !hooksBlock.includes('"async"'),
      'memory-capture hook should not be configured as async'
    );
  });

  it('uses jq recursive merge to preserve existing settings', () => {
    // Should use jq '. * $cfg' pattern for recursive merge
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    // Find the settings.json merge block
    assert.ok(
      entrypoint.includes('. * $'),
      'should use jq recursive merge (. * $var) for settings.json'
    );
  });

  it('creates settings.json when it does not exist', () => {
    // Should handle case where settings.json doesn't exist
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    // Should have an else branch that creates the file
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

  it('hooks merge runs before bisync baseline', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    const hooksIdx = main.indexOf('memory-capture.sh');
    const bisyncBaselineIdx = main.indexOf('establish_bisync_baseline');

    assert.ok(hooksIdx > -1, 'hooks config should exist in main execution');
    assert.ok(bisyncBaselineIdx > -1, 'establish_bisync_baseline should exist');
    assert.ok(
      hooksIdx < bisyncBaselineIdx,
      'hooks merge must run before bisync baseline'
    );
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
