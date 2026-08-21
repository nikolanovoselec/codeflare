import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_EVENT_FRAMES,
  AGENT_EVENT_LIMITS,
  AgentEventQueue,
  OscAgentEventParser,
} from '../dist/agent-events.js';

function client(name) {
  return Object.freeze({ name });
}

function queueAt(start = 1_700_000_000_000) {
  let now = start;
  let id = 0;
  const queue = new AgentEventQueue({
    now: () => now,
    createEventId: () => `event-${++id}`,
  });
  return {
    queue,
    now: () => now,
    advanceBy(ms) {
      now += ms;
      return queue.advance(now);
    },
  };
}

function eventActions(result, type) {
  return result.actions.filter((action) => action.type === type);
}

describe('REQ-TERM-023 AC1 / H1: bounded stream-safe OSC 777 parser', () => {
  it('emits one event when an exact frame is split across arbitrary chunks', () => {
    const parser = new OscAgentEventParser();
    const frame = AGENT_EVENT_FRAMES.piInputRequired;
    const cutA = Math.floor(frame.length / 3);
    const cutB = Math.floor(frame.length * 2 / 3);

    assert.deepEqual(parser.push(frame.slice(0, cutA)), []);
    assert.deepEqual(parser.push(frame.slice(cutA, cutB)), []);
    assert.deepEqual(parser.push(frame.slice(cutB)), ['input-required']);
  });

  it('maps only reviewed Pi and Claude frames and ignores every near-match', () => {
    const parser = new OscAgentEventParser();
    const frames = [
      [AGENT_EVENT_FRAMES.piInputRequired, 'input-required'],
      [AGENT_EVENT_FRAMES.piTaskCompleted, 'task-completed'],
      [AGENT_EVENT_FRAMES.piTaskFailed, 'task-failed'],
      [AGENT_EVENT_FRAMES.claudeInputRequired, 'input-required'],
    ];
    for (const [frame, kind] of frames) {
      assert.deepEqual(parser.push(frame), [kind]);
    }

    for (const frame of [
      '\x1b]777;notify;Claude Code;Claude is waiting for your input\x07',
      '\x1b]777;notify;Claude Code;Claude needs your permission!\x07',
      '\x1b]777;notify;Pi;Agent needs your input and here is prose\x07',
      '\x1b]777;notify;Other;Agent needs your input\x07',
      '\x1b]777;notify;Pi;Agent needs your input',
    ]) {
      assert.deepEqual(parser.push(frame), [], frame);
    }
  });

  it('drops malformed and oversized frames, recovers, and never returns terminal bytes', () => {
    const parser = new OscAgentEventParser();
    assert.deepEqual(parser.push('ordinary terminal output'), []);
    assert.deepEqual(parser.push('\x1b]777;notify;Pi\x07'), []);
    assert.deepEqual(parser.push(`\x1b]777;${'x'.repeat(AGENT_EVENT_LIMITS.maxFrameBytes + 1)}\x07`), []);
    assert.deepEqual(parser.push(AGENT_EVENT_FRAMES.piInputRequired), ['input-required']);
  });
});

describe('REQ-TERM-023 AC2-AC4 / H2-H3: global client coordination', () => {
  it('makes a zero-client event eligible immediately and re-offers it until acknowledged', () => {
    const { queue } = queueAt();
    const created = queue.enqueue('input-required', []);
    assert.equal(created.event.state, 'eligible');

    const first = queue.drain({ ackEventIds: [] });
    assert.deepEqual(first.events.map((event) => event.eventId), ['event-1']);
    assert.equal(queue.get('event-1').state, 'drained');

    const second = queue.drain({ ackEventIds: [] });
    assert.deepEqual(second.events.map((event) => event.eventId), ['event-1']);

    const cleared = queue.drain({ ackEventIds: ['event-1'] });
    assert.deepEqual(cleared.events, []);
    assert.equal(queue.get('event-1'), undefined);
  });

  it('lets one active client suppress every device before any display grant', () => {
    const { queue } = queueAt();
    const laptop = client('laptop-active');
    const phone = client('phone-away');
    const created = queue.enqueue('input-required', [laptop, phone]);
    assert.equal(created.event.state, 'pending');

    const away = queue.submitDisposition('event-1', phone, 'display-request');
    assert.deepEqual(eventActions(away, 'grant-display'), []);

    const suppressed = queue.submitDisposition('event-1', laptop, 'suppress');
    assert.equal(queue.get('event-1').state, 'cancelled');
    assert.equal(eventActions(suppressed, 'cancel-display').length, 1);
    assert.deepEqual(queue.drain({ ackEventIds: [] }).events, []);
  });

  it('grants exactly one display only after every snapshotted client reports away', () => {
    const { queue } = queueAt();
    const first = client('first-away');
    const second = client('second-away');
    queue.enqueue('task-completed', [first, second]);

    assert.deepEqual(
      eventActions(queue.submitDisposition('event-1', first, 'display-request'), 'grant-display'),
      [],
    );
    const resolved = queue.submitDisposition('event-1', second, 'display-request');
    const grants = eventActions(resolved, 'grant-display');
    assert.equal(grants.length, 1);
    assert.equal(grants[0].client, first);
    assert.equal(queue.get('event-1').state, 'awaiting-display-confirmation');

    const confirmed = queue.confirmDisplay('event-1', first);
    assert.equal(confirmed.accepted, true);
    assert.equal(queue.get('event-1').state, 'cancelled');
    assert.deepEqual(queue.drain({ ackEventIds: [] }).events, []);
  });

  it('rejects a disposition or confirmation from a foreign connection', () => {
    const { queue } = queueAt();
    const attached = client('attached');
    const foreign = client('foreign-session');
    queue.enqueue('input-required', [attached]);

    assert.equal(queue.submitDisposition('event-1', foreign, 'suppress').accepted, false);
    assert.equal(queue.submitDisposition('event-1', foreign, 'display-request').accepted, false);
    assert.equal(queue.confirmDisplay('event-1', foreign).accepted, false);
    assert.equal(queue.get('event-1').state, 'pending');
  });

  it('makes an unprocessed event eligible after the disposition window', () => {
    const { queue, advanceBy } = queueAt();
    queue.enqueue('input-required', [client('unresponsive')]);
    advanceBy(AGENT_EVENT_LIMITS.clientDispositionWindowMs + 1);
    assert.equal(queue.get('event-1').state, 'eligible');
  });

  it('makes an unconfirmed granted display eligible after its confirmation window', () => {
    const { queue, advanceBy } = queueAt();
    const away = client('away');
    queue.enqueue('input-required', [away]);
    queue.submitDisposition('event-1', away, 'display-request');
    assert.equal(queue.get('event-1').state, 'awaiting-display-confirmation');
    advanceBy(AGENT_EVENT_LIMITS.displayConfirmationWindowMs + 1);
    assert.equal(queue.get('event-1').state, 'eligible');
  });
});

describe('REQ-TERM-023 AC10 / H4 and queue lifecycle bounds', () => {
  it('attach or classified input cancels pending, eligible, and drained-unacknowledged events', () => {
    const { queue } = queueAt();
    const attached = client('attached');
    queue.enqueue('input-required', [attached]);
    queue.enqueue('task-completed', []);
    queue.drain({ ackEventIds: [] });

    const cancelled = queue.cancelForPresence();
    assert.equal(cancelled.cancelledCount, 2);
    assert.deepEqual(queue.drain({ ackEventIds: [] }).events, []);
  });

  it('drops the oldest event at the per-session cap and records the drop', () => {
    const { queue } = queueAt();
    for (let i = 0; i < AGENT_EVENT_LIMITS.queueMax + 1; i++) {
      queue.enqueue('input-required', []);
    }
    assert.equal(queue.size, AGENT_EVENT_LIMITS.queueMax);
    assert.equal(queue.droppedCount, 1);
    assert.equal(queue.get('event-1'), undefined);
    assert.notEqual(queue.get(`event-${AGENT_EVENT_LIMITS.queueMax + 1}`), undefined);
  });

  it('expires events older than the maximum age', () => {
    const { queue, advanceBy } = queueAt();
    queue.enqueue('input-required', []);
    advanceBy(AGENT_EVENT_LIMITS.eventMaxAgeMs + 1);
    assert.equal(queue.get('event-1'), undefined);
    assert.deepEqual(queue.drain({ ackEventIds: [] }).events, []);
  });

  it('caps one drain and preserves the remainder for the next drain', () => {
    const { queue } = queueAt();
    for (let i = 0; i < AGENT_EVENT_LIMITS.drainMax + 2; i++) {
      queue.enqueue('input-required', []);
    }
    const first = queue.drain({ ackEventIds: [] });
    assert.equal(first.events.length, AGENT_EVENT_LIMITS.drainMax);
    const second = queue.drain({ ackEventIds: first.events.map((event) => event.eventId) });
    assert.equal(second.events.length, 2);
  });

  it('final drain atomically promotes pending and awaiting-confirmation events', () => {
    const { queue, now } = queueAt();
    const pendingClient = client('pending');
    const grantedClient = client('granted');
    queue.enqueue('input-required', [pendingClient]);
    queue.enqueue('task-completed', [grantedClient]);
    queue.submitDisposition('event-2', grantedClient, 'display-request');

    const drained = queue.drain({ ackEventIds: [], final: true });
    assert.equal(drained.hostNow, now());
    assert.deepEqual(
      drained.events.map((event) => event.eventId).sort(),
      ['event-1', 'event-2'],
    );
  });
});
