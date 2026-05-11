// Behavioral test for entrypoint.sh's settings.json hook merge: verifies that
// duplicated `enforce-ctx-mode.sh` entries get pruned by the "managed hooks"
// regex on every entrypoint run, both when context-mode hooks are being
// re-applied (advanced+manifest) and when downgrading to default mode.
//
// "Run the real thing" per tdd-discipline.md: extracts the actual jq filter
// from entrypoint.sh and runs jq against a fixture settings.json that
// reproduces the prod accumulation pattern (4× duplicate strict-hook
// entries on the Bash|WebFetch|Grep matcher). If the regex doesn't match
// the enforce-ctx-mode.sh paths, the test fails.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Extract the jq filter expression used to merge SETTINGS_CONFIG into
// settings.json. Bounded by the literal opener `jq --argjson cfg
// "$SETTINGS_CONFIG" '` and the literal closer `' "$SETTINGS_FILE"`.
function extractMergeFilter() {
  const opener = `jq --argjson cfg "$SETTINGS_CONFIG" '`;
  const closer = `' "$SETTINGS_FILE"`;
  const start = entrypoint.indexOf(opener);
  if (start === -1) throw new Error('settings.json merge jq opener not found');
  const filterStart = start + opener.length;
  const end = entrypoint.indexOf(closer, filterStart);
  if (end === -1) throw new Error('settings.json merge jq closer not found');
  return entrypoint.slice(filterStart, end);
}

// Build a settings.json fixture that mirrors the prod accumulation pattern:
// the matcher `Bash|WebFetch|Grep` carries FOUR copies of the strict hook
// invocation (once at the legacy ~/.claude/hooks/ path + three identical
// entries under ~/.claude/plugins/context-mode/scripts/). Plus a user-added
// hook on a different matcher that must be preserved.
function accumulatedSettingsFixture() {
  const strictLegacy = 'bash /home/user/.claude/hooks/enforce-ctx-mode.sh';
  const strictPlugin = 'bash /home/user/.claude/plugins/context-mode/scripts/enforce-ctx-mode.sh';
  return JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'bash /home/user/.claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh' },
          ],
        },
        {
          matcher: 'Bash|Read|WebFetch|Grep|Glob|Agent',
          hooks: [
            { type: 'command', command: 'context-mode hook claude-code pretooluse' },
          ],
        },
        {
          matcher: 'Bash|WebFetch|Grep',
          hooks: [
            { type: 'command', command: strictLegacy },
            { type: 'command', command: strictPlugin },
            { type: 'command', command: strictPlugin },
            { type: 'command', command: strictPlugin },
          ],
        },
        {
          // User-added hook on its own matcher — must survive merge.
          matcher: 'Edit',
          hooks: [
            { type: 'command', command: 'bash /home/user/custom/my-hook.sh' },
          ],
        },
      ],
    },
  });
}

// The advanced+manifest SETTINGS_CONFIG that entrypoint.sh builds when the
// plugin manifest is present. We assemble it inline rather than re-extracting
// from bash because we only need the merge target to contain ONE strict-hook
// entry on the Bash|WebFetch|Grep matcher — the surface we're testing.
function advancedContextModeSettingsConfig() {
  const strictPlugin = 'bash /home/user/.claude/plugins/context-mode/scripts/enforce-ctx-mode.sh';
  return {
    skipDangerousModePermissionPrompt: true,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', if: 'Bash(git *)', command: 'bash /home/user/.claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh' },
            { type: 'command', if: 'Bash(gh *)', command: 'bash /home/user/.claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh' },
          ],
        },
        {
          matcher: 'Bash|Read|WebFetch|Grep|Glob|Agent',
          hooks: [
            { type: 'command', command: 'context-mode hook claude-code pretooluse' },
          ],
        },
        {
          matcher: 'Bash|WebFetch|Grep',
          hooks: [
            { type: 'command', command: strictPlugin },
          ],
        },
      ],
    },
  };
}

// Default-mode SETTINGS_CONFIG: no hooks. Used to verify downgrade prunes
// previously-managed strict-hook entries.
function defaultModeSettingsConfig() {
  return { skipDangerousModePermissionPrompt: true };
}

function runJqMerge(settingsJson, settingsConfig) {
  const filter = extractMergeFilter();
  const cwd = mkdtempSync(join(tmpdir(), 'ctx-dedup-'));
  const settingsPath = join(cwd, 'settings.json');
  writeFileSync(settingsPath, settingsJson);
  const result = spawnSync(
    'jq',
    ['--argjson', 'cfg', JSON.stringify(settingsConfig), filter, settingsPath],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    throw new Error(`jq exited ${result.status}: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function strictHookEntries(merged) {
  const pre = merged?.hooks?.PreToolUse ?? [];
  const strict = pre.find((entry) => entry.matcher === 'Bash|WebFetch|Grep');
  return strict?.hooks ?? [];
}

describe('entrypoint settings.json hook merge - enforce-ctx-mode.sh dedup', () => {
  it('advanced re-apply: 4× duplicated strict hook entries collapse to exactly 1', () => {
    const merged = runJqMerge(accumulatedSettingsFixture(), advancedContextModeSettingsConfig());
    const strict = strictHookEntries(merged);
    assert.equal(
      strict.length,
      1,
      `expected exactly 1 strict-hook entry after merge, got ${strict.length}: ${JSON.stringify(strict)}`,
    );
    assert.ok(
      strict[0].command.includes('enforce-ctx-mode.sh'),
      'surviving entry should be the canonical enforce-ctx-mode.sh path',
    );
  });

  it('advanced re-apply: legacy ~/.claude/hooks/ path is also pruned', () => {
    const merged = runJqMerge(accumulatedSettingsFixture(), advancedContextModeSettingsConfig());
    const strict = strictHookEntries(merged);
    const legacySurvives = strict.some((h) => h.command.includes('/.claude/hooks/enforce-ctx-mode.sh'));
    assert.equal(
      legacySurvives,
      false,
      'legacy ~/.claude/hooks/enforce-ctx-mode.sh entry must be pruned by the managed-hooks regex',
    );
  });

  it('user-added hooks on unmanaged matchers are preserved', () => {
    const merged = runJqMerge(accumulatedSettingsFixture(), advancedContextModeSettingsConfig());
    const userMatcher = merged.hooks.PreToolUse.find((e) => e.matcher === 'Edit');
    assert.ok(userMatcher, 'user-added Edit matcher should survive');
    assert.equal(userMatcher.hooks[0].command, 'bash /home/user/custom/my-hook.sh');
  });

  it('downgrade to default mode: all strict-hook entries are pruned', () => {
    const merged = runJqMerge(accumulatedSettingsFixture(), defaultModeSettingsConfig());
    const pre = merged?.hooks?.PreToolUse ?? [];
    const anyStrict = pre.some((entry) =>
      (entry.hooks ?? []).some((h) => (h.command ?? '').includes('enforce-ctx-mode.sh')),
    );
    assert.equal(
      anyStrict,
      false,
      'after downgrade, no enforce-ctx-mode.sh entries should remain in any PreToolUse matcher',
    );
  });

  it('downgrade to default mode: user-added Edit matcher is still preserved', () => {
    const merged = runJqMerge(accumulatedSettingsFixture(), defaultModeSettingsConfig());
    const userMatcher = merged?.hooks?.PreToolUse?.find((e) => e.matcher === 'Edit');
    assert.ok(
      userMatcher,
      'user-added Edit matcher must survive downgrade (only managed hooks are pruned)',
    );
  });
});
