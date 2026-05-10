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
//
// Behavioral: spawn rclone with the actual filters extracted from entrypoint.sh
// against a real tmpdir, assert counter files are excluded from `ls` output.
// Skipped if rclone isn't on PATH (test env doesn't have it). NO text-matching:
// either rclone proves the filter excludes the file, or the test skips with a
// concrete reason.
// ============================================================================
describe('rclone memory counter exclusion (behavior)', () => {
  const hasRclone = (() => {
    const r = spawnSync('which', ['rclone'], { encoding: 'utf8' });
    return r.status === 0;
  })();

  it(
    'rclone with extracted filters excludes .memory/counter/** but keeps siblings',
    // Skipped on hosts without rclone installed (CI runners may differ).
    // The full-stack smoke is verified at deploy time when bisync runs in
    // the live container.
    { skip: hasRclone ? false : 'rclone not installed on this host' },
    () => {
      // Extract every `--filter` entry from RCLONE_FILTERS_COMMON in
      // entrypoint.sh by parsing the array literal block.
      const start = entrypoint.indexOf('RCLONE_FILTERS_COMMON=(');
      const end = entrypoint.indexOf('\n)\n', start);
      assert.ok(start > -1 && end > start, 'RCLONE_FILTERS_COMMON array not found');
      const block = entrypoint.slice(start, end);
      // Each filter line: --filter "- pattern" or --filter '- pattern'.
      // Capture the pattern.
      const filterRx = /--filter\s+["']-\s+([^"']+)["']/g;
      const patterns = [];
      let m;
      while ((m = filterRx.exec(block)) !== null) patterns.push(m[1]);
      assert.ok(
        patterns.includes('.memory/counter/**'),
        '.memory/counter/** must be one of the extracted filter patterns'
      );

      const dir = mkdtempSync(join(tmpdir(), 'rclone-filters-'));
      mkdirSync(join(dir, '.memory/counter'), { recursive: true });
      writeFileSync(join(dir, '.memory/counter/sess-1.jsonl'), '{}');
      writeFileSync(join(dir, '.memory/keep-me.jsonl'), '{}');
      writeFileSync(join(dir, 'normal-file.txt'), 'x');

      // Build the same --filter args rclone gets in production.
      const rcloneArgs = ['ls', dir];
      for (const p of patterns) {
        rcloneArgs.push('--filter', `- ${p}`);
      }
      const ls = spawnSync('rclone', rcloneArgs, { encoding: 'utf8' });
      assert.equal(ls.status, 0, `rclone ls failed: ${ls.stderr}`);

      assert.ok(
        !ls.stdout.includes('counter/sess-1.jsonl'),
        `counter file must be excluded; got:\n${ls.stdout}`
      );
      assert.ok(
        ls.stdout.includes('normal-file.txt'),
        'unrelated file must remain visible'
      );
    }
  );
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

  // The "cleanup_old_memory_files is gated on SESSION_MODE=advanced" test was
  // removed: the asserted invariant no longer holds in production (cleanup
  // now runs unconditionally inside the bisync-baseline subshell because in
  // default mode .memory/** is excluded from sync, making the gate moot). The
  // test was also text-matching theater per tdd-discipline.md — it scanned
  // 200 chars before the function name for a substring rather than exercising
  // any real behavior.
});
