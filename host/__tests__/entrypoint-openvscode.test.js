// Real behavioral tests for the OpenVSCode supervisor in entrypoint.sh
// (REQ-IDE-001, REQ-IDE-002, REQ-IDE-003).
//
// Per tdd-discipline / engineering-constitution mandate 2 we do NOT match
// source text: we EXTRACT the real shell functions, RUN them with a stubbed
// openvscode-server binary + temp flag/trigger files, and assert on observable
// side effects (exit codes, captured launch args, whether/how many times the
// stub was invoked, whether a pidfile-tracked process is killed). Mirrors the
// extract-and-run harness in entrypoint-vault-boot.test.js.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

// Extract a top-level `name() {` body (header to the matching column-0 `}`).
function extractFn(name) {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  let start = -1;
  const header = new RegExp(`^${name}\\(\\) \\{`);
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && header.test(lines[i])) start = i;
    else if (start !== -1 && /^\}$/.test(lines[i])) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`Could not locate ${name}() in entrypoint.sh`);
}

// Extract the nested walk_kill + kill_pidfile_subtree helpers (4-space indent
// inside shutdown_handler) as one runnable block.
function extractKillHelpers() {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const startIdx = lines.findIndex((l) => /^ {4}walk_kill\(\) \{/.test(l));
  if (startIdx === -1) throw new Error('walk_kill() not found');
  const kpsIdx = lines.findIndex((l, i) => i > startIdx && / {4}kill_pidfile_subtree\(\) \{/.test(l));
  if (kpsIdx === -1) throw new Error('kill_pidfile_subtree() not found');
  let endIdx = -1;
  for (let i = kpsIdx + 1; i < lines.length; i++) {
    if (/^ {4}\}$/.test(lines[i])) { endIdx = i; break; }
  }
  if (endIdx === -1) throw new Error('closing brace of kill_pidfile_subtree() not found');
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

function mkTmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Write an executable stub that records each invocation's args, then exits.
function writeStub(dir, argsFile) {
  const stub = join(dir, 'openvscode-server');
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "${argsFile}"\nprintf -- '---\\n' >> "${argsFile}"\nexit 0\n`);
  chmodSync(stub, 0o755);
  return stub;
}

function runBash(script, env = {}) {
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
}

describe('_openvscode_should_launch / REQ-IDE-003 AC1 (lazy-start gate)', () => {
  let dir, flag, trigger;
  beforeEach(() => {
    dir = mkTmp('ovsc-gate-');
    flag = join(dir, 'init-complete');
    trigger = join(dir, 'requested');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const fn = () => extractFn('_openvscode_should_launch');

  function gate(env) {
    const r = runBash(`${fn()}\n_openvscode_should_launch; echo "RC=$?"`, env);
    return r.stdout.trim();
  }

  it('does NOT launch when the trigger file is absent (even with a session id + init flag)', () => {
    writeFileSync(flag, '');
    assert.equal(gate({ SESSION_ID: 'abcd1234', CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger }), 'RC=1');
  });

  it('does NOT launch when init is incomplete (no init flag)', () => {
    writeFileSync(trigger, '');
    assert.equal(gate({ SESSION_ID: 'abcd1234', CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger }), 'RC=1');
  });

  it('does NOT launch when there is no session id (fail-safe against a base-path mismatch)', () => {
    writeFileSync(flag, '');
    writeFileSync(trigger, '');
    assert.equal(gate({ SESSION_ID: '', CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger }), 'RC=1');
  });

  it('launches only when session id + init flag + trigger are ALL present', () => {
    writeFileSync(flag, '');
    writeFileSync(trigger, '');
    assert.equal(gate({ SESSION_ID: 'abcd1234', CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger }), 'RC=0');
  });
});

describe('_openvscode_launch_once / REQ-IDE-001, REQ-IDE-002 (session-isolated launch command)', () => {
  let dir, argsFile, workspace;
  beforeEach(() => {
    dir = mkTmp('ovsc-launch-');
    argsFile = join(dir, 'args.log');
    workspace = join(dir, 'workspace');
    mkdirSync(workspace);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes --server-base-path=/api/vscode/<SESSION_ID>, the ephemeral /tmp data dir, the workspace, and no connection token', () => {
    const stub = writeStub(dir, argsFile);
    // OPENVSCODE_DATA_DIR is intentionally NOT set, so the real default applies.
    const r = runBash(`${extractFn('_openvscode_launch_once')}\n_openvscode_launch_once`, {
      OPENVSCODE_BIN: stub,
      SESSION_ID: 'abcd1234',
      OPENVSCODE_WORKSPACE: workspace,
    });
    assert.equal(r.status, 0);
    const args = readFileSync(argsFile, 'utf8').split('\n');
    // Session isolation: the base path carries the session id (REQ-IDE-002).
    assert.ok(args.includes('--server-base-path'), 'has --server-base-path flag');
    assert.ok(args.includes('/api/vscode/abcd1234'), 'base path is /api/vscode/<sid>');
    // Ephemeral, never-synced data dir under /tmp -- the real default (REQ-IDE-002/003 AC6).
    assert.ok(args.includes('--server-data-dir'), 'has --server-data-dir flag');
    assert.ok(args.includes('/tmp/openvscode-data'), 'data dir defaults to the ephemeral /tmp path (never R2-synced)');
    // Worker is the auth boundary -> no connection token.
    assert.ok(args.includes('--without-connection-token'), 'runs without a connection token');
    // Opens the session workspace.
    assert.ok(args.includes('--default-folder'), 'has --default-folder flag');
    assert.ok(args.includes(workspace), 'opens the workspace folder');
    // Bound to localhost only.
    assert.ok(args.includes('127.0.0.1'), 'binds localhost');
  });
});

describe('_openvscode_supervise_loop / REQ-IDE-003 AC1+AC4 (lazy no-launch, restart on exit)', () => {
  let dir, argsFile, flag, trigger;
  beforeEach(() => {
    dir = mkTmp('ovsc-loop-');
    argsFile = join(dir, 'args.log');
    flag = join(dir, 'init-complete');
    trigger = join(dir, 'requested');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function loopScript() {
    // export -f so the inner `timeout bash -c '_openvscode_supervise_loop'`
    // inherits the helpers -- the exact mechanism start_openvscode_supervisor
    // uses for its setsid subshell.
    return [
      extractFn('_openvscode_should_launch'),
      extractFn('_openvscode_launch_once'),
      extractFn('_openvscode_supervise_loop'),
      'export -f _openvscode_should_launch _openvscode_launch_once _openvscode_supervise_loop',
    ].join('\n');
  }

  it('never launches while the trigger is absent (lazy start)', () => {
    const stub = writeStub(dir, argsFile);
    // 3s window; the gate polls every 2s and never passes -> stub untouched.
    runBash(`${loopScript()}\ntimeout 3 bash -c '_openvscode_supervise_loop' || true`, {
      OPENVSCODE_BIN: stub, SESSION_ID: 'abcd1234',
      CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger,
      OPENVSCODE_DATA_DIR: join(tmpdir(), 'ovsc-d'), OPENVSCODE_WORKSPACE: dir,
    });
    assert.equal(existsSync(argsFile), false, 'stub was never invoked');
  });

  it('relaunches the server after it exits (restart loop)', () => {
    const stub = writeStub(dir, argsFile);
    writeFileSync(flag, '');
    writeFileSync(trigger, '');
    // 8s window; the stub exits immediately and the loop restarts after 5s,
    // so we expect launches at ~0s and ~5s -> at least 2 invocations.
    runBash(`${loopScript()}\ntimeout 8 bash -c '_openvscode_supervise_loop' || true`, {
      OPENVSCODE_BIN: stub, SESSION_ID: 'abcd1234',
      CODEFLARE_INIT_FLAG_FILE: flag, OPENVSCODE_REQUEST_TRIGGER: trigger,
      OPENVSCODE_DATA_DIR: join(tmpdir(), 'ovsc-d'), OPENVSCODE_WORKSPACE: dir,
    });
    const launches = (readFileSync(argsFile, 'utf8').match(/---/g) || []).length;
    assert.ok(launches >= 2, `expected >=2 relaunches, got ${launches}`);
  });
});

describe('kill_pidfile_subtree / REQ-IDE-003 AC5 (shutdown releases the IDE port)', () => {
  let dir, pidfile;
  beforeEach(() => {
    dir = mkTmp('ovsc-kill-');
    pidfile = join(dir, 'openvscode.pid');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('kills the pidfile-tracked process subtree (the mechanism shutdown_handler uses for /tmp/openvscode.pid)', () => {
    // Start a real long sleeper, record its PID as the "supervisor" pidfile,
    // then run the extracted teardown helpers and assert the process is gone.
    const script = `
${extractKillHelpers()}
sleep 30 &
child=$!
echo "$child" > "${pidfile}"
kill_pidfile_subtree "${pidfile}"
sleep 0.3
if kill -0 "$child" 2>/dev/null; then echo "ALIVE"; else echo "DEAD"; fi
`;
    const r = runBash(script);
    assert.equal(r.stdout.trim(), 'DEAD');
  });
});
