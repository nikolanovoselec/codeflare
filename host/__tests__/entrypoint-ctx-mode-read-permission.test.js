import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

function extractReadPermissionBlock() {
  const start = entrypoint.indexOf('# Grant context-mode unrestricted file reads.');
  if (start === -1) throw new Error('Read(/**) permission block start not found');
  const end = entrypoint.indexOf('# Ensure any .mjs hook files in ~/.claude/hooks/ are executable.', start);
  if (end === -1) throw new Error('Read(/**) permission block end not found');
  return entrypoint.slice(start, end);
}

// Run the entrypoint block against a settings.json seeded with `initial`,
// once or twice (to prove idempotence), and return the resulting parsed JSON.
function runBlock(initial, runs = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-read-perm-'));
  const settingsFile = join(dir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify(initial));
  const script = join(dir, 'snippet.sh');
  const block = extractReadPermissionBlock();
  writeFileSync(
    script,
    `set -euo pipefail\nexport SETTINGS_FILE=${JSON.stringify(settingsFile)}\n${Array(runs).fill(block).join('\n')}\n`,
  );
  const result = spawnSync('bash', [script], { encoding: 'utf-8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(settingsFile, 'utf-8'));
}

describe('entrypoint context-mode Read(/**) permission seed', () => {
  it('adds the broad Read allow rule when permissions has only defaultMode', () => {
    const out = runBlock({ permissions: { defaultMode: 'default' } });
    assert.ok(out.permissions.allow.includes('Read(/**)'));
    // existing permission settings are preserved, not clobbered
    assert.equal(out.permissions.defaultMode, 'default');
  });

  it('creates the permissions object when settings has none', () => {
    const out = runBlock({ skipDangerousModePermissionPrompt: true });
    assert.ok(out.permissions.allow.includes('Read(/**)'));
    // unrelated top-level settings survive
    assert.equal(out.skipDangerousModePermissionPrompt, true);
  });

  it('preserves pre-existing allow entries alongside Read(/**)', () => {
    const out = runBlock({ permissions: { allow: ['Bash(ls)'] } });
    assert.ok(out.permissions.allow.includes('Read(/**)'));
    assert.ok(out.permissions.allow.includes('Bash(ls)'));
  });

  it('is idempotent — two runs do not duplicate the rule', () => {
    const out = runBlock({ permissions: { defaultMode: 'default' } }, 2);
    const occurrences = out.permissions.allow.filter((r) => r === 'Read(/**)').length;
    assert.equal(occurrences, 1);
  });
});
