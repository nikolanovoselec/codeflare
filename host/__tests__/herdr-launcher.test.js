import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const launcher = join(root, 'image/herdr/codeflare-herdr-terminal');

function harness(command, tabConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-launcher-'));
  const bin = join(dir, 'bin');
  const runtime = join(dir, 'runtime');
  const log = join(dir, 'herdr.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  const fake = join(bin, 'herdr');
  writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "api snapshot" ]; then
  printf '%s\n' '{"result":{"focused_pane_id":"w1:p1"}}'
fi
`, { mode: 0o755 });
  chmodSync(fake, 0o755);

  const result = spawnSync(launcher, ['bootstrap'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HERDR_BIN: fake,
      HERDR_TEST_LOG: log,
      CODEFLARE_RUNTIME_ROOT: runtime,
      SESSION_ID: 'abc12345',
      TAB_CONFIG: JSON.stringify([{ id: '1', command, label: 'Terminal 1' }]),
      ...(tabConfig === undefined ? {} : { TAB_CONFIG: JSON.stringify(tabConfig) }),
    },
  });
  return {
    result,
    calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    runtime,
    fake,
    log,
  };
}

describe('Codeflare Herdr launcher', () => {
  it('rejects malformed session identity before invoking Herdr', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-invalid-'));
    const result = spawnSync(launcher, ['bootstrap'], {
      encoding: 'utf8',
      env: { ...process.env, SESSION_ID: '-bad', CODEFLARE_RUNTIME_ROOT: dir },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid SESSION_ID/);
  });

  it('maps Claude to fixed argv, bootstraps once, and bootstraps again after a successful stop', () => {
    const { result, calls, runtime, fake, log } = harness('claude --dangerously-skip-permissions');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [
      'api snapshot',
      'agent start codeflare --kind claude --pane w1:p1 --timeout 30000 -- --dangerously-skip-permissions',
    ]);

    const env = {
      ...process.env,
      HERDR_BIN: fake,
      HERDR_TEST_LOG: log,
      CODEFLARE_RUNTIME_ROOT: runtime,
      SESSION_ID: 'abc12345',
      TAB_CONFIG: JSON.stringify([{ id: '1', command: 'claude --dangerously-skip-permissions', label: 'Terminal 1' }]),
    };
    const second = spawnSync(launcher, ['bootstrap'], { encoding: 'utf8', env });
    assert.equal(second.status, 0, second.stderr);
    const stopped = spawnSync(launcher, ['stop'], { encoding: 'utf8', env });
    assert.equal(stopped.status, 0, stopped.stderr);
    const restarted = spawnSync(launcher, ['bootstrap'], { encoding: 'utf8', env });
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      ...calls,
      'session stop cf-abc12345 --json',
      'api snapshot',
      'agent start codeflare --kind claude --pane w1:p1 --timeout 30000 -- --dangerously-skip-permissions',
    ]);
  });

  it('cancels an in-flight bootstrap without deleting its lock, then permits one restart', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-race-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const log = join(dir, 'herdr.log');
    const started = join(dir, 'agent.started');
    const release = join(dir, 'agent.release');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "api snapshot" ]; then
  printf '%s\\n' '{"result":{"focused_pane_id":"w1:p1"}}'
elif [ "\${HERDR_TEST_BLOCK:-}" = "1" ] && [ "$1 $2" = "agent start" ]; then
  : > "$HERDR_TEST_STARTED"
  while [ ! -f "$HERDR_TEST_RELEASE" ]; do sleep 0.02; done
fi
`, { mode: 0o755 });
    const baseEnv = {
      ...process.env,
      HERDR_BIN: fake,
      HERDR_TEST_LOG: log,
      HERDR_TEST_STARTED: started,
      HERDR_TEST_RELEASE: release,
      CODEFLARE_RUNTIME_ROOT: runtime,
      SESSION_ID: 'abc12345',
      TAB_CONFIG: JSON.stringify([{ id: '1', command: 'claude', label: 'Terminal 1' }]),
    };
    const bootstrap = spawn(launcher, ['bootstrap'], {
      stdio: 'ignore',
      env: { ...baseEnv, HERDR_TEST_BLOCK: '1' },
    });
    const bootstrapExit = new Promise((resolve) => bootstrap.once('exit', resolve));
    t.after(() => {
      writeFileSync(release, '');
      bootstrap.kill('SIGKILL');
    });
    for (let attempt = 0; attempt < 100 && !existsSync(started); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(started), true, 'bootstrap did not reach the blocking agent start');

    const stopped = spawnSync(launcher, ['stop'], { encoding: 'utf8', env: baseEnv });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(existsSync(join(runtime, 'herdr/abc12345/bootstrap.lock')), true);
    writeFileSync(release, '');
    assert.equal(await bootstrapExit, 0);
    assert.equal(existsSync(join(runtime, 'herdr/abc12345/bootstrap.done')), false);

    const restarted = spawnSync(launcher, ['bootstrap'], { encoding: 'utf8', env: baseEnv });
    assert.equal(restarted.status, 0, restarted.stderr);
    const agentStarts = readFileSync(log, 'utf8').split('\n')
      .filter((line) => line.startsWith('agent start '));
    assert.equal(agentStarts.length, 2);
  });

  it('leaves Bash untouched and maps ordinary TUI commands without shell interpolation', () => {
    const bash = harness('', [{ id: '1', command: '', label: 'Terminal 1' }]);
    assert.equal(bash.result.status, 0, bash.result.stderr);
    assert.deepEqual(bash.calls, ['api snapshot']);

    const lazygit = harness('lazygit');
    assert.equal(lazygit.result.status, 0, lazygit.result.stderr);
    assert.deepEqual(lazygit.calls, ['api snapshot', 'pane run w1:p1 lazygit']);
  });

  it('stops only the deterministic named runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-stop-'));
    const bin = join(dir, 'bin');
    const log = join(dir, 'herdr.log');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    const runtime = join(dir, 'runtime');
    const staleLock = join(runtime, 'herdr/abc12345/bootstrap.lock');
    mkdirSync(staleLock, { recursive: true });
    writeFileSync(join(staleLock, 'pid'), '99999999\n');
    writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$HERDR_TEST_LOG"\n`, { mode: 0o755 });
    const result = spawnSync(launcher, ['stop'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        CODEFLARE_RUNTIME_ROOT: runtime,
        SESSION_ID: 'abc12345',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(log, 'utf8').trim(), 'session stop cf-abc12345 --json');
    assert.equal(existsSync(staleLock), false);
  });

  it('rejects unreviewed command text instead of passing it to a shell', () => {
    const { result, calls } = harness('bash -c id');
    assert.notEqual(result.status, 0);
    assert.deepEqual(calls, ['api snapshot']);
    assert.match(result.stderr, /unsupported terminal command/);
  });
});
