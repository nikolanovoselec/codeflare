import { z } from 'zod';
import { Tokenizer, TokenParser, TokenType } from '@streamparser/json';
import { dispatcherCapacities, type DispatcherCapacities, type DispatcherCapacityPolicy } from './dispatcher-capacity-limits';

/** Exact-submission authority and bounded observations only; SDK history is not a result. */
export interface DispatcherResultProjection {
  offset: string;
  conversationId?: string;
  incarnation?: string;
  upToDate?: boolean;
  messageIds: string[];
  result?: unknown;
  writes: number;
  outcome?: 'completed' | 'failed' | 'aborted';
  error?: { type?: string; meta?: { reason?: string; operation?: string } };
  position?: { batch: number; index: number };
  /** Observation only; opaque correlations never enter owner logs or result authority. */
  completion?: { calls: Array<{ id: string; outcome: 'pending' | 'succeeded' | 'failed' }>; truncated: boolean };
  tools?: { calls: Array<{ id: string; role: string; outcome: 'pending' | 'succeeded' | 'failed' }>; truncated: boolean };
  unmatchedAssessment?: boolean;
  readiness?: { latest?: DispatcherReadiness; observations: number; truncated: boolean };
  sealPreflight?: { latest?: DispatcherSealPreflight; observations: number; truncated: boolean };
}
const readinessSchema = z.object({
  discovered: z.boolean(), sealed: z.boolean(),
  targetCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  decisionCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  resultCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unknownOperationCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  category: z.enum(['ready', 'undiscovered', 'unknown-operation', 'incomplete-results', 'schema', 'oversized', 'emission']),
}).strict();
type DispatcherReadiness = z.infer<typeof readinessSchema>;
const sealPreflightSchema = z.object({
  category: z.enum(['undiscovered', 'incomplete-decisions', 'receipt', 'capacity', 'schema', 'oversized', 'ready']),
  targetCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  decisionCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  operationCount: z.number().int().positive().safe().nullable(),
  operationLimit: z.number().int().positive().safe().nullable(),
  requiredOperationCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  sealed: z.boolean(),
}).strict().refine(value => value.operationCount === null || value.operationLimit === null
  || value.operationCount <= value.operationLimit);
type DispatcherSealPreflight = z.infer<typeof sealPreflightSchema>;
const toolRoles: Record<string, string> = { discover_renovate: 'discover', research_renovate: 'research', decide_renovate: 'decide',
  seal_dispatcher: 'seal', comment_renovate: 'comment', merge_renovate: 'merge', finish_dispatcher: 'finish', finish: 'generic-finish' };
function observeTool(state: DispatcherResultProjection, id: unknown, name: unknown,
  outcome: 'pending' | 'succeeded' | 'failed', limits: DispatcherCapacities): void {
  const prior = state.tools?.calls.find(call => call.id === id);
  if (prior) { if (outcome !== 'pending') prior.outcome = outcome; return; }
  if (typeof name !== 'string' || !Object.hasOwn(toolRoles, name)) return;
  const observation = state.tools ??= { calls: [], truncated: false };
  if (typeof id !== 'string' || !id || id.length > MAX_COMPLETION_ID_LENGTH) { observation.truncated = true; return; }
  if (observation.calls.length >= limits.toolObservationLimit) { observation.truncated = true; return; }
  observation.calls.push({ id, role: toolRoles[name], outcome });
}
const MAX_COMPLETION_ID_LENGTH = 256;

function captureResult(state: DispatcherResultProjection, value: unknown, limits: DispatcherCapacities): void {
  if (!z.json().safeParse(value).success || !value || typeof value !== 'object' || Array.isArray(value)
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > limits.assessmentBytes) {
    throw new Error('Dispatcher result unavailable');
  }
  if (state.outcome !== undefined) throw new Error('Dispatcher result follows terminal settlement');
  state.writes++;
  if (state.writes !== 1) throw new Error('Dispatcher result duplicated');
  state.result = value;
}

function observeReadiness(state: DispatcherResultProjection, value: unknown, limits: DispatcherCapacities): void {
  const observation = state.readiness ??= { observations: 0, truncated: false };
  if (observation.observations >= limits.readinessObservationLimit) { observation.truncated = true; return; }
  observation.observations++;
  const parsed = readinessSchema.safeParse(value);
  if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > limits.readinessBytes) {
    observation.truncated = true; return;
  }
  observation.latest = parsed.data;
}

// Drop every unknown value before persistence/accounting, regardless of JSON member order.
function normalizeReadinessData(part: Record<string, unknown>, limits: DispatcherCapacities): void {
  const parsed = readinessSchema.safeParse(part.data);
  const valid = !part.dataProjectionOversized && parsed.success
    && new TextEncoder().encode(JSON.stringify(part.data)).byteLength <= limits.readinessBytes;
  Object.defineProperty(part, 'data', { value: valid && parsed.success ? parsed.data : undefined,
    enumerable: false, configurable: true, writable: true });
  delete part.dataProjectionOversized;
}

function observeSealPreflight(state: DispatcherResultProjection, value: unknown, limits: DispatcherCapacities): void {
  const observation = state.sealPreflight ??= { observations: 0, truncated: false };
  if (observation.observations >= limits.preflightObservationLimit) { observation.truncated = true; return; }
  observation.observations++;
  const parsed = sealPreflightSchema.safeParse(value);
  if (!parsed.success || new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > limits.preflightBytes) {
    observation.truncated = true; return;
  }
  observation.latest = parsed.data;
}

function normalizeSealPreflightData(part: Record<string, unknown>, limits: DispatcherCapacities): void {
  const parsed = sealPreflightSchema.safeParse(part.data);
  const valid = !part.dataProjectionOversized && parsed.success
    && new TextEncoder().encode(JSON.stringify(part.data)).byteLength <= limits.preflightBytes;
  Object.defineProperty(part, 'data', { value: valid && parsed.success ? parsed.data : undefined,
    enumerable: false, configurable: true, writable: true });
  delete part.dataProjectionOversized;
}

function observeCompletion(state: DispatcherResultProjection, id: unknown,
  outcome: 'pending' | 'succeeded' | 'failed', limits: DispatcherCapacities): void {
  const completion = state.completion ??= { calls: [], truncated: false };
  if (typeof id !== 'string' || !id || id.length > MAX_COMPLETION_ID_LENGTH) {
    completion.truncated = true; return;
  }
  const previous = completion.calls.find(call => call.id === id);
  if (previous) {
    if (outcome !== 'pending') previous.outcome = outcome;
  } else if (completion.calls.length < limits.completionObservationLimit) completion.calls.push({ id, outcome });
  else completion.truncated = true;
}

function project(state: DispatcherResultProjection, value: unknown, submissionId: string, limits: DispatcherCapacities): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Dispatcher update unavailable');
  const chunk = value as Record<string, unknown>;
  // The pinned SDK prefixes every updates page with stream identity, not a conversation event.
  if (chunk.type === 'stream-checkpoint') {
    if (typeof chunk.incarnation !== 'string' || !chunk.incarnation || chunk.incarnation.length > 512
      || (state.incarnation !== undefined && state.incarnation !== chunk.incarnation)) throw new Error('Dispatcher stream incarnation changed');
    state.incarnation = chunk.incarnation;
    return;
  }
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
  if (chunk.unmatchedAssessment === true) state.unmatchedAssessment = true;
  if (chunk.type === 'conversation-reset') {
    const snapshot = chunk.snapshot as { messages?: Array<{ id?: string; submissionId?: string; diagnosticTruncated?: boolean; toolsTruncated?: boolean;
      parts?: Array<{ type?: string; data?: unknown; toolName?: string; toolCallId?: string; state?: string; diagnosticTruncated?: boolean }> }>;
      settlements?: Array<{ submissionId?: string; outcome?: string; error?: unknown }> } | undefined;
    if (!snapshot || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.settlements)
      || (chunk.snapshot as { conversationId?: unknown }).conversationId !== chunk.conversationId) throw new Error('Dispatcher reset unavailable');
    state.messageIds = []; state.writes = 0; delete state.result; delete state.outcome; delete state.error;
    for (const message of snapshot.messages) {
      if (message.submissionId !== submissionId) continue;
      if (typeof message.id !== 'string' || !Array.isArray(message.parts)) throw new Error('Dispatcher reset message unavailable');
      state.messageIds.push(message.id);
      if (message.diagnosticTruncated) (state.completion ??= { calls: [], truncated: false }).truncated = true;
      if (message.toolsTruncated) (state.tools ??= { calls: [], truncated: false }).truncated = true;
      for (const part of message.parts) {
        if (part.type === 'data-assessment' || part.type === 'data-result') captureResult(state, part.data, limits);
        if (part.type === 'data-dispatcher-readiness') observeReadiness(state, part.data, limits);
        if (part.type === 'data-dispatcher-seal-preflight') observeSealPreflight(state, part.data, limits);
        if (part.type === 'dynamic-tool') observeTool(state, part.toolCallId, part.toolName,
          part.state === 'output-available' ? 'succeeded' : part.state === 'output-error' ? 'failed' : 'pending', limits);
        if (part.type === 'dynamic-tool' && part.toolName === 'finish_dispatcher') {
          observeCompletion(state, part.toolCallId, part.state === 'output-available' ? 'succeeded'
            : part.state === 'output-error' ? 'failed' : 'pending', limits);
          if (part.diagnosticTruncated) (state.completion ??= { calls: [], truncated: false }).truncated = true;
        }
      }
    }
    const settlements = snapshot.settlements.filter(item => item.submissionId === submissionId);
    if (settlements.length > 1) throw new Error('Dispatcher settlement duplicated');
    if (settlements[0]) { chunk.outcome = settlements[0].outcome; chunk.error = settlements[0].error; }
  } else if (chunk.type === 'message-started' && chunk.submissionId === submissionId) {
    if (typeof chunk.messageId !== 'string' || chunk.messageId.length > 256) throw new Error('Dispatcher message unavailable');
    if (!state.messageIds.includes(chunk.messageId)) state.messageIds.push(chunk.messageId);
  } else if (chunk.type === 'data-part' && (chunk.name === 'assessment' || chunk.name === 'result')) {
    if (state.messageIds.includes(chunk.messageId as string)) captureResult(state, chunk.data, limits);
    else state.unmatchedAssessment = true;
  } else if (chunk.type === 'data-part' && chunk.name === 'dispatcher-readiness'
    && state.messageIds.includes(chunk.messageId as string)) {
    observeReadiness(state, chunk.data, limits);
  } else if (chunk.type === 'data-part' && chunk.name === 'dispatcher-seal-preflight'
    && state.messageIds.includes(chunk.messageId as string)) {
    observeSealPreflight(state, chunk.data, limits);
  } else if (chunk.type === 'tool-input' && state.messageIds.includes(chunk.messageId as string)) {
    observeTool(state, chunk.toolCallId, chunk.toolName, 'pending', limits);
    if (chunk.toolName === 'finish_dispatcher') observeCompletion(state, chunk.toolCallId, 'pending', limits);
  } else if ((chunk.type === 'tool-output' || chunk.type === 'tool-output-error')
    && state.completion?.calls.some(call => call.id === chunk.toolCallId)) {
    observeCompletion(state, chunk.toolCallId, chunk.type === 'tool-output' ? 'succeeded' : 'failed', limits);
  }
  if ((chunk.type === 'tool-output' || chunk.type === 'tool-output-error')
    && state.tools?.calls.some(call => call.id === chunk.toolCallId)) {
    observeTool(state, chunk.toolCallId, undefined, chunk.type === 'tool-output' ? 'succeeded' : 'failed', limits);
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
  if (previousResult !== undefined
    && JSON.stringify(previousResult) !== JSON.stringify(state.result)) throw new Error('Dispatcher immutable result changed');
  if (state.messageIds.length > 128) throw new Error('Dispatcher message bound exceeded');
  state.position = next;
}

/** Project SDK identity, named data, settlements and bounded completion metadata; discard history bodies.
 * The caller supplies the originally admitted capacity policy, not a refreshed operator policy.
 */
export async function readDispatcherUpdates(response: Response, previous: DispatcherResultProjection,
  submissionId: string, signal?: AbortSignal, capacityPolicy?: DispatcherCapacityPolicy): Promise<DispatcherResultProjection> {
  const limits = dispatcherCapacities(capacityPolicy);
  const offset = response.headers.get('stream-next-offset');
  if (response.status !== 200 || !response.body || !offset || offset.length > 2048
    || response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('Dispatcher updates unavailable');
  const state = structuredClone(previous);
  const reader = response.body.getReader();
  const tokenizer = new Tokenizer();
  const diagnosticFields = ['toolName', 'toolCallId', 'state'];
  const fields = ['type', 'incarnation', 'conversationId', 'position', 'messageId', 'submissionId', 'name', 'data', 'outcome', 'error',
    'toolName', 'toolCallId'];
  const parser = new TokenParser({ keepStack: false, paths: [
    ...fields.map(field => `$.*.${field}`), '$.*.snapshot.conversationId',
    '$.*.snapshot.messages.*.id', '$.*.snapshot.messages.*.submissionId',
    '$.*.snapshot.messages.*.parts.*.type', '$.*.snapshot.messages.*.parts.*.data',
    ...diagnosticFields.map(field => `$.*.snapshot.messages.*.parts.*.${field}`),
    '$.*.snapshot.settlements.*',
  ] });
  type Frame = { path: Array<string | number>; array: boolean; index: number; key?: string; expectingKey: boolean;
    diagnosticStart?: number; toolDiagnosticStart?: number };
  const frames: Frame[] = [];
  let record: Record<string, unknown> = Object.create(null);
  let bytes = 0;
  let records = 0;
  let diagnosticParts = 0;
  let toolParts = 0;
  let ended = false;
  // Diagnostic metadata is separately bounded and must not consume the existing result-record allowance.
  const put = (path: Array<string | number>, value: unknown, enumerable = true) => {
    let target = record as Record<string | number, unknown>;
    for (let index = 0; index < path.length; index++) {
      const key = path[index];
      if (index === path.length - 1) {
        Object.defineProperty(target, key, { value, enumerable, configurable: true, writable: true });
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
      if (path[3] === 'parts' && message?.submissionId !== undefined && message.submissionId !== submissionId) {
        if (path[5] === 'type' && (value === 'data-assessment' || value === 'data-result')) put(['unmatchedAssessment'], true, false);
        return;
      }
      if (path[3] === 'parts' && path[5] === 'data') {
        const part = message?.parts?.[path[4] as number] as { type?: string } | undefined;
        if (part?.type !== undefined && part.type !== 'data-assessment' && part.type !== 'data-result'
          && part.type !== 'data-dispatcher-readiness' && part.type !== 'data-dispatcher-seal-preflight') return;
      }
    }
    const diagnostic = (path.length === 1 && diagnosticFields.includes(String(path[0])))
      || (path.length === 6 && path[0] === 'snapshot' && path[1] === 'messages'
        && path[3] === 'parts' && diagnosticFields.includes(String(path[5])));
    if (diagnostic) {
      if (path.at(-1) === 'toolName') {
        if (typeof value !== 'string' || !Object.hasOwn(toolRoles, value)) return;
      } else if (typeof value !== 'string' || !value || value.length > MAX_COMPLETION_ID_LENGTH) {
        if (path.length === 6) put([...path.slice(0, -1), 'diagnosticTruncated'], true, false);
        return;
      }
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > limits.assessmentBytes) {
      // The name/type may follow data. Defer only data's existing denial until attribution.
      if ((path.length === 1 && path[0] === 'data') || (path.length === 6 && path[3] === 'parts' && path[5] === 'data')) {
        put([...path.slice(0, -1), 'dataProjectionOversized'], true, false); return;
      }
      throw new Error('Dispatcher projected value exceeds limit');
    }
    put(path, value, !diagnostic);
    if (path[0] === 'snapshot' && path[1] === 'messages' && path[3] === 'submissionId' && value !== submissionId) {
      const message = snapshotMessages()?.[path[2] as number];
      if (message) {
        if (message.parts?.some(part => ['data-assessment', 'data-result'].includes((part as { type?: string })?.type ?? ''))) {
          put(['unmatchedAssessment'], true, false);
        }
        message.parts = [];
      }
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
      frames.push({ path, array: kind === TokenType.LEFT_BRACKET, index: 0, expectingKey: true,
        ...(path.length === 4 && path[1] === 'snapshot' && path[2] === 'messages'
          ? { diagnosticStart: diagnosticParts, toolDiagnosticStart: toolParts } : {}) });
      if (frames.length > 128) throw new Error('Dispatcher update nesting exceeds limit');
      parser.write(token);
      return;
    }
    if (kind === TokenType.RIGHT_BRACE || kind === TokenType.RIGHT_BRACKET) {
      parser.write(token);
      const frame = frames.pop();
      if (!frame) throw new Error('Dispatcher update trailer unavailable');
      if (frame.path.length === 6 && frame.path[1] === 'snapshot' && frame.path[2] === 'messages'
        && frame.path[4] === 'parts') {
        const part = snapshotMessages()?.[frame.path[3] as number]?.parts?.[frame.path[5] as number] as Record<string, unknown> | undefined;
        if (part) {
          if (part.type === 'data-dispatcher-readiness') normalizeReadinessData(part, limits);
          else if (part.type === 'data-dispatcher-seal-preflight') normalizeSealPreflightData(part, limits);
          else if (part.dataProjectionOversized) throw new Error('Dispatcher projected value exceeds limit');
          const completionPart = part.type === 'dynamic-tool' && part.toolName === 'finish_dispatcher';
          const otherTool = part.type === 'dynamic-tool' && typeof part.toolName === 'string'
            && Object.hasOwn(toolRoles, part.toolName) && !completionPart;
          if (otherTool && toolParts < limits.toolObservationLimit) { toolParts++; }
          else if (!completionPart || diagnosticParts >= limits.completionObservationLimit) {
            if (completionPart) put(['snapshot', 'messages', frame.path[3], 'diagnosticTruncated'], true, false);
            if (otherTool) put(['snapshot', 'messages', frame.path[3], 'toolsTruncated'], true, false);
            for (const field of [...diagnosticFields, 'diagnosticTruncated']) delete part[field];
          } else diagnosticParts++;
        }
      }
      // Parts may precede submissionId. Foreign candidates remain bounded but cannot spend the requested budget.
      if (frame.diagnosticStart !== undefined
        && snapshotMessages()?.[frame.path[3] as number]?.submissionId !== submissionId) {
        diagnosticParts = frame.diagnosticStart;
        toolParts = frame.toolDiagnosticStart ?? toolParts;
      }
      if (frame.path.length === 1) {
        if (record.type === 'data-part' && record.name === 'dispatcher-readiness') normalizeReadinessData(record, limits);
        else if (record.type === 'data-part' && record.name === 'dispatcher-seal-preflight') normalizeSealPreflightData(record, limits);
        else if (record.dataProjectionOversized) throw new Error('Dispatcher projected value exceeds limit');
        if (++records > 65536) throw new Error('Dispatcher update count exceeds limit');
        const snapshot = record.snapshot as { messages?: Array<{ submissionId?: string }> } | undefined;
        if (Array.isArray(snapshot?.messages)) snapshot.messages = snapshot.messages.filter(message => message?.submissionId === submissionId);
        if (new TextEncoder().encode(JSON.stringify(record)).byteLength > limits.projectedRecordBytes) throw new Error('Dispatcher projection exceeds limit');
        project(state, record, submissionId, limits);
        record = Object.create(null);
        diagnosticParts = 0;
        toolParts = 0;
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
      if (bytes > limits.updatePageBytes) throw new Error('Dispatcher update page exceeds limit');
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
