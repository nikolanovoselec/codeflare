// Real behavioral tests for the host (container-side) half of REQ-TERM-002:
//   AC3 — the PTY is spawned as a login shell ("-l") with full-color terminal
//         emulation (name + TERM/COLORTERM env = xterm-256color / truecolor).
//   AC4 — raw PTY output flows to attached WebSocket clients WITHOUT JSON
//         wrapping, byte-for-byte.
//   AC5 — host-originated out-of-band control messages (restore, process-name)
//         are JSON objects carrying a leading `type` discriminator field.
//
// These REPLACE the readFileSync()+regex source-string assertions in
// host/__audits__/terminal-compound-key.audit.js for the host-side ACs that
// are reachable without a real PTY/WebSocket pair.
//
// Strategy (mirrors host/__tests__/session-process-name.test.js +
// session-resize-authority.test.js for the Session harness, and
// host/__tests__/metrics.test.js for the mock.module shape): mock node-pty so
// Session.start() runs its REAL spawn + onData broadcast wiring against a fake
// PTY whose data/exit handlers we capture and drive. The headless xterm
// terminal (@xterm/headless) is real, so the restore-state frame is exercised
// through the genuine serialize path.
//
// Gut-check: each assertion below fails if the named symbol is gutted — change
// `name: 'xterm-256color'` -> 'dumb', drop `-l`, JSON-wrap the raw send, or
// strip the `type` field, and the matching test goes red.
//
// Run with:
//   node --test host/__tests__/session-wire-protocol.test.js

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock node-pty so start() can run without forking a real PTY ──────────────
// spawn() records the (cmd, args, opts) it was called with and returns a fake
// PTY whose onData/onExit listeners we capture so we can drive output frames.
let lastSpawn = null;

function makeFakePty() {
  const pty = {
    pid: 4242,
    process: 'bash',
    _dataListeners: [],
    _exitListeners: [],
    onData(fn) { pty._dataListeners.push(fn); return { dispose() {} }; },
    onExit(fn) { pty._exitListeners.push(fn); return { dispose() {} }; },
    write() {},
    resize() {},
    kill() {},
    emitData(data) { for (const fn of pty._dataListeners) fn(data); },
  };
  return pty;
}

const spawnMock = mock.fn((cmd, args, opts) => {
  const pty = makeFakePty();
  lastSpawn = { cmd, args, opts, pty };
  return pty;
});

mock.module('node-pty', {
  defaultExport: { spawn: spawnMock },
  namedExports: { spawn: spawnMock },
});

// Import the REAL compiled Session after the mock is registered.
const { Session } = await import('../dist/session.js');

function createWs(readyState = 1) {
  return {
    readyState,
    sent: [],
    send(data) { this.sent.push(data); },
    close() {},
  };
}

// ── REQ-TERM-002 AC3: login shell + full-color terminal emulation ───────────

describe('REQ-TERM-002 AC3: PTY spawned as a full-color login shell', () => {
  it('buildPtyEnv() exposes TERM=xterm-256color and COLORTERM=truecolor', () => {
    const env = new Session('sess-1', 'Terminal').buildPtyEnv('1');
    assert.equal(env.TERM, 'xterm-256color', 'TERM must select 256-color emulation');
    assert.equal(env.COLORTERM, 'truecolor', 'COLORTERM must advertise truecolor');
  });

  it('start() spawns the PTY with name "xterm-256color" and the matching env', () => {
    spawnMock.mock.resetCalls();
    const session = new Session('sess-2', 'Terminal');
    session.start(120, 40);

    assert.equal(spawnMock.mock.callCount(), 1, 'PTY is spawned exactly once');
    assert.equal(lastSpawn.opts.name, 'xterm-256color',
      'pty.spawn must request the xterm-256color terminfo name');
    assert.equal(lastSpawn.opts.cols, 120);
    assert.equal(lastSpawn.opts.rows, 40);
    assert.equal(lastSpawn.opts.env.TERM, 'xterm-256color');
    assert.equal(lastSpawn.opts.env.COLORTERM, 'truecolor');

    session.kill();
  });

  it('start() passes the "-l" login-shell flag through to the spawned shell', () => {
    spawnMock.mock.resetCalls();
    // Default terminalArgs is "-l" (login shell) — assert it reaches argv.
    const session = new Session('sess-3', 'Terminal');
    session.start();

    assert.equal(lastSpawn.cmd, '/bin/bash', 'default shell is bash');
    assert.ok(lastSpawn.args.includes('-l'),
      `login-shell flag "-l" must be in the spawned argv, got ${JSON.stringify(lastSpawn.args)}`);

    session.kill();
  });

  it('start() forwards an explicitly configured terminalArgs string as argv', () => {
    spawnMock.mock.resetCalls();
    // A non-default args value proves args are split + forwarded, not hardcoded.
    const session = new Session('sess-4', 'Terminal', false, { terminalArgs: '-l --norc' });
    session.start();

    assert.deepEqual(lastSpawn.args, ['-l', '--norc'],
      'configured terminalArgs must be split on whitespace and forwarded to spawn');

    session.kill();
  });
});

// ── REQ-TERM-002 AC4: raw PTY data flows unwrapped ──────────────────────────

describe('REQ-TERM-002 AC4: raw PTY output reaches clients without JSON wrapping', () => {
  it('forwards a PTY data frame byte-for-byte to an attached OPEN client', () => {
    const session = new Session('sess-5', 'Terminal');
    const ws = createWs();
    // attach() starts the PTY (no ptyProcess yet) and wires onData broadcast.
    session.attach(ws);

    const before = ws.sent.length; // attach may send a restore/process-name frame
    const raw = '\x1b[32mhello\x1b[0m\r\n\x07'; // ANSI + control bytes, NOT JSON
    lastSpawn.pty.emitData(raw);

    assert.equal(ws.sent.length, before + 1, 'exactly one frame emitted for the PTY output');
    const frame = ws.sent[before];
    assert.equal(frame, raw, 'PTY output is delivered verbatim, not re-encoded');
    // It must NOT be a JSON control object — raw binary-clean passthrough.
    assert.equal(frame.startsWith('{'), false, 'raw PTY output is never JSON-wrapped');

    session.kill();
  });

  it('does not push raw PTY data to a CLOSED client', () => {
    const session = new Session('sess-6', 'Terminal');
    const open = createWs(1);   // WebSocket.OPEN
    const closed = createWs(3); // WebSocket.CLOSED
    session.attach(open);
    session.attach(closed);

    const openBefore = open.sent.length;
    const closedBefore = closed.sent.length;
    lastSpawn.pty.emitData('payload-bytes');

    assert.equal(open.sent.length, openBefore + 1, 'open client receives the raw frame');
    assert.equal(closed.sent.length, closedBefore, 'closed client receives nothing');
    assert.equal(open.sent[openBefore], 'payload-bytes');

    session.kill();
  });
});

// ── REQ-TERM-002 AC5: host control messages are JSON with a `type` field ────

describe('REQ-TERM-002 AC5: host-originated control frames are typed JSON', () => {
  it('attach() sends a restore frame as JSON carrying type="restore" once buffer has state', async () => {
    const session = new Session('sess-7', 'Terminal');
    const first = createWs();
    session.attach(first); // spawns PTY, real headless terminal now buffers output

    // Feed real PTY output so the headless serialize addon has state to restore.
    lastSpawn.pty.emitData('echo seeded-output\r\n');

    // @xterm/headless parses writes on its own async write queue, so serialize()
    // only reflects the fed data after that queue drains. Yield a macrotask so
    // the buffer is parsed before the next attach serializes it (also lets the
    // headless write timer settle so the test file exits instead of timing out).
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = createWs();
    session.attach(second);

    // The restore frame is the JSON control message attach() pushes to a newly
    // attached client when serialized buffer state exists.
    const restoreFrames = second.sent
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((m) => m && m.type === 'restore');

    assert.equal(restoreFrames.length, 1, 'a single restore control frame is sent on attach');
    assert.equal(typeof restoreFrames[0].state, 'string',
      'restore frame carries the serialized buffer state as its payload');
    assert.ok(restoreFrames[0].state.length > 0, 'serialized restore state is non-empty');

    session.kill();
  });

  it('process-name control frames are JSON objects with a leading type discriminator', () => {
    const session = new Session('sess-8', 'Terminal');
    const ws = createWs();
    session.attach(ws);

    // Drive a foreground-process change so emitProcessNameIfChanged broadcasts.
    session.lastProcessName = 'bash';
    lastSpawn.pty.process = 'nvim';
    const emitted = session.emitProcessNameIfChanged();

    assert.equal(emitted, true, 'a process-name change is detected and emitted');
    const frames = ws.sent
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((m) => m && m.type === 'process-name');
    assert.equal(frames.length >= 1, true, 'a process-name control frame is sent');
    const last = frames[frames.length - 1];
    assert.equal(last.type, 'process-name', 'frame is identifiable by its type field');
    assert.equal(last.processName, 'nvim', 'frame carries the new foreground process name');
    assert.equal(last.terminalId, 'sess-8', 'frame carries the compound terminal identity');

    session.kill();
  });
});
