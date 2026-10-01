import { z } from 'zod';
import { Tokenizer, TokenParser, TokenType } from '@streamparser/json';

/** Only exact-submission result/settlement state is retained; SDK history is not a result. */
export interface DispatcherResultProjection {
  offset: string;
  conversationId?: string;
  upToDate?: boolean;
  messageIds: string[];
  result?: unknown;
  writes: number;
  outcome?: 'completed' | 'failed' | 'aborted';
  error?: { type?: string; meta?: { reason?: string; operation?: string } };
  position?: { batch: number; index: number };
}
const MAX_UPDATE_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_PROJECTED_RECORD_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;

function captureResult(state: DispatcherResultProjection, value: unknown): void {
  if (!z.json().safeParse(value).success || !value || typeof value !== 'object' || Array.isArray(value)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RESULT_BYTES) {
    throw new Error('Dispatcher result unavailable');
  }
  if (state.outcome !== undefined) throw new Error('Dispatcher result follows terminal settlement');
  state.writes++;
  if (state.writes !== 1) throw new Error('Dispatcher result duplicated');
  state.result = value;
}

function project(state: DispatcherResultProjection, value: unknown, submissionId: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dispatcher update unavailable');
  const chunk = value as Record<string, unknown>;
  if (typeof chunk.conversationId !== 'string' || !chunk.conversationId || chunk.conversationId.length > 512
    || (state.conversationId !== undefined && state.conversationId !== chunk.conversationId)) {
    throw new Error('Dispatcher conversation changed');
  }
  state.conversationId = chunk.conversationId;
  const previousOutcome = state.outcome;
  const previousResult = state.result;
  const position = chunk.position as { batch?: unknown; index?: unknown } | undefined;
  if (!position || !Number.isSafeInteger(position.batch) || !Number.isSafeInteger(position.index)
    || (position.batch as number) < 0 || (position.index as number) < 0) throw new Error('Dispatcher update position unavailable');
  const next = { batch: position.batch as number, index: position.index as number };
  if (state.position && (next.batch < state.position.batch
    || (next.batch === state.position.batch && next.index <= state.position.index))) return;
  if (chunk.type === 'conversation-reset') {
    const snapshot = chunk.snapshot as { messages?: Array<{ id?: string; submissionId?: string; parts?: Array<{ type?: string; data?: unknown }> }>;
      settlements?: Array<{ submissionId?: string; outcome?: string; error?: unknown }> } | undefined;
    if (!snapshot || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.settlements)
      || (chunk.snapshot as { conversationId?: unknown }).conversationId !== chunk.conversationId) throw new Error('Dispatcher reset unavailable');
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
  if (previousOutcome !== undefined && state.outcome !== previousOutcome) throw new Error('Dispatcher terminal settlement changed');
  if (previousResult !== undefined && state.result !== undefined
    && JSON.stringify(previousResult) !== JSON.stringify(state.result)) throw new Error('Dispatcher immutable result changed');
  if (state.messageIds.length > 128) throw new Error('Dispatcher message bound exceeded');
  state.position = next;
}

/** Project only SDK identity, named data and settlements; discard history as it is tokenized. */
export async function readDispatcherUpdates(response: Response, previous: DispatcherResultProjection,
  submissionId: string, signal?: AbortSignal): Promise<DispatcherResultProjection> {
  const offset = response.headers.get('stream-next-offset');
  if (response.status !== 200 || !response.body || !offset || offset.length > 2048
    || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('Dispatcher updates unavailable');
  const state = structuredClone(previous);
  const reader = response.body.getReader();
  const tokenizer = new Tokenizer();
  const fields = ['type', 'conversationId', 'position', 'messageId', 'submissionId', 'name', 'data', 'outcome', 'error'];
  const parser = new TokenParser({ keepStack: false, paths: [
    ...fields.map(field => `$.*.${field}`), '$.*.snapshot.conversationId',
    '$.*.snapshot.messages.*.id', '$.*.snapshot.messages.*.submissionId',
    '$.*.snapshot.messages.*.parts.*.type', '$.*.snapshot.messages.*.parts.*.data',
    '$.*.snapshot.settlements.*',
  ] });
  type Frame = { path: Array<string | number>; array: boolean; index: number; key?: string; expectingKey: boolean };
  const frames: Frame[] = [];
  let record: Record<string, unknown> = Object.create(null);
  let bytes = 0;
  let records = 0;
  let ended = false;
  const put = (path: Array<string | number>, value: unknown) => {
    let target = record as Record<string | number, unknown>;
    for (let index = 0; index < path.length; index++) {
      const key = path[index];
      if (index === path.length - 1) {
        Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
      } else {
        if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, {
          value: typeof path[index + 1] === 'number' ? [] : Object.create(null),
          enumerable: true, configurable: true, writable: true,
        });
        if (!target[key] || typeof target[key] !== 'object') throw new Error('Dispatcher projection unavailable');
        target = target[key] as Record<string | number, unknown>;
      }
    }
  };
  const snapshotMessages = () => (record.snapshot as { messages?: Array<{ submissionId?: string; parts?: unknown[] }> } | undefined)?.messages;
  parser.onValue = ({ value, key, stack }) => {
    const path = [...stack.map(item => item.key), key].filter((part): part is string | number => part !== undefined).slice(1);
    if (!path.length) return;
    if (path[0] === 'snapshot' && path[1] === 'messages') {
      const index = path[2] as number;
      const message = snapshotMessages()?.[index];
      if (path[3] === 'parts' && message?.submissionId !== undefined && message.submissionId !== submissionId) return;
      if (path[3] === 'parts' && path[5] === 'data') {
        const part = message?.parts?.[path[4] as number] as { type?: string } | undefined;
        if (part?.type !== undefined && part.type !== 'data-assessment' && part.type !== 'data-result') return;
      }
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RESULT_BYTES) throw new Error('Dispatcher projected value exceeds limit');
    put(path, value);
    if (path[0] === 'snapshot' && path[1] === 'messages' && path[3] === 'submissionId' && value !== submissionId) {
      const message = snapshotMessages()?.[path[2] as number];
      if (message) message.parts = [];
    }
  };
  tokenizer.onError = error => { throw error; };
  parser.onError = error => { throw error; };
  tokenizer.onToken = token => {
    const { token: kind, value } = token;
    if (kind === TokenType.LEFT_BRACE || kind === TokenType.LEFT_BRACKET) {
      const parent = frames.at(-1);
      const path = parent ? [...parent.path, parent.array ? parent.index : parent.key!] : [];
      if (!parent && (ended || kind !== TokenType.LEFT_BRACKET)) throw new Error('Dispatcher update array unavailable');
      if (path.length === 1 && kind !== TokenType.LEFT_BRACE) throw new Error('Dispatcher update record unavailable');
      if (path.length === 3 && path[1] === 'snapshot' && ['messages', 'settlements'].includes(String(path[2]))) {
        if (kind !== TokenType.LEFT_BRACKET) throw new Error('Dispatcher reset unavailable');
        put(path.slice(1), []);
      }
      if (path.length === 5 && path[1] === 'snapshot' && path[2] === 'messages' && path[4] === 'parts') {
        if (kind !== TokenType.LEFT_BRACKET) throw new Error('Dispatcher reset parts unavailable');
        put(path.slice(1), []);
      }
      frames.push({ path, array: kind === TokenType.LEFT_BRACKET, index: 0, expectingKey: true });
      if (frames.length > 128) throw new Error('Dispatcher update nesting exceeds limit');
      parser.write(token);
      return;
    }
    if (kind === TokenType.RIGHT_BRACE || kind === TokenType.RIGHT_BRACKET) {
      parser.write(token);
      const frame = frames.pop();
      if (!frame) throw new Error('Dispatcher update trailer unavailable');
      if (frame.path.length === 1) {
        if (++records > 65536) throw new Error('Dispatcher update count exceeds limit');
        const snapshot = record.snapshot as { messages?: Array<{ submissionId?: string }> } | undefined;
        if (Array.isArray(snapshot?.messages)) snapshot.messages = snapshot.messages.filter(message => message?.submissionId === submissionId);
        if (new TextEncoder().encode(JSON.stringify(record)).byteLength > MAX_PROJECTED_RECORD_BYTES) throw new Error('Dispatcher projection exceeds limit');
        project(state, record, submissionId);
        record = Object.create(null);
      }
      if (frame.path.length === 0) ended = true;
      return;
    }
    const frame = frames.at(-1);
    if (kind === TokenType.COMMA && frame) {
      if (frame.array) frame.index++;
      else { frame.key = undefined; frame.expectingKey = true; }
    } else if (kind === TokenType.STRING && frame && !frame.array && frame.expectingKey) {
      frame.key = value as string;
      frame.expectingKey = false;
    }
    parser.write(token);
  };
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (signal?.aborted) throw signal.reason;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_UPDATE_PAGE_BYTES) throw new Error('Dispatcher update page exceeds limit');
      tokenizer.write(chunk.value);
    }
    tokenizer.end();
    if (!ended || frames.length) throw new Error('Dispatcher updates incomplete');
    state.upToDate = response.headers.get('stream-up-to-date') === 'true';
    if (!state.upToDate && offset === previous.offset) throw new Error('Dispatcher update cursor stalled');
    state.offset = offset;
    return state;
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
