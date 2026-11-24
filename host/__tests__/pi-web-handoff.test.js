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
  let confirmLateOwner = false;
  let deferRelease = false;
  let stopRequests = 0;
  let parkedInput = false;
  const transcript = [];
  const maybeIdle = () => {
    if (!working && !question && openingIdle) finish?.();
  };
  const handoff = createPiWebHandoff({
    generation, initialSurface,
    stopWork: async (surface) => {
      assert.equal(writer, surface);
      stopRequests++;
      question = false;
      if (!parkedInput) working = 0;
      maybeIdle();
    },
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
      if (deferRelease) {
        deferRelease = false;
        openingIdle = false;
        return undefined;
      }
      writer = null;
      return binding;
    },
    confirmOpen: (surface, next) => confirmLateOwner && writer === surface && next === binding,
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
    get stopRequests() { return stopRequests; },
    parkInputHook() { parkedInput = true; },
    settleInputHook() { parkedInput = false; working = 0; maybeIdle(); },
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
    confirmLateOwner() { confirmLateOwner = true; },
    discoverWorkAtRelease() { deferRelease = true; },
  };
}

for (const [source, target] of [['chat', 'terminal'], ['terminal', 'chat']]) {
  test(`REQ-AGENT-272 AC3: ${source} requests abort before ${target} may open the saved conversation`, async () => {
    const f = fixture(source);
    f.startWork('interrupted prompt already in saved history');
    f.ask();
    f.waitForNativeQueue();
    const done = f.handoff.switchTo({ generation, requestId: 'attempt-1', target });
    assert.equal(f.handoff.permits(source, 'work'), false);
    await waitForPhase(f.handoff, 'stopping');
    assert.equal(f.stopRequests, 1, 'no normal answer is needed to request abort');
    assert.equal(f.writer, source);
    assert.equal(f.handoff.permits(target, 'read'), false);
    f.settleNativeQueue();
    assert.equal((await done).phase, 'complete');
    assert.equal(f.writer, target);
    assert.equal(f.handoff.permits(source, 'read'), false);
    assert.deepEqual(f.transcript, ['interrupted prompt already in saved history'], 'no prompt replay');
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
  assert.equal(f.stopRequests, 0, 'abort must not precede dispatch of admitted work');
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

test('REQ-AGENT-272 AC3: newly observed work at the final release fence keeps the same writer waiting', async () => {
  const f = fixture('chat');
  f.discoverWorkAtRelease();
  const done = f.handoff.switchTo({ generation, requestId: 'held-settler', target: 'terminal' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.handoff.status().phase, 'stopping');
  assert.equal(f.writer, 'chat');
  assert.equal(f.handoff.permits('chat', 'settle'), true);
  assert.equal(f.handoff.permits('chat', 'work'), false);
  f.settleNativeQueue();
  assert.equal((await done).phase, 'complete');
  assert.equal(f.writer, 'terminal');
});

test('REQ-AGENT-272 AC2: an empty conversation switches without another prompt', async () => {
  const f = fixture('chat');
  const status = await f.handoff.switchTo({ generation, requestId: 'empty', target: 'terminal' });
  assert.equal(status.phase, 'complete');
  assert.equal(f.writer, 'terminal');
  assert.deepEqual(f.transcript, []);
});

test('REQ-AGENT-272 AC6: cancellation before abort keeps the turn; after abort it cannot undo the stop', async () => {
  const f = fixture('chat');
  f.startWork('ongoing turn');
  f.parkInputHook();
  const cancelled = f.handoff.switchTo({ generation, requestId: 'cancelled', target: 'terminal' });
  assert.equal(f.handoff.cancel({ generation, requestId: 'cancelled' }), true);
  assert.equal((await cancelled).phase, 'cancelled');
  assert.equal(f.stopRequests, 0);
  assert.equal(f.handoff.permits('chat', 'work'), true);
  const done = f.handoff.switchTo({ generation, requestId: 'held-input', target: 'terminal' });
  await waitForPhase(f.handoff, 'stopping');
  assert.equal(f.stopRequests, 1);
  assert.equal(f.handoff.cancel({ generation, requestId: 'held-input' }), false);
  assert.equal(f.writer, 'chat', 'an acknowledged abort cannot retire a writer with a parked input hook');
  f.settleInputHook();
  assert.equal((await done).phase, 'complete');
  assert.equal(f.writer, 'terminal');
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
  f.confirmLateOwner();
  assert.equal((await f.handoff.switchTo(attempt)).phase, 'complete');
  assert.equal(f.handoff.permits('terminal', 'work'), true);
  assert.equal(f.handoff.permits('chat', 'read'), false);
});

test('REQ-AGENT-272: timeout of the initial Chat writer exposes only the verified same-transcript retry', async () => {
  const opened = [];
  const handoff = createPiWebHandoff({
    generation, initialSurface: 'chat',
    stopWork: async () => { assert.fail('initial Chat has no outgoing writer'); },
    waitForIdle: async () => { assert.fail('initial Chat has no outgoing writer'); },
    release: async () => { assert.fail('initial Chat has no outgoing writer'); },
    open: async (surface, transcript) => {
      opened.push({ surface, transcript });
      return opened.length > 1;
    },
  });
  const requestId = 'first-chat';
  assert.equal((await handoff.openInitialChat(requestId, binding)).phase, 'failed');
  assert.equal(handoff.admit('chat', 'work'), undefined);
  await assert.rejects(handoff.switchTo({ generation, requestId: 'other', target: 'terminal' }));
  assert.equal((await handoff.switchTo({ generation, requestId, target: 'chat' })).phase, 'complete');
  assert.deepEqual(opened, [{ surface: 'chat', transcript: binding }, { surface: 'chat', transcript: binding }]);
});

test('REQ-AGENT-272: an unconfirmed Chat startup retirement cannot dispatch another writer', async () => {
  const f = fixture('terminal');
  f.setOpenOutcome('unknown');
  const attempt = { generation, requestId: 'unknown-chat', target: 'chat' };
  assert.equal((await f.handoff.switchTo(attempt)).phase, 'uncertain');
  assert.equal(f.writer, 'chat');
  assert.equal(f.handoff.admit('chat', 'read'), undefined);
  await assert.rejects(f.handoff.switchTo({ generation, requestId: 'different', target: 'terminal' }));
  assert.equal((await f.handoff.switchTo(attempt)).phase, 'uncertain');
  assert.equal(f.writer, 'chat');
});

test('REQ-AGENT-273: only an explicit native re-entry can request a new Terminal grant', async () => {
  const f = fixture('terminal');
  const request = { generation, target: 'terminal', requestId: 'native-reentry' };
  assert.equal((await f.handoff.switchTo(request)).phase, 'active');
  assert.equal(f.stopRequests, 0, 'an ordinary same-surface switch does not relaunch Pi');
  assert.equal((await f.handoff.switchTo(request, true)).phase, 'complete');
  assert.equal(f.stopRequests, 1, 'explicit restart goes through the existing release fence');
  assert.equal(f.writer, 'terminal');
});

test('REQ-AGENT-273: a safely revoked native re-entry leaves Terminal selected', async () => {
  const f = fixture('terminal');
  f.setOpenOutcome('not-started');
  const result = await f.handoff.switchTo({ generation, target: 'terminal', requestId: 'interrupted' }, true);
  assert.deepEqual(result, { phase: 'active', surface: 'terminal' });
  assert.equal(f.writer, null);
  assert.equal(f.handoff.admit('chat', 'work'), undefined);
});

test('REQ-AGENT-273: a possibly consumed native re-entry remains fenced', async () => {
  const f = fixture('terminal');
  f.setOpenOutcome('unknown');
  const result = await f.handoff.switchTo({ generation, target: 'terminal', requestId: 'unconfirmed' }, true);
  assert.equal(result.phase, 'uncertain');
  await assert.rejects(f.handoff.switchTo({ generation, target: 'chat', requestId: 'different' }));
  assert.equal(f.handoff.admit('chat', 'work'), undefined);
  assert.equal(f.writer, 'terminal');
});
