// Verifies the engineering constitution has one canonical Claude owner and one
// Pi-native adaptation delivered through the generated instruction surface in
// both Pi modes. The test asserts ownership and mode contracts, never prose.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const claudeDir = resolve(repoRoot, 'preseed/agents/claude');
const piDir = resolve(repoRoot, 'preseed/agents/pi');

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

  it('seeds one Pi-native constitution adaptation in both modes', () => {
    assert.ok(
      existsSync(resolve(piDir, 'rules/engineering-constitution.md')),
      'Pi engineering constitution adaptation must exist',
    );
    const manifest = JSON.parse(readFileSync(resolve(piDir, 'manifest.json'), 'utf8'));
    assert.deepEqual(
      manifest['rules/engineering-constitution.md']?.modes,
      ['default', 'advanced'],
      'Pi constitution must be present in Standard and Pro modes',
    );
  });
});
