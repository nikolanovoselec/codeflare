import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { findBackendTestFiles } from '../../scripts/run-workers-runtime-tests.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = resolve(__dirname, '../../scripts/run-backend-tests.sh');
const WORKERS_RUNNER = resolve(__dirname, '../../scripts/run-workers-runtime-tests.mjs');
const BACKEND_TEST_FILE_COUNT = findBackendTestFiles().length;

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

function runWorkersWithFakeNpx(failOnCall) {
  const root = mkdtempSync(join(tmpdir(), 'workers-test-runner-'));
  const fakeNpx = join(root, 'npx');
  const counter = join(root, 'counter');
  writeFileSync(
    fakeNpx,
    `#!/usr/bin/env bash\ncount=0\nif [ -f "$FAKE_COUNTER" ]; then count=$(cat "$FAKE_COUNTER"); fi\ncount=$((count + 1))\nprintf '%s' "$count" > "$FAKE_COUNTER"\nif [ "$count" = "$FAKE_FAIL_ON" ]; then exit 37; fi\n`,
    'utf8',
  );
  chmodSync(fakeNpx, 0o755);

  try {
    const result = spawnSync(process.execPath, [WORKERS_RUNNER], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH ?? ''}`,
        FAKE_COUNTER: counter,
        FAKE_FAIL_ON: String(failOnCall),
      },
    });
    return { result, calls: Number(readFileSync(counter, 'utf8')) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Workers-runtime runner stops at the first failed isolated process', () => {
  const { result, calls } = runWorkersWithFakeNpx(2);

  assert.equal(result.status, 37);
  assert.equal(calls, 2);
});

test('Workers-runtime runner executes every backend test file when each process succeeds', () => {
  const { result, calls } = runWorkersWithFakeNpx(0);

  assert.equal(result.status, 0);
  assert.equal(calls, BACKEND_TEST_FILE_COUNT);
});
