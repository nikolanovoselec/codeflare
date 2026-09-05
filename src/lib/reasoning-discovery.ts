// Ported from the validated Worker prototype:
// codeflare-profile-discovery.mjs
// SHA-256 f0f68dbb8415d5aaccf2d3b03002153be2dbbdb61bde3c209384d687dc5a2985
// Its validation fixture is SHA-256 a5ccaea163d5920eb2ece172b8b7048751a383467272ad704c39bdabc0a0405b.

export const PI_WIRE_CANARY_VERSION = 'pi-openai-completions-0.84.4-canary-v1';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ReasoningLevel = typeof LEVELS[number];
type JsonScalar = string | number | boolean | null;
type PlainObject = Record<string, unknown>;

const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_text'] as const;
const REPLAY_REASONING_FIELDS = new Set<string>(REASONING_FIELDS);
const CANARY_TOOL_NAME = 'codeflare_profile_canary';
const CANARY_TOOL_RESULT = 'ok';
const SAFE_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']);
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_COMPLETION_CEILING = 16_384;
const MAX_REASONING_PROBES = 5;
const MAX_TOOL_CANARIES = 7;
const SAFE_MAPPING_ROOTS = new Set(['reasoning_effort', 'reasoning', 'thinking', 'chat_template_kwargs']);
const SAFE_CHAT_TEMPLATE_KEYS = new Set(['enable_thinking', 'thinking', 'clear_thinking']);
const DANGEROUS_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

const CANARY_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: CANARY_TOOL_NAME,
    description: 'Return the supplied canary value.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    strict: false,
  },
});

interface SemanticMapping {
  mapping: PlainObject;
  removePaths: string[];
}

interface DiscoveryProfile {
  id: string;
  supportedLevels: ReasoningLevel[];
  levels: Partial<Record<ReasoningLevel, SemanticMapping>>;
}

export interface DiscoveryEndpoint {
  rest: string;
  compat: string;
}

export interface DiscoveryInput {
  accountId?: string;
  gatewayId?: string;
  apiToken?: string;
  endpoint?: DiscoveryEndpoint;
  route: string;
  profile: unknown;
  maxCompletionTokens: number;
  offCandidateMapping?: unknown;
  fetcher?: typeof fetch;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ParsedPiSse {
  content: string;
  reasoningBlocks: Array<{ signature: string; text: string }>;
  toolCalls: Array<{ id: string; type: string; name: string; argumentsText: string }>;
  rawFinishReason: string | null;
  effectiveFinishReason: string | null;
  finishReasonRepaired: boolean;
  sawDone: boolean;
  doneRepaired: boolean;
  usage: Record<string, unknown> | null;
  eventCount: number;
  malformedEvents: number;
}

export interface ChatCompletionsAttemptInput {
  accountId?: string;
  gatewayId?: string;
  apiToken: string;
  endpoint?: DiscoveryEndpoint;
  body: PlainObject;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ChatCompletionsAttempt {
  response: Response;
  attempts: number;
  transport: 'rest' | 'compat';
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is PlainObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function deletePath(target: PlainObject, path: string): void {
  const parts = path.split('.');
  let cursor: PlainObject = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const next = cursor[parts[index]];
    if (!isPlainObject(next)) return;
    cursor = next;
  }
  delete cursor[parts[parts.length - 1]];
}

function setPath(target: PlainObject, path: string, value: JsonScalar): void {
  const parts = path.split('.');
  if (parts.some((part) => DANGEROUS_PATH_SEGMENTS.has(part))) throw new TypeError('Invalid profile mapping path');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as PlainObject;
  }
  cursor[parts[parts.length - 1]] = value;
}

function mergeData(target: PlainObject, source: PlainObject): PlainObject {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value)) {
      if (!isPlainObject(target[key])) target[key] = {};
      mergeData(target[key] as PlainObject, value);
    } else {
      target[key] = clone(value);
    }
  }
  return target;
}

function isScalar(value: unknown): value is JsonScalar {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function validatePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 120) throw new TypeError('Invalid profile mapping path');
  const parts = path.split('.');
  if (parts.some((part) => DANGEROUS_PATH_SEGMENTS.has(part))) throw new TypeError('Invalid profile mapping path');
  if (!SAFE_MAPPING_ROOTS.has(parts[0])) throw new TypeError(`Unsafe profile mapping root: ${parts[0]}`);
  if (parts[0] === 'chat_template_kwargs') {
    if (parts.length !== 2 || !SAFE_CHAT_TEMPLATE_KEYS.has(parts[1])) throw new TypeError('Unsafe chat_template_kwargs key');
  } else if (parts.length !== 1) {
    throw new TypeError(`${parts[0]} must be a scalar or null`);
  }
}

function validateMapping(mapping: unknown): asserts mapping is PlainObject {
  if (!isPlainObject(mapping)) throw new TypeError('Each level mapping must be an object');
  for (const [key, value] of Object.entries(mapping)) {
    if (!SAFE_MAPPING_ROOTS.has(key)) throw new TypeError(`Unsafe profile mapping root: ${key}`);
    if (key === 'chat_template_kwargs') {
      if (!isPlainObject(value)) throw new TypeError('chat_template_kwargs must be an object');
      for (const [child, childValue] of Object.entries(value)) {
        if (!SAFE_CHAT_TEMPLATE_KEYS.has(child)) throw new TypeError(`Unsafe chat_template_kwargs key: ${child}`);
        if (!isScalar(childValue)) throw new TypeError(`chat_template_kwargs.${child} must be a scalar or null`);
      }
    } else if (!isScalar(value)) {
      throw new TypeError(`${key} must be a scalar or null`);
    }
  }
}

function mappingFromWrites(writes: unknown): PlainObject {
  if (!Array.isArray(writes)) throw new TypeError('Profile level writes must be an array');
  const mapping: PlainObject = {};
  for (const write of writes) {
    if (!isPlainObject(write) || !isScalar(write.value)) throw new TypeError('Profile writes require bounded scalar values');
    validatePath(write.path);
    setPath(mapping, write.path, write.value);
  }
  validateMapping(mapping);
  return mapping;
}

function normalizeLevelMapping(raw: unknown, profileRemovePaths: string[]): SemanticMapping {
  if (Array.isArray(raw)) return { mapping: mappingFromWrites(raw), removePaths: [...profileRemovePaths] };
  if (isPlainObject(raw) && ('writes' in raw || 'removePaths' in raw)) {
    const removePaths = [...profileRemovePaths, ...normalizeRemovePaths(raw.removePaths ?? [])];
    return { mapping: mappingFromWrites(raw.writes ?? []), removePaths };
  }
  validateMapping(raw);
  return { mapping: clone(raw), removePaths: [...profileRemovePaths] };
}

function normalizeRemovePaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new TypeError('removePaths must be an array');
  return raw.map((path) => {
    validatePath(path);
    return path;
  });
}

function normalizeProfile(raw: unknown): DiscoveryProfile {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 128) {
    throw new TypeError('Invalid profile');
  }
  if (!Array.isArray(raw.supportedLevels) || raw.supportedLevels.length === 0) throw new TypeError('Profile requires supportedLevels');
  const supportedLevels = raw.supportedLevels.map((level) => {
    if (typeof level !== 'string' || !(LEVELS as readonly string[]).includes(level)) throw new TypeError(`Unknown level: ${String(level)}`);
    return level as ReasoningLevel;
  });
  if (new Set(supportedLevels).size !== supportedLevels.length) throw new TypeError('Profile levels must be unique');
  const profileRemovePaths = normalizeRemovePaths(raw.removePaths ?? []);
  const rawLevels = isPlainObject(raw.levelMappings) ? raw.levelMappings : raw.levels;
  if (!isPlainObject(rawLevels)) throw new TypeError('Profile requires level mappings');
  const levels: Partial<Record<ReasoningLevel, SemanticMapping>> = {};
  for (const level of supportedLevels) {
    if (!(level in rawLevels)) throw new TypeError(`Missing mapping for level: ${level}`);
    levels[level] = normalizeLevelMapping(rawLevels[level], profileRemovePaths);
  }
  return { id: raw.id, supportedLevels, levels };
}

function normalizeStandaloneMapping(raw: unknown): SemanticMapping {
  return normalizeLevelMapping(raw, []);
}

function validateInput(input: DiscoveryInput): { profile: DiscoveryProfile; offCandidate?: SemanticMapping } {
  if (!isPlainObject(input)) throw new TypeError('Discovery input is required');
  if (!/^dynamic\/[A-Za-z0-9._/-]{1,180}$/.test(input.route)) throw new TypeError('Route must be a bounded dynamic route');
  if (!Number.isInteger(input.maxCompletionTokens)
    || input.maxCompletionTokens < 32
    || input.maxCompletionTokens > MAX_COMPLETION_CEILING) {
    throw new TypeError('Requested completion ceiling must be between 32 and 16384');
  }
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > DEFAULT_TIMEOUT_MS)) {
    throw new TypeError('Discovery timeout exceeds the per-attempt limit');
  }
  if (input.maxResponseBytes !== undefined
    && (!Number.isInteger(input.maxResponseBytes) || input.maxResponseBytes < 1 || input.maxResponseBytes > DEFAULT_MAX_RESPONSE_BYTES)) {
    throw new TypeError('Invalid discovery response byte limit');
  }
  if (!input.endpoint) {
    if (!input.accountId || !/^[a-f0-9]{32}$/i.test(input.accountId)) throw new TypeError('Invalid Cloudflare account ID');
    if (!input.gatewayId || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(input.gatewayId)) throw new TypeError('Invalid AI Gateway ID');
  } else {
    for (const endpoint of [input.endpoint.rest, input.endpoint.compat]) {
      let parsed: URL;
      try { parsed = new URL(endpoint); } catch { throw new TypeError('Invalid discovery endpoint'); }
      if (parsed.protocol !== 'https:' || endpoint.length > 512) throw new TypeError('Invalid discovery endpoint');
    }
  }
  if (typeof input.apiToken !== 'string' || input.apiToken.length < 8) throw new TypeError('Worker-side API token is required');

  const profile = normalizeProfile(input.profile);
  const offCandidate = input.offCandidateMapping === undefined ? undefined : normalizeStandaloneMapping(input.offCandidateMapping);
  const groups = groupMappings(profile);
  const reasoningProbeCount = groups.length + (offCandidate ? 1 : 0);
  if (reasoningProbeCount > MAX_REASONING_PROBES) throw new TypeError('Discovery permits at most five reasoning probes');
  if (groups.length > MAX_TOOL_CANARIES) throw new TypeError('Discovery permits at most seven semantic-mode tool canaries');
  return { profile, ...(offCandidate && { offCandidate }) };
}

function applySemanticMapping(payload: PlainObject, semantic: SemanticMapping): PlainObject {
  const result = clone(payload);
  for (const path of semantic.removePaths) deletePath(result, path);
  return mergeData(result, semantic.mapping);
}

export function applyProfileMapping(payload: PlainObject, rawProfile: unknown, level: string): PlainObject {
  const profile = normalizeProfile(rawProfile);
  if (!profile.supportedLevels.includes(level as ReasoningLevel)) throw new TypeError(`Unsupported profile level: ${level}`);
  return applySemanticMapping(payload, profile.levels[level as ReasoningLevel] as SemanticMapping);
}

function basePiMessages(prompt: string): Array<Record<string, unknown>> {
  return [
    {
      role: 'system',
      content: 'You are a deterministic protocol compatibility canary. Follow the user request and use only the provided inert function.',
    },
    { role: 'user', content: prompt },
  ];
}

export function buildInitialPiRequest(input: {
  route: string;
  mapping: PlainObject;
  maxCompletionTokens: number;
  sessionId?: string;
}): PlainObject {
  validateMapping(input.mapping);
  const sessionId = input.sessionId ?? 'reasoning-profile-discovery-v1';
  return mergeData({
    model: input.route,
    messages: basePiMessages(`Call ${CANARY_TOOL_NAME} with value "ok". After its result, reply exactly DONE.`),
    stream: true,
    prompt_cache_key: sessionId.slice(0, 64),
    stream_options: { include_usage: true },
    store: false,
    max_completion_tokens: input.maxCompletionTokens,
    tools: [clone(CANARY_TOOL)],
  }, input.mapping);
}

function buildReasoningRequest(input: {
  route: string;
  mapping: PlainObject;
  maxCompletionTokens: number;
  sessionId?: string;
}): PlainObject {
  const sessionId = input.sessionId ?? 'reasoning-profile-discovery-v1';
  return mergeData({
    model: input.route,
    messages: basePiMessages('Compute (37 × 41) + (29 × 31) − 17. Reply with only the integer.'),
    stream: true,
    prompt_cache_key: sessionId.slice(0, 64),
    stream_options: { include_usage: true },
    store: false,
    max_completion_tokens: input.maxCompletionTokens,
  }, input.mapping);
}

function appendReasoningBlock(blocks: ParsedPiSse['reasoningBlocks'], signature: string, text: string): void {
  const previous = blocks.at(-1);
  if (previous?.signature === signature) previous.text += text;
  else blocks.push({ signature, text });
}

function newParsedState(): ParsedPiSse {
  return {
    content: '', reasoningBlocks: [], toolCalls: [], rawFinishReason: null,
    effectiveFinishReason: null, finishReasonRepaired: false, sawDone: false,
    doneRepaired: false, usage: null, eventCount: 0, malformedEvents: 0,
  };
}

function consumeSseData(payload: string, state: ParsedPiSse): void {
  if (payload === '[DONE]') {
    state.sawDone = true;
    return;
  }
  let event: unknown;
  try { event = JSON.parse(payload); } catch {
    state.malformedEvents += 1;
    return;
  }
  if (!isPlainObject(event)) {
    state.malformedEvents += 1;
    return;
  }
  state.eventCount += 1;
  if (isPlainObject(event.usage)) state.usage = event.usage;
  if (!Array.isArray(event.choices)) return;
  for (const rawChoice of event.choices) {
    if (!isPlainObject(rawChoice)) continue;
    if (typeof rawChoice.finish_reason === 'string') {
      state.rawFinishReason = SAFE_FINISH_REASONS.has(rawChoice.finish_reason) ? rawChoice.finish_reason : 'unknown';
    }
    const delta = isPlainObject(rawChoice.delta) ? rawChoice.delta : {};
    if (typeof delta.content === 'string') state.content += delta.content;
    for (const field of REASONING_FIELDS) {
      const value = delta[field];
      if (typeof value === 'string' && value.length > 0) {
        appendReasoningBlock(state.reasoningBlocks, field, value);
        break;
      }
    }
    if (!Array.isArray(delta.tool_calls)) continue;
    for (const rawToolCall of delta.tool_calls) {
      if (!isPlainObject(rawToolCall)) continue;
      const index = typeof rawToolCall.index === 'number' && Number.isInteger(rawToolCall.index) && rawToolCall.index >= 0
        ? rawToolCall.index : 0;
      state.toolCalls[index] ??= { id: '', type: 'function', name: '', argumentsText: '' };
      const current = state.toolCalls[index];
      if (typeof rawToolCall.id === 'string') current.id += rawToolCall.id;
      if (typeof rawToolCall.type === 'string') current.type = rawToolCall.type;
      const fn = isPlainObject(rawToolCall.function) ? rawToolCall.function : {};
      if (typeof fn.name === 'string') current.name += fn.name;
      if (typeof fn.arguments === 'string') current.argumentsText += fn.arguments;
    }
  }
}

function finishParsedSse(state: ParsedPiSse): ParsedPiSse {
  state.finishReasonRepaired = !state.rawFinishReason;
  state.doneRepaired = !state.sawDone;
  state.effectiveFinishReason = state.rawFinishReason ?? (state.toolCalls.length > 0 ? 'tool_calls' : 'stop');
  state.sawDone = true;
  return state;
}

export async function parsePiSseText(text: string): Promise<ParsedPiSse> {
  const state = newParsedState();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('data:')) consumeSseData(trimmed.slice(trimmed.indexOf(':') + 1).trim(), state);
  }
  return finishParsedSse(state);
}

async function parsePiSseStream(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<ParsedPiSse> {
  if (!stream) throw new Error('missing_response_body');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  const state = newParsedState();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel('response too large');
      throw new Error('response_too_large');
    }
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      const trimmed = line.trimStart();
      if (trimmed.startsWith('data:')) consumeSseData(trimmed.slice(trimmed.indexOf(':') + 1).trim(), state);
    }
  }
  buffer += decoder.decode();
  const trimmed = buffer.trimStart();
  if (trimmed.startsWith('data:')) consumeSseData(trimmed.slice(trimmed.indexOf(':') + 1).trim(), state);
  return finishParsedSse(state);
}

function parsedToolArguments(call: ParsedPiSse['toolCalls'][number]): { value: 'ok' } {
  const value: unknown = JSON.parse(call.argumentsText);
  if (!isPlainObject(value) || value.value !== 'ok' || Object.keys(value).some((key) => key !== 'value')) {
    throw new Error('Canary tool arguments did not match the bounded contract');
  }
  return { value: 'ok' };
}

export function buildPiReplayMessages(initialMessages: unknown, parsed: ParsedPiSse): Array<Record<string, unknown>> {
  if (!Array.isArray(initialMessages)) throw new Error('Initial Pi messages are required');
  if (parsed.toolCalls.length !== 1) throw new Error('Expected exactly one canary tool call');
  const call = parsed.toolCalls[0];
  if (!call.id || call.name !== CANARY_TOOL_NAME || call.type !== 'function') throw new Error('Invalid canary tool call');
  const assistant: Record<string, unknown> = { role: 'assistant' };
  if (parsed.content.length > 0) assistant.content = parsed.content;
  const nonEmptyThinking = parsed.reasoningBlocks.filter((block) => block.text.trim().length > 0);
  if (nonEmptyThinking.length > 0) {
    const signature = nonEmptyThinking[0].signature;
    if (REPLAY_REASONING_FIELDS.has(signature)) assistant[signature] = nonEmptyThinking.map((block) => block.text).join('\n');
  }
  assistant.tool_calls = [{
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(parsedToolArguments(call)) },
  }];
  return [
    ...(clone(initialMessages) as Array<Record<string, unknown>>),
    assistant,
    { role: 'tool', content: CANARY_TOOL_RESULT, tool_call_id: call.id },
  ];
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = '';
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel('response too large');
      throw new Error('response_too_large');
    }
    result += decoder.decode(value, { stream: true });
  }
  return result + decoder.decode();
}

function sanitizedError(status: number | null, text: string, codeOverride?: string): {
  status: number | null;
  code: unknown;
  type: unknown;
  bodyLength: number;
} {
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  const candidate = isPlainObject(body) ? body : {};
  const errors = Array.isArray(candidate.errors) && isPlainObject(candidate.errors[0]) ? candidate.errors[0] : {};
  const error = isPlainObject(candidate.error) ? candidate.error : {};
  const reportedCode = [errors.code, error.code, candidate.code].find((value) =>
    (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value)));
  const reportedType = [errors.type, error.type, candidate.type].find((value) =>
    typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value));
  return {
    status,
    code: codeOverride ?? reportedCode ?? null,
    type: reportedType ?? null,
    bodyLength: text.length,
  };
}

class DiscoveryAttemptError extends Error {
  constructor(public readonly kind: 'timeout' | 'transport_error' | 'response_too_large', public readonly attempts: number) {
    super(kind);
  }
}

async function fetchWithTimeout(fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number, attempt: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('discovery timeout'), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal, redirect: 'manual' });
  } catch {
    throw new DiscoveryAttemptError(controller.signal.aborted ? 'timeout' : 'transport_error', attempt);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Shared REST-first attempt primitive. Compat is attempted only after the REST
 * 404 body has been consumed completely, and removes only store and
 * prompt_cache_key from the replayed request.
 */
export async function requestChatCompletionsWithCompat(input: ChatCompletionsAttemptInput): Promise<ChatCompletionsAttempt> {
  const fetcher = input.fetcher ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const metadata = JSON.stringify({ user: 'reasoning-discovery' });
  const restUrl = input.endpoint?.rest
    ?? `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/ai/v1/chat/completions`;
  const compatUrl = input.endpoint?.compat
    ?? `https://gateway.ai.cloudflare.com/v1/${input.accountId}/${input.gatewayId}/compat/chat/completions`;
  let response = await fetchWithTimeout(fetcher, restUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiToken}`,
      'cf-aig-gateway-id': input.gatewayId ?? '',
      'cf-aig-metadata': metadata,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input.body),
  }, timeoutMs, 1);
  if (response.status !== 404) return { response, attempts: 1, transport: 'rest' };

  try {
    await readBoundedText(response, maxResponseBytes);
  } catch {
    throw new DiscoveryAttemptError('response_too_large', 1);
  }
  const compatBody = clone(input.body);
  delete compatBody.store;
  delete compatBody.prompt_cache_key;
  response = await fetchWithTimeout(fetcher, compatUrl, {
    method: 'POST',
    headers: {
      'cf-aig-authorization': `Bearer ${input.apiToken}`,
      'cf-aig-metadata': metadata,
      'content-type': 'application/json',
    },
    body: JSON.stringify(compatBody),
  }, timeoutMs, 2);
  return { response, attempts: 2, transport: 'compat' };
}

async function digest(value: string): Promise<string | null> {
  if (!value) return null;
  const bytes = new TextEncoder().encode(value);
  const result = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...result].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function numericUsage(usage: Record<string, unknown> | null, key: string): number | null {
  const value = usage?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function usageSummary(usage: Record<string, unknown> | null): Record<string, number | null> {
  const details = isPlainObject(usage?.completion_tokens_details) ? usage.completion_tokens_details : null;
  return {
    promptTokens: numericUsage(usage, 'prompt_tokens'),
    completionTokens: numericUsage(usage, 'completion_tokens'),
    totalTokens: numericUsage(usage, 'total_tokens'),
    reasoningTokens: numericUsage(details, 'reasoning_tokens'),
  };
}

async function summarizeParsedSse(parsed: ParsedPiSse, transport: string, attempts: number): Promise<Record<string, unknown>> {
  return {
    status: 200,
    transport,
    httpAttempts: attempts,
    effectiveFinishReason: parsed.effectiveFinishReason,
    finishReasonRepaired: parsed.finishReasonRepaired,
    doneRepaired: parsed.doneRepaired,
    malformedEvents: parsed.malformedEvents,
    eventCount: parsed.eventCount,
    contentLength: parsed.content.length,
    contentHash: await digest(parsed.content),
    reasoning: await Promise.all(parsed.reasoningBlocks.map(async (block) => ({
      field: block.signature,
      length: block.text.length,
      hash: await digest(block.text),
    }))),
    toolCallCount: parsed.toolCalls.length,
    toolNames: parsed.toolCalls.map((call) => call.name === CANARY_TOOL_NAME ? CANARY_TOOL_NAME : 'unexpected'),
    ...usageSummary(parsed.usage),
  };
}

interface ProbeResult extends Record<string, unknown> {
  status: number | null;
  httpAttempts: number;
  stop: boolean;
}

interface CommonRequest {
  accountId?: string;
  gatewayId?: string;
  apiToken: string;
  endpoint?: DiscoveryEndpoint;
  fetcher: typeof fetch;
  timeoutMs: number;
  maxResponseBytes: number;
}

function transportFailure(error: unknown): ProbeResult {
  const failure = error instanceof DiscoveryAttemptError ? error : new DiscoveryAttemptError('transport_error', 1);
  return {
    ...sanitizedError(null, '', failure.kind),
    transport: null,
    httpAttempts: failure.attempts,
    stop: true,
  } as ProbeResult;
}

async function executeReasoningProbe(common: CommonRequest, request: PlainObject): Promise<ProbeResult> {
  let attempt: ChatCompletionsAttempt;
  try {
    attempt = await requestChatCompletionsWithCompat({ ...common, body: request });
  } catch (error) {
    return transportFailure(error);
  }
  if (attempt.response.status !== 200) {
    let text = '';
    try { text = await readBoundedText(attempt.response, common.maxResponseBytes); } catch { return transportFailure(new DiscoveryAttemptError('response_too_large', attempt.attempts)); }
    return {
      ...sanitizedError(attempt.response.status, text),
      transport: attempt.transport,
      httpAttempts: attempt.attempts,
      stop: true,
    } as ProbeResult;
  }
  let parsed: ParsedPiSse;
  try { parsed = await parsePiSseStream(attempt.response.body, common.maxResponseBytes); } catch {
    return {
      ...sanitizedError(200, '', 'malformed_response'),
      transport: attempt.transport,
      httpAttempts: attempt.attempts,
      stop: true,
    } as ProbeResult;
  }
  const summary = await summarizeParsedSse(parsed, attempt.transport, attempt.attempts);
  const reasoning = parsed.reasoningBlocks.map((block) => block.text).join('\n');
  return {
    status: 200,
    transport: attempt.transport,
    httpAttempts: attempt.attempts,
    finishReason: parsed.effectiveFinishReason,
    finishReasonRepaired: parsed.finishReasonRepaired,
    doneRepaired: parsed.doneRepaired,
    malformedEvents: parsed.malformedEvents,
    contentLength: summary.contentLength,
    contentHash: summary.contentHash,
    reasoningField: parsed.reasoningBlocks[0]?.signature ?? null,
    reasoningLength: reasoning.length,
    reasoningHash: await digest(reasoning),
    ...usageSummary(parsed.usage),
    stop: parsed.malformedEvents > 0,
  };
}

interface ToolLifecycleResult extends Record<string, unknown> {
  passed: boolean;
  stage: string;
  first: Record<string, unknown> | null;
  replay: Record<string, unknown> | null;
  stop: boolean;
}

async function executeToolLifecycle(common: CommonRequest, initialRequest: PlainObject): Promise<ToolLifecycleResult> {
  let firstAttempt: ChatCompletionsAttempt;
  try { firstAttempt = await requestChatCompletionsWithCompat({ ...common, body: initialRequest }); } catch (error) {
    return { passed: false, stage: 'tool-call', first: publicProbe(transportFailure(error)), replay: null, stop: true };
  }
  if (firstAttempt.response.status !== 200) {
    let text = '';
    try { text = await readBoundedText(firstAttempt.response, common.maxResponseBytes); } catch { return { passed: false, stage: 'tool-call', first: publicProbe(transportFailure(new DiscoveryAttemptError('response_too_large', firstAttempt.attempts))), replay: null, stop: true }; }
    return {
      passed: false,
      stage: 'tool-call',
      first: { ...sanitizedError(firstAttempt.response.status, text), transport: firstAttempt.transport, httpAttempts: firstAttempt.attempts },
      replay: null,
      stop: true,
    };
  }

  let firstParsed: ParsedPiSse;
  try { firstParsed = await parsePiSseStream(firstAttempt.response.body, common.maxResponseBytes); } catch {
    return {
      passed: false,
      stage: 'tool-call-validation',
      first: { ...sanitizedError(200, '', 'malformed_response'), transport: firstAttempt.transport, httpAttempts: firstAttempt.attempts },
      replay: null,
      stop: true,
    };
  }
  const first = await summarizeParsedSse(firstParsed, firstAttempt.transport, firstAttempt.attempts);
  try {
    if (firstParsed.malformedEvents > 0 || firstParsed.effectiveFinishReason !== 'tool_calls') {
      throw new Error('First turn did not terminate as tool_calls');
    }
    const replayMessages = buildPiReplayMessages(initialRequest.messages, firstParsed);
    const replayRequest = { ...clone(initialRequest), messages: replayMessages };
    let replayAttempt: ChatCompletionsAttempt;
    try { replayAttempt = await requestChatCompletionsWithCompat({ ...common, body: replayRequest }); } catch (error) {
      return { passed: false, stage: 'tool-replay', first, replay: publicProbe(transportFailure(error)), stop: true };
    }
    if (replayAttempt.response.status !== 200) {
      let text = '';
      try { text = await readBoundedText(replayAttempt.response, common.maxResponseBytes); } catch { return { passed: false, stage: 'tool-replay', first, replay: publicProbe(transportFailure(new DiscoveryAttemptError('response_too_large', replayAttempt.attempts))), stop: true }; }
      return {
        passed: false,
        stage: 'tool-replay',
        first,
        replay: { ...sanitizedError(replayAttempt.response.status, text), transport: replayAttempt.transport, httpAttempts: replayAttempt.attempts },
        stop: true,
      };
    }
    let replayParsed: ParsedPiSse;
    try { replayParsed = await parsePiSseStream(replayAttempt.response.body, common.maxResponseBytes); } catch {
      return {
        passed: false,
        stage: 'tool-replay',
        first,
        replay: { ...sanitizedError(200, '', 'malformed_response'), transport: replayAttempt.transport, httpAttempts: replayAttempt.attempts },
        stop: true,
      };
    }
    const replay = await summarizeParsedSse(replayParsed, replayAttempt.transport, replayAttempt.attempts);
    const passed = replayParsed.malformedEvents === 0 && replayParsed.effectiveFinishReason === 'stop';
    return { passed, stage: passed ? 'complete' : 'final-response', first, replay, stop: replayParsed.malformedEvents > 0 };
  } catch {
    return {
      passed: false,
      stage: 'tool-call-validation',
      first,
      replay: null,
      validationError: 'invalid tool call',
      stop: firstParsed.malformedEvents > 0,
    };
  }
}

function groupMappings(profile: DiscoveryProfile): Array<{ levels: ReasoningLevel[]; semantic: SemanticMapping }> {
  const groups = new Map<string, { levels: ReasoningLevel[]; semantic: SemanticMapping }>();
  for (const level of profile.supportedLevels) {
    const semantic = profile.levels[level] as SemanticMapping;
    const key = stableStringify({ removePaths: semantic.removePaths, mapping: semantic.mapping });
    const current = groups.get(key) ?? { levels: [], semantic: clone(semantic) };
    current.levels.push(level);
    groups.set(key, current);
  }
  return [...groups.values()];
}

interface Accounting {
  logicalProbes: number;
  httpAttempts: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function addEvidence(accounting: Accounting, evidence: Record<string, unknown> | null): void {
  if (!evidence) return;
  const attempts = typeof evidence.httpAttempts === 'number' ? evidence.httpAttempts : 0;
  const prompt = typeof evidence.promptTokens === 'number' ? evidence.promptTokens : 0;
  const completion = typeof evidence.completionTokens === 'number' ? evidence.completionTokens : 0;
  const total = typeof evidence.totalTokens === 'number' ? evidence.totalTokens : prompt + completion;
  accounting.httpAttempts += attempts;
  accounting.promptTokens += prompt;
  accounting.completionTokens += completion;
  accounting.totalTokens += total;
}

function publicProbe<T extends Record<string, unknown> & { stop: boolean }>(probe: T): Omit<T, 'stop'> {
  const result: Record<string, unknown> = { ...probe };
  delete result.stop;
  return result as Omit<T, 'stop'>;
}

export async function discoverPiCompatibility(input: DiscoveryInput): Promise<Record<string, any>> {
  const { profile, offCandidate } = validateInput(input);
  const fetcher = input.fetcher ?? input.fetchImpl ?? fetch;
  const common: CommonRequest = {
    accountId: input.accountId,
    gatewayId: input.gatewayId,
    apiToken: input.apiToken as string,
    endpoint: input.endpoint,
    fetcher,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
  const groups = groupMappings(profile);
  const accounting: Accounting = { logicalProbes: 0, httpAttempts: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const distinctMappings: Array<Record<string, any>> = [];
  let stopped = false;

  for (const group of groups) {
    const representativeLevel = group.levels[0];
    const reasoningRequest = applySemanticMapping(buildReasoningRequest({
      route: input.route,
      mapping: {},
      maxCompletionTokens: input.maxCompletionTokens,
      sessionId: `${profile.id}-${representativeLevel}-reasoning`,
    }), group.semantic);
    accounting.logicalProbes += 1;
    const reasoningProbe = await executeReasoningProbe(common, reasoningRequest);
    addEvidence(accounting, reasoningProbe);
    if (reasoningProbe.stop) {
      distinctMappings.push({
        levels: group.levels,
        reasoningProbe: publicProbe(reasoningProbe),
        toolLifecycle: { passed: false, stage: 'not-run', first: null, replay: null },
      });
      stopped = true;
      break;
    }

    const initialRequest = applySemanticMapping(buildInitialPiRequest({
      route: input.route,
      mapping: {},
      maxCompletionTokens: input.maxCompletionTokens,
      sessionId: `${profile.id}-${representativeLevel}-tools`,
    }), group.semantic);
    accounting.logicalProbes += 1;
    const toolLifecycle = await executeToolLifecycle(common, initialRequest);
    addEvidence(accounting, toolLifecycle.first);
    addEvidence(accounting, toolLifecycle.replay);
    distinctMappings.push({
      levels: group.levels,
      reasoningProbe: publicProbe(reasoningProbe),
      toolLifecycle: publicProbe(toolLifecycle),
    });
    if (toolLifecycle.stop) {
      stopped = true;
      break;
    }
  }

  let offCandidateEvidence: Record<string, unknown> | null = null;
  if (!stopped && !profile.supportedLevels.includes('off') && offCandidate) {
    const request = applySemanticMapping(buildReasoningRequest({
      route: input.route,
      mapping: {},
      maxCompletionTokens: input.maxCompletionTokens,
      sessionId: `${profile.id}-off-candidate`,
    }), offCandidate);
    accounting.logicalProbes += 1;
    const probe = await executeReasoningProbe(common, request);
    addEvidence(accounting, probe);
    offCandidateEvidence = publicProbe(probe);
    stopped = probe.stop;
  }

  const verifiedLevels = distinctMappings.filter((item) => item.toolLifecycle.passed).flatMap((item) => item.levels) as ReasoningLevel[];
  const attemptedLevels = new Set(distinctMappings.flatMap((item) => item.levels as ReasoningLevel[]));
  const failedLevels = profile.supportedLevels.filter((level) => !verifiedLevels.includes(level) || !attemptedLevels.has(level));
  const allToolsPassed = verifiedLevels.length === profile.supportedLevels.length;
  const replayUnsupported = distinctMappings.some((item) => item.toolLifecycle.stage === 'tool-replay'
    && typeof item.toolLifecycle.replay?.status === 'number'
    && item.toolLifecycle.replay.status >= 400
    && item.toolLifecycle.replay.status < 500);
  const reasoningTransportFailures = distinctMappings.some((item) => item.reasoningProbe.status !== 200 || item.reasoningProbe.malformedEvents > 0);
  const offItem = distinctMappings.find((item) => (item.levels as ReasoningLevel[]).includes('off'));
  const off = profile.supportedLevels.includes('off')
    ? offItem?.reasoningProbe.status === 200 && offItem.reasoningProbe.reasoningLength === 0
      ? 'verified-disabled'
      : offItem?.reasoningProbe.status === 200 ? 'not-disabled' : 'not-verified'
    : offCandidateEvidence?.status === 200 && (offCandidateEvidence.reasoningLength as number) > 0
      ? 'verified-unsupported'
      : offCandidateEvidence?.status === 200 && offCandidateEvidence.reasoningLength === 0
        ? 'candidate-disabled-profile-mismatch'
        : 'unsupported-by-profile';

  const assignable = !stopped
    && allToolsPassed
    && !reasoningTransportFailures
    && !['not-disabled', 'not-verified', 'candidate-disabled-profile-mismatch'].includes(off);
  const classification = stopped
    ? 'Inconclusive'
    : assignable
      ? 'Verified'
      : replayUnsupported || verifiedLevels.length === 0
        ? 'Unsupported'
        : 'Compatible, unverified';
  const piStatus = allToolsPassed
    ? 'verified'
    : replayUnsupported
      ? 'tool-replay-unsupported'
      : verifiedLevels.length > 0
        ? 'partial'
        : stopped
          ? 'inconclusive'
          : 'unsupported';

  return {
    schemaVersion: 1,
    canaryVersion: PI_WIRE_CANARY_VERSION,
    profileId: profile.id,
    route: input.route,
    requestedCompletionCeiling: input.maxCompletionTokens,
    distinctMappings,
    piCompatibility: { status: piStatus, verifiedLevels, failedLevels },
    reasoningConfiguration: {
      off,
      offCandidateEvidence,
      graduatedEffort: 'not-proven-by-discovery',
      routeHealthVerified: !reasoningTransportFailures && !stopped,
    },
    classification,
    assignable,
    accounting,
    evidence: {
      current: true,
      toolReplay: allToolsPassed,
      ingress: 'ai-gateway-chat-completions',
      canaryVersion: PI_WIRE_CANARY_VERSION,
      status: classification,
    },
    normalizedDraft: {
      schemaVersion: 1,
      profileId: profile.id,
      supportedLevels: [...profile.supportedLevels],
      classification,
      evidence: {
        current: true,
        toolReplay: allToolsPassed,
        ingress: 'ai-gateway-chat-completions',
        canaryVersion: PI_WIRE_CANARY_VERSION,
        status: classification,
        route: input.route,
        requestedCompletionCeiling: input.maxCompletionTokens,
      },
    },
    goodToKnow: [
      ...(replayUnsupported ? ['The model can emit a tool call but rejects the tool-result replay. Restart the session before continuing with another model or profile.'] : []),
      ...(reasoningTransportFailures || stopped ? ['At least one probe failed at the provider boundary. Revalidate before assignment.'] : []),
    ],
    limitations: [
      'Discovery validates only the exercised route path and current backend configuration.',
      'Accepted graduated level fields do not prove that effort was honored.',
      'Runtime output and thinking limits remain administrator configuration and are not profile properties.',
    ],
  };
}
