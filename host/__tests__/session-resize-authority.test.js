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
}

describe('Session resize authority / REQ-TERM-016 visible resize ownership', () => {
  it('REQ-TERM-016: accepts resize frames only from the foreground WebSocket owner', () => {
    const session = new Session('sess-1', 'Terminal');
    const resizeCalls = [];
    attachFakePty(session, resizeCalls);

    const first = createWs();
    const second = createWs();
    try {
      session.attach(first);
      session.attach(second);

      assert.equal(session.canResize(first), true);
      assert.equal(session.canResize(second), false);
      assert.equal(session.canResize(createWs()), false, 'detached clients have no resize authority');
      assert.equal(session.resize(120, 40, second), false, 'background client cannot resize the PTY');
      assert.deepEqual(resizeCalls, [], 'ignored resize sends no PTY resize');

      assert.equal(session.resize(100, 30, first), true, 'first attached client owns resize by default');
      assert.deepEqual(resizeCalls, [{ cols: 100, rows: 30 }]);
      assert.deepEqual({ cols: session.headlessTerminal.cols, rows: session.headlessTerminal.rows }, { cols: 100, rows: 30 });

      session.claimResizeAuthority(second);
      assert.equal(session.resize(90, 25, second), true, 'focused client can claim resize authority');
      assert.equal(session.resize(80, 24, first), false, 'stale first client cannot override focused dimensions');

      session.detach(second);
      assert.equal(session.resize(70, 20, first), true, 'authority falls back to remaining client after focused client detaches');
    } finally {
      session.kill();
    }
  });

  it('REQ-TERM-016: applies a replacement pane resize when authority transfers after overlapping reconnects', () => {
    const session = new Session('sess-1', 'Terminal');
    const resizeCalls = [];
    attachFakePty(session, resizeCalls);

    const oldFullWidthClient = createWs();
    const replacementMultiViewClient = createWs();
    const detachedNonOwner = createWs();
    try {
      session.attach(oldFullWidthClient);
      assert.equal(session.resize(160, 50, oldFullWidthClient), true);

      session.attach(replacementMultiViewClient);
      assert.equal(session.resize(80, 50, replacementMultiViewClient), false,
        'replacement pane cannot steal authority while the old visible client remains attached');
      assert.equal(session.resize(75, 45, replacementMultiViewClient), false,
        'handoff retains the replacement pane latest dimensions');
      assert.equal(session.resize(Number.NaN, 45, replacementMultiViewClient), false,
        'invalid dimensions cannot replace a valid retained handoff size');
      session.attach(detachedNonOwner);
      assert.equal(session.resize(60, 40, detachedNonOwner), false);
      session.detach(detachedNonOwner);
      assert.deepEqual(resizeCalls, [{ cols: 160, rows: 50 }],
        'detaching a non-owner cannot resize the PTY');
      assert.deepEqual({ cols: session.headlessTerminal.cols, rows: session.headlessTerminal.rows }, { cols: 160, rows: 50 });

      session.detach(oldFullWidthClient);

      assert.equal(session.resizeAuthorityClient, replacementMultiViewClient);
      assert.deepEqual(resizeCalls, [
        { cols: 160, rows: 50 },
        { cols: 75, rows: 45 },
      ], 'authority handoff must immediately align the PTY to the replacement pane');
      assert.deepEqual({ cols: session.headlessTerminal.cols, rows: session.headlessTerminal.rows }, { cols: 75, rows: 45 },
        'authority handoff must align reconnect state to the replacement pane');
      assert.equal(session.resize(70, 40, oldFullWidthClient), false,
        'a detached client cannot alter retained handoff dimensions');
      assert.deepEqual(resizeCalls.at(-1), { cols: 75, rows: 45 });
    } finally {
      session.kill();
    }
  });
});
