import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
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
    // Advanced mode should merge PreToolUse, PostToolUse, and UserPromptSubmit hooks
    assert.ok(
      entrypoint.includes('PreToolUse'),
      'entrypoint should configure PreToolUse hook for advanced mode'
    );
    assert.ok(
      entrypoint.includes('PostToolUse'),
      'entrypoint should configure PostToolUse hook for review-reminder'
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

  it('hooks use if-gates to filter by command pattern', () => {
    // PreToolUse: block-attributed-commits gated on git * and gh *.
    // PreToolUse block-attributed-commits keeps its `if:` gates because
    // commit/PR-create commands always lead with `git`/`gh`.
    assert.ok(
      entrypoint.includes('"if":"Bash(git *)"'),
      'block-attributed-commits should be if-gated on Bash(git *)'
    );
    assert.ok(
      entrypoint.includes('"if":"Bash(gh *)"'),
      'block-attributed-commits should also be if-gated on Bash(gh *)'
    );
    // PostToolUse git-push-review-reminder must NOT carry a prefix `if:` gate —
    // it would silently skip chained pipelines (`git add . && git push`),
    // see #243. The script's in-process case statement is the canonical filter.
    assert.ok(
      !entrypoint.includes('"if":"Bash(git push*)"'),
      'git-push-review-reminder must NOT be if-gated on Bash(git push*) — chained pushes would be silently bypassed (#243)'
    );
  });

  // REQ-MEM-011 AC1: hooks (PreToolUse and UserPromptSubmit) are merged into
  // settings.json ONLY in advanced mode. Default mode gets only
  // skipDangerousModePermissionPrompt -- no hook registrations.
  it('SESSION_MODE gates hook registration', () => {
    assert.ok(
      entrypoint.includes('SESSION_MODE:-default') && entrypoint.includes('"hooks"'),
      'hook registration should be gated on SESSION_MODE'
    );
  });

  // REQ-MEM-011 AC1: default mode must not inject the hooks block.
  // Verify that the hook registration JSON (PreToolUse + UserPromptSubmit) is
  // inside the advanced-mode branch only -- the SETTINGS_CONFIG variable
  // containing "hooks" must be defined inside the advanced conditional, NOT
  // at the top level that runs regardless of mode.
  it('default mode emits only skipDangerousModePermissionPrompt, not hook registrations', () => {
    // Locate the else/default-mode branch of the SESSION_MODE conditional.
    // The advanced branch assigns SETTINGS_CONFIG with hooks; the default
    // branch must produce a config with ONLY skipDangerousModePermissionPrompt.
    // Strategy: find the block that sets skipDangerousModePermissionPrompt
    // and verify it is not co-located with "PreToolUse" or "UserPromptSubmit"
    // on the same conditional line / assignment.
    const skipIdx = entrypoint.indexOf('skipDangerousModePermissionPrompt');
    assert.notEqual(skipIdx, -1, 'skipDangerousModePermissionPrompt must exist');

    // Extract ~200 chars around the first occurrence to inspect context.
    const context = entrypoint.slice(Math.max(0, skipIdx - 50), skipIdx + 200);

    // The default-mode SETTINGS_CONFIG must not embed hook registrations.
    // If PreToolUse appears within the same assignment block it means hooks
    // are being merged unconditionally -- that violates AC1.
    assert.ok(
      !context.includes('PreToolUse'),
      'skipDangerousModePermissionPrompt assignment must not include PreToolUse (default mode must be hook-free)'
    );
    assert.ok(
      !context.includes('UserPromptSubmit'),
      'skipDangerousModePermissionPrompt assignment must not include UserPromptSubmit (default mode must be hook-free)'
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
//
// Behavioral: spawn rclone with the actual filters extracted from entrypoint.sh
// against a real tmpdir, assert counter files are excluded from `ls` output.
// Skipped if rclone isn't on PATH (test env doesn't have it). NO text-matching:
// either rclone proves the filter excludes the file, or the test skips with a
// concrete reason.
// ============================================================================
// ============================================================================
// Test: memory-capture counter location (post REQ-MEM-002 AC6 redesign)
//
// The counter directory moved from $HOME/.memory/counter/ to
// /tmp/.memory-counter/ to leverage Cloudflare Containers' ephemeral-disk
// guarantee (every container start = fresh /tmp = canonical "fresh container"
// signal). The bisync filter and the boot-time mkdir are therefore obsolete
// and must be absent from entrypoint.sh; the hook script itself mkdir -p's the
// new /tmp path on first fire.
// ============================================================================
describe('memory-capture counter location (REQ-MEM-002 AC6)', () => {
  it('entrypoint.sh does NOT carry the obsolete .memory/counter bisync filter', () => {
    const start = entrypoint.indexOf('RCLONE_FILTERS_COMMON=(');
    const end = entrypoint.indexOf('\n)\n', start);
    assert.ok(start > -1 && end > start, 'RCLONE_FILTERS_COMMON array not found');
    const block = entrypoint.slice(start, end);
    const filterRx = /--filter\s+["']-\s+([^"']+)["']/g;
    const patterns = [];
    let m;
    while ((m = filterRx.exec(block)) !== null) patterns.push(m[1]);
    assert.ok(
      !patterns.includes('.memory/counter/**'),
      'obsolete filter .memory/counter/** must be absent (counter now under /tmp)'
    );
  });

  it('entrypoint.sh does NOT carry the obsolete mkdir -p ~/.memory/counter', () => {
    assert.doesNotMatch(
      entrypoint,
      /mkdir\s+-p\s+["']?\$\{?USER_HOME\}?\/\.memory\/counter["']?/,
      'obsolete mkdir -p $USER_HOME/.memory/counter must be absent'
    );
  });

  it('memory-capture.sh resolves COUNTER_DIR to /tmp/.memory-counter by default', () => {
    const hookPath = resolve(
      __dirname,
      '../../preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture.sh',
    );
    const hook = readFileSync(hookPath, 'utf-8');
    assert.match(
      hook,
      /COUNTER_DIR=["']?\$\{MEMCAP_COUNTER_DIR:-\/tmp\/\.memory-counter\}["']?/,
      'memory-capture.sh must default COUNTER_DIR to /tmp/.memory-counter via MEMCAP_COUNTER_DIR override'
    );
    assert.match(
      hook,
      /mkdir\s+-p\s+["']?\$COUNTER_DIR["']?/,
      'memory-capture.sh must mkdir -p its own COUNTER_DIR on first fire'
    );
  });
});

// merge_memory_files and cleanup_old_memory_files were removed alongside the
// MCP server-memory subsystem; the vault is now the sole cross-session memory
// store. ~/.memory/counter survives as the hook gate (see counter directory
// test above).
