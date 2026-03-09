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
  it('settings.json merge includes enabledPlugins for all advanced plugins', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('enabledPlugins'),
      'entrypoint should configure enabledPlugins in settings.json'
    );
    assert.ok(
      main.includes('everything-claude-code@everything-claude-code'),
      'enabledPlugins should reference ECC plugin'
    );
    assert.ok(
      main.includes('context7@claude-plugins-official'),
      'enabledPlugins should reference context7 plugin'
    );
    assert.ok(
      main.includes('superpowers@claude-plugins-official'),
      'enabledPlugins should reference superpowers plugin'
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
  it('exports ECC_DISABLED_HOOKS with 4 disabled hooks', () => {
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
    assert.ok(
      main.includes('post:bash:build-complete'),
      'should disable post:bash:build-complete hook (no-op stub)'
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

// ============================================================================
// Test: Preseeded run-with-flags-shell.sh uses bash (rclone permission fix)
// ============================================================================
describe('run-with-flags-shell.sh rclone permission fix', () => {
  const rwfPath = resolve(__dirname, '../../preseed/agents/claude/plugins/cache/everything-claude-code/everything-claude-code/1.8.0/scripts/hooks/run-with-flags-shell.sh');
  let rwfContent;

  try {
    rwfContent = readFileSync(rwfPath, 'utf8');
  } catch {
    rwfContent = null;
  }

  it('preseeded run-with-flags-shell.sh exists', () => {
    assert.ok(rwfContent, 'run-with-flags-shell.sh should exist in preseed');
  });

  it('invokes scripts via bash instead of direct execution', () => {
    assert.ok(rwfContent, 'file must exist');
    assert.ok(
      rwfContent.includes('bash "$SCRIPT_PATH"'),
      'should use bash "$SCRIPT_PATH" (rclone strips execute bits)'
    );
    assert.ok(
      !rwfContent.match(/\| "\$SCRIPT_PATH"$/m),
      'should NOT use direct "$SCRIPT_PATH" invocation'
    );
  });

  it('is listed in manifest.json for advanced mode', () => {
    const manifest = readFileSync(resolve(__dirname, '../../preseed/agents/claude/manifest.json'), 'utf8');
    assert.ok(
      manifest.includes('run-with-flags-shell.sh'),
      'manifest should include run-with-flags-shell.sh'
    );
  });
});

// ============================================================================
// Test: CL v2.1 Instinct system (homunculus) configuration
// ============================================================================
describe('CL v2.1 Instinct system configuration', () => {
  it('creates homunculus directory inside advanced mode block', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('homunculus'),
      'should reference homunculus directory'
    );
    assert.ok(
      main.includes('mkdir -p "$HOMUNCULUS_DIR"'),
      'should create homunculus directory'
    );
  });

  it('writes config.json with observer settings', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    assert.ok(
      main.includes('config.json'),
      'should write homunculus config.json'
    );
    assert.ok(
      main.includes('"observer"'),
      'config should contain observer settings'
    );
    assert.ok(
      main.includes('run_interval_minutes'),
      'config should set observer interval'
    );
    assert.ok(
      main.includes('min_observations_to_analyze'),
      'config should set minimum observations threshold'
    );
  });

  it('observer loop is disabled for 1-vCPU container', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');
    // observer.enabled should be false — analysis too heavy for 1-vCPU
    assert.ok(
      main.includes('"enabled": false'),
      'observer loop should be disabled (enabled: false) for 1-vCPU'
    );
  });

  it('homunculus config is inside the advanced mode guard', () => {
    const main = extractMainExecution();
    assert.ok(main, 'MAIN EXECUTION section should exist');

    // The advanced mode guard checks for rules/common
    const guardIdx = main.indexOf('if [ -d "$USER_CLAUDE_DIR/rules/common" ]');
    const homunculusIdx = main.indexOf('HOMUNCULUS_DIR=');

    assert.ok(guardIdx > -1, 'advanced mode guard should exist');
    assert.ok(homunculusIdx > -1, 'HOMUNCULUS_DIR should exist');
    assert.ok(
      guardIdx < homunculusIdx,
      'homunculus config must be inside the advanced mode guard block'
    );
  });
});
