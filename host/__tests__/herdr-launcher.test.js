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
  const persistent = join(dir, '.codeflare');
  const log = join(dir, 'herdr.log');
  mkdirSync(bin, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  const fake = join(bin, 'herdr');
  writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "api snapshot" ]; then
  printf '%s\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
elif [ "$1 $2" = "agent get" ] && [ -n "\${HERDR_TEST_AGENT:-}" ]; then
  printf '{"result":{"agent":{"agent":"%s"}}}\n' "$HERDR_TEST_AGENT"
elif [ "$1 $2" = "pane process-info" ] && [ -n "\${HERDR_TEST_PROCESS:-}" ]; then
  printf '{"result":{"process_info":{"foreground_processes":[{"name":"%s"}]}}}\n' "$HERDR_TEST_PROCESS"
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
      CODEFLARE_HERDR_PERSIST_ROOT: persistent,
      SESSION_ID: 'abc12345',
      TAB_CONFIG: JSON.stringify([{ id: '1', command, label: 'Terminal 1' }]),
      HERDR_TEST_AGENT: command.startsWith('claude') ? 'claude'
        : command === 'codex' ? 'codex'
          : command === 'opencode' ? 'opencode'
            : command.startsWith('copilot') ? 'copilot'
              : command === 'pi' ? 'pi'
                : command.startsWith('agy') ? 'agy' : '',
      HERDR_TEST_PROCESS: ['htop', 'yazi', 'lazygit'].includes(command) ? command : '',
      ...(tabConfig === undefined ? {} : { TAB_CONFIG: JSON.stringify(tabConfig) }),
    },
  });
  return {
    result,
    calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    runtime,
    persistent,
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

  it('keeps Pi on its authoritative config root while Herdr uses private XDG state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-pi-config-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const home = join(dir, 'home');
    const log = join(dir, 'herdr.log');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf 'pi-config=%s\\n' "$PI_CODING_AGENT_DIR" >> "$HERDR_TEST_LOG"
if [ "$*" = "api snapshot" ]; then
  printf '%s\\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
fi
`, { mode: 0o755 });

    const result = spawnSync(launcher, ['bootstrap'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PI_CODING_AGENT_DIR: join(dir, 'wrong-pi-config'),
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        CODEFLARE_RUNTIME_ROOT: runtime,
        CODEFLARE_HERDR_PERSIST_ROOT: persistent,
        SESSION_ID: 'abc12345',
        TAB_CONFIG: '[]',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(log, 'utf8').trim(), `pi-config=${join(home, '.pi/agent')}`);
  });

  it('keeps the maximum-length session client socket within the Linux path limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-socket-path-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const log = join(dir, 'herdr.log');
    const sessionId = 'abcdefghijklmnopqrstuvwx';
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf 'config=%s\\n' "$XDG_CONFIG_HOME" >> "$HERDR_TEST_LOG"
if [ "$*" = "api snapshot" ]; then
  session_dir="$XDG_CONFIG_HOME/herdr/sessions/$HERDR_SESSION"
  mkdir -p "$session_dir"
  printf '%s\\n' '{"version":3}' > "$session_dir/session.json"
  printf '%s\\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
fi
`, { mode: 0o755 });

    const result = spawnSync(launcher, ['bootstrap'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        CODEFLARE_RUNTIME_ROOT: runtime,
        CODEFLARE_HERDR_PERSIST_ROOT: persistent,
        SESSION_ID: sessionId,
        TAB_CONFIG: '[]',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const configHome = join(runtime, 'herdr-config');
    assert.equal(readFileSync(log, 'utf8').trim(), `config=${configHome}`);
    assert.equal(readFileSync(join(persistent, 'herdr/sessions', `cf-${sessionId}`, 'session.json'), 'utf8').trim(), '{"version":3}');
    const clientSocket = join('/run/codeflare/herdr-config', 'herdr/sessions', `cf-${sessionId}`, 'herdr-client.sock');
    assert.ok(Buffer.byteLength(clientSocket) <= 107, clientSocket);
  });

  it('reattaches after repeated client exits while the Herdr server remains healthy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-reattach-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const log = join(dir, 'herdr.log');
    const count = join(dir, 'client-count');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
if [ "\${1:-}" = "--session" ]; then
  current=0
  [ ! -f "$HERDR_CLIENT_COUNT" ] || current=$(cat "$HERDR_CLIENT_COUNT")
  printf '%s' "$((current + 1))" > "$HERDR_CLIENT_COUNT"
  exit 0
fi
if [ "$*" = "api snapshot" ]; then
  current=0
  [ ! -f "$HERDR_CLIENT_COUNT" ] || current=$(cat "$HERDR_CLIENT_COUNT")
  [ "$current" -lt 3 ] || exit 1
  printf '%s\\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
fi
`, { mode: 0o755 });

    const result = spawnSync(launcher, [], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        HERDR_CLIENT_COUNT: count,
        CODEFLARE_RUNTIME_ROOT: runtime,
        CODEFLARE_HERDR_PERSIST_ROOT: persistent,
        SESSION_ID: 'abc12345',
        TAB_CONFIG: JSON.stringify([{ id: '1', command: '', label: 'Terminal 1' }]),
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Herdr server unavailable after client exit/);
    const clientStarts = readFileSync(log, 'utf8').split('\n')
      .filter((line) => line.startsWith('--session cf-abc12345')).length;
    assert.equal(clientStarts, 3);
  });

  it('waits for live Pi integration on a fresh start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-fresh-pi-ready-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const log = join(dir, 'herdr.log');
    const count = join(dir, 'agent-list-count');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "--version" ]; then
  printf '%s\n' 'herdr 0.8.2'
elif [ "$*" = "api snapshot" ]; then
  printf '%s\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
elif [ "$1 $2" = "agent get" ]; then
  printf '%s\n' '{"result":{"agent":{"agent":"pi"}}}'
elif [ "$*" = "agent list" ]; then
  current=0
  [ ! -f "$HERDR_AGENT_LIST_COUNT" ] || current=$(cat "$HERDR_AGENT_LIST_COUNT")
  current=$((current + 1))
  printf '%s' "$current" > "$HERDR_AGENT_LIST_COUNT"
  if [ "$current" -eq 1 ]; then
    printf '%s\n' '{"result":{"agents":[{"agent":"pi"}]}}'
  else
    printf '%s\n' '{"result":{"agents":[{"agent":"pi","screen_detection_skipped":true}]}}'
  fi
fi
`, { mode: 0o755 });

    const result = spawnSync(launcher, ['bootstrap'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        HERDR_AGENT_LIST_COUNT: count,
        CODEFLARE_RUNTIME_ROOT: runtime,
        CODEFLARE_HERDR_PERSIST_ROOT: persistent,
        SESSION_ID: 'abc12345',
        TAB_CONFIG: JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.filter((call) => call === 'agent list').length, 2);
    assert.equal(calls.filter((call) => call.startsWith('pane run ')).length, 1);
    assert.equal(existsSync(join(runtime, 'herdr/abc12345/bootstrap.done')), true);
  });

  it('uses regular fresh Pi startup when native readiness version changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-fresh-pi-fallback-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const log = join(dir, 'herdr.log');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "--version" ]; then
  printf '%s\n' 'herdr 0.8.3'
elif [ "$*" = "api snapshot" ]; then
  printf '%s\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
elif [ "$1 $2" = "agent get" ]; then
  printf '%s\n' '{"result":{"agent":{"agent":"pi"}}}'
fi
`, { mode: 0o755 });

    const result = spawnSync(launcher, ['bootstrap'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        CODEFLARE_RUNTIME_ROOT: runtime,
        CODEFLARE_HERDR_PERSIST_ROOT: persistent,
        SESSION_ID: 'abc12345',
        TAB_CONFIG: JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.some((call) => call === 'agent list'), false);
    assert.equal(calls.filter((call) => call.startsWith('pane run ')).length, 1);
  });

  it('falls back to persisted agent metadata when Pi lifecycle readiness is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-restore-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const sessionDir = join(persistent, 'herdr/sessions/cf-abc12345');
    const log = join(dir, 'herdr.log');
    const count = join(dir, 'agent-list-count');
    mkdirSync(bin, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), '{"version":3,"workspaces":[]}');
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "--version" ]; then
  printf '%s\\n' 'herdr 0.8.3'
elif [ "$*" = "api snapshot" ]; then
  [ ! -f "$HERDR_RESTORE_READY" ] || exit 1
  printf '%s\\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
elif [ "$*" = "agent list" ]; then
  current=0
  [ ! -f "$HERDR_AGENT_LIST_COUNT" ] || current=$(cat "$HERDR_AGENT_LIST_COUNT")
  current=$((current + 1))
  printf '%s' "$current" > "$HERDR_AGENT_LIST_COUNT"
  if [ "$current" -eq 1 ]; then
    exec sleep 60
  else
    printf '%s' ready > "$HERDR_RESTORE_READY"
    printf '%s\\n' '{"result":{"agents":[{"agent":"pi"}]}}'
  fi
elif [ "\${1:-}" = "--session" ]; then
  sleep 0.2
fi
`, { mode: 0o755 });

    const result = spawnSync(launcher, [], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        HERDR_RESTORE_READY: join(dir, 'restore-ready'),
        HERDR_AGENT_LIST_COUNT: count,
        CODEFLARE_RUNTIME_ROOT: runtime,
        CODEFLARE_HERDR_PERSIST_ROOT: persistent,
        SESSION_ID: 'abc12345',
        TAB_CONFIG: JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]),
      },
    });

    assert.equal(result.status, 1, result.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.includes('agent list'), true);
    assert.equal(calls.filter((call) => call === 'agent list').length, 2);
    assert.equal(calls.some((call) => call.startsWith('pane run ')), false);
  });

  it('falls back to persisted metadata when pinned Pi live readiness fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-pi-fallback-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const sessionDir = join(persistent, 'herdr/sessions/cf-abc12345');
    const log = join(dir, 'herdr.log');
    const apiCount = join(dir, 'api-count');
    const agentCount = join(dir, 'agent-count');
    mkdirSync(bin, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), '{"version":3,"workspaces":[]}');
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "--version" ]; then
  printf '%s\\n' 'herdr 0.8.2'
elif [ "$*" = "api snapshot" ]; then
  current=0
  [ ! -f "$HERDR_API_COUNT" ] || current=$(cat "$HERDR_API_COUNT")
  current=$((current + 1))
  printf '%s' "$current" > "$HERDR_API_COUNT"
  [ "$current" -eq 1 ] || exit 1
  printf '%s\\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
elif [ "$*" = "agent list" ]; then
  current=0
  [ ! -f "$HERDR_AGENT_COUNT" ] || current=$(cat "$HERDR_AGENT_COUNT")
  current=$((current + 1))
  printf '%s' "$current" > "$HERDR_AGENT_COUNT"
  printf '%s\\n' '{"result":{"agents":[{"agent":"pi"}]}}'
elif [ "\${1:-}" = "--session" ]; then
  sleep 1
fi
`, { mode: 0o755 });

    const result = spawnSync(launcher, [], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        HERDR_API_COUNT: apiCount,
        HERDR_AGENT_COUNT: agentCount,
        CODEFLARE_RUNTIME_ROOT: runtime,
        CODEFLARE_HERDR_PERSIST_ROOT: persistent,
        SESSION_ID: 'abc12345',
        TAB_CONFIG: JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]),
      },
    });

    assert.equal(result.status, 1, result.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.filter((call) => call === 'agent list').length, 2);
    assert.equal(calls.some((call) => call.startsWith('pane run ')), false);
    assert.equal(existsSync(join(runtime, 'herdr/abc12345/bootstrap.done')), true);
  });

  it('waits for live Pi integration before completing restored bootstrap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-pi-ready-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const sessionDir = join(persistent, 'herdr/sessions/cf-abc12345');
    const log = join(dir, 'herdr.log');
    const count = join(dir, 'agent-list-count');
    mkdirSync(bin, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), '{"version":3,"workspaces":[]}');
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "--version" ]; then
  printf '%s\\n' 'herdr 0.8.2'
elif [ "$*" = "api snapshot" ]; then
  [ ! -f "$HERDR_RESTORE_READY" ] || exit 1
  printf '%s\\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
elif [ "$*" = "agent list" ]; then
  current=0
  [ ! -f "$HERDR_AGENT_LIST_COUNT" ] || current=$(cat "$HERDR_AGENT_LIST_COUNT")
  current=$((current + 1))
  printf '%s' "$current" > "$HERDR_AGENT_LIST_COUNT"
  if [ "$current" -eq 1 ]; then
    exec sleep 60
  elif [ "$current" -eq 2 ]; then
    printf '%s\\n' '{"result":{"agents":[{"agent":"pi","screen_detection_skipped":true},{"agent":"pi"}]}}'
  else
    printf '%s' ready > "$HERDR_RESTORE_READY"
    printf '%s\\n' '{"result":{"agents":[{"agent":"pi","screen_detection_skipped":true},{"agent":"pi","screen_detection_skipped":true}]}}'
  fi
elif [ "\${1:-}" = "--session" ]; then
  sleep 3
fi
`, { mode: 0o755 });

    const result = spawnSync(launcher, [], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        HERDR_RESTORE_READY: join(dir, 'restore-ready'),
        HERDR_AGENT_LIST_COUNT: count,
        CODEFLARE_RUNTIME_ROOT: runtime,
        CODEFLARE_HERDR_PERSIST_ROOT: persistent,
        SESSION_ID: 'abc12345',
        TAB_CONFIG: JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]),
      },
    });

    assert.equal(result.status, 1, result.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(calls.filter((call) => call === 'agent list').length, 3);
    assert.equal(calls.some((call) => call.startsWith('pane run ')), false);
  });

  it('submits fixed commands and waits for expected detection', () => {
    const { result, calls, runtime, persistent, fake, log } = harness('claude --dangerously-skip-permissions');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [
      'api snapshot',
      'integration install claude',
      'pane run w1:p1 claude --dangerously-skip-permissions',
      'agent get w1:p1',
    ]);

    const env = {
      ...process.env,
      HERDR_BIN: fake,
      HERDR_TEST_LOG: log,
      CODEFLARE_RUNTIME_ROOT: runtime,
      CODEFLARE_HERDR_PERSIST_ROOT: persistent,
      SESSION_ID: 'abc12345',
      TAB_CONFIG: JSON.stringify([{ id: '1', command: 'claude --dangerously-skip-permissions', label: 'Terminal 1' }]),
      HERDR_TEST_AGENT: 'claude',
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
      'integration install claude',
      'pane run w1:p1 claude --dangerously-skip-permissions',
      'agent get w1:p1',
    ]);
  });

  it('serializes concurrent bootstrap launchers to one command submission', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-concurrent-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const log = join(dir, 'herdr.log');
    const started = join(dir, 'agent.started');
    const release = join(dir, 'agent.release');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "api snapshot" ]; then
  printf '%s\\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
elif [ "$1 $2" = "pane run" ]; then
  : > "$HERDR_TEST_STARTED"
  while [ ! -f "$HERDR_TEST_RELEASE" ]; do sleep 0.02; done
elif [ "$1 $2" = "agent get" ]; then
  printf '%s\n' '{"result":{"agent":{"agent":"claude"}}}'
fi
`, { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HERDR_BIN: fake,
      HERDR_TEST_LOG: log,
      HERDR_TEST_STARTED: started,
      HERDR_TEST_RELEASE: release,
      CODEFLARE_RUNTIME_ROOT: runtime,
      CODEFLARE_HERDR_PERSIST_ROOT: persistent,
      SESSION_ID: 'abc12345',
      TAB_CONFIG: JSON.stringify([{ id: '1', command: 'claude', label: 'Terminal 1' }]),
      HERDR_TEST_AGENT: 'claude',
    };
    const first = spawn(launcher, ['bootstrap'], { stdio: 'ignore', env });
    const firstExit = new Promise((resolve) => first.once('exit', resolve));
    t.after(() => {
      writeFileSync(release, '');
      first.kill('SIGKILL');
    });
    for (let attempt = 0; attempt < 100 && !existsSync(started); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(existsSync(started), true, 'first bootstrap did not reach command submission');

    const second = spawn(launcher, ['bootstrap'], { stdio: 'ignore', env });
    const secondExit = new Promise((resolve) => second.once('exit', resolve));
    t.after(() => second.kill('SIGKILL'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(release, '');

    assert.deepEqual(await Promise.all([firstExit, secondExit]), [0, 0]);
    const commandSubmissions = readFileSync(log, 'utf8').split('\n')
      .filter((line) => line.startsWith('pane run '));
    assert.equal(commandSubmissions.length, 1);
  });

  it('cancels an in-flight bootstrap without deleting its lock, then permits one restart', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-race-'));
    const bin = join(dir, 'bin');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const log = join(dir, 'herdr.log');
    const started = join(dir, 'agent.started');
    const release = join(dir, 'agent.release');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    writeFileSync(fake, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$HERDR_TEST_LOG"
if [ "$*" = "api snapshot" ]; then
  printf '%s\\n' '{"result":{"snapshot":{"focused_pane_id":"w1:p1"}}}'
elif [ "\${HERDR_TEST_BLOCK:-}" = "1" ] && [ "$1 $2" = "pane run" ]; then
  : > "$HERDR_TEST_STARTED"
  while [ ! -f "$HERDR_TEST_RELEASE" ]; do sleep 0.02; done
elif [ "$1 $2" = "agent get" ]; then
  printf '%s\n' '{"result":{"agent":{"agent":"claude"}}}'
fi
`, { mode: 0o755 });
    const baseEnv = {
      ...process.env,
      HERDR_BIN: fake,
      HERDR_TEST_LOG: log,
      HERDR_TEST_STARTED: started,
      HERDR_TEST_RELEASE: release,
      CODEFLARE_RUNTIME_ROOT: runtime,
      CODEFLARE_HERDR_PERSIST_ROOT: persistent,
      SESSION_ID: 'abc12345',
      TAB_CONFIG: JSON.stringify([{ id: '1', command: 'claude', label: 'Terminal 1' }]),
      HERDR_TEST_AGENT: 'claude',
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
    assert.equal(existsSync(started), true, 'bootstrap did not reach the blocking command submission');

    const stopped = spawnSync(launcher, ['stop'], { encoding: 'utf8', env: baseEnv });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(existsSync(join(runtime, 'herdr/abc12345/bootstrap.lock')), true);
    writeFileSync(release, '');
    assert.equal(await bootstrapExit, 0);
    assert.equal(existsSync(join(runtime, 'herdr/abc12345/bootstrap.done')), false);

    const restarted = spawnSync(launcher, ['bootstrap'], { encoding: 'utf8', env: baseEnv });
    assert.equal(restarted.status, 0, restarted.stderr);
    const commandSubmissions = readFileSync(log, 'utf8').split('\n')
      .filter((line) => line.startsWith('pane run '));
    assert.equal(commandSubmissions.length, 2);
  });

  it('leaves Bash untouched and maps ordinary TUI commands without shell interpolation', () => {
    const bash = harness('', [{ id: '1', command: '', label: 'Terminal 1' }]);
    assert.equal(bash.result.status, 0, bash.result.stderr);
    assert.deepEqual(bash.calls, ['api snapshot']);

    const lazygit = harness('lazygit');
    assert.equal(lazygit.result.status, 0, lazygit.result.stderr);
    assert.deepEqual(lazygit.calls, ['api snapshot', 'pane run w1:p1 lazygit', 'pane process-info --pane w1:p1']);
  });

  it('stops only the deterministic named runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codeflare-herdr-stop-'));
    const bin = join(dir, 'bin');
    const log = join(dir, 'herdr.log');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'herdr');
    const runtime = join(dir, 'runtime');
    const persistent = join(dir, '.codeflare');
    const staleLock = join(runtime, 'herdr/abc12345/bootstrap.lock');
    mkdirSync(staleLock, { recursive: true });
    writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$HERDR_TEST_LOG"\n`, { mode: 0o755 });
    const result = spawnSync(launcher, ['stop'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HERDR_BIN: fake,
        HERDR_TEST_LOG: log,
        CODEFLARE_RUNTIME_ROOT: runtime,
        CODEFLARE_HERDR_PERSIST_ROOT: persistent,
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

  it('reports invalid bootstrap configuration without an EXIT-trap error', () => {
    const { result } = harness('', { invalid: true });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid TAB_CONFIG/);
    assert.doesNotMatch(result.stderr, /lock_fd: unbound variable/);
  });
});
