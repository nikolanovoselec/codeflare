// Verifies the engineering constitution is seeded as an advanced-gated Claude
// rule. Pi system-prompt composition is exercised behaviorally by
// src/__tests__/lib/codeflare-system-prompt.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const claudeDir = resolve(repoRoot, 'preseed/agents/claude');

// REQ-AGENT-065: Engineering Constitution Preseeded to All Agents
describe('engineering constitution preseed', () => {
  it('seeds the Claude constitution rule, gated to advanced mode', () => {
    assert.ok(
      existsSync(resolve(claudeDir, 'rules/engineering-constitution.md')),
      'engineering-constitution.md must exist in preseed/agents/claude/rules/',
    );
    const manifest = JSON.parse(readFileSync(resolve(claudeDir, 'manifest.json'), 'utf8'));
    const entry = manifest['rules/engineering-constitution.md'];
    assert.ok(entry, 'manifest must list the constitution rule');
    assert.deepEqual(entry.modes, ['advanced'], 'constitution rule must be advanced-gated');
  });
});
