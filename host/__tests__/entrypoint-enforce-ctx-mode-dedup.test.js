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

// Reproduces the prod accumulation observed in production verification of
// PR #367: vault-monitor-hook.sh registered 2x on UserPromptSubmit and the
// graphify hooks (graphify-clone-prompt.sh, graphify-session-start.sh)
// registered 10x each. Without the extended MANAGED_HOOKS_REGEX, the merge
// preserves every prior copy because the prune regex only knew about
// codeflare-(hooks|memory)/scripts/ + enforce-ctx-mode.sh + context-mode
// invocations.
function accumulatedVaultGraphifySettingsFixture() {
  const vaultHook = 'bash /home/user/.claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh';
  const memoryHook = 'bash /home/user/.claude/plugins/codeflare-memory/scripts/memory-capture.sh';
  const graphifyClone = 'bash /home/user/.claude/plugins/graphify/scripts/graphify-clone-prompt.sh';
  const graphifyStart = 'bash /home/user/.claude/plugins/graphify/scripts/graphify-session-start.sh';
  return JSON.stringify({
    skipDangerousModePermissionPrompt: true,
    hooks: {
      UserPromptSubmit: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: vaultHook },
            { type: 'command', command: memoryHook },
            { type: 'command', command: vaultHook },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: graphifyClone },
            { type: 'command', command: graphifyClone },
            { type: 'command', command: graphifyClone },
            { type: 'command', command: graphifyClone },
            { type: 'command', command: graphifyClone },
            { type: 'command', command: graphifyClone },
            { type: 'command', command: graphifyClone },
            { type: 'command', command: graphifyClone },
            { type: 'command', command: graphifyClone },
            { type: 'command', command: graphifyClone },
          ],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup',
          hooks: Array.from({ length: 10 }, () => ({ type: 'command', command: graphifyStart })),
        },
        {
          // User-added SessionStart hook on the default matcher — must survive.
          matcher: '',
          hooks: [
            { type: 'command', command: 'bash /home/user/custom/my-session-start.sh' },
          ],
        },
      ],
    },
  });
}

// Canonical advanced-mode config with one copy of each managed hook on its
// canonical matcher (mirrors what entrypoint.sh assembles into SETTINGS_CONFIG).
function advancedVaultGraphifySettingsConfig() {
  const vaultHook = 'bash /home/user/.claude/plugins/codeflare-vault/scripts/vault-monitor-hook.sh';
  const memoryHook = 'bash /home/user/.claude/plugins/codeflare-memory/scripts/memory-capture.sh';
  const graphifyClone = 'bash /home/user/.claude/plugins/graphify/scripts/graphify-clone-prompt.sh';
  const graphifyStart = 'bash /home/user/.claude/plugins/graphify/scripts/graphify-session-start.sh';
  return {
    skipDangerousModePermissionPrompt: true,
    hooks: {
      UserPromptSubmit: [
        {
          matcher: '',
          hooks: [
            { type: 'command', command: memoryHook },
            { type: 'command', command: vaultHook },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: graphifyClone }],
        },
      ],
      SessionStart: [
        {
          matcher: 'startup',
          hooks: [{ type: 'command', command: graphifyStart }],
        },
      ],
    },
  };
}

describe('entrypoint settings.json hook merge - vault + graphify dedup', () => {
  it('vault-monitor-hook.sh duplicated 2x collapses to exactly 1 on UserPromptSubmit', () => {
    const merged = runJqMerge(accumulatedVaultGraphifySettingsFixture(), advancedVaultGraphifySettingsConfig());
    const ups = merged?.hooks?.UserPromptSubmit ?? [];
    const defaultMatcher = ups.find((e) => e.matcher === '');
    assert.ok(defaultMatcher, 'UserPromptSubmit default matcher must exist after merge');
    const vaultCount = defaultMatcher.hooks.filter((h) => h.command.includes('vault-monitor-hook.sh')).length;
    assert.equal(
      vaultCount,
      1,
      `expected exactly 1 vault-monitor-hook.sh entry, got ${vaultCount}: ${JSON.stringify(defaultMatcher.hooks)}`,
    );
  });

  it('memory-capture.sh stays exactly 1 (was already managed by codeflare-memory regex)', () => {
    const merged = runJqMerge(accumulatedVaultGraphifySettingsFixture(), advancedVaultGraphifySettingsConfig());
    const ups = merged?.hooks?.UserPromptSubmit ?? [];
    const defaultMatcher = ups.find((e) => e.matcher === '');
    const memCount = defaultMatcher.hooks.filter((h) => h.command.includes('memory-capture.sh')).length;
    assert.equal(memCount, 1, 'memory-capture.sh should remain exactly 1 after dedup');
  });

  it('graphify-clone-prompt.sh duplicated 10x collapses to exactly 1 on PostToolUse[Bash]', () => {
    const merged = runJqMerge(accumulatedVaultGraphifySettingsFixture(), advancedVaultGraphifySettingsConfig());
    const post = merged?.hooks?.PostToolUse ?? [];
    const bashMatcher = post.find((e) => e.matcher === 'Bash');
    assert.ok(bashMatcher, 'PostToolUse Bash matcher must exist after merge');
    const cloneCount = bashMatcher.hooks.filter((h) => h.command.includes('graphify-clone-prompt.sh')).length;
    assert.equal(
      cloneCount,
      1,
      `expected exactly 1 graphify-clone-prompt.sh entry, got ${cloneCount}`,
    );
  });

  it('graphify-session-start.sh duplicated 10x collapses to exactly 1 on SessionStart[startup]', () => {
    const merged = runJqMerge(accumulatedVaultGraphifySettingsFixture(), advancedVaultGraphifySettingsConfig());
    const ss = merged?.hooks?.SessionStart ?? [];
    const startupMatcher = ss.find((e) => e.matcher === 'startup');
    assert.ok(startupMatcher, 'SessionStart startup matcher must exist after merge');
    const startCount = startupMatcher.hooks.filter((h) => h.command.includes('graphify-session-start.sh')).length;
    assert.equal(
      startCount,
      1,
      `expected exactly 1 graphify-session-start.sh entry, got ${startCount}`,
    );
  });

  it('user-added SessionStart hook on default matcher survives the prune', () => {
    const merged = runJqMerge(accumulatedVaultGraphifySettingsFixture(), advancedVaultGraphifySettingsConfig());
    const ss = merged?.hooks?.SessionStart ?? [];
    const userMatcher = ss.find((e) => e.matcher === '');
    assert.ok(userMatcher, 'user-added SessionStart default-matcher entry must survive');
    assert.equal(userMatcher.hooks[0].command, 'bash /home/user/custom/my-session-start.sh');
  });

  it('downgrade to default mode: vault and graphify managed hooks are pruned', () => {
    const merged = runJqMerge(accumulatedVaultGraphifySettingsFixture(), defaultModeSettingsConfig());
    const allCommands = JSON.stringify(merged?.hooks ?? {});
    assert.ok(!allCommands.includes('vault-monitor-hook.sh'), 'vault-monitor-hook.sh must be pruned on downgrade');
    assert.ok(!allCommands.includes('graphify-clone-prompt.sh'), 'graphify-clone-prompt.sh must be pruned on downgrade');
    assert.ok(!allCommands.includes('graphify-session-start.sh'), 'graphify-session-start.sh must be pruned on downgrade');
    assert.ok(!allCommands.includes('memory-capture.sh'), 'memory-capture.sh must be pruned on downgrade');
  });

  it('regex anchor: paths without the literal `plugins/` segment are NOT considered managed', () => {
    // Defence-in-depth: a hook script at an unrelated location like
    // /opt/myrepo/graphify/scripts/foo.sh - same basename, different
    // anchor - must NOT be scooped up by the prune. Only paths under
    // the literal `plugins/` segment are managed by entrypoint.sh.
    const fixture = JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'bash /opt/myrepo/graphify/scripts/foo.sh' },
              { type: 'command', command: 'bash /home/user/custom/codeflare-vault/scripts/not-ours.sh' },
            ],
          },
        ],
      },
    });
    const merged = runJqMerge(fixture, defaultModeSettingsConfig());
    const post = merged?.hooks?.PostToolUse ?? [];
    const bashMatcher = post.find((e) => e.matcher === 'Bash');
    assert.ok(bashMatcher, 'Bash matcher must survive downgrade because its hooks are user-owned');
    const allCmds = bashMatcher.hooks.map((h) => h.command).join(' ');
    assert.match(allCmds, /\/opt\/myrepo\/graphify\/scripts\/foo\.sh/,
      'user hook at /opt/.../graphify/scripts/ must survive (no plugins/ anchor matched)');
    assert.match(allCmds, /\/home\/user\/custom\/codeflare-vault\/scripts\/not-ours\.sh/,
      'user hook outside ~/.claude/plugins/ must survive');
  });
});
