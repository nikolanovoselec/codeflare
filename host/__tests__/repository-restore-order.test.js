// REQ-TERM-033 AC2: use the compiled composition root, not copied startup code.
// The terminal peer observes bytes at the real PTY boundary; it does not emulate
// Herdr hydration or R2. Run in the normal Linux host lane after its host build.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

// node-pty creates a separate session for its child. Stop the host first so it
// cannot fork during cleanup, then collect and kill its owned descendants too.
function descendants(pid) {
  let children;
  try { children = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim(); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return []; throw error; }
  return children ? children.split(/\s+/).map(Number).flatMap(child => [child, ...descendants(child)]) : [];
}

function signal(pid, name) {
  try { process.kill(pid, name); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

it('REQ-TERM-033 AC2: real host prewarm waits for restored snapshot bytes and the init flag', {
  skip: process.platform !== 'linux',
  timeout: 20_000,
}, async (t) => {
  const root = mkdtempSync('/tmp/codeflare-restore-order-');
  const home = join(root, 'home');
  const runtime = join(root, 'runtime');
  const workspace = join(home, 'workspace');
  const sessionId = 'restore01';
  const snapshot = join(home, '.codeflare/herdr/sessions', `cf-${sessionId}`, 'session.json');
  const flag = join(runtime, 'services/init-complete');
  const launch = join(root, 'terminal-launch.json');
  const peer = join(root, 'terminal-peer.cjs');
  let child;
  let closed = Promise.resolve();
  let diagnostics = '';
  let spawnError;

  t.after(async () => {
    try {
      const pids = new Set();
      const hostAlive = child?.pid && child.exitCode === null && child.signalCode === null;
      if (hostAlive) {
        // SIGKILL deliberately avoids the production SIGTERM shutdown hook:
        // Herdr mode's hook invokes the real image launcher, outside this fixture.
        signal(child.pid, 'SIGSTOP');
        for (const pid of descendants(child.pid)) pids.add(pid);
      }
      if (existsSync(launch)) {
        const { pid } = JSON.parse(readFileSync(launch, 'utf8'));
        // If the host died first, only signal a still-owned peer, not a reused PID.
        try {
          if (readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from(peer))) pids.add(pid);
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
      }
      for (const pid of pids) {
        signal(-pid, 'SIGKILL');
        signal(pid, 'SIGKILL');
      }
      if (hostAlive) {
        signal(-child.pid, 'SIGKILL');
        signal(child.pid, 'SIGKILL');
      }
      let timer;
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Host child did not close after cleanup')), 2_000);
        })]);
      } finally { clearTimeout(timer); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  for (const dir of [workspace, join(runtime, 'services'), join(home, '.config'),
    join(home, '.cache'), join(home, '.local/state'), join(root, 'tmp')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(peer, `
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const snapshot = path.join(home, '.codeflare/herdr/sessions', 'cf-' + process.env.SESSION_ID, 'session.json');
const receipt = { pid: process.pid, terminalId: process.env.TERMINAL_ID,
  initObserved: fs.existsSync(process.env.CODEFLARE_INIT_FLAG_FILE) };
try { receipt.bytes = fs.readFileSync(snapshot).toString('base64'); }
catch (error) { receipt.error = error.code; }
const destination = ${JSON.stringify(launch)};
fs.writeFileSync(destination + '.tmp', JSON.stringify(receipt));
fs.renameSync(destination + '.tmp', destination);
// Bound even a parent test-process crash; do not launch shells or agents.
setTimeout(() => process.exit(0), 15_000);
`);

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  const token = 'isolated-restore-order-fixture';
  child = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
    cwd: workspace,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Do not inherit credentials, NODE_OPTIONS, operator config, or user paths.
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local/state'),
      TMPDIR: join(root, 'tmp'),
      WORKSPACE: workspace,
      PI_CODING_AGENT_DIR: join(home, '.pi/agent'),
      CODEFLARE_RUNTIME_ROOT: runtime,
      CODEFLARE_HERDR_PERSIST_ROOT: join(home, '.codeflare'),
      CODEFLARE_INIT_FLAG_FILE: flag,
      CODEFLARE_SESSION_WORKSPACE: 'terminal',
      CODEFLARE_TERMINAL_MODE: 'herdr',
      CODEFLARE_PI_SURFACE: 'chat',
      CODEFLARE_PI_GENERATION: '7',
      CODEFLARE_CLONE_RESTORE_FLAG_FILE: flag,
      SESSION_ID: sessionId,
      TERMINAL_PORT: String(port),
      TERMINAL_COMMAND: process.execPath,
      TERMINAL_ARGS: peer,
      CONTAINER_AUTH_TOKEN: token,
    },
  });
  closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', error => { spawnError = error; });
  const record = bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-16_384); };
  child.stdout.on('data', record);
  child.stderr.on('data', record);

  function assertAlive() {
    assert.equal(spawnError, undefined, spawnError?.message);
    assert.equal(child.exitCode, null, diagnostics);
    assert.equal(child.signalCode, null, diagnostics);
  }
  async function waitFor(observed, description) {
    const deadline = Date.now() + 5_000;
    while (!observed()) {
      assertAlive();
      assert.ok(Date.now() < deadline, `${description}\n${diagnostics}`);
      await delay(25, undefined, { signal: t.signal });
    }
  }
  async function assertGated(duration) {
    const deadline = Date.now() + duration;
    do {
      assertAlive();
      assert.equal(existsSync(flag), false, 'fixture must not release initialization yet');
      assert.equal(existsSync(launch), false, 'terminal launched before initialization was released');
      await delay(25, undefined, { signal: t.signal });
    } while (Date.now() < deadline);
  }

  await waitFor(() => diagnostics.includes('Terminal server listening'), 'Host never reported listening');
  // REQ-AGENT-272: exercise the real Host composition root with otherwise
  // eligible handoff settings. The routed control would return 200 if mounted.
  const chat = await fetch(`http://127.0.0.1:${port}/api/pi-web/${sessionId}/_switch?generation=7`, {
    headers: { Authorization: `Bearer ${token}`, 'x-codeflare-pi-generation': '7',
      'x-forwarded-host': 'localhost', 'x-forwarded-proto': 'https' },
    signal: t.signal,
  });
  assert.equal(chat.status, 404, 'Herdr Host must not mount Pi Chat');
  assert.deepEqual(await chat.json(), { error: 'Not found' });
  await assertGated(750);

  const restoredBytes = Buffer.from('{"version":3}\n');
  mkdirSync(join(home, '.codeflare/herdr/sessions', `cf-${sessionId}`), { recursive: true });
  writeFileSync(`${snapshot}.tmp`, restoredBytes);
  renameSync(`${snapshot}.tmp`, snapshot);
  // The restored file alone is not the release signal.
  await assertGated(500);
  writeFileSync(flag, '');

  await waitFor(() => existsSync(launch), 'Real prewarm did not launch the terminal peer');
  const receipt = JSON.parse(readFileSync(launch, 'utf8'));
  assert.equal(receipt.terminalId, '1');
  assert.equal(receipt.initObserved, true);
  assert.equal(receipt.error, undefined);
  assert.deepEqual(Buffer.from(receipt.bytes, 'base64'), restoredBytes);
  assertAlive();
});
