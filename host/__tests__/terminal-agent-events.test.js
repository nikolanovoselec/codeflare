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

function harness(sessions, readiness = () => ({ initFlagObserved: true, terminalServiceReady: true })) {
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
    readiness,
    keepalivePingMs: 60_000,
    maxControlMsgLength: 512,
  });
  return { wss, sessionManager };
}

function connect(wss, sessionId) {
  const ws = new FakeSocket();
  wss.emit('connection', ws, { url: `/?session=${encodeURIComponent(sessionId)}` });
  return ws;
}

describe('REQ-TERM-023 AC2/AC3: terminal WS event coordination protocol', () => {
  it('REQ-SESSION-015 AC4: rejects an unregistered prewarm with 1013 then accepts after registration', t => {
    const session = fakeSession('session-a-1');
    const sessions = {};
    const { wss, sessionManager } = harness(sessions, () => ({
      initFlagObserved: true,
      terminalServiceReady: sessionManager.sessions.has(session.id),
    }));
    const warming = connect(wss, session.id);
    assert.deepEqual(warming.closes, [{ code: 1013, reason: 'container-warming-up' }]);
    assert.equal(session.clients.has(warming), false);
    assert.deepEqual(warming.sent, []);

    sessions[session.id] = session;
    sessionManager.sessions.set(session.id, session);
    const accepted = connect(wss, session.id);
    t.after(() => accepted.emit('close', 1000, Buffer.alloc(0)));
    assert.deepEqual(accepted.closes, []);
    assert.equal(session.clients.has(accepted), true);
    const writes = [];
    session.write = value => writes.push(value);
    accepted.emit('message', Buffer.from('registered terminal input\r'));
    assert.deepEqual(writes, ['registered terminal input\r']);
    assert.equal(session.clients.has(warming), false);
  });
  it('REQ-TERM-019 AC2: unknown typed JSON is dropped while terminal input reaches the bound Session', t => {
    const session = fakeSession('session-a-1');
    const writes = [];
    session.write = value => writes.push(value);
    const { wss } = harness({ 'session-a-1': session });
    const ws = connect(wss, 'session-a-1');
    t.after(() => ws.emit('close', 1000, Buffer.alloc(0)));
    for (const type of ['unknown-control', 'ping', 'heartbeat']) {
      ws.emit('message', Buffer.from(JSON.stringify({ type, data: 'must not reach PTY' })));
    }
    assert.deepEqual(writes, []);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'data', data: 'typed command\r' })));
    ws.emit('message', Buffer.from('raw command\r'));
    assert.deepEqual(writes, ['typed command\r', 'raw command\r']);
  });

  it('REQ-TERM-019 AC3: keepalive emits protocol pings without application JSON heartbeat', t => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1000 });
    const session = fakeSession('session-a-1');
    const { wss } = harness({ 'session-a-1': session });
    const ws = connect(wss, 'session-a-1');
    t.after(() => ws.emit('close', 1000, Buffer.alloc(0)));
    const pings = [];
    ws.ping = () => pings.push(Date.now());
    t.mock.timers.tick(60_000);
    ws.emit('pong');
    t.mock.timers.tick(60_000);
    assert.deepEqual(pings, [61_000, 121_000]);
    assert.deepEqual(ws.sent, []);
    assert.deepEqual(ws.closes, []);
  });

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
