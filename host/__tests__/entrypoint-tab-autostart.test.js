// Real behavioral tests for REQ-AGENT-003 (Agent CLI Auto-Started in Tab 1).
//
// Strategy mirrors entrypoint-bisync-behavior.test.js and
// entrypoint-sse-c-config.test.js: extract the configure_tab_autostart
// function body from entrypoint.sh at test time, run it in a bash subshell
// with a temp USER_HOME, and read back the generated .bashrc to assert on
// real file contents — not source-text matching.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');
const CLASSIC_PI_STATE_SCRIPT = resolve(__dirname, '../../image/pi-web/classic-session-state.mjs');
const PI_TAB = JSON.stringify([{ id: '1', command: 'pi' }]);

function piStore(home, workspace = join(home, 'workspace')) {
  return join(home, '.pi/agent/sessions', `--${workspace.slice(1).replace(/[\\/:]/g, '-')}--`);
}

function writeNative(home, id, overrides = {}, name = `2026-09-09T00-00-00-000Z_${id}.jsonl`, store = piStore(home)) {
  mkdirSync(store, { recursive: true });
  const path = join(store, name);
  writeFileSync(path, `${JSON.stringify({
    type: 'session', version: 3, id, timestamp: '2026-09-09T00:00:00.000Z', cwd: join(home, 'workspace'), ...overrides,
  })}\n`);
  return path;
}

function extractConfigureBody() {
  const src = readFileSync(ENTRYPOINT, 'utf8');
  const lines = src.split('\n');
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && /^configure_tab_autostart\(\) \{/.test(lines[i])) {
      start = i;
    } else if (start !== -1 && /^\}$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    throw new Error('Could not locate configure_tab_autostart() in entrypoint.sh');
  }
  return lines.slice(start, end + 1).join('\n');
}

function runHarness({ tabConfig, env = {}, dir = mkdtempSync(join(tmpdir(), 'tab-autostart-harness-')) } = {}) {
  const body = extractConfigureBody();
  const runtimeRoot = join(dir, 'runtime');
  const envLines = [
    `export CLASSIC_PI_STATE_SCRIPT=${JSON.stringify(CLASSIC_PI_STATE_SCRIPT)}`,
    `export USER_HOME='${dir}'`,
    `export CODEFLARE_RUNTIME_ROOT='${runtimeRoot}'`,
    `export SESSION_ID=${JSON.stringify(env.SESSION_ID ?? 'abc12345')}`,
    `export CODEFLARE_TERMINAL_MODE=${JSON.stringify(env.CODEFLARE_TERMINAL_MODE ?? 'classic')}`,
    `mkdir -p '${runtimeRoot}/services'`,
    ...Object.entries(env)
      .filter(([key]) => key !== 'SESSION_ID' && key !== 'CODEFLARE_TERMINAL_MODE')
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`),
  ];
  if (tabConfig !== undefined) {
    envLines.push(`export TAB_CONFIG=${JSON.stringify(tabConfig)}`);
  } else {
    envLines.push('unset TAB_CONFIG');
  }
  const script = [
    '#!/usr/bin/env bash',
    'set -e',
    ...envLines,
    body,
    'configure_tab_autostart',
  ].join('\n');
  const scriptPath = join(dir, 'harness.sh');
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 10_000 });
  return {
    dir,
    result,
    bashrc: existsSync(join(dir, '.bashrc')) ? readFileSync(join(dir, '.bashrc'), 'utf8') : '',
  };
}

function runGeneratedBashrc(dir, command, manualTab = '', terminalId = '1') {
  const bin = join(dir, 'bin');
  const log = join(dir, 'agent.log');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, command), '#!/usr/bin/env bash\nprintf \'%s\\n\' "$@" > "$AGENT_LOG"\n', { mode: 0o755 });
  const bashrcPath = join(dir, '.bashrc');
  writeFileSync(
    bashrcPath,
    readFileSync(bashrcPath, 'utf8').replace(
      'export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"',
      `export PATH="${bin}:/usr/local/bin:/usr/bin:/bin:$PATH"`,
    ),
  );
  const shell = `env HOME=${dir} AGENT_LOG=${log} TERMINAL_ID=${terminalId} TERMINAL_APP_STARTED= MANUAL_TAB=${manualTab} bash --noprofile --rcfile ${bashrcPath} -ic 'printf shell-survived'`;
  const result = spawnSync('script', ['-qfec', shell, '/dev/null'], { encoding: 'utf8', timeout: 10_000 });
  return {
    result,
    args: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [],
  };
}

function bindingId(dir, sessionId) {
  return readFileSync(join(dir, '.codeflare/classic/sessions', `cf-${sessionId}`, 'agent-session-id'), 'utf8').trim();
}

function piSessionHeader(dir, nativeId) {
  const sessionDir = piStore(dir);
  const sessionFile = readdirSync(sessionDir).find((name) => name.endsWith(`_${nativeId}.jsonl`));
  assert.ok(sessionFile, `fresh Pi session ${nativeId} must have an empty native transcript`);
  return JSON.parse(readFileSync(join(sessionDir, sessionFile), 'utf8'));
}

function piSessionPath(dir, id) {
  return join(piStore(dir), readdirSync(piStore(dir)).find(name => name.endsWith(`_${id}.jsonl`)));
}

// REQ-TERM-005: Tab 1 auto-starts the configured agent
// REQ-TERM-006: User-created tabs start with plain bash

describe('entrypoint.sh configure_tab_autostart / REQ-AGENT-003 (Agent CLI auto-started in tab 1)', () => {
  // REQ-AGENT-003 AC1: tab 1 launch command written into .bashrc.
  // REQ-AGENT-003 AC2: claude is launched with --dangerously-skip-permissions
  // (IS_SANDBOX=1 in Dockerfile lets root use this flag; we don't run claude
  // here, we just verify the launch line is generated).
  // REQ-AGENT-003 AC4: PATH is hardened so PTY sessions find global CLIs.
  it('AC1+AC2+AC4: default layout writes the claude --dangerously-skip-permissions launch line + hardened PATH into .bashrc', () => {
    const { result, bashrc } = runHarness();
    assert.equal(result.status, 0, `configure_tab_autostart exited non-zero: ${result.stderr}`);
    assert.match(bashrc, /^# terminal-autostart$/m, 'autostart marker must be present');
    assert.match(bashrc, /claude --dangerously-skip-permissions/,
      'tab 1 must launch claude with --dangerously-skip-permissions (AC1+AC2)');
    assert.match(bashrc, /export PATH="\/usr\/local\/bin:\/usr\/bin:\/bin:\$PATH"/,
      'PATH must be set so PTY sessions find global CLIs (AC4)');
  });

  // REQ-AGENT-003 AC3: MANUAL_TAB=1 short-circuits autostart for user-created tabs.
  it('AC3: generated .bashrc guards autostart with the MANUAL_TAB skip branch', () => {
    const { dir, result } = runHarness();
    try {
      assert.equal(result.status, 0, result.stderr);
      const manual = runGeneratedBashrc(dir, 'claude', '1');
      assert.equal(manual.result.status, 0, manual.result.stderr);
      assert.match(manual.result.stdout, /shell-survived/);
      assert.equal(existsSync(join(dir, 'agent.log')), false, 'manual tab must not launch the agent');
      const automatic = runGeneratedBashrc(dir, 'claude');
      assert.equal(automatic.result.status, 0, automatic.result.stderr);
      assert.ok(automatic.args.includes('--dangerously-skip-permissions'), 'control tab must launch the recording agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('AC1 dynamic: TAB_CONFIG with id=1 command=lazygit emits the lazygit launch for tab 1 (overrides the default claude)', () => {
    const tabConfig = JSON.stringify([
      { id: '1', command: 'lazygit', label: 'Git' },
      { id: '2', command: '', label: 'bash' },
    ]);
    const { result, bashrc } = runHarness({ tabConfig });
    assert.equal(result.status, 0, `configure_tab_autostart exited non-zero: ${result.stderr}`);
    assert.match(bashrc, /lazygit/, 'dynamic layout must emit the configured tab-1 command');
    // Marker still present so re-runs short-circuit
    assert.match(bashrc, /^# terminal-autostart$/m);
  });

  it('REQ-AGENT-272 AC1: a fresh Chat-first Classic boot does not create a CLI conversation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classic-chat-first-'));
    try {
      mkdirSync(join(dir, 'workspace'));
      const { result } = runHarness({ dir,
        env: { CODEFLARE_PI_SURFACE: 'chat', CODEFLARE_PI_GENERATION: '7' },
        tabConfig: JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]),
      });
      assert.equal(result.status, 0, result.stderr);
      const shell = runGeneratedBashrc(dir, 'pi');
      assert.equal(existsSync(join(dir, 'agent.log')), false, 'native Pi must not take the Chat writer slot');
      assert.equal(existsSync(join(dir, '.pi/agent/sessions')), false, 'Chat creates the first native transcript');
      assert.doesNotMatch(shell.result.stderr, /missing-session/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REQ-AGENT-272 AC2: a configured secondary Classic Pi never receives the primary conversation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classic-secondary-pi-'));
    try {
      mkdirSync(join(dir, 'workspace'));
      const { result } = runHarness({ dir,
        env: { CODEFLARE_PI_SURFACE: 'terminal', CODEFLARE_PI_GENERATION: '7' },
        tabConfig: JSON.stringify([{ id: '1', command: 'pi' }, { id: '2', command: 'pi' }]),
      });
      assert.equal(result.status, 0, result.stderr);
      const primary = bindingId(dir, 'abc12345');
      assert.equal(piSessionHeader(dir, primary).id, primary);
      const secondary = runGeneratedBashrc(dir, 'pi', '', '2');
      assert.equal(secondary.result.status, 0, secondary.result.stderr);
      assert.ok(existsSync(join(dir, 'agent.log')), 'the secondary tab still launches native Pi');
      assert.deepEqual(secondary.args, [], 'the secondary process starts its own conversation');
      assert.equal(bindingId(dir, 'abc12345'), primary);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REQ-AGENT-211 AC1+AC3+AC4: binds fresh and restored Pi and Claude launches to the Codeflare session', () => {
    for (const command of ['pi', 'claude']) {
      const sessionId = command === 'pi' ? 'piabc123' : 'claude12';
      const dir = mkdtempSync(join(tmpdir(), `classic-${command}-resume-`));
      mkdirSync(join(dir, 'workspace'), { recursive: true });
      const tabConfig = JSON.stringify([{ id: '1', command, label: 'Terminal 1' }]);

      const first = runHarness({ dir, tabConfig, env: { SESSION_ID: sessionId } });
      assert.equal(first.result.status, 0, first.result.stderr);
      const nativeId = bindingId(dir, sessionId);
      assert.match(nativeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const fresh = runGeneratedBashrc(dir, command);
      assert.equal(fresh.result.status, 0, fresh.result.stderr);
      assert.match(fresh.result.stdout, /shell-survived/);
      assert.deepEqual(
        fresh.args,
        command === 'pi'
          ? ['--session', piSessionPath(dir, nativeId)]
          : ['--dangerously-skip-permissions', '--session-id', nativeId],
      );

      if (command === 'pi') {
        const header = piSessionHeader(dir, nativeId);
        assert.deepEqual(
          { ...header, timestamp: undefined },
          { type: 'session', version: 3, id: nativeId, timestamp: undefined, cwd: join(dir, 'workspace') },
        );
        assert.match(header.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      } else {
        const transcriptDir = join(dir, '.claude/projects/-home-user-workspace');
        mkdirSync(transcriptDir, { recursive: true });
        writeFileSync(join(transcriptDir, `${nativeId}.jsonl`), '{}\n');
      }
      rmSync(join(dir, '.bashrc'));
      rmSync(join(dir, '.bash_profile'));
      const restored = runHarness({ dir, tabConfig, env: { SESSION_ID: sessionId } });
      assert.equal(restored.result.status, 0, restored.result.stderr);
      assert.equal(bindingId(dir, sessionId), nativeId);
      const resumed = runGeneratedBashrc(dir, command);
      assert.deepEqual(
        resumed.args,
        command === 'pi'
          ? ['--session', piSessionPath(dir, nativeId)]
          : ['--dangerously-skip-permissions', '--resume', nativeId],
      );
    }
  });

  it('REQ-AGENT-211 AC6: restarts Classic Pi with its last explicitly resumed named session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classic-pi-named-resume-'));
    mkdirSync(join(dir, 'workspace'), { recursive: true });
    const codeflareSessionId = 'namedpi1';
    const nativeId = 'last-active.jsonl';
    const bindingDir = join(dir, '.codeflare/classic/sessions', `cf-${codeflareSessionId}`);
    mkdirSync(bindingDir, { recursive: true });
    writeFileSync(join(bindingDir, 'agent-session-id'), `${nativeId}\n`);
    const path = writeNative(dir, nativeId, { parentSession: '/retained-or-pruned-parent.jsonl' });

    const tabConfig = JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]);
    const restored = runHarness({ dir, tabConfig, env: { SESSION_ID: codeflareSessionId } });
    assert.equal(restored.result.status, 0, restored.result.stderr);
    assert.deepEqual(runGeneratedBashrc(dir, 'pi').args, ['--session', path]);
  });

  it('REQ-AGENT-211 AC5: a different Codeflare session starts empty under a different native ID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'classic-session-isolation-'));
    mkdirSync(join(dir, 'workspace'), { recursive: true });
    const tabConfig = JSON.stringify([{ id: '1', command: 'pi', label: 'Terminal 1' }]);
    runHarness({ dir, tabConfig, env: { SESSION_ID: 'sessiona1' } });
    const firstId = bindingId(dir, 'sessiona1');
    rmSync(join(dir, '.bashrc'));
    rmSync(join(dir, '.bash_profile'));
    runHarness({ dir, tabConfig, env: { SESSION_ID: 'sessionb2' } });
    const secondId = bindingId(dir, 'sessionb2');
    assert.notEqual(secondId, firstId);
    const fresh = runGeneratedBashrc(dir, 'pi');
    assert.deepEqual(fresh.args, ['--session', piSessionPath(dir, secondId)]);
  });

  it('REQ-AGENT-211 AC1+AC2: failed seed leaves no binding and can be retried in the same home', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'classic-seed-retry-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'workspace'));
    mkdirSync(join(dir, '.pi/agent'), { recursive: true });
    const blocked = join(dir, '.pi/agent/sessions');
    writeFileSync(blocked, 'keep this file');
    const failed = runHarness({ dir, tabConfig: PI_TAB });
    assert.equal(failed.result.status, 0, failed.result.stderr);
    assert.throws(() => bindingId(dir, 'abc12345'), { code: 'ENOENT' });
    const failedLaunch = runGeneratedBashrc(dir, 'pi');
    assert.deepEqual(failedLaunch.args, []);
    assert.match(failedLaunch.result.stdout, /unavailable/);
    assert.equal(readFileSync(blocked, 'utf8'), 'keep this file');

    rmSync(blocked);
    const retried = runHarness({ dir, tabConfig: PI_TAB });
    assert.equal(retried.result.status, 0, retried.result.stderr);
    const id = bindingId(dir, 'abc12345');
    assert.equal(piSessionHeader(dir, id).id, id);
    assert.deepEqual(runGeneratedBashrc(dir, 'pi').args, ['--session', piSessionPath(dir, id)]);
  });

  it('REQ-AGENT-211 AC1: refuses redirected state ancestors before creating files or directories', (t) => {
    for (const key of ['.codeflare', '.pi/agent/sessions', piStore]) {
      const dir = mkdtempSync(join(tmpdir(), 'classic-redirect-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      mkdirSync(join(dir, 'workspace'));
      const target = join(dir, 'untouched');
      mkdirSync(target);
      const path = typeof key === 'function' ? key(dir) : join(dir, key);
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(target, path);
      const boot = runHarness({ dir, tabConfig: PI_TAB });
      assert.equal(boot.result.status, 0, boot.result.stderr);
      assert.deepEqual(readdirSync(target), []);
      assert.throws(() => bindingId(dir, 'abc12345'), { code: 'ENOENT' });
      assert.deepEqual(runGeneratedBashrc(dir, 'pi').args, []);
    }
  });

  it('REQ-AGENT-211 AC4: standalone restore reports unavailable without launching a substitute', (t) => {
    for (const state of ['missing', 'wrong-store', 'wrong-header', 'duplicate', 'symlink', 'removed-after-boot']) {
      const dir = mkdtempSync(join(tmpdir(), 'classic-unavailable-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      mkdirSync(join(dir, 'workspace'));
      const id = 'selected';
      const binding = join(dir, '.codeflare/classic/sessions/cf-abc12345/agent-session-id');
      mkdirSync(dirname(binding), { recursive: true });
      writeFileSync(binding, `${id}\n`);
      const substitute = writeNative(dir, 'selected-longer');
      const misplaced = state === 'wrong-store' || state === 'symlink'
        ? writeNative(dir, id, {}, undefined, join(dir, '.pi/agent/sessions/--other--')) : undefined;
      if (state === 'symlink') symlinkSync(misplaced, join(piStore(dir), `alias_${id}.jsonl`));
      if (state === 'wrong-header') writeNative(dir, id, { cwd: join(dir, 'other') });
      if (state === 'duplicate') {
        writeNative(dir, id);
        writeNative(dir, id, {}, `second_${id}.jsonl`);
      }
      const removed = state === 'removed-after-boot' ? writeNative(dir, id) : undefined;
      const boot = runHarness({ dir, tabConfig: PI_TAB });
      assert.equal(boot.result.status, 0, boot.result.stderr);
      if (removed) rmSync(removed);
      const shell = runGeneratedBashrc(dir, 'pi');
      assert.equal(shell.result.status, 0, shell.result.stdout);
      assert.match(shell.result.stdout, /saved Classic agent transcript is unavailable/);
      assert.equal(existsSync(join(dir, 'agent.log')), false, state);
      assert.equal(bindingId(dir, 'abc12345'), id);
      assert.ok(existsSync(substitute));
    }
  });

  it('AC1 dynamic: TAB_CONFIG entries with non-1-6 ids are rejected by the validator (injection guard)', () => {
    // The validator regex is [1-6] — id '7' must be skipped, not emitted.
    const tabConfig = JSON.stringify([
      { id: '1', command: 'claude', label: 'claude' },
      { id: '7; rm -rf /', command: 'malicious', label: 'attack' },
    ]);
    const { bashrc } = runHarness({ tabConfig });
    assert.doesNotMatch(bashrc, /malicious/,
      'invalid tab id must NOT make it into the generated .bashrc case block');
    assert.doesNotMatch(bashrc, /rm -rf/);
  });

  // REQ-AGENT-003: the Antigravity agent launches as `agy --dangerously-skip-permissions`.
  // The autostart case arm lists `agy` among the known-safe CLIs (matching the
  // "Only known-safe CLIs autostart" design comment); this guards that an agy tab
  // emits its launch line into .bashrc and is not silently dropped.
  it('AC1 dynamic: an agy (Antigravity) tab emits its launch command into .bashrc', () => {
    const tabConfig = JSON.stringify([
      { id: '1', command: 'agy --dangerously-skip-permissions', label: 'Terminal 1' },
    ]);
    const { result, bashrc } = runHarness({ tabConfig });
    assert.equal(result.status, 0, `configure_tab_autostart exited non-zero: ${result.stderr}`);
    assert.match(bashrc, /agy --dangerously-skip-permissions/,
      'agy tab must emit its launch command for tab 1');
    // Guard the real bug: an autostart arm that matched `antigravity*` (the agent
    // type) instead of `agy` (the binary) sent the command to the `*)` fallback,
    // which emits a "Unknown command ... falling back to bash" comment and never
    // executes it. The match above alone is satisfied by that comment, so assert
    // the fallback warning is absent.
    assert.doesNotMatch(bashrc, /Unknown command/,
      'agy tab must hit the known-safe autostart arm, not the unknown-command fallback');
  });

  it('idempotent: a second invocation does NOT re-append the marker block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tab-autostart-idempotent-'));
    const body = extractConfigureBody();
    const runtimeRoot = join(dir, 'runtime');
    const script = [
      '#!/usr/bin/env bash',
      'set -e',
      `export USER_HOME='${dir}'`,
      `export CODEFLARE_RUNTIME_ROOT='${runtimeRoot}'`,
      `mkdir -p '${runtimeRoot}/services'`,
      body,
      'configure_tab_autostart',
      'configure_tab_autostart',
    ].join('\n');
    const scriptPath = join(dir, 'harness.sh');
    writeFileSync(scriptPath, script, { mode: 0o755 });
    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0);
    const bashrc = readFileSync(join(dir, '.bashrc'), 'utf8');
    // Marker should appear exactly once.
    const markerCount = (bashrc.match(/^# terminal-autostart$/gm) ?? []).length;
    assert.equal(markerCount, 1, 'autostart marker must appear exactly once after two invocations');
  });
});
