import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { attachTerminalConnectionHandler } from '../dist/terminal-ws.js';
import { focusHerdrPane } from '../dist/herdr-agent-status.js';
import { once } from 'node:events';
import { SessionManager, PREWARM_SESSION_ID } from '../dist/session-manager.js';
import { Session } from '../dist/session.js';
import primaryIdentity, { activatePrimaryBridge } from '../../image/chat/primary-identity.mjs';

const disposals = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

const PRIMARY_ID = 'abcdef0123456789-1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description);
    await delay(10);
  }
}

// Real WS and PTY boundary; no private ws transport or replacement input queue.
async function terminalHost(t, { focusPrimary, ...options } = {}) {
  const savedSession = process.env.SESSION_ID;
  process.env.SESSION_ID = 'abcdef0123456789';
  const manager = new SessionManager({ terminalCommand: '/bin/cat', terminalArgs: '',
    getWorkingDirectory: () => tmpdir(), ptyKeepaliveMs: 150, ...options });
  const wss = new WebSocketServer({ noServer: true });
  attachTerminalConnectionHandler(wss, { sessionManager: manager, log() {}, logWsEvent() {},
    readiness: () => ({ initFlagObserved: true, terminalServiceReady: true }),
    keepalivePingMs: 30000, maxControlMsgLength: 65536, focusPrimary,
  });
  const server = http.createServer();
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const ws of wss.clients) ws.terminate();
    manager.killAll();
    await Promise.all([
      new Promise(resolve => wss.close(resolve)),
      new Promise(resolve => server.close(resolve)),
    ]);
    if (savedSession === undefined) delete process.env.SESSION_ID;
    else process.env.SESSION_ID = savedSession;
  });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { manager, wss, connect(query = `session=${PRIMARY_ID}`) {
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/terminal?${query}`);
    clients.add(client);
    return client;
  } };
}

async function disconnectTerminal(client, wss) {
  const serverClosed = once([...wss.clients][0], 'close');
  const clientClosed = once(client, 'close');
  client.close();
  await Promise.all([serverClosed, clientClosed]);
}

describe('Codeflare configured-primary ownership', { timeout: 15000 }, () => {
  // Concrete first-party adoption delta, using disposable real PTYs, not SDK internals.
  it('REQ-AGENT-224: Chat-only entry adopts the exact prewarm without a hidden terminal client', async () => {
    const options = { terminalCommand: '/bin/cat', terminalArgs: '', getWorkingDirectory: () => tmpdir() };
    const manager = new SessionManager(options); disposals.push(() => manager.killAll());
    const prewarm = new Session(PREWARM_SESSION_ID, 'Terminal', false, options);
    manager.sessions.set(PREWARM_SESSION_ID, prewarm); prewarm.start();
    const pid = prewarm.ptyProcess.pid;
    const sessions = await Promise.all(Array.from({ length: 8 }, () => manager.ensurePrimary('abcdef0123456789-1')));
    for (const session of sessions) assert.equal(session.ptyProcess.pid, pid);
    assert.equal(manager.clients.size, 0); assert.equal(manager.size, 1);
    assert.equal(manager.get(PREWARM_SESSION_ID), undefined);
    assert.equal(sessions[0].manual, false);
  });
  it('REQ-AGENT-224: primary-return flag focuses before terminal attach, without manufacturing a replacement PTY', async () => {
    const savedSession = process.env.SESSION_ID; process.env.SESSION_ID = 'abcdef0123456789';
    const manager = new SessionManager({ terminalCommand: '/bin/cat', terminalArgs: '', getWorkingDirectory: () => tmpdir(), ptyKeepaliveMs: 250 });
    const session = manager.ensurePrimary('abcdef0123456789-1'); const pid = session.ptyProcess.pid;
    const wss = new WebSocketServer({ noServer: true });
    let focused = false;
    attachTerminalConnectionHandler(wss, { sessionManager: manager, log() {}, logWsEvent() {},
      readiness: () => ({ initFlagObserved: true, terminalServiceReady: true }),
      keepalivePingMs: 30000, maxControlMsgLength: 65536,
      focusPrimary: async () => { focused = true; },
    });
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/terminal?session=abcdef0123456789-1&primary=1`);
    const greeting = once(client, 'message');
    try {
      await once(client, 'open'); await greeting;
      assert.equal(focused, true); assert.equal(manager.get('abcdef0123456789-1').ptyProcess.pid, pid);
      assert.equal(manager.clients.size, 1);
      const disconnected = once(client, 'close'); client.close(); await disconnected;
      await new Promise(resolve => setTimeout(resolve, 10));
      manager.ensurePrimary('abcdef0123456789-1');
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(manager.get('abcdef0123456789-1').ptyProcess.pid, pid);
      assert.equal(manager.clients.size, 0);
    } finally {
      client.terminate(); manager.killAll();
      for (const ws of wss.clients) ws.terminate(); wss.close();
      await new Promise(resolve => server.close(resolve));
      if (savedSession === undefined) delete process.env.SESSION_ID; else process.env.SESSION_ID = savedSession;
    }
  });
  it('REQ-AGENT-224: resize and input sent on OPEN survive pending primary focus and reach the same PTY only after focus', async t => {
    const focus = deferred();
    const host = await terminalHost(t, { focusPrimary: () => focus.promise,
      terminalCommand: '/bin/bash', terminalArgs: '--noprofile --norc' });
    const session = host.manager.getOrCreate(PRIMARY_ID, 'Terminal'); session.start();
    const pid = session.ptyProcess.pid;
    let ptyOutput = '', browserOutput = '';
    const subscription = session.ptyProcess.onData(data => { ptyOutput += data; });
    t.after(() => { focus.resolve(); subscription.dispose(); });
    const client = host.connect(`session=${PRIMARY_ID}&primary=1`);
    client.on('message', data => { browserOutput += data.toString(); });
    await once(client, 'open');
    client.send(JSON.stringify({ type: 'resize', cols: 113, rows: 37 }));
    client.send("printf '%s%s\\n' 'FOCUS_' 'RELEASED'; stty size\r");
    client.send(JSON.stringify({ type: 'data', data: "printf '%s%s\\n' 'JSON_' 'DELIVERED'\r" }));
    // Deliberately leave focus unresolved while OPEN frames arrive at Host.
    await delay(75);
    assert.equal(host.manager.clients.size, 0, 'pending focus must not attach a terminal');
    assert.doesNotMatch(ptyOutput, /FOCUS_RELEASED|JSON_DELIVERED/, 'no input reaches the PTY before focus');
    focus.resolve();
    await waitFor(() => /FOCUS_RELEASED\r?\n37 113/.test(ptyOutput) && /JSON_DELIVERED/.test(ptyOutput),
      'early raw/JSON input and resize must reach the real PTY after focus');
    await waitFor(() => /FOCUS_RELEASED\r?\n37 113/.test(browserOutput) && /JSON_DELIVERED/.test(browserOutput),
      'the browser must receive the resulting PTY output');
    assert.equal(session.ptyProcess.pid, pid, 'focus must not replace the PTY');
    assert.equal(host.manager.clients.size, 1);
  });

  it('REQ-AGENT-224: failed pending focus closes with retryable status without delivering early input or attaching', async t => {
    const focus = deferred();
    const host = await terminalHost(t, { focusPrimary: () => focus.promise });
    const session = host.manager.getOrCreate(PRIMARY_ID, 'Terminal'); session.start();
    const pid = session.ptyProcess.pid;
    let output = '';
    const subscription = session.ptyProcess.onData(data => { output += data; });
    t.after(() => { focus.resolve(); subscription.dispose(); });
    const client = host.connect(`session=${PRIMARY_ID}&primary=1`);
    await once(client, 'open');
    client.send('must-not-reach-pty\r');
    await delay(75);
    const closed = once(client, 'close');
    focus.reject(new Error('pane unavailable'));
    const [code, reason] = await closed;
    assert.equal(code, 1013);
    assert.equal(reason.toString(), 'Primary pane unavailable');
    assert.equal(host.manager.clients.size, 0);
    assert.equal(session.ptyProcess.pid, pid);
    assert.doesNotMatch(output, /must-not-reach-pty/);
  });

  for (const outcome of ['resolve', 'reject']) {
    it(`REQ-AGENT-224: focus ${outcome} after socket closure cannot start or attach a PTY`, async t => {
      const focus = deferred();
      const host = await terminalHost(t, { focusPrimary: () => focus.promise });
      t.after(() => focus.resolve());
      const client = host.connect(`session=${PRIMARY_ID}&primary=1`);
      await once(client, 'open');
      const ws = [...host.wss.clients][0];
      const serverClosed = once(ws, 'close'), clientClosed = once(client, 'close');
      // Public server-side termination models shutdown while pane.focus is pending.
      ws.terminate();
      await Promise.all([serverClosed, clientClosed]);
      if (outcome === 'resolve') focus.resolve();
      else focus.reject(new Error('pane unavailable after disconnect'));
      await delay(25);
      assert.equal(host.manager.size, 0);
      assert.equal(host.manager.clients.size, 0);
    });
  }

  it('REQ-AGENT-224: session-cap rejection after pending focus completes the socket close without attaching', async t => {
    const focus = deferred();
    const host = await terminalHost(t, { focusPrimary: () => focus.promise, maxSessions: 1 });
    t.after(() => focus.resolve());
    const existing = host.manager.ensurePrimary('fedcba9876543210-1');
    const client = host.connect(`session=${PRIMARY_ID}&primary=1`);
    await once(client, 'open');
    client.send('not-attached\r');
    const closed = once(client, 'close');
    focus.resolve();
    const [code, reason] = await closed;
    assert.equal(code, 1013);
    assert.equal(reason.toString(), 'Session limit reached');
    assert.equal(host.manager.get(PRIMARY_ID), undefined);
    assert.equal(host.manager.clients.size, 0);
    assert.equal(existing.isPtyAlive(), true);
  });

  for (const order of ['ensure-before-detach', 'ensure-after-detach']) {
    it(`REQ-AGENT-224: ${order} retains the adopted primary beyond Terminal disconnect expiry without hidden clients`, async t => {
      const host = await terminalHost(t);
      const client = host.connect();
      await once(client, 'open');
      await waitFor(() => host.manager.clients.size === 1, 'terminal must attach');
      const session = host.manager.get(PRIMARY_ID), pid = session.ptyProcess.pid;
      if (order === 'ensure-before-detach') host.manager.ensurePrimary(PRIMARY_ID);
      await disconnectTerminal(client, host.wss);
      if (order === 'ensure-after-detach') host.manager.ensurePrimary(PRIMARY_ID);
      await delay(300);
      assert.equal(host.manager.clients.size, 0, 'Chat must not manufacture a terminal client');
      assert.equal(host.manager.get(PRIMARY_ID)?.ptyProcess?.pid, pid, 'the same PTY survives Terminal expiry');
      assert.equal(session.isPtyAlive(), true);
      assert.doesNotThrow(() => process.kill(pid, 0), 'the retained OS process must still exist');
      // Retention does not supersede the existing explicit lifecycle owner.
      host.manager.delete(PRIMARY_ID);
      assert.equal(session.isPtyAlive(), false);
      assert.equal(host.manager.get(PRIMARY_ID), undefined);
    });
  }

  for (const [id, manual] of [[PRIMARY_ID, false], ['abcdef0123456789-2', false], ['abcdef0123456789-3', true]]) {
    it(`REQ-AGENT-224: unretained ${manual ? 'manual' : id === PRIMARY_ID ? 'primary' : 'secondary'} still expires after its last Terminal detaches`, async t => {
      const host = await terminalHost(t);
      // Retaining another primary must not retain unrelated sessions.
      const retained = host.manager.ensurePrimary('fedcba9876543210-1');
      const client = host.connect(`session=${id}${manual ? '&manual=1' : ''}`);
      await once(client, 'open');
      await waitFor(() => host.manager.clients.size === 1, 'ordinary terminal must attach');
      const session = host.manager.get(id);
      assert.equal(session.isPtyAlive(), true);
      await disconnectTerminal(client, host.wss);
      await waitFor(() => host.manager.get(id) === undefined, 'unretained session must be reaped');
      assert.equal(session.isPtyAlive(), false, 'ordinary disconnect expiry must kill its PTY');
      assert.equal(retained.isPtyAlive(), true, 'expiry must remain session-local');
      assert.equal(host.manager.clients.size, 0);
    });
  }

  it('REQ-AGENT-224: return to Terminal focuses the recorded primary pane through supported Herdr pane.focus', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-pane-')); const socket = join(dir, 'herdr.sock');
    disposals.push(() => rmSync(dir, { recursive: true, force: true }));
    let focused;
    const server = net.createServer(client => {
      client.once('data', data => {
        const request = JSON.parse(data.toString());
        if (request.method === 'pane.focus') focused = request.params.pane_id;
        client.end(JSON.stringify({ id: request.id, result: { focused_pane_id: focused } }) + '\n');
      });
    });
    server.listen(socket); await once(server, 'listening');
    try { await focusHerdrPane(socket, 'w1:p2'); assert.equal(focused, 'w1:p2'); }
    finally { await new Promise(resolve => server.close(resolve)); }
  });
  it('REQ-AGENT-224: one late primary remains distinct from secondary/manual PTYs', async () => {
    const manager = new SessionManager({ terminalCommand: '/bin/cat', terminalArgs: '', getWorkingDirectory: () => tmpdir() });
    disposals.push(() => manager.killAll());
    const secondary = manager.getOrCreate('abcdef0123456789-2', 'Bash', true); secondary.start();
    const primaries = await Promise.all(Array.from({ length: 8 }, () => manager.ensurePrimary('abcdef0123456789-1')));
    assert.equal(new Set(primaries.map(session => session.ptyProcess.pid)).size, 1);
    assert.notEqual(primaries[0].ptyProcess.pid, secondary.ptyProcess.pid);
    assert.equal(primaries[0].manual, false); assert.equal(manager.clients.size, 0);
  });
  it('REQ-AGENT-224: scoped public bridge activation does not leak endpoint/activation to child processes', async () => {
    const original = { ...process.env };
    try {
      process.env.CODEFLARE_CHAT_PRIMARY_PID = String(process.pid);
      process.env.CODEFLARE_CHAT_SOCKET = '/run/codeflare/chat/.pi/dashboard/gateway-9998.sock';
      process.env.PI_DASHBOARD_BRIDGE = 'off';
      delete process.env.PI_DASHBOARD_SOCKET;
      let endpoint;
      activatePrimaryBridge({}, () => {
        endpoint = process.env.PI_DASHBOARD_SOCKET;
        assert.equal(process.env.PI_DASHBOARD_BRIDGE, 'on');
      });
      assert.equal(endpoint, process.env.CODEFLARE_CHAT_SOCKET);
      const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({socket:process.env.PI_DASHBOARD_SOCKET,bridge:process.env.PI_DASHBOARD_BRIDGE}))'], { stdio: 'pipe' });
      let text = ''; child.stdout.on('data', chunk => { text += chunk; });
      assert.equal((await once(child, 'exit'))[0], 0);
      assert.deepEqual(JSON.parse(text), { bridge: 'off' });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
    }
  });
  it('REQ-AGENT-224: explicit primary identity helper publishes actual public session identity and excludes inherited child runtimes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-primary-'));
    disposals.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'primary.json');
    const resume = join(dir, 'resume.json'); const herdr = join(dir, 'herdr.mjs');
    writeFileSync(herdr, `#!/usr/bin/env node\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(resume)},JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(herdr, 0o755);
    const hooks = new Map();
    const env = { CODEFLARE_CHAT_PRIMARY_PID: String(process.pid), CODEFLARE_CHAT_IDENTITY_FILE: file,
      CODEFLARE_CHAT_GENERATION: '7', HERDR_PANE_ID: 'w1:p2', HERDR_ENV: '1', HERDR_BIN_PATH: herdr };
    primaryIdentity({ on: (name, callback) => hooks.set(name, callback) }, env);
    await hooks.get('session_start')({ reason: 'startup' }, { mode: 'tui', sessionManager: { getSessionId: () => 'real-session-a' } });
    // Public Herdr resume-command contract: restore re-enters the same scoped
    // launcher/session, not plain pi (which would omit the explicit extension).
    const reported = JSON.parse(readFileSync(resume, 'utf8'));
    assert.deepEqual(reported.slice(-6), ['--', 'codeflare-primary-pi', '--tui-mode', 'fullscreen', '--session-id', 'real-session-a']);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      sessionId: 'real-session-a', generation: 7, pid: process.pid, paneId: 'w1:p2',
      startTime: readFileSync('/proc/self/stat', 'utf8').split(') ').slice(1).join(') ').split(' ')[19],
    });
    // Real child inherits the parent's activation environment, but cannot publish identity.
    const fixture = join(dir, 'child.mjs');
    writeFileSync(fixture, `import identity from ${JSON.stringify(new URL('../../image/chat/primary-identity.mjs', import.meta.url).href)};\nidentity({on(){throw new Error('child activated primary hooks')}}, process.env);\n`);
    const child = spawn(process.execPath, [fixture], { env: { ...process.env, ...env }, stdio: 'pipe' });
    assert.equal((await once(child, 'exit'))[0], 0);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessionId, 'real-session-a');
    // A headless SDK runtime in the SAME process cannot replace OR withdraw it.
    const childHooks = new Map();
    primaryIdentity({ on: (name, callback) => childHooks.set(name, callback) }, env);
    await childHooks.get('session_start')({ reason: 'startup' }, { mode: 'json',
      sessionManager: { getSessionId: () => 'sdk-child-session' } });
    childHooks.get('session_shutdown')({ reason: 'quit' });
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).sessionId, 'real-session-a');
    hooks.get('session_shutdown')({ reason: 'quit' });
    assert.throws(() => readFileSync(file));
  });
});
