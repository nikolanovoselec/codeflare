// Primary-only application glue over documented Pi, Dashboard and RPIV events.
// RPIV owns all native state, acceptance, cancellation and the existing deadline.
import { randomUUID } from 'node:crypto';

// RPIV documents these public channel names as immutable JSON contracts.
const PROMPT = 'rpiv:ask-user:prompt';
const BLOCKED = 'rpiv:ask-user:blocked';
const ANSWER = 'rpiv:ask-user:answer';
const VERDICT = 'rpiv:ask-user:answer-result';
const TIMEOUT = 'PI_EXT_PI_DASHBOARD_ASK_USER_PROMPT_TIMEOUT_SECONDS';
const PIPELINE = 'codeflare-questionnaire';
const RETRY = 'Answer was not accepted. Complete every question and try again.';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

/** Validate our opt-in batch wire result before forwarding the public native API. */
function decode(record, wire) {
  const entries = JSON.parse(wire);
  if (!Array.isArray(entries) || entries.length !== record.questions.length) throw new Error('Incomplete answer');
  let globalNote;
  const answers = entries.map((entry, questionIndex) => {
    const question = record.questions[questionIndex];
    const field = question.multiSelect ? 'values' : 'value';
    if (!only(entry, [field, 'codeflare', 'notes', 'globalNote'])
      || !only(entry.codeflare, ['optionIndexes', 'text'])) throw new Error('Invalid answer fields');
    const { optionIndexes, text } = entry.codeflare;
    if (!Array.isArray(optionIndexes) || new Set(optionIndexes).size !== optionIndexes.length
      || optionIndexes.some(index => !Number.isInteger(index) || index < 0 || index >= question.options.length)
      || (text !== undefined && (typeof text !== 'string' || !text.trim()))
      || (optionIndexes.length === 0 && text === undefined)
      || (!question.multiSelect && (optionIndexes.length > 1 || (optionIndexes.length > 0 && text !== undefined)))) {
      throw new Error('Invalid answer selection');
    }
    const selected = optionIndexes.map(String);
    const expected = [...new Set([...selected, ...(text !== undefined ? [text] : [])])];
    if (question.multiSelect) {
      if (!Array.isArray(entry.values) || entry.values.length !== expected.length
        || new Set(entry.values).size !== entry.values.length || entry.values.some(value => !expected.includes(value))) {
        throw new Error('Conflicting answer values');
      }
    } else if (typeof entry.value !== 'string' || entry.value !== (text ?? selected[0])) {
      throw new Error('Conflicting answer value');
    }
    if (entry.notes !== undefined && typeof entry.notes !== 'string') throw new Error('Invalid answer notes');
    if (entry.globalNote !== undefined) {
      if (questionIndex !== entries.length - 1 || typeof entry.globalNote !== 'string') throw new Error('Invalid global note');
      globalNote = entry.globalNote;
    }
    return { questionIndex, ...(optionIndexes.length ? { optionIndexes } : {}), ...(text !== undefined ? { text } : {}),
      ...(entry.notes !== undefined ? { notes: entry.notes } : {}) };
  });
  return { answers, ...(globalNote !== undefined ? { globalNote } : {}) };
}

/**
 * Register before the stock factory; invoke the returned finalizer AFTER it.
 * Ordered PUBLIC session_start handlers scope the documented bus timeout override
 * to stock initialization and restore it before ordinary tools/SDK children run.
 */
export default function primaryQuestions(pi, env = process.env) {
  if (!/^\d+$/.test(env.CODEFLARE_CHAT_PRIMARY_PID ?? '')
    || Number(env.CODEFLARE_CHAT_PRIMARY_PID) !== process.pid || !env.CODEFLARE_CHAT_SOCKET) return () => {};
  // Correlation only: no second question authority, timer, answer queue or store.
  const records = new Map();
  let active = false;
  let context;
  let request;
  let cancelMirror;
  let respondMirror;
  let savedTimeout;
  let timeoutOverridden = false;
  let subscriptions = [];
  const restoreTimeout = () => {
    if (!timeoutOverridden) return;
    if (savedTimeout === undefined) delete env[TIMEOUT]; else env[TIMEOUT] = savedTimeout;
    timeoutOverridden = false;
  };
  const find = id => [...records.values()].find(record => record.promptId === id);
  const close = (record, cancelled = true) => {
    if (!record || record.closed) return;
    record.closed = true;
    records.delete(record.toolCallId);
    record.signal?.removeEventListener('abort', record.onAbort);
    const id = record.promptId;
    record.promptId = undefined;
    // Remove correlation first: a mirror dismissal is NOT a native user action.
    if (id) {
      if (cancelled) cancelMirror?.(id);
      else respondMirror?.({ id, source: 'codeflare-native' });
    }
  };
  const retry = record => queueMicrotask(() => {
    if (!record.closed && !record.nativeEnded && !record.accepted && records.get(record.toolCallId) === record) mirror(record, RETRY);
  });
  const send = (record, body) => {
    if (record.closed || record.nativeEnded || record.accepted || record.attempt) return;
    record.attempt = randomUUID();
    pi.events.emit(ANSWER, { toolCallId: record.toolCallId, requestId: record.attempt, ...body });
  };
  const adapter = {
    name: 'codeflare-primary-questionnaire',
    onRequest(prompt) {
      if (prompt.pipeline !== PIPELINE) return;
      const record = records.get(prompt.metadata?.toolCallId);
      if (!record || record.closed || !record.questions) return;
      record.promptId = prompt.id;
      // Default Dashboard rendering; RPIV already owns the native TUI arm.
      return {};
    },
    onResponse(response) {
      const record = find(response.id);
      if (!record || record.closed) return;
      record.promptId = undefined;
      if (record.nativeEnded) return;
      try {
        if (response.cancelled === true && response.answer === undefined) send(record, { cancel: true });
        else if (response.cancelled !== true && typeof response.answer === 'string') send(record, decode(record, response.answer));
        else retry(record);
      } catch { retry(record); }
    },
    onCancel(id) {
      const record = find(id);
      if (!record) return;
      record.promptId = undefined;
      // Bus cancellation is not evidence that a human cancelled RPIV.
      if (record.signal?.aborted) close(record); else retry(record);
    },
    setCancel(callback) { cancelMirror = callback; },
    setRespond(callback) { respondMirror = callback; },
  };
  function mirror(record, message = 'Answer the questions below. Optional notes are sent only when you submit.') {
    if (record.closed || record.nativeEnded || record.accepted || record.promptId || !request) return;
    const steps = record.questions.map((question, index) => ({
      method: question.multiSelect ? 'multiselect' : 'select', title: question.question,
      options: question.options.map((_option, i) => String(i)), allowOther: true,
      codeflareQuestionnaire: { header: question.header,
        options: question.options.map((option, i) => ({ label: option.label, description: option.description,
          ...(option.hasPreview && typeof record.input.questions[index]?.options[i]?.preview === 'string'
            ? { preview: record.input.questions[index].options[i].preview } : {}) })),
        last: index === record.questions.length - 1 },
    }));
    try {
      // metadata.questions survives live messages and the stock detail/reconnect
      // projection; component props alone would not survive the detail road.
      const completion = request({ pipeline: PIPELINE, type: 'batch', question: 'Questions from Pi',
        metadata: { toolCallId: record.toolCallId, questions: steps, message } });
      Promise.resolve(completion).catch(() => {
        if (!record.closed) context?.ui.notify('Chat question unavailable. Continue in Terminal.', 'error');
      });
    } catch { context?.ui.notify('Chat question unavailable. Continue in Terminal.', 'error'); }
  }
  const clear = () => {
    for (const record of [...records.values()]) close(record);
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    request = undefined;
    cancelMirror = undefined;
    respondMirror = undefined;
    restoreTimeout();
  };
  const filterAlternateTool = () => {
    if (active) pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'ask_user'));
  };
  pi.on('session_start', (_event, ctx) => {
    clear();
    active = ctx.mode === 'tui';
    context = ctx;
    if (!active) return;
    savedTimeout = env[TIMEOUT];
    env[TIMEOUT] = '0';
    timeoutOverridden = true;
    subscriptions = [
      pi.events.on('prompt:set-bus-request', payload => {
        request = payload.request;
        pi.events.emit('prompt:register-adapter', adapter);
      }),
      pi.events.on(PROMPT, payload => {
        const record = records.get(payload.toolCallId);
        if (!record || record.closed || record.questions || !request) return;
        record.questions = payload.questions;
        mirror(record);
      }),
      pi.events.on(BLOCKED, payload => {
        const record = records.get(payload.toolCallId);
        if (record && payload.active === false) record.nativeEnded = true;
        // This phase alone cannot distinguish a manual/automatic answer from
        // cancellation or failure. The public tool result supplies the outcome.
      }),
      pi.events.on(VERDICT, payload => {
        const record = records.get(payload.toolCallId);
        if (!record || !record.attempt || record.attempt !== payload.requestId) return;
        record.attempt = undefined;
        if (payload.ok === true) record.accepted = true;
        else if (payload.code === 'invalid_answer' || payload.code === 'invalid_payload') retry(record);
        else {
          close(record);
          context?.ui.notify('Chat answer unavailable. Continue in Terminal if the question is still open.', 'error');
        }
      }),
    ];
  });
  pi.on('before_agent_start', (_event, ctx) => { if (ctx.mode === 'tui') filterAlternateTool(); });
  pi.on('tool_call', (event, ctx) => {
    if (!active || ctx.mode !== 'tui') return;
    if (event.toolName === 'ask_user') return { block: true, reason: 'Use ask_user_question to preserve native questionnaire and timeout policy.' };
    if (event.toolName !== 'ask_user_question' || records.has(event.toolCallId)) return;
    const record = { toolCallId: event.toolCallId, input: event.input, signal: ctx.signal };
    record.onAbort = () => close(record);
    records.set(event.toolCallId, record);
    if (record.signal?.aborted) close(record);
    else record.signal?.addEventListener('abort', record.onAbort, { once: true });
  });
  pi.on('tool_result', event => {
    if (event.toolName === 'ask_user_question') {
      close(records.get(event.toolCallId), event.isError === true || event.details?.cancelled === true);
    }
  });
  pi.on('session_shutdown', () => { clear(); active = false; context = undefined; });
  return () => pi.on('session_start', () => { restoreTimeout(); filterAlternateTool(); });
}
