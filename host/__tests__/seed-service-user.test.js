import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SCRIPT = join(ROOT, 'scripts', 'ci', 'seed-service-user.sh');
const fixtures = [];
afterEach(() => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function seed({ accessSecret = '', fallbackSecret = '', failures = 0 } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'service-user-seed-'));
  fixtures.push(cwd);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const calls = join(cwd, 'calls');
  const sleeps = join(cwd, 'sleeps');
  const counter = join(cwd, 'counter');
  writeFileSync(join(bin, 'npx'), `#!/bin/sh
count=0
[ ! -f "$FAKE_COUNTER" ] || count=$(cat "$FAKE_COUNTER")
count=$((count + 1))
printf '%s' "$count" > "$FAKE_COUNTER"
printf '%s\\n' "$*" >> "$FAKE_CALLS"
[ "$count" -gt "$FAKE_FAILURES" ]
`);
  writeFileSync(join(bin, 'sleep'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_SLEEPS"
`);
  chmodSync(join(bin, 'npx'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      CF_ACCESS_CLIENT_SECRET: accessSecret,
      OAUTH_E2E_TEST_SECRET: fallbackSecret,
      FAKE_CALLS: calls,
      FAKE_COUNTER: counter,
      FAKE_FAILURES: String(failures),
      FAKE_SLEEPS: sleeps,
    },
  });
  const lines = (path) => {
    try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
  };
  return { result, calls: lines(calls), sleeps: lines(sleeps) };
}

describe('configured service-user deployment seed', () => {
  it('does nothing when neither service-auth secret is configured', () => {
    const outcome = seed();
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.deepEqual(outcome.calls, []);
    assert.deepEqual(outcome.sleeps, []);
  });

  it('writes the fixed admin identity once when the first attempt succeeds', () => {
    const outcome = seed({ accessSecret: 'configured' });
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.equal(outcome.calls.length, 1);
    assert.match(outcome.calls[0], /^wrangler kv key put user:e2e-service@codeflare\.local /);
    assert.match(outcome.calls[0], /"addedBy":"deploy"/);
    assert.match(outcome.calls[0], /"role":"admin"/);
    assert.match(outcome.calls[0], /--binding KV --remote$/);
  });

  it('retries transient failures and succeeds on the third attempt', () => {
    const outcome = seed({ fallbackSecret: 'configured', failures: 2 });
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.equal(outcome.calls.length, 3);
    assert.deepEqual(outcome.sleeps, ['5', '5']);
  });

  it('fails after three unsuccessful writes', () => {
    const outcome = seed({ accessSecret: 'configured', failures: 3 });
    assert.equal(outcome.result.status, 1);
    assert.equal(outcome.calls.length, 3);
    assert.deepEqual(outcome.sleeps, ['5', '5']);
    assert.match(outcome.result.stderr, /could not be seeded after 3 attempts/);
  });
});
