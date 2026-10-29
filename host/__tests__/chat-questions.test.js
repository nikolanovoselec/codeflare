import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import primaryQuestions from '../../image/chat/primary-questions.mjs';

// Intentional public contracts: RPIV's documented JSON event channels, Pi's
// lifecycle/tool hooks, and Dashboard's documented request/adapter callbacks.
// No imported widget, provider implementation or SDK internals are exercised.
const promptChannel = 'rpiv:ask-user:prompt';
const blockedChannel = 'rpiv:ask-user:blocked';
const answerChannel = 'rpiv:ask-user:answer';
const verdictChannel = 'rpiv:ask-user:answer-result';
const timeoutKey = 'PI_EXT_PI_DASHBOARD_ASK_USER_PROMPT_TIMEOUT_SECONDS';
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const questions = [
  { header: 'Direction', question: 'Which direction?', options: [
    { label: 'North (Recommended)', description: 'Use the northern path', preview: '```text\nN\n|\nS\n```' },
    { label: 'Cancel', description: 'An authored answer, not a cancellation control' },
  ] },
  { header: 'Features', question: 'Which features?', multiSelect: true, options: [
    { label: 'Other', description: 'An authored choice, not a freeform sentinel' },
    { label: 'Logs', description: 'Include logs' },
  ] },
];
const answer = () => JSON.stringify([
  { value: '0', codeflare: { optionIndexes: [0] }, notes: 'Keep the existing work' },
  { values: ['1', '0'], codeflare: { optionIndexes: [1], text: '0' }, notes: 'A typed zero is not option zero', globalNote: 'Ship only to Integration' },
]);

function fixture({ mode = 'tui', owner = true, signal, nativeVerdict = () => ({ ok: true }) } = {}) {
  const emitter = new EventEmitter();
  const hooks = new Map();
  const pending = new Map();
  const requests = [];
  const attempted = [];
  const outcomes = [];
  const notifications = [];
  const env = { CODEFLARE_CHAT_PRIMARY_PID: String(process.pid + (owner ? 0 : 1)),
    CODEFLARE_CHAT_SOCKET: '/run/codeflare/chat/.pi/dashboard/gateway-9998.sock', [timeoutKey]: '73' };
  let activeTools = ['read', 'ask_user', 'ask_user_question'];
  let adapter;
  let serial = 0;
  let observedTimeout;
  const pi = {
    on(name, handler) { const list = hooks.get(name) ?? []; list.push(handler); hooks.set(name, list); },
    events: {
      on(name, handler) { emitter.on(name, handler); return () => emitter.off(name, handler); },
      emit(name, payload) { emitter.emit(name, payload); },
    },
    getActiveTools: () => activeTools.slice(),
    setActiveTools: tools => { activeTools = tools.slice(); },
  };
  const ctx = { mode, signal, hasUI: mode === 'tui', ui: { notify: (message, level) => notifications.push({ message, level }) } };
  const run = async (name, event = {}) => {
    const results = [];
    for (const handler of hooks.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  const finishRegistration = primaryQuestions(pi, env);
  // A stand-in for the PUBLIC stock session_start contract: instantiate the
  // bus while its documented per-session setting is in scope, then publish ports.
  pi.on('session_start', () => {
    observedTimeout = env[timeoutKey];
    pi.events.on('prompt:register-adapter', next => {
      adapter = next;
      next.setRespond?.(response => respond(response.id, response));
      next.setCancel?.(id => cancel(id));
    });
    pi.events.emit('prompt:set-bus-request', { request(options) {
      const id = `mirror-${++serial}`;
      requests.push({ id, ...options });
      adapter?.onRequest({ id, ...options });
      return new Promise(resolve => pending.set(id, resolve));
    } });
  });
  finishRegistration();
  function respond(id, body) {
    const resolve = pending.get(id);
    if (!resolve) return false;
    pending.delete(id);
    const response = { id, source: 'dashboard', ...body };
    adapter?.onResponse(response);
    outcomes.push(response);
    resolve(response);
    return true;
  }
  function cancel(id) {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    adapter?.onCancel(id);
    const response = { id, cancelled: true, source: '__bus__' };
    outcomes.push(response);
    resolve(response);
  }
  pi.events.on(answerChannel, payload => {
    attempted.push(payload);
    pi.events.emit(verdictChannel, { toolCallId: payload.toolCallId, requestId: payload.requestId, ...nativeVerdict(payload) });
  });
  const open = async (id = 'tool-a', input = questions) => {
    await run('tool_call', { toolName: 'ask_user_question', toolCallId: id, input: { questions: input } });
    pi.events.emit(promptChannel, { toolCallId: id, questions: input.map(q => ({
      header: q.header, question: q.question, multiSelect: !!q.multiSelect,
      options: q.options.map(o => ({ label: o.label, description: o.description, hasPreview: typeof o.preview === 'string' })),
    })) });
    pi.events.emit(blockedChannel, { toolCallId: id, active: true });
    return requests.at(-1)?.id;
  };
  return { pi, env, run, open, respond, pending, requests, attempted, outcomes, notifications,
    activeTools: () => activeTools, observedTimeout: () => observedTimeout };
}

describe('REQ-AGENT-218 / REQ-AGENT-224 primary public questionnaire bridge', () => {
  it('keeps previews/labels/headers in recoverable question metadata without extra questions', async () => {
    const f = fixture(); await f.run('session_start'); await f.open();
    const request = f.requests[0];
    assert.equal(request.type, 'batch');
    const recovered = JSON.parse(JSON.stringify(request)).metadata.questions;
    assert.equal(recovered.length, questions.length);
    assert.deepEqual(recovered[0].options, ['0', '1']);
    assert.equal(recovered[0].title, questions[0].question);
    assert.equal(recovered[0].codeflareQuestionnaire.header, 'Direction');
    assert.deepEqual(recovered[0].codeflareQuestionnaire.options, questions[0].options);
    assert.equal(recovered[0].codeflareQuestionnaire.last, false);
    assert.equal(recovered[1].codeflareQuestionnaire.last, true);
    assert.equal(recovered[1].method, 'multiselect');
    assert.equal(recovered[1].allowOther, true);
    assert.match(request.metadata.message, /answer|question/i);
  });

  it('transmits complete manual choices, distinct freeform, notes/global note through only the native public API', async () => {
    const f = fixture(); await f.run('session_start'); const id = await f.open();
    f.respond(id, { answer: answer() }); await flush();
    assert.deepEqual(f.attempted.map(({ requestId, ...body }) => body), [{
      toolCallId: 'tool-a', answers: [
        { questionIndex: 0, optionIndexes: [0], notes: 'Keep the existing work' },
        { questionIndex: 1, optionIndexes: [1], text: '0', notes: 'A typed zero is not option zero' },
      ], globalNote: 'Ship only to Integration',
    }]);
    assert.equal(typeof f.attempted[0].requestId, 'string');
    f.pi.events.emit(blockedChannel, { toolCallId: 'tool-a', active: false });
    await flush(); assert.equal(f.pending.size, 0);
  });

  for (const invalid of [
    'not JSON', '[]', JSON.stringify([{ value: '0', codeflare: { optionIndexes: [0] } }]),
    JSON.stringify([{ value: '4', codeflare: { optionIndexes: [4] } }, { values: [], codeflare: { optionIndexes: [] } }]),
    answer().replace('"optionIndexes":[0]', '"optionIndexes":[0],"automatic":true'),
    answer().replace('"value":"0"', '"value":"1"'),
  ]) {
    it(`rejects invalid/incomplete or forged submission without dropping the native pending question: ${invalid.slice(0, 35)}`, async () => {
      const f = fixture(); await f.run('session_start'); const id = await f.open();
      f.respond(id, { answer: invalid }); await flush();
      assert.deepEqual(f.attempted, []);
      assert.equal(f.pending.size, 1);
      assert.equal(f.requests.at(-1).metadata.toolCallId, 'tool-a');
      assert.deepEqual(f.requests.at(-1).metadata.questions, f.requests[0].metadata.questions);
      assert.match(f.requests.at(-1).metadata.message, /not accepted|invalid|complete/i);
    });
  }

  it('does not mistake an ambiguous browser answer-plus-cancellation for a native cancellation', async () => {
    const f = fixture(); await f.run('session_start'); const id = await f.open();
    f.respond(id, { answer: answer(), cancelled: true }); await flush();
    assert.deepEqual(f.attempted, []); assert.equal(f.pending.size, 1);
  });

  it('ignores browser provenance claims instead of granting automatic authorization', async () => {
    const f = fixture(); await f.run('session_start'); const id = await f.open();
    f.respond(id, { answer: answer(), source: 'automatic' }); await flush();
    assert.deepEqual(Object.keys(f.attempted[0]).sort(), ['answers', 'globalNote', 'requestId', 'toolCallId']);
    assert.ok(f.attempted[0].answers.every(a => !('automatic' in a) && !('provenance' in a)));
  });

  it('keeps a pure freeform single answer distinct from an identical option token', async () => {
    const f = fixture(); await f.run('session_start'); const id = await f.open();
    const entries = JSON.parse(answer());
    entries[0] = { value: '0', codeflare: { optionIndexes: [], text: '0' }, notes: 'Typed, not clicked' };
    f.respond(id, { answer: JSON.stringify(entries) }); await flush();
    assert.deepEqual(f.attempted[0].answers[0], { questionIndex: 0, text: '0', notes: 'Typed, not clicked' });
  });

  it('omits option selection entirely for a pure freeform multi-select answer', async () => {
    const f = fixture(); await f.run('session_start'); const id = await f.open();
    const entries = JSON.parse(answer());
    entries[1] = { values: ['0'], codeflare: { optionIndexes: [], text: '0' }, globalNote: 'Only custom text' };
    f.respond(id, { answer: JSON.stringify(entries) }); await flush();
    assert.deepEqual(f.attempted[0].answers[1], { questionIndex: 1, text: '0' });
    assert.equal(f.attempted[0].globalNote, 'Only custom text');
  });

  it('a browser winner cannot be delivered twice or reopened by a later native completion', async () => {
    const f = fixture(); await f.run('session_start'); const id = await f.open();
    assert.equal(f.respond(id, { answer: answer() }), true);
    assert.equal(f.respond(id, { answer: answer() }), false);
    f.pi.events.emit(blockedChannel, { toolCallId: 'tool-a', active: false });
    f.pi.events.emit(blockedChannel, { toolCallId: 'tool-a', active: false });
    await flush(); assert.deepEqual(f.attempted.map(p => p.toolCallId), ['tool-a']);
    assert.equal(f.pending.size, 0);
  });

  it('does not treat bus completion as provider acceptance; a rejected native verdict restores the mirror', async () => {
    const f = fixture({ nativeVerdict: () => ({ ok: false, code: 'invalid_answer', reason: 'not accepted' }) });
    await f.run('session_start'); const id = await f.open();
    f.respond(id, { answer: answer() }); await flush();
    assert.equal(f.pending.size, 1);
    assert.equal(f.requests.at(-1).metadata.toolCallId, 'tool-a');
    assert.match(f.requests.at(-1).metadata.message, /not accepted/i);
  });

  it('matches verdicts to both native tool call and attempt; a late unrelated refusal cannot reopen a settled question', async () => {
    const f = fixture(); await f.run('session_start'); const id = await f.open();
    f.respond(id, { answer: answer() }); await flush();
    const attempt = f.attempted[0];
    f.pi.events.emit(verdictChannel, { toolCallId: 'other-tool', requestId: attempt.requestId, ok: false, code: 'invalid_answer' });
    f.pi.events.emit(verdictChannel, { toolCallId: 'tool-a', requestId: 'other-attempt', ok: false, code: 'invalid_answer' });
    await flush(); assert.equal(f.pending.size, 0);
    f.pi.events.emit(blockedChannel, { toolCallId: 'tool-a', active: false });
    f.pi.events.emit(verdictChannel, { toolCallId: 'tool-a', requestId: attempt.requestId, ok: false, code: 'invalid_answer' });
    await flush(); assert.equal(f.pending.size, 0);
  });

  it('native completion/automatic expiry wins without echoing cancellation or fabricating manual/automatic answers', async () => {
    const f = fixture(); await f.run('session_start'); const id = await f.open();
    f.pi.events.emit(blockedChannel, { toolCallId: 'tool-a', active: false });
    await f.run('tool_result', { toolName: 'ask_user_question', toolCallId: 'tool-a', details: {
      automatic: true, cancelled: false, answers: [{ questionIndex: 0, selected: ['North (Recommended)'], automatic: true, notes: 'native partial note' }],
    } });
    assert.equal(f.respond(id, { answer: answer() }), false);
    await flush(); assert.equal(f.pending.size, 0); assert.deepEqual(f.attempted, []);
    assert.equal(f.outcomes[0].cancelled, undefined);
    assert.equal(f.outcomes[0].source, 'codeflare-native');
  });

  it('uses the actual native result to distinguish successful dismissal from cancellation', async () => {
    const f = fixture(); await f.run('session_start'); await f.open();
    f.pi.events.emit(blockedChannel, { toolCallId: 'tool-a', active: false });
    await f.run('tool_result', { toolName: 'ask_user_question', toolCallId: 'tool-a', details: { cancelled: true } });
    assert.equal(f.outcomes[0].cancelled, true);
    assert.deepEqual(f.attempted, []);
  });

  it('a candidate arriving between native wait completion and its public result cannot answer the native question', async () => {
    const f = fixture(); await f.run('session_start'); const id = await f.open();
    f.pi.events.emit(blockedChannel, { toolCallId: 'tool-a', active: false });
    f.respond(id, { answer: answer() });
    await f.run('tool_result', { toolName: 'ask_user_question', toolCallId: 'tool-a', details: { cancelled: false } });
    await flush(); assert.equal(f.pending.size, 0); assert.deepEqual(f.attempted, []);
  });

  it('turn abort dismisses the mirror without manufacturing native user-cancellation', async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal }); await f.run('session_start'); await f.open();
    controller.abort(); await flush();
    assert.equal(f.pending.size, 0); assert.deepEqual(f.attempted, []);
    assert.equal(f.outcomes[0].cancelled, true);
  });

  it('browser cancellation uses native cancellation; abort/error cleanup does not pretend the user cancelled', async () => {
    const f = fixture(); await f.run('session_start'); const first = await f.open();
    f.respond(first, { cancelled: true }); await flush();
    assert.deepEqual(f.attempted.map(({ requestId, ...body }) => body), [{ toolCallId: 'tool-a', cancel: true }]);
    f.pi.events.emit(blockedChannel, { toolCallId: 'tool-a', active: false });
    await f.open('tool-b');
    await f.run('tool_result', { toolName: 'ask_user_question', toolCallId: 'tool-b', isError: true });
    await flush(); assert.equal(f.pending.size, 0);
    assert.deepEqual(f.attempted.map(({ requestId, ...body }) => body), [{ toolCallId: 'tool-a', cancel: true }]);
  });

  it('isolates concurrent tool calls and ignores unrelated prompt events', async () => {
    const f = fixture(); await f.run('session_start'); await f.open('tool-a'); await f.open('tool-b');
    f.pi.events.emit(promptChannel, { toolCallId: 'unknown', questions });
    f.pi.events.emit(blockedChannel, { toolCallId: 'tool-a', active: false });
    await f.run('tool_result', { toolName: 'ask_user_question', toolCallId: 'tool-a', details: { cancelled: false } });
    assert.equal(f.pending.size, 1);
    f.respond(f.requests.at(-1).id, { answer: answer() }); await flush();
    assert.deepEqual(f.attempted.map(a => a.toolCallId), ['tool-b']);
  });

  it('shutdown removes pending mirror state and listeners without sending user-cancellation or resetting native provenance', async () => {
    const f = fixture(); await f.run('session_start'); await f.open(); await f.run('session_shutdown');
    f.pi.events.emit(promptChannel, { toolCallId: 'tool-a', questions });
    await flush(); assert.equal(f.pending.size, 0); assert.deepEqual(f.attempted, []);
    assert.equal(f.env[timeoutKey], '73');
  });

  it('disables only the competing primary bus timeout during its public initialization and restores inherited config afterwards', async () => {
    const f = fixture(); await f.run('session_start');
    assert.equal(f.observedTimeout(), '0');
    assert.equal(f.env[timeoutKey], '73');
    assert.deepEqual(f.activeTools(), ['read', 'ask_user_question']);
    const blocked = await f.run('tool_call', { toolName: 'ask_user', toolCallId: 'alternate', input: {} });
    assert.ok(blocked.some(r => r?.block === true));
    assert.deepEqual(f.attempted, []);
  });

  for (const options of [{ owner: false }, { mode: 'json' }, { mode: 'rpc' }]) {
    it(`leaves inherited/SDK/IDE runtimes outside the primary integration ${JSON.stringify(options)}`, async () => {
      const f = fixture(options); await f.run('session_start'); await f.open();
      assert.equal(f.observedTimeout(), '73'); assert.equal(f.env[timeoutKey], '73');
      assert.deepEqual(f.requests, []); assert.deepEqual(f.attempted, []);
      assert.deepEqual(f.activeTools(), ['read', 'ask_user', 'ask_user_question']);
    });
  }
});
