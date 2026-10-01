import { z } from 'zod';

/** Only exact-submission result/settlement state is retained; SDK history is not a result. */
export interface DispatcherResultProjection {
  offset: string;
  messageIds: string[];
  result?: unknown;
  writes: number;
  outcome?: 'completed' | 'failed' | 'aborted';
  error?: { type?: string; meta?: { reason?: string; operation?: string } };
  position?: { batch: number; index: number };
}
const MAX_UPDATE_RECORD_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

function captureResult(state: DispatcherResultProjection, value: unknown): void {
  if (!z.json().safeParse(value).success || !value || typeof value !== 'object' || Array.isArray(value)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RESULT_BYTES) {
    throw new Error('Dispatcher result unavailable');
  }
  state.writes++;
  if (state.writes !== 1) throw new Error('Dispatcher result duplicated');
  state.result = value;
}

function project(state: DispatcherResultProjection, value: unknown, submissionId: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dispatcher update unavailable');
  const chunk = value as Record<string, unknown>;
  const position = chunk.position as { batch?: unknown; index?: unknown } | undefined;
  if (!position || !Number.isSafeInteger(position.batch) || !Number.isSafeInteger(position.index)
    || (position.batch as number) < 0 || (position.index as number) < 0) throw new Error('Dispatcher update position unavailable');
  const next = { batch: position.batch as number, index: position.index as number };
  if (state.position && (next.batch < state.position.batch
    || (next.batch === state.position.batch && next.index <= state.position.index))) return;
  if (chunk.type === 'conversation-reset') {
    const snapshot = chunk.snapshot as { messages?: Array<{ id?: string; submissionId?: string; parts?: Array<{ type?: string; data?: unknown }> }>;
      settlements?: Array<{ submissionId?: string; outcome?: string; error?: unknown }> } | undefined;
    if (!snapshot || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.settlements)) throw new Error('Dispatcher reset unavailable');
    state.messageIds = []; state.writes = 0; delete state.result; delete state.outcome; delete state.error;
    for (const message of snapshot.messages) {
      if (message.submissionId !== submissionId) continue;
      if (typeof message.id !== 'string' || !Array.isArray(message.parts)) throw new Error('Dispatcher reset message unavailable');
      state.messageIds.push(message.id);
      for (const part of message.parts) if (part.type === 'data-assessment' || part.type === 'data-result') captureResult(state, part.data);
    }
    const settlements = snapshot.settlements.filter(item => item.submissionId === submissionId);
    if (settlements.length > 1) throw new Error('Dispatcher settlement duplicated');
    if (settlements[0]) { chunk.outcome = settlements[0].outcome; chunk.error = settlements[0].error; }
  } else if (chunk.type === 'message-started' && chunk.submissionId === submissionId) {
    if (typeof chunk.messageId !== 'string' || chunk.messageId.length > 256) throw new Error('Dispatcher message unavailable');
    if (!state.messageIds.includes(chunk.messageId)) state.messageIds.push(chunk.messageId);
  } else if (chunk.type === 'data-part' && state.messageIds.includes(chunk.messageId as string)
    && (chunk.name === 'assessment' || chunk.name === 'result')) {
    captureResult(state, chunk.data);
  }
  if ((chunk.type === 'submission-settled' && chunk.submissionId === submissionId)
    || (chunk.type === 'conversation-reset' && chunk.outcome !== undefined)) {
    if (!['completed', 'failed', 'aborted'].includes(chunk.outcome as string)) throw new Error('Dispatcher settlement unavailable');
    state.outcome = chunk.outcome as DispatcherResultProjection['outcome'];
    const error = chunk.error as { type?: unknown; meta?: { reason?: unknown; operation?: unknown } } | undefined;
    if (error && typeof error === 'object' && !Array.isArray(error)) state.error = {
      ...(typeof error.type === 'string' && error.type.length <= 128 ? { type: error.type } : {}),
      meta: { ...(typeof error.meta?.reason === 'string' ? { reason: error.meta.reason.slice(0, 2048) } : {}),
        ...(typeof error.meta?.operation === 'string' ? { operation: error.meta.operation.slice(0, 256) } : {}) },
    };
  }
  if (state.messageIds.length > 128) throw new Error('Dispatcher message bound exceeded');
  state.position = next;
}

/** Documented Flue updates wire: bounded individual records, not a buffered history snapshot. */
export async function readDispatcherUpdates(response: Response, previous: DispatcherResultProjection,
  submissionId: string): Promise<DispatcherResultProjection> {
  const offset = response.headers.get('stream-next-offset');
  if (response.status !== 200 || !response.body || !offset || offset.length > 2048
    || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('Dispatcher updates unavailable');
  const state = structuredClone(previous);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let record = ''; let recordBytes = 0; let depth = 0; let quoted = false; let escaped = false;
  let started = false; let ended = false; let afterRecord = false; let recordRequired = false;
  const consume = (text: string) => {
    for (const character of text) {
      if (!started) { if (/\s/.test(character)) continue; if (character !== '[') throw new Error('Dispatcher update array unavailable'); started = true; continue; }
      if (ended) { if (!/\s/.test(character)) throw new Error('Dispatcher update trailer unavailable'); continue; }
      if (depth === 0) {
        if (/\s/.test(character)) continue;
        if (character === ',') { if (!afterRecord) throw new Error('Dispatcher update separator unavailable'); afterRecord = false; recordRequired = true; continue; }
        if (character === ']') { if (recordRequired) throw new Error('Dispatcher update record unavailable'); ended = true; continue; }
        if (character !== '{' || afterRecord) throw new Error('Dispatcher update record unavailable');
        recordRequired = false;
      }
      record += character;
      const point = character.codePointAt(0)!;
      recordBytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      if (recordBytes > MAX_UPDATE_RECORD_BYTES) throw new Error('Dispatcher update exceeds limit');
      if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; }
      else if (character === '"') quoted = true;
      else if (character === '{' || character === '[') depth++;
      else if (character === '}' || character === ']') depth--;
      if (depth === 0) { project(state, JSON.parse(record), submissionId); record = ''; recordBytes = 0; afterRecord = true; }
    }
  };
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; consume(decoder.decode(chunk.value, { stream: true })); }
    consume(decoder.decode());
    if (!started || !ended || depth !== 0 || quoted) throw new Error('Dispatcher updates incomplete');
    state.offset = offset;
    return state;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
