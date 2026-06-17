// Verifies the engineering constitution is hardwired into every preseed-managed
// agent: seeded as an advanced-gated Claude rule, and injected into every Pi agent
// system prompt via before_agent_start. Asserts the seeding/wiring CONTRACT only
// (file presence, manifest mode gate, always-on injection) — never the prose, so
// the constitution text can be edited without churning this test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const claudeDir = resolve(repoRoot, 'preseed/agents/claude');

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

  it('injects the constitution into every Pi agent system prompt (always-on)', () => {
    const ext = readFileSync(
      resolve(repoRoot, 'preseed/agents/pi/extensions/codeflare-pi.ts'),
      'utf8',
    );
    // The block is a tagged, self-contained constitution.
    assert.match(ext, /<codeflare_constitution>[\s\S]*<\/codeflare_constitution>/);
    // It is seeded into the base systemPrompt parts array (not behind a conditional),
    // so it is present on every before_agent_start, not only in some sessions.
    assert.match(
      ext,
      /const parts = \[[^\]]*ENGINEERING_CONSTITUTION/,
      'ENGINEERING_CONSTITUTION must be in the base before_agent_start parts array',
    );
  });
});
