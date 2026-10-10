import { createLogger } from './logger';

/** Parent-owned correlation; never populated from model input or operation IDs. */
export interface InferenceDiagnosticContext {
  activityId: string;
  generation: number;
  loggingEnabled?: boolean;
  operationOrdinal?: number;
  requestDigest?: string;
}
const logger = createLogger('operator-inference');
const categories: Record<string, ReadonlySet<string>> = {
  stage: new Set(['drive', 'operation-prepared', 'authority', 'journal', 'upstream', 'response-commit', 'journal-inspection',
    'route-selection', 'gateway-fetch', 'interceptor-response', 'native-request', 'native-response', 'native-stream', 'native-replay',
    'source-fetch', 'source-read', 'settlement', 'assessment', 'sdk-release', 'collection', 'cleanup', 'inference-attempt']),
  outcome: new Set(['started', 'completed', 'failed', 'canceled', 'reserved', 'cached', 'conflict', 'unknown', 'denied', 'observed', 'pending', 'aborted']),
  boundary: new Set(['authority', 'artifact', 'lease', 'loader', 'admission', 'cursor', 'commit', 'snapshot', 'projection', 'recheck', 'status', 'assessment', 'operations']),
  resource: new Set(['inference', 'source', 'comment', 'merge', 'pull-request', 'files', 'checks', 'release-notes', 'upstream-guide', 'changed-compose', 'open-pull-requests', 'unparsed']),
  transport: new Set(['invoke', 'eventstream', 'compat', 'rest']),
  inferenceOutcome: new Set(['usable', 'final-error', 'retryable', 'permanent', 'transport']),
  contentType: new Set(['sse', 'json', 'eventstream', 'other']),
  stopReason: new Set(['stop', 'tool_calls', 'length', 'content_filter', 'none', 'other']),
  streamError: new Set(['native-error', 'other-error', 'none']),
  physicalCleanup: new Set(['unknown', 'pending', 'stopping']),
  sdkErrorType: new Set(['cloudflare_ai_binding_error', 'invalid_request', 'tool_input_validation',
    'tool_output_validation', 'operation_failed', 'submission_timeout', 'submission_aborted',
    'internal_error', 'submission_retry_exhausted', 'other']),
  failureClass: new Set(['frame-integrity', 'frame-payload', 'frame-headers', 'frame-size', 'frame-content-type', 'provider-exception',
    'provider-error', 'event-sequence', 'replay-limit', 'replay-schema', 'truncated-frame', 'missing-stop', 'stop-reason', 'tool-arguments',
    'replay-persistence', 'replay-encryption', 'replay-load', 'stream-read', 'request-invalid', 'native-response', 'gateway-fetch', 'upstream-status',
    'body-read', 'body-limit', 'authority', 'commit', 'sdk-cleanup', 'model-completion', 'persistence', 'superseded', 'unknown',
    'not-ready', 'not-admitted', 'source-fetch', 'source-read', 'source-reflection', 'source-envelope', 'assessment', 'loader', 'admission']),
};
const numeric = new Set(['operationOrdinal', 'operationCount', 'operationLimit', 'responseBytes', 'inputBytes', 'requestBytes',
  'elapsedMs', 'frames', 'events', 'chunks', 'replayBytes', 'serializedReplayBytes', 'replayLimit', 'frameLimit', 'toolBlocks', 'status', 'sourceStatus',
  'messages', 'tools', 'replayLoads', 'replayMissing', 'inferenceRequestBytes', 'inspectedEntries', 'journalCount', 'unresolved', 'completionCalls', 'results',
  'toolCallCount', 'toolArgumentBytes', 'toolArgumentFieldCount', 'toolUnknownFieldCount', 'inferenceAttempt', 'inferenceAttemptLimit']);
const flags = new Set(['sampled', 'doneObserved', 'malformedObserved', 'sdkReleased', 'assessmentPresent', 'thinkingPresent',
  'toolArgumentsObserved', 'toolArgumentsMalformed']);
const toolRoles = new Set(['discover', 'research', 'decide', 'seal', 'comment', 'merge', 'finish', 'generic-finish', 'unknown']);
const toolFields = new Set(['target', 'decision', 'comment', 'claims', 'bindings', 'analysis', 'url', 'kind', 'offset']);
const roleNames: Record<string, string> = { discover_renovate: 'discover', research_renovate: 'research', decide_renovate: 'decide',
  seal_dispatcher: 'seal', comment_renovate: 'comment', merge_renovate: 'merge', finish_dispatcher: 'finish', finish: 'generic-finish' };

/** Closed logging wire. Logging failures cannot change execution or response outcomes. */
export function inferenceDiagnostic(context: InferenceDiagnosticContext | undefined,
  observation: { stage: string; outcome: string } & Record<string, unknown>): void {
  try {
    if (context?.loggingEnabled === false) return;
    if (!categories.stage.has(observation.stage) || !categories.outcome.has(observation.outcome)) return;
    const data: Record<string, unknown> = { schemaVersion: 1 };
    if (context) {
      data.activityId = context.activityId;
      data.generation = context.generation;
      if (Number.isSafeInteger(context.operationOrdinal) && context.operationOrdinal! >= 0) data.operationOrdinal = context.operationOrdinal;
      if (context.requestDigest && /^[a-f0-9]{64}$/.test(context.requestDigest)) data.requestDigest = context.requestDigest;
    }
    for (const [key, value] of Object.entries(observation)) {
      if (categories[key]?.has(value as string)) data[key] = value;
      else if (numeric.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0
        && (key === 'elapsedMs' || Number.isSafeInteger(value))) data[key] = value;
      else if (flags.has(key) && typeof value === 'boolean') data[key] = value;
      else if (key === 'responseDigest' && typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) data[key] = value;
      else if (key === 'toolRoles' && Array.isArray(value) && value.length <= 16 && value.every(role => toolRoles.has(role))) data[key] = value;
      else if (key === 'toolArgumentFields' && Array.isArray(value) && value.length <= 9 && value.every(field => toolFields.has(field))) data[key] = value;
    }
    logger.info('Inference pipeline observed', data);
  } catch { /* Observation is never authority or an execution dependency. */ }
}

/** Sample only the bounded final SSE records; never certify model completion. */
export function inferenceResponseObservation(value: { body: string; contentType: string }) {
  const bytes = new TextEncoder().encode(value.body);
  const result = { responseBytes: bytes.length, stopReason: 'none', streamError: 'none', doneObserved: false,
    malformedObserved: false, sampled: bytes.length > 65536, toolCallCount: 0, toolArgumentBytes: 0,
    toolArgumentsObserved: false, toolArgumentsMalformed: false, toolArgumentFieldCount: 0, toolUnknownFieldCount: 0,
    toolRoles: [] as string[], toolArgumentFields: [] as string[] };
  const calls = new Map<number, { name: string; arguments: string }>();
  if (!/^text\/event-stream(?:;|$)/i.test(value.contentType)) return result;
  let tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 65536)));
  if (result.sampled) tail = tail.slice(tail.indexOf('\n') + 1);
  const lines = tail.split('\n');
  if (lines.length > 256) result.sampled = true;
  for (const line of lines.slice(-256)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') { result.doneObserved = true; continue; }
    try {
      const event = JSON.parse(data);
      if (event?.error) result.streamError = event.error.code === 'NATIVE_BEDROCK_STREAM_ERROR' ? 'native-error' : 'other-error';
      if (Array.isArray(event?.choices)) for (const choice of event.choices) {
        if (choice?.finish_reason != null) result.stopReason = categories.stopReason.has(choice.finish_reason) ? choice.finish_reason : 'other';
        const toolCalls = choice?.delta?.tool_calls ?? choice?.message?.tool_calls ?? [];
        if (!Array.isArray(toolCalls)) { result.malformedObserved = true; continue; }
        for (const [position, call] of toolCalls.entries()) {
          if (!Number.isSafeInteger(call?.index ?? position) || (call.index ?? position) < 0) continue;
          const index = call.index ?? position;
          if (!calls.has(index) && calls.size >= 16) { result.sampled = true; continue; }
          const retained = calls.get(index) ?? { name: '', arguments: '' };
          if (typeof call?.function?.name === 'string') retained.name += call.function.name;
          if (typeof call?.function?.arguments === 'string') retained.arguments += call.function.arguments;
          calls.set(index, retained);
        }
      }
    } catch { result.malformedObserved = true; }
  }
  result.toolCallCount = calls.size;
  for (const call of calls.values()) {
    result.toolArgumentBytes += new TextEncoder().encode(call.arguments).length;
    const role = Object.hasOwn(roleNames, call.name) ? roleNames[call.name] : 'unknown';
    if (!result.toolRoles.includes(role)) result.toolRoles.push(role);
    if (result.sampled) continue;
    result.toolArgumentsObserved = true;
    try {
      const argumentsValue: unknown = JSON.parse(call.arguments);
      if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
        result.toolArgumentsMalformed = true; continue;
      }
      for (const field of Object.keys(argumentsValue)) {
        result.toolArgumentFieldCount++;
        if (toolFields.has(field)) { if (!result.toolArgumentFields.includes(field)) result.toolArgumentFields.push(field); }
        else result.toolUnknownFieldCount++;
      }
    } catch { result.toolArgumentsMalformed = true; }
  }
  return result;
}
