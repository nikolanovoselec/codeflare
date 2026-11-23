import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPiWebHandoff } from '../src/pi-web-handoff.ts';

const generation = 7;
const binding = Object.freeze({
  id: 'native-conversation',
  cwd: '/home/user/workspace',
  path: '/home/user/.pi/agent/sessions/--home-user-workspace--/native.jsonl',
});

function fixture(initialSurface) {
  let writer = initialSurface;
  let working = 0;
  let question = false;
  let finish;
  let openOutcome = 'started';
  let openingIdle = true;
  const transcript = [];
  const maybeIdle = () => {
    if (!working && !question && openingIdle) finish?.();
  };
  const handoff = createPiWebHandoff({
    generation, initialSurface,
    waitForIdle: async (surface, signal) => {
      assert.equal(writer, surface);
      if (!working && !question && openingIdle) return;
      await new Promise((resolve, reject) => {
        finish = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    release: async (surface) => {
      assert.equal(writer, surface);
      assert.equal(working, 0);
      assert.equal(question, false);
      writer = null;
      return binding;
    },
    open: async (surface, next) => {
      assert.equal(writer, null, 'the outgoing writer must have closed');
      assert.deepEqual(next, binding);
      if (openOutcome === 'not-started') return false;
      writer = surface;
      if (openOutcome === 'unknown') throw new Error('Target started without returning readiness');
      return true;
    },
  });
  return {
    handoff,
    get writer() { return writer; },
    get transcript() { return transcript; },
    startWork(text) {
      assert.equal(handoff.permits(writer, 'work'), true);
      transcript.push(text);
      working++;
    },
    finishWork() { working--; maybeIdle(); },
    ask() { question = true; },
    answer() {
      assert.equal(handoff.permits(writer, 'settle'), true);
      question = false;
      maybeIdle();
    },
    abort() {
      assert.equal(handoff.permits(writer, 'settle'), true);
      working = 0;
      question = false;
      maybeIdle();
    },
    waitForNativeQueue() { openingIdle = false; },
    settleNativeQueue() { openingIdle = true; maybeIdle(); },
    setOpenOutcome(outcome) { openOutcome = outcome; },
  };
}

for (const [source, target] of [['chat', 'terminal'], ['terminal', 'chat']]) {
  test(`REQ-AGENT-272 AC2+AC3: ${source} drains questions and queued work before ${target} owns the transcript`, async () => {
    const f = fixture(source);
    f.startWork('the original question');
    f.startWork('already accepted follow-up');
    f.ask();
    const done = f.handoff.switchTo({ generation, requestId: 'attempt-1', target });
    assert.equal(f.handoff.status().phase, 'waiting');
    assert.equal(f.handoff.permits(source, 'work'), false);
    assert.equal(f.handoff.permits(target, 'work'), false);
    assert.equal(f.handoff.permits(target, 'read'), false);
    f.finishWork();
    f.answer();
    assert.equal(f.writer, source);
    f.finishWork();
    assert.equal((await done).phase, 'complete');
    assert.equal(f.writer, target);
    assert.equal(f.handoff.permits(source, 'read'), false);
    assert.equal(f.handoff.permits(target, 'work'), true);
    assert.deepEqual(f.transcript, ['the original question', 'already accepted follow-up']);
  });
}

async function waitForPhase(handoff, phase) {
  const deadline = Date.now() + 1000;
  while (handoff.status().phase !== phase) {
    assert.ok(Date.now() < deadline, `switch never reached ${phase}`);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('REQ-AGENT-272 AC2+AC5: an admitted web request cannot outlive the writer or let a stale tab reopen it', async () => {
  const f = fixture('chat');
  const finishRequest = f.handoff.admit('chat', 'work');
  assert.ok(finishRequest);
  const done = f.handoff.switchTo({ generation, requestId: 'pending-http', target: 'terminal' });
  await Promise.resolve();
  assert.equal(f.writer, 'chat', 'a request can start work after its HTTP admission');
  assert.equal(f.handoff.admit('chat', 'work'), undefined);
  const finishRead = f.handoff.admit('chat', 'read');
  assert.ok(finishRead);
  finishRequest();
  await waitForPhase(f.handoff, 'releasing');
  assert.equal(f.writer, 'chat', 'a read can reopen the runtime until its response is drained');
  assert.equal(f.handoff.admit('chat', 'read'), undefined);
  finishRead();
  assert.equal((await done).phase, 'complete');
  assert.equal(f.handoff.admit('chat', 'read'), undefined);
  assert.equal(f.writer, 'terminal');
});

test('REQ-AGENT-272 AC2: an empty conversation switches without another prompt', async () => {
  const f = fixture('chat');
  const status = await f.handoff.switchTo({ generation, requestId: 'empty', target: 'terminal' });
  assert.equal(status.phase, 'complete');
  assert.equal(f.writer, 'terminal');
  assert.deepEqual(f.transcript, []);
});

test('REQ-AGENT-272 AC3: cancel switch preserves the source; native abort settles a later switch', async () => {
  const f = fixture('terminal');
  f.startWork('ongoing turn');
  f.waitForNativeQueue();
  const cancelled = f.handoff.switchTo({ generation, requestId: 'cancelled', target: 'chat' });
  assert.equal(f.handoff.cancel({ generation, requestId: 'cancelled' }), true);
  assert.equal((await cancelled).phase, 'cancelled');
  assert.equal(f.writer, 'terminal');
  assert.equal(f.handoff.permits('terminal', 'work'), true);
  const done = f.handoff.switchTo({ generation, requestId: 'aborted-turn', target: 'chat' });
  f.abort();
  assert.equal(f.writer, 'terminal');
  f.settleNativeQueue();
  assert.equal((await done).phase, 'complete');
  assert.equal(f.writer, 'chat');
});

test('REQ-AGENT-272 AC2+AC5: stale attempts and target startup failures never open another writer', async () => {
  const f = fixture('chat');
  await assert.rejects(f.handoff.switchTo({ generation: generation - 1, requestId: 'stale', target: 'terminal' }));
  assert.equal(f.writer, 'chat');
  f.setOpenOutcome('not-started');
  assert.equal((await f.handoff.switchTo({ generation, requestId: 'transfer', target: 'terminal' })).phase, 'failed');
  assert.equal(f.writer, null);
  assert.equal(f.handoff.permits('chat', 'read'), false);
  f.setOpenOutcome('started');
  assert.equal((await f.handoff.switchTo({ generation, requestId: 'transfer', target: 'terminal' })).phase, 'complete');
  assert.equal(f.writer, 'terminal');
});

test('REQ-AGENT-272 AC2: an ambiguous launch rejects new owners until the original launch is resolved', async () => {
  const f = fixture('chat');
  f.setOpenOutcome('unknown');
  const attempt = { generation, requestId: 'lost-response', target: 'terminal' };
  assert.equal((await f.handoff.switchTo(attempt)).phase, 'uncertain');
  assert.equal(f.writer, 'terminal');
  assert.equal(f.handoff.admit('chat', 'read'), undefined);
  assert.equal(f.handoff.admit('terminal', 'work'), undefined);
  await assert.rejects(f.handoff.switchTo({ generation, requestId: 'other-tab', target: 'chat' }));
  assert.equal((await f.handoff.switchTo(attempt)).phase, 'uncertain');
  assert.equal(f.writer, 'terminal');
});
