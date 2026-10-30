import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
let emitOutput;
const writes = [];
mock.module('node-pty', { defaultExport: { spawn: () => ({
  pid: 4242, process: 'pi', write: text => writes.push(text), resize() {}, kill() {},
  onData: fn => { emitOutput = fn; }, onExit() {},
}) } });
const { Session } = await import('../dist/session.js');
const { createActivityTracker } = await import('../dist/activity-tracker.js');
const { AGENT_EVENT_FRAMES } = await import('../dist/agent-events.js');
class Socket extends EventEmitter {
  readyState = 1; sent = [];
  send(text) { this.sent.push(text); }
  close() { this.readyState = 3; this.emit('close'); }
}

describe('REQ-AGENT-224 / REQ-SESSION-002/004/005 / REQ-TERM-023/024/028/031 primary notification-only consumers', () => {
  it('shares terminal/Chat cancellation while keeping PTY bytes and resize ownership terminal-only', () => {
    writes.length = 0;
    const tracker = createActivityTracker();
    const session = new Session('cf-1', 'Primary', false, { activityTracker: tracker });
    const terminal = new Socket(); const chat = new Socket();
    try {
      session.attach(terminal);
      const unregister = session.registerAgentEventClient(chat, () => true);
      emitOutput('terminal bytes');
      assert.ok(terminal.sent.includes('terminal bytes'));
      assert.deepEqual(chat.sent, []);
      assert.deepEqual([...session.clients], [terminal]);
      assert.equal(session.canResize(chat), false);
      assert.equal(session.resize(120, 30, chat), false);
      assert.equal(session.resizeAuthorityClient, terminal);
      session.enqueueAgentEvent('task-completed');
      const event = JSON.parse(chat.sent.at(-1));
      assert.equal(event.type, 'agent-event');
      assert.equal(session.submitAgentEventDisposition(event.eventId, chat, 'display-request'), true);
      assert.equal(session.confirmAgentEventDisplay(event.eventId, chat), false, 'terminal has not submitted its disposition yet');
      assert.equal(session.submitAgentEventDisposition(event.eventId, terminal, 'suppress'), true);
      assert.equal(JSON.parse(chat.sent.at(-1)).type, 'agent-event-cancelled');
      assert.equal(tracker.getActivityInfo().lastInputAt, null);
      emitOutput(AGENT_EVENT_FRAMES.piInputRequired);
      assert.ok(terminal.sent.includes(AGENT_EVENT_FRAMES.piInputRequired), 'the fixed producer frame remains byte-for-byte terminal output');
      assert.equal(JSON.parse(chat.sent.at(-1)).kind, 'input-required');
      session.recordHumanActivity();
      assert.ok(tracker.getActivityInfo().lastInputAt > 0);
      assert.deepEqual(writes, [], 'manual Chat activity must not synthesize terminal input');
      assert.deepEqual(session.drainAgentEvents({ ackEventIds: [], final: true }).events, []);
      unregister();
      assert.equal(session.submitAgentEventDisposition(event.eventId, chat, 'suppress'), false);
    } finally { session.kill(); }
  });

  it('reconciles pending events without a terminal wake; stale/disconnected consumers cannot act', () => {
    const session = new Session('cf-1'); const foreign = new Session('other-1');
    const chat = new Socket(); let bound = true;
    try {
      session.enqueueAgentEvent('task-failed');
      const unregister = session.registerAgentEventClient(chat, () => bound);
      const event = JSON.parse(chat.sent.at(-1));
      assert.equal(event.type, 'agent-event');
      assert.equal(session.ptyProcess, null); assert.equal(session.clients.size, 0);
      assert.equal(session.resizeAuthorityClient, null);
      assert.equal(foreign.submitAgentEventDisposition(event.eventId, chat, 'suppress'), false);
      bound = false;
      assert.equal(session.submitAgentEventDisposition(event.eventId, chat, 'suppress'), false);
      assert.equal(session.confirmAgentEventDisplay(event.eventId, chat), false);
      const before = [...chat.sent]; session.cancelAgentEvents('task-failed');
      assert.deepEqual(chat.sent, before, 'even cancellations recheck binding before delivery');
      bound = true; unregister(); unregister();
      assert.equal(session.submitAgentEventDisposition(event.eventId, chat, 'suppress'), false);
    } finally { session.headlessTerminal.dispose(); foreign.headlessTerminal.dispose(); }
  });
});
