// Behavioural tests for preseed/.../graphify/scripts/safe-graphify-update.sh
//
// Strategy: replace the real `graphify` binary on PATH with a tiny shell
// stub that prints back its env + args + the inherited RLIMIT_AS cap.
// The wrapper script `exec`s graphify, so the stub captures exactly what
// the wrapper set up. Gut-check: remove `ulimit -v` from the wrapper and
// the AS_LIMIT assertions fail; remove `export GRAPHIFY_MAX_WORKERS` and
// the workers assertions fail; remove the `exec graphify update "$@"`
// line and stdout becomes empty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/graphify/scripts/safe-graphify-update.sh',
);

// Build a temp PATH dir containing a fake `graphify` that dumps its
// invocation state. Returns the dir + a cleanup callback.
function fakeGraphify() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-graphify-'));
  const stub = join(dir, 'graphify');
  // The stub prints lines the test can grep. `ulimit -v` reflects the
  // RLIMIT_AS the wrapper applied (inherited across exec). We print it
  // before exiting so the wrapper's `exec graphify ...` is observable.
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "MAX_WORKERS=\${GRAPHIFY_MAX_WORKERS:-unset}"
echo "AS_LIMIT_KB=$(ulimit -v)"
echo "ARGV_COUNT=$#"
echo "ARGV=$*"
exit 0
`,
    { mode: 0o755 },
  );
  chmodSync(stub, 0o755);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runWrapper({ args = ['.'], env = {} } = {}) {
  const { dir, cleanup } = fakeGraphify();
  try {
    const r = spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ...env,
      },
    });
    return r;
  } finally {
    cleanup();
  }
}

test('safe-graphify-update.sh: defaults set GRAPHIFY_MAX_WORKERS=1 and ulimit -v=1500000', () => {
  const r = runWrapper({ args: ['.'] });
  assert.equal(r.status, 0, `wrapper exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /^MAX_WORKERS=1$/m);
  assert.match(r.stdout, /^AS_LIMIT_KB=1500000$/m);
});

test('safe-graphify-update.sh: forwards "update" subcommand + path arg unchanged', () => {
  const r = runWrapper({ args: ['/some/path'] });
  assert.equal(r.status, 0, r.stderr);
  // The stub's $0 was `graphify`, so $* contains everything AFTER `graphify`
  // i.e. `update /some/path`. The wrapper's `exec graphify update "$@"`
  // is what produces this shape.
  assert.match(r.stdout, /^ARGV=update \/some\/path$/m);
  assert.match(r.stdout, /^ARGV_COUNT=2$/m);
});

test('safe-graphify-update.sh: forwards extra flags (--no-cluster, --force) to graphify', () => {
  const r = runWrapper({ args: ['.', '--no-cluster', '--force'] });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ARGV=update \. --no-cluster --force$/m);
  assert.match(r.stdout, /^ARGV_COUNT=4$/m);
});

test('safe-graphify-update.sh: GRAPHIFY_SAFE_WORKERS env overrides default worker count', () => {
  const r = runWrapper({ args: ['.'], env: { GRAPHIFY_SAFE_WORKERS: '4' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^MAX_WORKERS=4$/m);
});

test('safe-graphify-update.sh: GRAPHIFY_SAFE_RLIMIT_KB env overrides default cap', () => {
  const r = runWrapper({ args: ['.'], env: { GRAPHIFY_SAFE_RLIMIT_KB: '1500000' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^AS_LIMIT_KB=1500000$/m);
});

test('safe-graphify-update.sh: RLIMIT_AS cap actually fires on out-of-budget allocation', () => {
  // Replace the fake graphify with one that tries to allocate >cap MB
  // and observe that the kernel kills it. This proves the wrapper's
  // ulimit is not a no-op; it really applies to the exec'd child.
  const dir = mkdtempSync(join(tmpdir(), 'fake-graphify-mem-'));
  const stub = join(dir, 'graphify');
  // Cap will be 100 MB (102400 KB). The stub tries to allocate 200 MB
  // via Python and is expected to die with MemoryError or be killed.
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
python3 -c "
import sys
try:
    b = bytearray(200_000_000)
    print('ALLOCATED', len(b))
    sys.exit(0)
except MemoryError:
    print('MEMORY_ERROR_AS_EXPECTED')
    sys.exit(42)
"
`,
    { mode: 0o755 },
  );
  chmodSync(stub, 0o755);
  try {
    const r = spawnSync('bash', [SCRIPT, '.'], {
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GRAPHIFY_SAFE_RLIMIT_KB: '102400', // 100 MB cap
      },
    });
    // Either the child caught MemoryError (exit 42, stdout includes the
    // expected message) or the kernel killed it harder (non-zero exit,
    // no ALLOCATED line). Both prove the cap fired. The forbidden state
    // is "ALLOCATED 200000000" in stdout with exit 0 - that would mean
    // ulimit was a no-op.
    assert.doesNotMatch(r.stdout, /^ALLOCATED 200000000$/m, 'cap did not fire -200 MB allocation succeeded under 100 MB cap');
    assert.notEqual(r.status, 0, 'cap did not fire -wrapper exited 0 on out-of-budget allocation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
