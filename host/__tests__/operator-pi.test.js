/**
 * REQ-OPERATOR-021 structured Pi behavior through injected SDK sessions. These
 * tests use no model calls: they pin ownership, persistence, reconciliation,
 * queue bounds, event cursors and cancellation without replacing PTY coverage.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { OperatorPiConversation } from '../dist/operator-pi.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(overrides = {}) {
  let listener = () => {};
  let streaming = false;
  const run = deferred();
  const calls = { prompt: [], tool: [], followUp: [], steer: [], abort: 0, opened: [] };
  const session = {
    sessionId: 'conversation-1', sessionFile: '/owned/session.jsonl',
    get isStreaming() { return streaming; },
    async prompt(text) { calls.prompt.push(text); streaming = true; await run.promise; streaming = false; },
    async executeTool(input) { calls.tool.push(input); },
    async followUp(text) { calls.followUp.push(text); },
    async steer(text) { calls.steer.push(text); },
    async abort() { calls.abort += 1; run.resolve(); },
    subscribe(next) { listener = next; return () => { listener = () => {}; }; },
    dispose() {},
    ...overrides.session,
  };
  let saved = overrides.saved ?? null;
  const store = { async load() { return saved; }, async save(value) { saved = structuredClone(value); } };
  const factory = { async create() { return session; }, async open(file) { calls.opened.push(file); return session; } };
  const adapter = new OperatorPiConversation({ activityId: 'activity-1', sessionId: 'session-1', store, factory });
  return { adapter, session, calls, run, emit: event => listener(event), saved: () => saved };
}

test('REQ-OPERATOR-021: creates once, persists exact identity and reopens only the recorded file', async () => {
  const first = fixture();
  assert.deepEqual(await first.adapter.ensure(), { conversationId: 'conversation-1', sessionFile: '/owned/session.jsonl' });
  assert.equal(first.saved().activityId, 'activity-1');
  const second = fixture({ saved: first.saved() });
  assert.deepEqual(await second.adapter.ensure(), { conversationId: 'conversation-1', sessionFile: '/owned/session.jsonl' });
  assert.deepEqual(second.calls.opened, ['/owned/session.jsonl']);

  const wrong = fixture({ saved: first.saved(), session: { sessionId: 'replacement', sessionFile: '/owned/session.jsonl' } });
  await assert.rejects(wrong.adapter.ensure(), /conversation.*lost/i);
  assert.deepEqual(wrong.calls.prompt, []);
});

test('REQ-OPERATOR-021: persists task intent before prompt and reconciles same ID without resubmission', async () => {
  const f = fixture();
  await f.adapter.ensure();
  assert.deepEqual(await f.adapter.send({ taskId: 'task-1', digest: 'a'.repeat(64), text: 'do work', mode: 'prompt' }), { status: 'running' });
  assert.equal(f.saved().tasks['task-1'].status, 'running');
  assert.deepEqual(f.calls.prompt, ['do work']);
  assert.deepEqual(await f.adapter.send({ taskId: 'task-1', digest: 'a'.repeat(64), text: 'do work', mode: 'prompt' }), { status: 'running' });
  assert.deepEqual(f.calls.prompt, ['do work']);
  await assert.rejects(f.adapter.send({ taskId: 'task-1', digest: 'b'.repeat(64), text: 'different', mode: 'prompt' }), /conflict/i);
  f.run.resolve();
});

test('REQ-OPERATOR-021: persists and executes an approved native Pi tool task without prompting the model', async () => {
  const f = fixture();
  await f.adapter.ensure();
  assert.deepEqual(await f.adapter.send({ taskId: 'tool-1', digest: 'f'.repeat(64), mode: 'tool',
    toolName: 'write', arguments: { path: '/owned/output.txt', content: 'expected' } }), { status: 'running' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.tool.map(call => ({ ...call, signal: Boolean(call.signal) })), [{
    toolCallId: 'tool-1', name: 'write', arguments: { path: '/owned/output.txt', content: 'expected' }, signal: true,
  }]);
  assert.deepEqual(f.calls.prompt, []);
  assert.equal(f.saved().tasks['tool-1'].status, 'completed');
  assert.deepEqual(await f.adapter.send({ taskId: 'tool-1', digest: 'f'.repeat(64), mode: 'tool',
    toolName: 'write', arguments: { path: '/owned/output.txt', content: 'expected' } }), { status: 'completed' });
  assert.equal(f.calls.tool.length, 1);
});

test('REQ-OPERATOR-021: permits one queued follow-up and one steering message while active', async () => {
  const f = fixture();
  await f.adapter.ensure();
  await f.adapter.send({ taskId: 'task-1', digest: 'a'.repeat(64), text: 'start', mode: 'prompt' });
  assert.deepEqual(await f.adapter.send({ taskId: 'follow-1', digest: 'b'.repeat(64), text: 'next', mode: 'follow-up' }), { status: 'queued' });
  assert.deepEqual(await f.adapter.send({ taskId: 'steer-1', digest: 'c'.repeat(64), text: 'adjust', mode: 'steer' }), { status: 'accepted' });
  await assert.rejects(f.adapter.send({ taskId: 'follow-2', digest: 'd'.repeat(64), text: 'too much', mode: 'follow-up' }), /queue.*full/i);
  await assert.rejects(f.adapter.send({ taskId: 'steer-2', digest: 'e'.repeat(64), text: 'too much', mode: 'steer' }), /steering.*pending/i);
  assert.deepEqual(f.calls.followUp, ['next']);
  assert.deepEqual(f.calls.steer, ['adjust']);
  f.run.resolve();
});

test('REQ-OPERATOR-021: exposes bounded sequenced events with explicit cursor gaps', async () => {
  const f = fixture();
  await f.adapter.ensure();
  for (let i = 0; i < 1030; i += 1) f.emit({ type: 'message_update', value: i });
  const page = f.adapter.observe(0);
  assert.equal(page.events.length <= 100, true);
  assert.equal(page.gap, true);
  assert.equal(page.events[0].sequence > 1, true);
  const next = f.adapter.observe(page.nextCursor);
  assert.equal(next.events.every((entry, index) => index === 0 || entry.sequence > next.events[index - 1].sequence), true);
});

test('REQ-OPERATOR-021: awaits SDK abort and records cancellation without claiming a fresh prompt', async () => {
  const f = fixture();
  await f.adapter.ensure();
  await f.adapter.send({ taskId: 'task-1', digest: 'a'.repeat(64), text: 'start', mode: 'prompt' });
  assert.deepEqual(await f.adapter.abort('task-1'), { status: 'cancelled' });
  assert.equal(f.calls.abort, 1);
  assert.equal(f.saved().tasks['task-1'].status, 'cancelled');
  assert.deepEqual(f.calls.prompt, ['start']);
});
