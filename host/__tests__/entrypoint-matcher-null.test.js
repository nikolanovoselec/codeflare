// Tests for the settings.json hooks-merge jq filter in entrypoint.sh.
//
// Reads the actual jq expression from entrypoint.sh, feeds it real input
// containing matcher: null (the shape Claude Code self-installs for the
// context-mode-cache-heal SessionStart hook), and asserts the output is
// valid per the Claude Code settings parser (matcher MUST be a string).
//
// Antipattern guardrail (per tdd-discipline): this is NOT a text-matching
// test. It runs the real jq filter and asserts on observable output.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Extract the jq filter body between `jq --argjson cfg "$SETTINGS_CONFIG" '`
// and the closing `'`. Single-quoted heredoc style in entrypoint.sh.
function extractMergeFilter() {
  const start = ENTRYPOINT.indexOf("jq --argjson cfg \"$SETTINGS_CONFIG\" '");
  assert.ok(start > -1, 'merge jq filter not found in entrypoint.sh');
  const filterStart = ENTRYPOINT.indexOf("'", start) + 1;
  const filterEnd = ENTRYPOINT.indexOf("' \"$SETTINGS_FILE\"", filterStart);
  assert.ok(filterEnd > filterStart, 'merge jq filter end not found');
  return ENTRYPOINT.slice(filterStart, filterEnd);
}

function runMerge(existing, cfg) {
  const filter = extractMergeFilter();
  const dir = mkdtempSync(join(tmpdir(), 'merge-'));
  const inputPath = join(dir, 'settings.json');
  writeFileSync(inputPath, JSON.stringify(existing));
  const result = spawnSync(
    'jq',
    ['--argjson', 'cfg', JSON.stringify(cfg), filter, inputPath],
    { encoding: 'utf-8' }
  );
  assert.equal(
    result.status,
    0,
    `jq failed: ${result.stderr}`
  );
  return JSON.parse(result.stdout);
}

const MANAGED_CFG = {
  hooks: {
    PreToolUse: [{
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'bash /home/user/.claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh' }],
    }],
    Stop: [{
      matcher: '',
      hooks: [{ type: 'command', command: 'bash /home/user/.claude/plugins/codeflare-hooks/scripts/enforce-review-spawn.sh' }],
    }],
  },
};

describe('entrypoint settings.json hooks merge - matcher null guard', () => {
  it('coerces matcher: null to "" for SessionStart entries written by Claude Code', () => {
    // Claude Code self-installs context-mode-cache-heal.mjs as a SessionStart
    // hook with matcher: null. The Claude Code settings parser then errors:
    // "Expected string, but received null". The merge must normalize.
    const existing = {
      hooks: {
        SessionStart: [{
          matcher: null,
          hooks: [{
            type: 'command',
            command: '"/home/user/.claude/hooks/context-mode-cache-heal.mjs"',
          }],
        }],
      },
    };

    const merged = runMerge(existing, MANAGED_CFG);

    assert.ok(merged.hooks.SessionStart, 'SessionStart should be preserved');
    assert.equal(
      merged.hooks.SessionStart.length,
      1,
      'one matcher group expected'
    );
    assert.equal(
      merged.hooks.SessionStart[0].matcher,
      '',
      'matcher null must be normalized to empty string'
    );
    // The user hook itself must survive (not stripped as a "managed" hook).
    assert.equal(
      merged.hooks.SessionStart[0].hooks[0].command,
      '"/home/user/.claude/hooks/context-mode-cache-heal.mjs"'
    );
  });

  it('preserves matcher "" untouched (already-correct case)', () => {
    const existing = {
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: '/some/user/hook' }],
        }],
      },
    };
    const merged = runMerge(existing, MANAGED_CFG);
    assert.equal(merged.hooks.SessionStart[0].matcher, '');
  });

  it('preserves named matchers (e.g., "Bash") untouched', () => {
    const existing = {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: '/some/user/git-hook' }],
        }],
      },
    };
    const merged = runMerge(existing, MANAGED_CFG);
    const bashGroup = merged.hooks.PreToolUse.find(g => g.matcher === 'Bash');
    assert.ok(bashGroup, 'Bash matcher group expected');
    // Both the user hook and the managed hook should appear under Bash.
    const commands = bashGroup.hooks.map(h => h.command);
    assert.ok(commands.includes('/some/user/git-hook'));
    assert.ok(commands.some(c => c.includes('block-attributed-commits.sh')));
  });

  it('does not collapse two distinct matchers (null and "Bash") into one group', () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: null, hooks: [{ type: 'command', command: '/a' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/b' }] },
        ],
      },
    };
    const merged = runMerge(existing, MANAGED_CFG);
    // null normalizes to "" - so the resulting groups are "" and "Bash"
    // (two distinct groups, never merged).
    const matchers = merged.hooks.PreToolUse.map(g => g.matcher).sort();
    assert.deepEqual(matchers, ['', 'Bash']);
    // Each group keeps its own commands.
    const emptyGroup = merged.hooks.PreToolUse.find(g => g.matcher === '');
    assert.ok(emptyGroup.hooks.some(h => h.command === '/a'));
    const bashGroup = merged.hooks.PreToolUse.find(g => g.matcher === 'Bash');
    assert.ok(bashGroup.hooks.some(h => h.command === '/b'));
  });

  it('output settings file passes the Claude Code matcher schema (string only)', () => {
    // Cross-cutting: every emitted matcher must be a string, never null.
    const existing = {
      hooks: {
        SessionStart: [{ matcher: null, hooks: [{ type: 'command', command: '/x' }] }],
        PreCompact: [{ matcher: null, hooks: [{ type: 'command', command: '/y' }] }],
      },
    };
    const merged = runMerge(existing, MANAGED_CFG);
    for (const [eventType, groups] of Object.entries(merged.hooks)) {
      for (const group of groups) {
        assert.equal(
          typeof group.matcher,
          'string',
          `${eventType} matcher must be string, got ${typeof group.matcher} (${group.matcher})`
        );
      }
    }
  });
});
