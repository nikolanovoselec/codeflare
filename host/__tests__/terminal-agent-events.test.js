import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachTerminalConnectionHandler } from '../dist/terminal-ws.js';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  closes = [];

  send(value) {
    this.sent.push(value);
  }

  ping() {}

  close(code, reason) {
    this.closes.push({ code, reason });
  }
}

function fakeSession(id, acceptedEventIds = new Set()) {
  const clients = new Set();
  const calls = [];
  return {
    id,
    clients,
    calls,
    ptyProcess: { pid: 1 },
    attach(ws) { clients.add(ws); },
    detach(ws) { clients.delete(ws); },
    isPtyAlive() { return true; },
    canResize(ws) { return clients.has(ws); },
    resize(cols, rows) { calls.push({ type: 'resize', cols, rows }); return true; },
    claimResizeAuthority() {},
    write() {},
    kill() {},
    submitAgentEventDisposition(eventId, ws, disposition) {
      calls.push({ type: 'disposition', eventId, ws, disposition });
      return acceptedEventIds.has(eventId);
    },
    confirmAgentEventDisplay(eventId, ws) {
      calls.push({ type: 'displayed', eventId, ws });
      return acceptedEventIds.has(eventId);
    },
  };
}

function harness(sessions, queryHerdrScroll) {
  const wss = new EventEmitter();
  const sessionManager = {
    sessions: new Map(Object.entries(sessions)),
    clients: new Map(),
    getOrCreate(id) { return sessions[id] ?? null; },
  };
  attachTerminalConnectionHandler(wss, {
    sessionManager,
    log() {},
    logWsEvent() {},
    readiness: () => ({ initFlagObserved: true, terminalServiceReady: true }),
    keepalivePingMs: 60_000,
    maxControlMsgLength: 512,
    queryHerdrScroll,
  });
  return { wss, sessionManager };
}

function connect(wss, sessionId) {
  const ws = new FakeSocket();
  wss.emit('connection', ws, { url: `/?session=${encodeURIComponent(sessionId)}` });
  return ws;
}

describe('Herdr scroll probe protocol', () => {
  it('returns focused scroll state and forces the requested same-size repaint', async (t) => {
    const session = fakeSession('session-a-1');
    const { wss } = harness({ 'session-a-1': session }, async () => true);
    const ws = connect(wss, 'session-a-1');
    t.after(() => ws.emit('close', 1000, Buffer.alloc(0)));

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'herdr-scroll-probe', requestId: 3, cols: 80, rows: 24,
    })));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(session.calls, [{ type: 'resize', cols: 80, rows: 24 }]);
    assert.deepEqual(JSON.parse(ws.sent.at(-1)), {
      type: 'herdr-scroll-state', requestId: 3, available: true, aboveBottom: true,
    });
  });

  it('fails open when the client cannot force the repaint', async (t) => {
    const session = fakeSession('session-a-1');
    session.canResize = () => false;
    const { wss } = harness({ 'session-a-1': session }, async () => true);
    const ws = connect(wss, 'session-a-1');
    t.after(() => ws.emit('close', 1000, Buffer.alloc(0)));

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'herdr-scroll-probe', requestId: 4, cols: 80, rows: 24,
    })));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(ws.sent.at(-1)), {
      type: 'herdr-scroll-state', requestId: 4, available: false, aboveBottom: false,
    });
  });
});

describe('REQ-TERM-023 AC2/AC3: terminal WS event coordination protocol', () => {
  it('routes a validated suppress disposition through the connection-bound Session', (t) => {
    const session = fakeSession('session-a-1', new Set(['event-a']));
    const { wss } = harness({ 'session-a-1': session });
    const ws = connect(wss, 'session-a-1');
    t.after(() => ws.emit('close', 1000, Buffer.alloc(0)));

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'agent-event-disposition',
      eventId: 'event-a',
      disposition: 'suppress',
    })));

    assert.deepEqual(session.calls, [{
      type: 'disposition',
      eventId: 'event-a',
      ws,
      disposition: 'suppress',
    }]);
    ws.emit('close', 1000, Buffer.alloc(0));
  });

  it('routes display requests and confirmations without writing either message to the PTY', (t) => {
    const session = fakeSession('session-a-1', new Set(['event-a']));
    const writes = [];
    session.write = (value) => writes.push(value);
    const { wss } = harness({ 'session-a-1': session });
    const ws = connect(wss, 'session-a-1');
    t.after(() => ws.emit('close', 1000, Buffer.alloc(0)));

    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'agent-event-disposition',
      eventId: 'event-a',
      disposition: 'display-request',
    })));
    ws.emit('message', Buffer.from(JSON.stringify({
      type: 'agent-event-displayed',
      eventId: 'event-a',
    })));

    assert.deepEqual(session.calls.map(({ ws: _ws, ...call }) => call), [
      { type: 'disposition', eventId: 'event-a', disposition: 'display-request' },
      { type: 'displayed', eventId: 'event-a' },
    ]);
    assert.deepEqual(writes, []);
    ws.emit('close', 1000, Buffer.alloc(0));
  });

  it('cannot use a socket attached to another Session to affect the originating queue', (t) => {
    const sessionA = fakeSession('session-a-1', new Set(['event-a']));
    const sessionB = fakeSession('session-b-1', new Set(['event-b']));
    const { wss } = harness({ 'session-a-1': sessionA, 'session-b-1': sessionB });
    const socketB = connect(wss, 'session-b-1');
    t.after(() => socketB.emit('close', 1000, Buffer.alloc(0)));

    socketB.emit('message', Buffer.from(JSON.stringify({
      type: 'agent-event-disposition',
      eventId: 'event-a',
      disposition: 'suppress',
    })));

    assert.deepEqual(sessionA.calls, [], 'the originating Session is never looked up globally');
    assert.equal(sessionB.calls.length, 1, 'only the socket-bound Session receives the attempt');
    assert.equal(sessionB.submitAgentEventDisposition('event-a', socketB, 'suppress'), false,
      'that Session rejects the foreign event ID');
    socketB.emit('close', 1000, Buffer.alloc(0));
  });

  it('drops malformed kinds, IDs, and dispositions as control messages rather than PTY input', (t) => {
    const session = fakeSession('session-a-1');
    const writes = [];
    session.write = (value) => writes.push(value);
    const { wss } = harness({ 'session-a-1': session });
    const ws = connect(wss, 'session-a-1');
    t.after(() => ws.emit('close', 1000, Buffer.alloc(0)));

    for (const message of [
      { type: 'agent-event-disposition', eventId: '', disposition: 'suppress' },
      { type: 'agent-event-disposition', eventId: 'event-a', disposition: 'other' },
      { type: 'agent-event-disposition', eventId: 'x'.repeat(200), disposition: 'display-request' },
      { type: 'agent-event-displayed', eventId: 7 },
    ]) {
      ws.emit('message', Buffer.from(JSON.stringify(message)));
    }

    assert.deepEqual(session.calls, []);
    assert.deepEqual(writes, []);
    ws.emit('close', 1000, Buffer.alloc(0));
  });
});
