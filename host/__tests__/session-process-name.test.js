// Real behavioral tests for:
//   REQ-TERM-009 AC1 — the host emits a process-name control message over the
//     WebSocket only when the foreground process name CHANGES (not every poll).
//   REQ-TERM-006 AC3 — the session exposes MANUAL_TAB to the PTY environment
//     when (and only when) the tab is manual.
//
// These replace the source-string-matching audit (terminal-process-name.test.ts)
// for the host side. We import the compiled Session and exercise the real
// methods against a fake PTY + fake WebSocket clients (same harness shape as
// session-resize-authority.test.js), with no real PTY spawned.
//
// AC1 behaviour is the per-tick body of the process-name interval, extracted
// into Session.emitProcessNameIfChanged() so the change-detection + broadcast
// can be driven directly. AC3 env exposure is Session.buildPtyEnv(), extracted
// from start() so the manual-flag branch is observable without spawning.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { Session } = await import('../dist/session.js');

function createWs(readyState = 1) {
  return {
    readyState,
    sent: [],
    send(data) { this.sent.push(data); },
    close() {},
  };
}

// Attach a fake PTY whose foreground process name is mutable so we can drive
// resolveProcessName() (and thus emitProcessNameIfChanged()) deterministically.
function attachFakePty(session, processName) {
  session.ptyProcess = {
    pid: 123,
    process: processName,
    resize() {},
    write() {},
    kill() {},
  };
}

describe('Session process-name emit / REQ-TERM-009 AC1 (emit only on change)', () => {
  it('emits exactly one process-name control message when the name changes', () => {
    const session = new Session('sess-1', 'Terminal');
    attachFakePty(session, 'bash');
    session.lastProcessName = session.resolveProcessName(); // baseline = "bash"

    const ws = createWs();
    session.clients.add(ws);

    // Foreground process changes bash -> claude.
    session.ptyProcess.process = 'claude';
    const emitted = session.emitProcessNameIfChanged();

    assert.equal(emitted, true, 'change should be detected and emitted');
    assert.equal(ws.sent.length, 1, 'exactly one frame sent on change');
    const msg = JSON.parse(ws.sent[0]);
    assert.deepEqual(msg, { type: 'process-name', terminalId: 'sess-1', processName: 'claude' });
    assert.equal(session.lastProcessName, 'claude', 'lastProcessName advances to the new value');
  });

  it('does NOT emit when the foreground process name is unchanged across polls', () => {
    const session = new Session('sess-1', 'Terminal');
    attachFakePty(session, 'claude');
    session.lastProcessName = session.resolveProcessName(); // baseline = "claude"

    const ws = createWs();
    session.clients.add(ws);

    // Poll twice with the SAME process name — must stay silent both times.
    const first = session.emitProcessNameIfChanged();
    const second = session.emitProcessNameIfChanged();

    assert.equal(first, false);
    assert.equal(second, false);
    assert.equal(ws.sent.length, 0, 'no frames sent when name is unchanged');
  });

  it('emits to OPEN clients only, skipping a closed client', () => {
    const session = new Session('sess-1', 'Terminal');
    attachFakePty(session, 'bash');
    session.lastProcessName = 'bash';

    const open = createWs(1);   // WebSocket.OPEN
    const closed = createWs(3); // WebSocket.CLOSED
    session.clients.add(open);
    session.clients.add(closed);

    session.ptyProcess.process = 'nvim';
    session.emitProcessNameIfChanged();

    assert.equal(open.sent.length, 1, 'open client receives the update');
    assert.equal(closed.sent.length, 0, 'closed client is skipped');
    assert.equal(JSON.parse(open.sent[0]).processName, 'nvim');
  });

  it('emits null processName when the PTY exits (process becomes unresolvable)', () => {
    const session = new Session('sess-1', 'Terminal');
    attachFakePty(session, 'claude');
    session.lastProcessName = 'claude';

    const ws = createWs();
    session.clients.add(ws);

    // PTY gone -> resolveProcessName() returns null, which differs from "claude".
    session.ptyProcess = null;
    const emitted = session.emitProcessNameIfChanged();

    assert.equal(emitted, true);
    assert.equal(ws.sent.length, 1);
    assert.deepEqual(JSON.parse(ws.sent[0]), {
      type: 'process-name', terminalId: 'sess-1', processName: null,
    });
  });
});

describe('Session PTY env / REQ-TERM-006 AC3 (MANUAL_TAB exposure)', () => {
  it('a manual session exposes MANUAL_TAB=1 in the PTY env', () => {
    const manualSession = new Session('sess-2', 'Terminal', true);
    const env = manualSession.buildPtyEnv('2');
    assert.equal(env.MANUAL_TAB, '1');
  });

  it('a non-manual session does NOT define MANUAL_TAB at all', () => {
    const autoSession = new Session('sess-3', 'Terminal', false);
    const env = autoSession.buildPtyEnv('1');
    assert.equal('MANUAL_TAB' in env, false, 'MANUAL_TAB must be absent, not empty, for agent tabs');
  });

  it('the manual flag defaults to false when the constructor arg is omitted', () => {
    const defaultSession = new Session('sess-4', 'Terminal');
    const env = defaultSession.buildPtyEnv('1');
    assert.equal('MANUAL_TAB' in env, false);
  });

  it('TERMINAL_ID is set to the supplied id regardless of manual flag', () => {
    const manualEnv = new Session('sess-5', 'Terminal', true).buildPtyEnv('5');
    const autoEnv = new Session('sess-6', 'Terminal', false).buildPtyEnv('6');
    assert.equal(manualEnv.TERMINAL_ID, '5');
    assert.equal(autoEnv.TERMINAL_ID, '6');
  });
});
