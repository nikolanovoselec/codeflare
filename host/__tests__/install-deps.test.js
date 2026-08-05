import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ACTION = parseYaml(readFileSync(join(ROOT, '.github', 'actions', 'install-deps', 'action.yml'), 'utf8'));
const fixtures = [];
afterEach(() => fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function install(failures) {
  const cwd = mkdtempSync(join(tmpdir(), 'install-deps-'));
  fixtures.push(cwd);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  const calls = join(cwd, 'calls');
  const sleeps = join(cwd, 'sleeps');
  const counter = join(cwd, 'counter');
  writeFileSync(join(bin, 'timeout'), `#!/bin/sh
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
  chmodSync(join(bin, 'timeout'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const installStep = ACTION.runs.steps.find((step) => step.name.startsWith('Install '));
  const result = spawnSync('bash', ['-c', installStep.run], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      DIR: '.',
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

describe('shared dependency installer contract', () => {
  it('keys the cache to the selected package lock and runner platform', () => {
    const cache = ACTION.runs.steps.find((step) => step.id === 'cache');
    assert.equal(
      cache.with.key,
      "${{ runner.os }}-${{ runner.arch }}-${{ inputs.key-prefix }}-${{ hashFiles(format('{0}/package-lock.json', inputs.directory)) }}",
    );
  });

  it('bounds each install attempt and succeeds on the third attempt', () => {
    const outcome = install(2);
    assert.equal(outcome.result.status, 0, outcome.result.stderr);
    assert.deepEqual(outcome.calls, Array(3).fill('600 npm ci --prefer-offline --no-audit --no-fund'));
    assert.deepEqual(outcome.sleeps, ['5', '10']);
  });

  it('fails after three bounded install attempts', () => {
    const outcome = install(3);
    assert.equal(outcome.result.status, 1);
    assert.deepEqual(outcome.calls, Array(3).fill('600 npm ci --prefer-offline --no-audit --no-fund'));
    assert.deepEqual(outcome.sleeps, ['5', '10', '15']);
    assert.match(outcome.result.stdout, /failed or hung three times/);
  });
});
