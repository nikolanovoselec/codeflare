import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

// The absolute fallback exists only in the built container. The "Verify image-baked TypeScript syntax parser" step enables this; remove the skip when host tests run inside that image.
it('REQ-AGENT-192 AC2-AC3: parses TypeScript without project dependencies or repository writes', {
  skip: process.env.CODEFLARE_IMAGE_TEST !== '1',
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'safe-local-check-image-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, 'valid.ts'), 'const value: number = 1;\n', 'utf8');
  const before = readdirSync(root).sort();
  assert.deepEqual(before, ['.git', 'valid.ts']);

  const result = spawnSync(process.execPath, [
    '/codeflare/preseed/agents/claude/skills/safe-local-checks/scripts/safe-local-check.mjs',
    'ts-syntax',
    'valid.ts',
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(root).sort(), before);
  assert.equal(readFileSync(join(root, 'valid.ts'), 'utf8'), 'const value: number = 1;\n');
});
