/** Parent-only inference attempt wire. Intermediate responses never reach the SDK. */
export interface DispatcherInferenceResponse { status: number; contentType: string; body: string }
export interface DispatcherInferenceSelection { routeId: string; reasoningLevel: string | null }
export interface DispatcherInferenceChain { version: 1; attempt: number; selection?: DispatcherInferenceSelection }
export type DispatcherInferenceClassification = 'usable' | 'final-error' | 'retryable' | 'permanent';
export interface DispatcherInferenceAttempt {
  index: number;
  ordinal: number;
  phase: 'ready' | 'in-flight' | 'completed' | 'unknown';
  notBefore: number;
  owner?: number;
  successor?: number;
  classification?: DispatcherInferenceClassification | 'transport';
  /** Separate bounded body; a usable/final-error attempt references the unchanged logical cache key. */
  responseKey?: string;
  responseDigest?: string;
}
export const inferenceAttemptKey = (generation: number, operationId: string, index: number) =>
  `dispatcher:inference-attempt:${generation}:${operationId}:${index}`;

/** Full bounded response classification, NOT sampled diagnostics or assessment validation. */
export function classifyDispatcherInference(response: DispatcherInferenceResponse, streaming = true): DispatcherInferenceClassification {
  if ([429, 500, 502, 503, 504].includes(response.status)) return 'retryable';
  // Known terminal protocol errors remain immutable SDK inputs (including context-overflow handling).
  if (response.status >= 400) return 'final-error';
  if (response.status < 200 || response.status >= 300) return 'permanent';
  let finished = false;
  let finalError = false;
  let failed = false;
  let invalid = false;
  const chunk = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { invalid = true; return; }
    const data = value as { error?: unknown; choices?: Array<{ finish_reason?: unknown }> };
    if (data.error !== undefined) {
      if (data.error && typeof data.error === 'object' && !Array.isArray(data.error)) {
        const error = data.error as { code?: string; type?: string };
        if (['NATIVE_BEDROCK_STREAM_ERROR', 'server_error', 'overloaded_error', 'rate_limit_error'].includes(error.code ?? error.type ?? '')) failed = true;
        else finalError = true;
      } else invalid = true;
    }
    if (data.choices !== undefined && !Array.isArray(data.choices)) { invalid = true; return; }
    const choice = data.choices?.[0];
    if (choice !== undefined && (!choice || typeof choice !== 'object' || Array.isArray(choice))) { invalid = true; return; }
    const reason = choice?.finish_reason;
    if (reason === undefined || reason === null || reason === '') return;
    // Same non-error finishes as the pinned public Workers AI provider; length is not retried.
    if (['stop', 'eos', 'length', 'tool_calls', 'function_call'].includes(String(reason))) finished = true;
    else if (reason === 'error') failed = true;
    else if (['context_length_exceeded', 'content_filter'].includes(String(reason))) finalError = true;
    else invalid = true;
  };
  try {
    if (streaming && /^text\/event-stream(?:;|$)/i.test(response.contentType)) {
      let data: string[] = [];
      const flush = () => {
        if (!data.length) return;
        const value = data.join('\n').trim(); data = [];
        if (value && value !== '[DONE]') chunk(JSON.parse(value));
      };
      // Match the pinned provider's LF/CRLF framing, including its EOF flush.
      if (/\r(?!\n)/.test(response.body)) return 'permanent';
      for (const line of response.body.split(/\r?\n/)) {
        if (line === '') flush();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      flush();
    } else if (!streaming && /^application\/json(?:;|$)/i.test(response.contentType)) chunk(JSON.parse(response.body));
    else return 'permanent';
  } catch { return 'permanent'; }
  return invalid ? 'permanent' : finalError ? 'final-error' : failed || !finished ? 'retryable' : 'usable';
}

/** Durable not-before time is allocated once per successor, never renewed on reconstruction. */
export function inferenceRetryDelay(index: number): number {
  return 1000 * 2 ** Math.min(index, 3);
}
