import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = resolve(__dirname, '../../scripts/run-backend-tests.sh');

function runWithFakeNpm(exitCode) {
  const root = mkdtempSync(join(tmpdir(), 'backend-test-launcher-'));
  const fakeNpm = join(root, 'npm');
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env bash\nprintf '%s\\n' 'Test Files 183 passed (189)' 'Tests 3265 passed (3265)' 'Errors 6 errors' '[vitest-pool]: Worker cloudflare-pool emitted error.'\nexit ${exitCode}\n`,
    'utf8',
  );
  chmodSync(fakeNpm, 0o755);

  try {
    return spawnSync('bash', [LAUNCHER], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH ?? ''}` },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('backend test launcher preserves a crashed suite nonzero exit despite pass-looking output', () => {
  const result = runWithFakeNpm(23);

  assert.equal(result.status, 23);
  assert.match(result.stdout, /183 passed \(189\)/);
  assert.match(result.stdout, /Errors 6 errors/);
});

test('backend test launcher returns success only when the suite process succeeds', () => {
  const result = runWithFakeNpm(0);

  assert.equal(result.status, 0);
});
