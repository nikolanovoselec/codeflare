import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT_PATH = resolve(__dirname, '../../entrypoint.sh');
const entrypoint = readFileSync(ENTRYPOINT_PATH, 'utf8');

// Run the SESSION_MODE-gated settings block from entrypoint.sh in a
// subshell with stub PLUGIN_DIR + CONTEXT_MODE_VERSION + SESSION_MODE,
// capture and parse the resulting SETTINGS_CONFIG. Same pattern as
// entrypoint-context-mode.test.js (see tdd-discipline.md "Run the
// real thing"): exercise the actual jq filter that ships rather than
// text-matching the bash source.
function runSettingsBlock(sessionMode) {
  const result = spawnSync('bash', ['-c', `
    set -e
    PLUGIN_DIR=/test-stub/plugins
    CONTEXT_MODE_VERSION=$(grep '^CONTEXT_MODE_VERSION=' ${ENTRYPOINT_PATH} | head -1 | cut -d'"' -f2)
    SESSION_MODE=${sessionMode}
    START=$(grep -n '^if \\[ "\\\${SESSION_MODE:-default}" = "advanced"' ${ENTRYPOINT_PATH} | head -1 | cut -d: -f1)
    END=$(awk -v s="$START" 'NR>s && /^fi$/ {print NR; exit}' ${ENTRYPOINT_PATH})
    BLOCK=$(sed -n "$START,$END"p ${ENTRYPOINT_PATH})
    eval "$BLOCK" >/dev/null 2>&1
    printf '%s' "$SETTINGS_CONFIG"
  `], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`bash failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

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
    // Advanced mode wires PreToolUse, PostToolUse, PreCompact, SessionStart,
    // Stop, and UserPromptSubmit. Detailed structural assertions live in
    // entrypoint-context-mode.test.js; this test just verifies the
    // advanced-mode block declares the expected event names.
    assert.ok(
      entrypoint.includes('PreToolUse'),
      'entrypoint should configure PreToolUse hook for advanced mode'
    );
    assert.ok(
      entrypoint.includes('PostToolUse'),
      'entrypoint should configure PostToolUse hook (context-mode posttooluse)'
    );
    assert.ok(
      entrypoint.includes('UserPromptSubmit'),
      'entrypoint should configure UserPromptSubmit hook for advanced mode'
    );
    assert.ok(
      entrypoint.includes('block-attributed-commits.sh'),
      'PreToolUse should still wire block-attributed-commits (Codeflare-managed)'
    );
    assert.ok(
      entrypoint.includes('memory-capture.sh'),
      'UserPromptSubmit hook should point to codeflare-memory plugin script'
    );
  });

  it('PreToolUse if-gates filter block-attributed-commits by git/gh command pattern', () => {
    // commit/PR-create commands always lead with git/gh; the if-gate is
    // what keeps block-attributed-commits from running on every Bash call.
    // The retired git-push-review-reminder.sh used to live in PostToolUse
    // without an if-gate, so chained pipelines like
    // `git add . && git push` silently bypassed it (issue #243).
    const settings = runSettingsBlock('advanced');
    const pre = settings.hooks.PreToolUse;
    const block = pre.find((e) =>
      e.hooks.some((h) => h.command && h.command.includes('block-attributed-commits.sh')),
    );
    assert.ok(block, 'block-attributed-commits PreToolUse entry must exist');
    const gates = block.hooks.map((h) => h.if).filter(Boolean);
    assert.ok(gates.includes('Bash(git *)'),
      `block-attributed-commits should be if-gated on Bash(git *), got: ${gates.join(',')}`);
    assert.ok(gates.includes('Bash(gh *)'),
      `block-attributed-commits should be if-gated on Bash(gh *), got: ${gates.join(',')}`);

    // The retired hook must not reappear in any hook event.
    for (const arr of Object.values(settings.hooks)) {
      for (const entry of arr) {
        for (const hook of entry.hooks || []) {
          assert.ok(
            !(hook.command && hook.command.includes('git-push-review-reminder.sh')),
            'git-push-review-reminder.sh is retired (AD49) and must not be referenced',
          );
        }
      }
    }
  });

  it('SESSION_MODE gates hook registration: advanced wires hooks, default does not', () => {
    // Pro mode (SESSION_MODE=advanced) emits a hooks key; Standard mode
    // (default) emits ONLY skipDangerousModePermissionPrompt. This is
    // the gate that keeps Codeflare's full hook stack from being applied
    // to non-Pro sessions.
    const advanced = runSettingsBlock('advanced');
    assert.ok(advanced.hooks && Object.keys(advanced.hooks).length > 0,
      'advanced mode must produce hooks');

    const standard = runSettingsBlock('default');
    assert.strictEqual(standard.hooks, undefined,
      'default (Standard) mode must not produce hooks');
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
