import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

function extractContextModeRuntimeBlock() {
  const start = entrypoint.indexOf('# Configure context-mode runtime defaults for every Pi session.');
  if (start === -1) throw new Error('context-mode runtime defaults block start not found');
  const end = entrypoint.indexOf('# Force HTML visualization generation regardless of graph size.', start);
  if (end === -1) throw new Error('context-mode runtime defaults block end not found');
  return entrypoint.slice(start, end);
}

function runBlock(initialValue) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-runtime-'));
  const script = join(dir, 'snippet.sh');
  const valueSetup = initialValue === undefined
    ? 'unset CONTEXT_MODE_BRIDGE_IDLE_MS\n'
    : `export CONTEXT_MODE_BRIDGE_IDLE_MS=${JSON.stringify(initialValue)}\n`;
  writeFileSync(script, `set -euo pipefail\n${valueSetup}${extractContextModeRuntimeBlock()}\nprintf '%s' "$CONTEXT_MODE_BRIDGE_IDLE_MS"\n`);
  const result = spawnSync('bash', [script], { encoding: 'utf-8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

describe('entrypoint context-mode runtime defaults', () => {
  it('sets bridge idle timeout to disabled when absent', () => {
    assert.equal(runBlock(undefined), '0');
  });

  it('overrides a nonzero inherited bridge idle timeout on session start', () => {
    assert.equal(runBlock('180000'), '0');
  });
});
