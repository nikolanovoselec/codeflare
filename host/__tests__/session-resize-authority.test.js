import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { Session } = await import('../dist/session.js');

function createWs() {
  return {
    readyState: 1,
    sent: [],
    send(data) { this.sent.push(data); },
    close() {},
  };
}

function attachFakePty(session, resizeCalls) {
  session.ptyProcess = {
    pid: 123,
    process: 'bash',
    resize(cols, rows) { resizeCalls.push({ cols, rows }); },
    write() {},
    kill() {},
  };
  session.headlessTerminal.resize = (cols, rows) => resizeCalls.push({ cols, rows, headless: true });
}

describe('Session resize authority / REQ-TERM-014 visible resize ownership', () => {
  it('REQ-TERM-014: accepts resize frames only from the foreground WebSocket owner', () => {
    const session = new Session('sess-1', 'Terminal');
    const resizeCalls = [];
    attachFakePty(session, resizeCalls);

    const first = createWs();
    const second = createWs();
    session.attach(first);
    session.attach(second);

    assert.equal(session.resize(120, 40, second), false, 'background client cannot resize the PTY');
    assert.deepEqual(resizeCalls, [], 'ignored resize sends no PTY or headless resize');

    assert.equal(session.resize(100, 30, first), true, 'first attached client owns resize by default');
    assert.deepEqual(resizeCalls, [{ cols: 100, rows: 30 }, { cols: 100, rows: 30, headless: true }]);

    session.claimResizeAuthority(second);
    assert.equal(session.resize(90, 25, second), true, 'focused client can claim resize authority');
    assert.equal(session.resize(80, 24, first), false, 'stale first client cannot override focused dimensions');

    session.detach(second);
    assert.equal(session.resize(70, 20, first), true, 'authority falls back to remaining client after focused client detaches');

    session.kill();
  });
});
