// Ported from the validated Worker prototype:
// codeflare-profile-discovery.mjs
// SHA-256 f0f68dbb8415d5aaccf2d3b03002153be2dbbdb61bde3c209384d687dc5a2985
// Its validation fixture is SHA-256 a5ccaea163d5920eb2ece172b8b7048751a383467272ad704c39bdabc0a0405b.

import { getBuiltInProfile, validateRequestPath } from './reasoning-profiles';
import type { CapabilityMapping, CapabilitySummaryV2 } from './ai-capability-discovery/contract';
import { repairRepeatedCompleteToolNames } from './openai-sse-tool-name-repair';
import { adaptBedrockAnthropicResponse, bedrockAnthropicGatewayPath, buildBedrockAnthropicRequest, selectBedrockAnthropicTransport, type BedrockReplayState, type BedrockThinkingObservation } from './bedrock-anthropic-native-adapter';
import { bedrockAnthropicCandidate } from './native-ai-target-draft';
import { compatibilityRequest, compatibilityResponse, type CompatibilityWire } from './ai-capability-discovery/compatibility-wire';

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
  reasoningMode: 'pi-levels' | 'provider-default';
  supportedLevels: ReasoningLevel[];
  levels: Partial<Record<ReasoningLevel, SemanticMapping>>;
  compatibility?: CompatibilityWire;
}

interface DiscoveryEndpoint {
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
  compatOnly?: boolean;
  byokAlias?: string;
  // Trusted server-selected coordinates, never browser-provided URLs/headers.
  native?: { model: string; region: string; transport: 'aig-bedrock-anthropic-invoke' | 'aig-bedrock-anthropic-eventstream' | 'aig-bedrock-anthropic-auto' };
  /** Collect independent capability evidence, including an optional cache pair.
   * Historical name retained for callers; cache reuse does not gate activation. */
  requireCacheEvidence?: boolean;
  /** Multi-backend inventory requires response identities for lifecycle qualification. */
  requireBackendIdentity?: boolean;
  /** Trusted campaign deadline. Legacy single-profile checks omit it. */
  campaignDeadline?: number;
}

export interface ParsedPiSse {
  content: string;
  reasoningBlocks: Array<{ signature: string; text: string }>;
  toolCalls: Array<{ id: string; type: string; name: string; argumentsText: string; thoughtSignature?: string }>;
  rawFinishReason: string | null;
  effectiveFinishReason: string | null;
  finishReasonRepaired: boolean;
  sawDone: boolean;
  doneRepaired: boolean;
  usage: Record<string, unknown> | null;
  eventCount: number;
  malformedEvents: number;
  publicDeltaTimes?: number[];
  eofTime?: number;
}

interface ChatCompletionsAttemptInput {
  accountId?: string;
  gatewayId?: string;
  apiToken: string;
  endpoint?: DiscoveryEndpoint;
  body: PlainObject;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  compatOnly?: boolean;
  byokAlias?: string;
  native?: DiscoveryInput['native'];
  replayState?: BedrockReplayState;
  compatibility?: CompatibilityWire;
  campaignDeadline?: number;
}

interface ChatCompletionsAttempt {
  response: Response;
  attempts: number;
  transport: 'rest' | 'compat' | 'bedrock-invoke' | 'bedrock-eventstream';
  nativeObservation?: { value?: BedrockThinkingObservation };
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
    if (part === '__proto__' || part === 'prototype' || part === 'constructor') throw new TypeError('Invalid profile mapping path');
    if (!Object.hasOwn(cursor, part) || !isPlainObject(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as PlainObject;
  }
  const last = parts[parts.length - 1];
  if (last === '__proto__' || last === 'prototype' || last === 'constructor') throw new TypeError('Invalid profile mapping path');
  cursor[last] = value;
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
    let path: string;
    try { path = validateRequestPath(write.path); } catch { throw new TypeError('Invalid profile mapping path'); }
    setPath(mapping, path, write.value);
  }
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
    try { return validateRequestPath(path); } catch { throw new TypeError('Invalid profile mapping path'); }
  });
}

function normalizeProfile(raw: unknown): DiscoveryProfile {
  if (!isPlainObject(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 128) {
    throw new TypeError('Invalid profile');
  }
  const reasoningMode = raw.reasoningMode === 'provider-default' ? 'provider-default' : 'pi-levels';
  if (!Array.isArray(raw.supportedLevels) || (raw.supportedLevels.length === 0 && reasoningMode !== 'provider-default')) throw new TypeError('Profile requires supportedLevels');
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
  const compatibility = isPlainObject(raw.compatibility) ? raw.compatibility as CompatibilityWire : undefined;
  if (compatibility && (!['stream', 'buffered'].includes(compatibility.response)
    || !['strict', 'repeated-complete'].includes(compatibility.toolNames))) throw new TypeError('Unsupported compatibility contract');
  return { id: raw.id, reasoningMode, supportedLevels, levels, compatibility };
}

function normalizeStandaloneMapping(raw: unknown): SemanticMapping {
  const semantic = normalizeLevelMapping(raw, []);
  // Candidate discovery stays bounded to its known forms; selected canonical
  // profile writes use the same protected-path rules as Save and runtime.
  validateMapping(semantic.mapping);
  semantic.removePaths.forEach(validatePath);
  return semantic;
}

function isBoundedModelSelector(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.startsWith('dynamic/')) return /^dynamic\/[A-Za-z0-9._/-]{1,180}$/.test(value);
  const separator = value.indexOf('/');
  if (separator < 1) return false;
  const selectorProvider = value.slice(0, separator);
  const provider = selectorProvider.startsWith('custom-') ? selectorProvider.slice('custom-'.length) : selectorProvider;
  const model = value.slice(separator + 1);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(provider)
    || !/^[A-Za-z0-9@][A-Za-z0-9@._:/-]{0,255}$/.test(model)
    || model.includes('..')
    || ['__proto__', 'prototype', 'constructor'].includes(model.toLowerCase())) return false;
  return selectorProvider !== 'aws-bedrock' || !model.includes('/');
}

function validateInput(input: DiscoveryInput): { profile: DiscoveryProfile; offCandidate?: SemanticMapping } {
  if (!isPlainObject(input)) throw new TypeError('Discovery input is required');
  if (!isBoundedModelSelector(input.route)) throw new TypeError('Route must be a bounded model selector');
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
  if (input.native) {
    if (input.route !== `aws-bedrock/${input.native.model}` || !bedrockAnthropicCandidate(input.native.model)
      || !['aig-bedrock-anthropic-auto', 'aig-bedrock-anthropic-invoke', 'aig-bedrock-anthropic-eventstream'].includes(input.native.transport)) {
      throw new TypeError('Native discovery requires the selected Anthropic contract');
    }
    bedrockAnthropicGatewayPath(input.native.region, input.native.model, 'invoke');
    const audited = normalizeProfile(getBuiltInProfile('bedrock-anthropic-native-opus-auto'));
    const canonical = (semantic: SemanticMapping) => stableStringify({ mapping: semantic.mapping, removePaths: [...new Set(semantic.removePaths)].sort() });
    if (profile.compatibility || input.offCandidateMapping !== undefined
      || (profile.reasoningMode === 'provider-default'
        ? profile.supportedLevels.length !== 0 || stableStringify(input.profile && (input.profile as PlainObject).levels) !== '{}'
        : profile.supportedLevels.some((level) => canonical(profile.levels[level]!) !== canonical(audited.levels[level]!)))) {
      throw new TypeError('Native discovery permits only audited disabled/adaptive mappings');
    }
  }
  if (input.requireCacheEvidence && groupMappings(profile).length !== 1) throw new TypeError('Capability certification requires one exact executable mapping');
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
  if (!isPlainObject(event) || 'error' in event || 'errors' in event) {
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
      const extra = isPlainObject(rawToolCall.extra_content) && isPlainObject(rawToolCall.extra_content.google)
        ? rawToolCall.extra_content.google.thought_signature : undefined;
      if (typeof extra === 'string' && extra.length > 0 && extra.length <= 32_768) current.thoughtSignature = extra;
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
  const start = performance.now();
  state.publicDeltaTimes = [];
  const consume = (payload: string) => {
    const length = state.content.length;
    consumeSseData(payload, state);
    if (state.content.length > length) state.publicDeltaTimes!.push(performance.now() - start);
  };
  try {
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
      if (trimmed.startsWith('data:')) consume(trimmed.slice(trimmed.indexOf(':') + 1).trim());
    }
  }
  buffer += decoder.decode();
  const trimmed = buffer.trimStart();
  if (trimmed.startsWith('data:')) consume(trimmed.slice(trimmed.indexOf(':') + 1).trim());
  state.eofTime = performance.now() - start;
  return finishParsedSse(state);
  } finally {
    // Cancellation also releases a timed-out/malformed provider stream. Never
    // leave an unread paid response running after a failed certification.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
    ...(call.thoughtSignature && { extra_content: { google: { thought_signature: call.thoughtSignature } } }),
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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('response_too_large');
      result += decoder.decode(value, { stream: true });
    }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
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
  constructor(public readonly kind: 'timeout' | 'transport_error' | 'response_too_large' | 'unexpected_response_format', public readonly attempts: number,
    public readonly status: number | null = null, public readonly transport: string | null = null) {
    super(kind);
  }
}

async function fetchWithTimeout(fetcher: typeof fetch, url: string, init: RequestInit, timeoutMs: number, attempt: number): Promise<Response> {
  const controller = new AbortController();
  let expireBody: (() => void) | undefined;
  let expireHeaders: ((error: Error) => void) | undefined;
  const acquisitionDeadline = new Promise<never>((_, reject) => { expireHeaders = reject; });
  const timeout = setTimeout(() => {
    controller.abort('discovery timeout');
    expireBody?.();
    expireHeaders?.(new DiscoveryAttemptError('timeout', attempt));
  }, timeoutMs);
  try {
    const pending = fetcher(url, { ...init, signal: controller.signal, redirect: 'manual' });
    // AbortSignal alone does not bound response acquisition when an upstream
    // implementation ignores it. Dispose a late body without another request.
    void pending.then((late) => { if (controller.signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
    const response = await Promise.race([pending, acquisitionDeadline]);
    expireHeaders = undefined;
    if (controller.signal.aborted) throw new DiscoveryAttemptError('timeout', attempt);
    if (!response.body) {
      clearTimeout(timeout);
      return response;
    }
    const reader = response.body.getReader();
    let settled = false;
    let responseBytes = 0;
    const settle = () => { settled = true; clearTimeout(timeout); };
    // Keep the original attempt deadline until EOF or cancellation, including
    // error/404 bodies. Error the consumer even if upstream ignores abort.
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        expireBody = () => {
          if (settled) return;
          settle();
          streamController.error(new DiscoveryAttemptError('timeout', attempt));
          void reader.cancel('discovery timeout').catch(() => {});
        };
      },
      async pull(streamController) {
        try {
          const { done, value } = await reader.read();
          if (settled) return;
          if (done) {
            settle();
            reader.releaseLock();
            streamController.close();
          } else {
            responseBytes += value.byteLength;
            if (responseBytes > DEFAULT_MAX_RESPONSE_BYTES) {
              settle();
              streamController.error(new DiscoveryAttemptError('response_too_large', attempt));
              void reader.cancel('response too large').catch(() => {});
              return;
            }
            streamController.enqueue(value);
          }
        } catch (error) {
          if (settled) return;
          settle();
          streamController.error(error);
        }
      },
      cancel(reason) {
        settle();
        controller.abort(reason);
        void reader.cancel(reason).catch(() => {});
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch {
    clearTimeout(timeout);
    throw new DiscoveryAttemptError(controller.signal.aborted ? 'timeout' : 'transport_error', attempt);
  }
}

/**
 * Shared REST-first attempt primitive. Compat is attempted only after the REST
 * 404 body has been consumed completely, and removes only store and
 * prompt_cache_key from the replayed request.
 */
async function requestChatCompletionsWithCompat(input: ChatCompletionsAttemptInput): Promise<ChatCompletionsAttempt> {
  const remaining = input.campaignDeadline === undefined ? DEFAULT_TIMEOUT_MS : input.campaignDeadline - Date.now();
  if (remaining <= 0) throw new DiscoveryAttemptError('timeout', 0);
  const attempt = await requestUnadaptedCompletions({ ...input, timeoutMs: Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, remaining), body: compatibilityRequest(input.body, input.compatibility) });
  try {
    return { ...attempt, response: await compatibilityResponse(attempt.response, input.compatibility, input.body.stream === true) };
  } catch (error) {
    // The buffered boundary received HTTP successfully but rejected its envelope.
    // Preserve that distinction without exposing the body or adapting another protocol.
    if (error instanceof Error && error.message === 'compatibility_not_openai_chat') {
      throw new DiscoveryAttemptError('unexpected_response_format', attempt.attempts, attempt.response.status, attempt.transport);
    }
    throw error;
  }
}

async function requestUnadaptedCompletions(input: ChatCompletionsAttemptInput): Promise<ChatCompletionsAttempt> {
  const fetcher = input.fetcher ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const metadata = JSON.stringify({ user: 'reasoning-discovery' });
  const restUrl = input.endpoint?.rest
    ?? `https://api.cloudflare.com/client/v4/accounts/${input.accountId}/ai/v1/chat/completions`;
  const compatUrl = input.endpoint?.compat
    ?? `https://gateway.ai.cloudflare.com/v1/${input.accountId}/${input.gatewayId}/compat/chat/completions`;
  if (input.native) {
    if (!input.replayState || !input.accountId || !input.gatewayId) throw new TypeError('Native discovery requires server-held replay and gateway coordinates');
    const configured = input.native.transport === 'aig-bedrock-anthropic-auto' ? 'auto'
      : input.native.transport === 'aig-bedrock-anthropic-eventstream' ? 'eventstream' : 'invoke';
    const body = await buildBedrockAnthropicRequest({ ...input.body, max_tokens: input.body.max_completion_tokens }, input.replayState);
    const operation = selectBedrockAnthropicTransport(configured, body.output_config?.effort);
    const url = `https://gateway.ai.cloudflare.com/v1/${input.accountId}/${input.gatewayId}${bedrockAnthropicGatewayPath(input.native.region, input.native.model, operation)}`;
    const upstream = await fetchWithTimeout(fetcher, url, { method: 'POST',
      headers: { 'cf-aig-authorization': `Bearer ${input.apiToken}`, 'cf-aig-max-attempts': '1', 'content-type': 'application/json',
        ...(operation === 'eventstream' && { accept: 'application/vnd.amazon.eventstream' }),
        ...(input.byokAlias && { 'cf-aig-byok-alias': input.byokAlias }) }, body: JSON.stringify(body),
    }, Math.min(timeoutMs, 90_000), 1);
    const nativeObservation: { value?: BedrockThinkingObservation } = {};
    const response = await adaptBedrockAnthropicResponse(upstream, operation, input.replayState, true, (value) => { nativeObservation.value = value; });
    // Read cache observations at the Gateway boundary, before native response
    // translation drops transport headers. No secret headers are propagated.
    for (const name of ['cf-aig-cache-status', 'cf-aig-provider', 'cf-aig-model']) {
      const value = upstream.headers.get(name); if (value) response.headers.set(name, value);
    }
    return { response, attempts: 1, transport: operation === 'invoke' ? 'bedrock-invoke' : 'bedrock-eventstream', nativeObservation };
  }
  if (input.compatOnly) {
    const compatBody = clone(input.body);
    delete compatBody.store;
    delete compatBody.prompt_cache_key;
    return {
      response: await fetchWithTimeout(fetcher, compatUrl, {
        method: 'POST', headers: { 'cf-aig-authorization': `Bearer ${input.apiToken}`, 'cf-aig-max-attempts': '1', ...(input.byokAlias && { 'cf-aig-byok-alias': input.byokAlias }), 'content-type': 'application/json' }, body: JSON.stringify(compatBody),
      }, timeoutMs, 1), attempts: 1, transport: 'compat',
    };
  }
  let response = await fetchWithTimeout(fetcher, restUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.apiToken}`,
      'cf-aig-max-attempts': '1',
      'cf-aig-gateway-id': input.gatewayId ?? '',
      'cf-aig-metadata': metadata,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input.body),
  }, timeoutMs, 1);
  if (response.status !== 404) return { response, attempts: 1, transport: 'rest' };

  try {
    await readBoundedText(response, maxResponseBytes);
  } catch (error) {
    throw error instanceof DiscoveryAttemptError ? error : new DiscoveryAttemptError('response_too_large', 1);
  }
  const compatBody = clone(input.body);
  delete compatBody.store;
  delete compatBody.prompt_cache_key;
  response = await fetchWithTimeout(fetcher, compatUrl, {
    method: 'POST',
    headers: {
      'cf-aig-authorization': `Bearer ${input.apiToken}`,
      'cf-aig-max-attempts': '1',
      ...(input.byokAlias && { 'cf-aig-byok-alias': input.byokAlias }),
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
  const promptDetails = isPlainObject(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  return {
    promptTokens: numericUsage(usage, 'prompt_tokens'),
    completionTokens: numericUsage(usage, 'completion_tokens'),
    totalTokens: numericUsage(usage, 'total_tokens'),
    reasoningTokens: numericUsage(details, 'reasoning_tokens'),
    cacheReadTokens: numericUsage(promptDetails, 'cached_tokens'),
    cacheWriteTokens: numericUsage(promptDetails, 'cache_write_tokens'),
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
    publicDeltaTimes: parsed.publicDeltaTimes ?? [], eofTime: parsed.eofTime ?? null,
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
  compatOnly?: boolean;
  byokAlias?: string;
  repairToolNames?: boolean;
  compatibility?: CompatibilityWire;
  campaignDeadline?: number;
  native?: DiscoveryInput['native'];
  replayState?: BedrockReplayState;
}

function transportFailure(error: unknown): ProbeResult {
  const failure = error instanceof DiscoveryAttemptError ? error : new DiscoveryAttemptError('transport_error', 1);
  return {
    ...sanitizedError(failure.status, '', failure.kind),
    transport: failure.transport,
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
    try { text = await readBoundedText(attempt.response, common.maxResponseBytes); } catch (error) { return transportFailure(error instanceof DiscoveryAttemptError ? error : new DiscoveryAttemptError('response_too_large', attempt.attempts)); }
    return {
      ...sanitizedError(attempt.response.status, text),
      transport: attempt.transport,
      httpAttempts: attempt.attempts,
      stop: true,
    } as ProbeResult;
  }
  let parsed: ParsedPiSse;
  try { parsed = await parsePiSseStream(attempt.response.body, common.maxResponseBytes); } catch (error) {
    if (error instanceof DiscoveryAttemptError) return transportFailure(error);
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
    effectiveFinishReason: parsed.effectiveFinishReason,
    finishReasonRepaired: parsed.finishReasonRepaired,
    doneRepaired: parsed.doneRepaired,
    malformedEvents: parsed.malformedEvents,
    contentLength: summary.contentLength,
    contentHash: summary.contentHash,
    ...gatewayObservation(attempt.response),
    publicDeltaTimes: summary.publicDeltaTimes, eofTime: summary.eofTime,
    ...(common.native && { nativeThinkingObserved: attempt.nativeObservation?.value?.thinkingPresent === true,
      nativeObservationCompleted: attempt.nativeObservation?.value?.completed === true }),
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
    try { text = await readBoundedText(firstAttempt.response, common.maxResponseBytes); } catch (error) { return { passed: false, stage: 'tool-call', first: publicProbe(transportFailure(error instanceof DiscoveryAttemptError ? error : new DiscoveryAttemptError('response_too_large', firstAttempt.attempts))), replay: null, stop: true }; }
    return {
      passed: false,
      stage: 'tool-call',
      first: { ...sanitizedError(firstAttempt.response.status, text), transport: firstAttempt.transport, httpAttempts: firstAttempt.attempts },
      replay: null,
      stop: true,
    };
  }

  let firstParsed: ParsedPiSse;
  try {
    const body = common.repairToolNames && firstAttempt.response.body ? firstAttempt.response.body.pipeThrough(repairRepeatedCompleteToolNames([CANARY_TOOL_NAME])) : firstAttempt.response.body;
    firstParsed = await parsePiSseStream(body, common.maxResponseBytes);
  } catch (error) {
    if (error instanceof DiscoveryAttemptError) return { passed: false, stage: 'tool-call', first: publicProbe(transportFailure(error)), replay: null, stop: true };
    return {
      passed: false,
      stage: 'tool-call-validation',
      first: { ...sanitizedError(200, '', 'malformed_response'), transport: firstAttempt.transport, httpAttempts: firstAttempt.attempts },
      replay: null,
      stop: true,
    };
  }
  const first = { ...(await summarizeParsedSse(firstParsed, firstAttempt.transport, firstAttempt.attempts)), ...gatewayObservation(firstAttempt.response) };
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
      try { text = await readBoundedText(replayAttempt.response, common.maxResponseBytes); } catch (error) { return { passed: false, stage: 'tool-replay', first, replay: publicProbe(transportFailure(error instanceof DiscoveryAttemptError ? error : new DiscoveryAttemptError('response_too_large', replayAttempt.attempts))), stop: true }; }
      return {
        passed: false,
        stage: 'tool-replay',
        first,
        replay: { ...sanitizedError(replayAttempt.response.status, text), transport: replayAttempt.transport, httpAttempts: replayAttempt.attempts },
        stop: true,
      };
    }
    let replayParsed: ParsedPiSse;
    try {
      const body = common.repairToolNames && replayAttempt.response.body ? replayAttempt.response.body.pipeThrough(repairRepeatedCompleteToolNames([CANARY_TOOL_NAME])) : replayAttempt.response.body;
      replayParsed = await parsePiSseStream(body, common.maxResponseBytes);
    } catch (error) {
      if (error instanceof DiscoveryAttemptError) return { passed: false, stage: 'tool-replay', first, replay: publicProbe(transportFailure(error)), stop: true };
      return {
        passed: false,
        stage: 'tool-replay',
        first,
        replay: { ...sanitizedError(200, '', 'malformed_response'), transport: replayAttempt.transport, httpAttempts: replayAttempt.attempts },
        stop: true,
      };
    }
    const replay = { ...(await summarizeParsedSse(replayParsed, replayAttempt.transport, replayAttempt.attempts)), ...gatewayObservation(replayAttempt.response) };
    const passed = replayParsed.malformedEvents === 0
      && replayParsed.effectiveFinishReason === 'stop'
      && replayParsed.content.trim().length > 0
      && replayParsed.toolCalls.length === 0;
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
  if (profile.reasoningMode === 'provider-default') return [{ levels: [], semantic: { mapping: {}, removePaths: [] } }];
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

interface DiscoveryDiagnostic {
  levels: ReasoningLevel[];
  stage: 'reasoning' | 'tool-call' | 'tool-replay' | 'final-response' | 'cache-fill' | 'cache-read' | 'branch-correlation';
  code: 'completion_limit' | 'no_tool_call' | 'invalid_tool_call' | 'replay_rejected' | 'request_rejected'
    | 'timeout' | 'transport_error' | 'malformed_response' | 'response_too_large' | 'unexpected_response_format' | 'provider_refusal'
    | 'off_not_disabled' | 'incomplete_final_response' | 'cache_reuse_unobserved' | 'backend_changed' | 'observed_backend_unidentified';
  status?: number;
  transport?: string;
  providerCode?: string | number;
  providerType?: string;
  effectiveFinishReason?: string;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  cacheReadAttempted?: boolean;
}

function stopsDiscovery(diagnostic: DiscoveryDiagnostic): boolean {
  return ['timeout', 'transport_error', 'malformed_response', 'response_too_large', 'unexpected_response_format'].includes(diagnostic.code)
    || diagnostic.status === 401 || diagnostic.status === 403 || diagnostic.status === 429
    || (diagnostic.status !== undefined && diagnostic.status >= 500);
}

function probeDiagnostic(probe: Record<string, any> | null, levels: ReasoningLevel[], stage: DiscoveryDiagnostic['stage']): DiscoveryDiagnostic | null {
  if (!probe) return null;
  const boundary = {
    ...(typeof probe.status === 'number' ? { status: probe.status } : {}),
    ...(['rest', 'compat', 'bedrock-invoke', 'bedrock-eventstream'].includes(probe.transport) ? { transport: String(probe.transport) } : {}),
    // Only fields already projected by sanitizedError belong here. Reapply the
    // grammar at the public boundary; a provider message/body is never a code.
    ...((typeof probe.code === 'number' && Number.isFinite(probe.code) || typeof probe.code === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(probe.code)) ? { providerCode: probe.code as string | number } : {}),
    ...(typeof probe.type === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(probe.type) ? { providerType: probe.type } : {}),
  };
  for (const code of ['timeout', 'transport_error', 'malformed_response', 'response_too_large', 'unexpected_response_format'] as const) {
    if (probe.code === code) return { levels, stage, code, ...boundary };
  }
  if (probe.malformedEvents > 0) return { levels, stage, code: 'malformed_response', ...boundary };
  if (probe.status !== 200) return { levels, stage, code: stage === 'tool-replay' ? 'replay_rejected' : 'request_rejected', ...boundary };
  if (probe.effectiveFinishReason === 'content_filter') return { levels, stage, code: 'provider_refusal', ...boundary,
    effectiveFinishReason: 'content_filter',
    ...(Number.isSafeInteger(probe.cacheWriteTokens) && probe.cacheWriteTokens >= 0 ? { cacheWriteTokens: probe.cacheWriteTokens as number } : {}),
    ...(Number.isSafeInteger(probe.cacheReadTokens) && probe.cacheReadTokens >= 0 ? { cacheReadTokens: probe.cacheReadTokens as number } : {}),
  };
  return null;
}

function mappingDiagnostics(items: Array<Record<string, any>>): DiscoveryDiagnostic[] {
  const diagnostics: DiscoveryDiagnostic[] = [];
  for (const item of items) {
    const levels = item.levels as ReasoningLevel[];
    const probe = item.reasoningProbe;
    const reasoningFailure = probeDiagnostic(probe, levels, 'reasoning');
    if (reasoningFailure) diagnostics.push(reasoningFailure);
    else if (levels.includes('off')) {
      if (probe.reasoningLength > 0 || probe.reasoningTokens > 0 || probe.nativeThinkingObserved === true || probe.nativeObservationCompleted === false) diagnostics.push({ levels: ['off'], stage: 'reasoning', code: 'off_not_disabled' });
      else if (probe.finishReason === 'length') diagnostics.push({ levels: ['off'], stage: 'reasoning', code: 'completion_limit' });
    }
    const tool = item.toolLifecycle;
    if (tool.stage === 'not-run' || tool.passed) continue;
    const firstFailure = probeDiagnostic(tool.first, levels, 'tool-call');
    const replayFailure = probeDiagnostic(tool.replay, levels, 'tool-replay');
    if (firstFailure || replayFailure) diagnostics.push((firstFailure ?? replayFailure)!);
    else if (tool.first?.effectiveFinishReason === 'length') diagnostics.push({ levels, stage: 'tool-call', code: 'completion_limit' });
    else if (tool.replay?.effectiveFinishReason === 'length') diagnostics.push({ levels, stage: 'final-response', code: 'completion_limit' });
    else if (tool.replay) diagnostics.push({ levels, stage: 'final-response', code: 'incomplete_final_response' });
    else diagnostics.push({ levels, stage: 'tool-call', code: tool.first?.toolCallCount === 0 ? 'no_tool_call' : 'invalid_tool_call' });
  }
  return diagnostics;
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

function gatewayObservation(response: Response): Record<string, unknown> {
  const cache = response.headers.get('cf-aig-cache-status')?.toUpperCase();
  const safe = (name: string) => {
    const value = response.headers.get(name);
    return value && /^[A-Za-z0-9@._:/-]{1,256}$/.test(value) ? value : undefined;
  };
  return { cacheStatus: cache === 'HIT' || cache === 'MISS' ? cache : null,
    backend: { ...(safe('cf-aig-provider') && { provider: safe('cf-aig-provider') }), ...(safe('cf-aig-model') && { model: safe('cf-aig-model') }) } };
}

/** One explicit discovery, not startup probing: tools/replay first, then two
 * bounded public cache observations. No TTL/key overrides or model substitutes.
 * Native markers never leak into Dynamic conversion. A MISS is inconclusive:
 * model-specific prefix thresholds, placement and best-effort reuse still apply.
 */
async function discoverCache(common: CommonRequest, route: string, maxCompletionTokens: number, mappingObservations: Array<Record<string, any>>, semantic: SemanticMapping) {
  const marker = crypto.randomUUID();
  // Large enough to exercise documented 4,096-token minima with ordinary text,
  // but not a tokenizer claim or a promise of a hit for an unknown future model.
  const prefix = `Public Codeflare cache canary ${marker}. Ignore the fictional inventory; follow the user request.\n`
    + Array.from({ length: 2048 }, (_, index) => `Item ${index}: amber birch cedar.`).join('\n');
  const request: PlainObject = applySemanticMapping({ model: route, messages: [
    { role: 'system', content: common.native ? [{ type: 'text', text: prefix, cache_control: { type: 'ephemeral', ttl: '5m' } }] : prefix },
    { role: 'user', content: 'Reply with a numbered list of 32 short fictional labels. Do not use tools.' },
  ], stream: true, stream_options: { include_usage: true }, max_completion_tokens: maxCompletionTokens }, semantic);
  request.max_completion_tokens = maxCompletionTokens;
  const observations: Array<Record<string, any>> = [];
  for (let index = 0; index < 2; index++) {
    try {
      const attempt = await requestChatCompletionsWithCompat({ ...common, body: request });
      const header = gatewayObservation(attempt.response);
      if (attempt.response.status !== 200) {
        const text = await readBoundedText(attempt.response, common.maxResponseBytes);
        observations.push({ ...sanitizedError(attempt.response.status, text), ...header, transport: attempt.transport, httpAttempts: attempt.attempts });
        break; // A validation/auth/provider failure is evidence, not a retry invitation.
      }
      const parsed = await parsePiSseStream(attempt.response.body, common.maxResponseBytes);
      const valid = parsed.malformedEvents === 0 && parsed.effectiveFinishReason === 'stop' && parsed.content.trim().length > 0 && parsed.usage !== null;
      observations.push({ ...(await summarizeParsedSse(parsed, attempt.transport, attempt.attempts)), ...header, valid });
      if (!valid) break;
    } catch (error) {
      observations.push(publicProbe(transportFailure(error))); break;
    }
  }
  // Certify the exercised path, not every configured fallback. But never join
  // known reasoning/tools-on-A and cache-on-B into a fictitious capable backend.
  // Missing Gateway identity stays unobserved, not invented from inventory.
  const allObservations = [...mappingObservations, ...observations];
  const backendConsistent = ['provider', 'model'].every((key) => new Set(allObservations.map((item) => item.backend?.[key]).filter(Boolean)).size <= 1);
  const backendIdentified = allObservations.every((item) => item.backend?.provider && item.backend?.model);
  const complete = backendConsistent && observations.length === 2 && observations.every((item) => item.valid)
    && observations[0].transport === observations[1].transport;
  const second = observations[1];
  const prefixRead = complete && second.cacheStatus !== 'HIT' && second.cacheReadTokens > 0;
  const cache: CapabilityMapping['cache'] = prefixRead ? 'provider-prefix'
    : complete && second.cacheStatus === 'HIT' ? 'gateway-response' : 'inconclusive';
  // Cached delivery and synthesized Invoke SSE are never cold-generation proof.
  const incremental = common.compatibility?.response !== 'buffered' && observations.some((item) => item.valid && item.cacheStatus !== 'HIT' && item.transport !== 'bedrock-invoke'
    && item.publicDeltaTimes.length >= 2 && item.publicDeltaTimes[0] + 5 < item.publicDeltaTimes.at(-1)
    && item.publicDeltaTimes[0] + 5 < item.eofTime);
  return { cache, incremental, observations, backendConsistent, backendIdentified, identicalPublicBody: true, publicBodyHash: await digest(JSON.stringify(compatibilityRequest(request, common.compatibility))),
    explanation: !backendConsistent ? 'Reasoning, tool or cache observations identify different backends. Evidence cannot certify one exercised route path; this is not an all-branches requirement.'
      : observations[0]?.effectiveFinishReason === 'content_filter'
        ? `The provider refused the cache-fill response.${Number.isSafeInteger(observations[0].cacheWriteTokens) && observations[0].cacheWriteTokens >= 0 ? ` Provider cache write: ${observations[0].cacheWriteTokens} tokens.` : ''} Cache-read was not attempted. A write alone does not prove input caching.`
      : cache === 'inconclusive' ? 'No qualifying cache reuse observed. Unsupported caching is NOT established by a miss, absent counters, truncation or a rejected probe.'
      : cache === 'gateway-response' ? 'Gateway HIT is whole-response reuse, not proof of provider input-prefix reuse.'
        : 'Positive provider prefix-cache reads observed on the native/compat request actually tested.' };
}

export async function discoverPiCompatibility(input: DiscoveryInput): Promise<Record<string, any>> {
  const { profile, offCandidate } = validateInput(input);
  const fetcher = input.fetcher ?? input.fetchImpl ?? fetch;
  const replay = new Map<string, unknown[]>();
  const common: CommonRequest = {
    accountId: input.accountId,
    gatewayId: input.gatewayId,
    apiToken: input.apiToken as string,
    endpoint: input.endpoint,
    fetcher,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    compatOnly: input.compatOnly || profile.compatibility?.transport === 'compat',
    byokAlias: input.byokAlias,
    repairToolNames: profile.compatibility?.toolNames === 'repeated-complete' || profile.id === 'bedrock-anthropic-compat' || profile.id === 'dynamic-bedrock-anthropic-provider-default',
    compatibility: profile.compatibility,
    campaignDeadline: input.campaignDeadline,
    native: input.native,
    ...(input.native && { replayState: { load: async (id: string) => replay.get(id) ?? null,
      save: async (id: string, blocks: unknown[]) => { replay.set(id, clone(blocks)); } } }),
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
    // The paid canary budget belongs to the caller, not the profile mapping.
    reasoningRequest.max_completion_tokens = input.maxCompletionTokens;
    let reasoningProbe: ProbeResult | null = null;
    if (profile.reasoningMode !== 'provider-default') {
      accounting.logicalProbes += 1;
      reasoningProbe = await executeReasoningProbe(common, reasoningRequest);
      addEvidence(accounting, reasoningProbe);
    }
    if (reasoningProbe?.stop) {
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
    initialRequest.max_completion_tokens = input.maxCompletionTokens;
    accounting.logicalProbes += 1;
    const toolLifecycle = await executeToolLifecycle(common, initialRequest);
    addEvidence(accounting, toolLifecycle.first);
    addEvidence(accounting, toolLifecycle.replay);
    distinctMappings.push({
      levels: group.levels,
      reasoningProbe: reasoningProbe ? publicProbe(reasoningProbe) : null,
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
    request.max_completion_tokens = input.maxCompletionTokens;
    accounting.logicalProbes += 1;
    const probe = await executeReasoningProbe(common, request);
    addEvidence(accounting, probe);
    offCandidateEvidence = publicProbe(probe);
    stopped = probe.stop;
  }

  const verifiedLevels = distinctMappings.filter((item) => item.toolLifecycle.passed).flatMap((item) => item.levels) as ReasoningLevel[];
  const attemptedLevels = new Set(distinctMappings.flatMap((item) => item.levels as ReasoningLevel[]));
  const failedLevels = profile.supportedLevels.filter((level) => !verifiedLevels.includes(level) || !attemptedLevels.has(level));
  const allToolsPassed = distinctMappings.length > 0 && distinctMappings.every((item) => item.toolLifecycle.passed === true && item.toolLifecycle.stage === 'complete')
    && verifiedLevels.length === profile.supportedLevels.length;
  const replayUnsupported = distinctMappings.some((item) => item.toolLifecycle.stage === 'tool-replay'
    && typeof item.toolLifecycle.replay?.status === 'number'
    && item.toolLifecycle.replay.status >= 400
    && item.toolLifecycle.replay.status < 500);
  const reasoningTransportFailures = distinctMappings.some((item) => item.reasoningProbe && (item.reasoningProbe.status !== 200 || item.reasoningProbe.malformedEvents > 0));
  const offItem = distinctMappings.find((item) => (item.levels as ReasoningLevel[]).includes('off'));
  const off = profile.supportedLevels.includes('off')
    ? offItem?.reasoningProbe.status === 200 && offItem.reasoningProbe.reasoningLength === 0
      && !(offItem.reasoningProbe.reasoningTokens > 0) && offItem.reasoningProbe.finishReason === 'stop'
      && offItem.reasoningProbe.malformedEvents === 0
      && (!input.native || (offItem.reasoningProbe.nativeObservationCompleted === true && offItem.reasoningProbe.nativeThinkingObserved === false))
      ? 'verified-disabled'
      : offItem?.reasoningProbe.status === 200 ? 'not-disabled' : 'not-verified'
    : offCandidateEvidence?.status === 200 && (offCandidateEvidence.reasoningLength as number) > 0
      ? 'verified-unsupported'
      : offCandidateEvidence?.status === 200 && offCandidateEvidence.reasoningLength === 0
        ? 'candidate-disabled-profile-mismatch'
        : 'unsupported-by-profile';

  const diagnostics = mappingDiagnostics(distinctMappings);
  // A capped reasoning observation may still validate an enabled mode through its complete
  // tool lifecycle. A capped tool call/replay, or an unproven off mode, never does.
  const compatibleLevels = verifiedLevels.filter((level) => !diagnostics.some((diagnostic) => diagnostic.levels.includes(level)));
  const completionLimited = diagnostics.some((diagnostic) => diagnostic.code === 'completion_limit' || diagnostic.code === 'provider_refusal');
  let stopDiscovery = diagnostics.some(stopsDiscovery);
  let assignable = !stopped
    && allToolsPassed
    && !reasoningTransportFailures
    && !['not-disabled', 'not-verified', 'candidate-disabled-profile-mismatch'].includes(off);
  let classification = stopDiscovery || completionLimited
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
        : stopDiscovery || completionLimited
          ? 'inconclusive'
          : 'unsupported';

  let cacheEvidence: Awaited<ReturnType<typeof discoverCache>> | undefined;
  let capabilitySummary: CapabilitySummaryV2 | undefined;
  if (input.requireCacheEvidence) {
    if (assignable) {
      // Keep the successful leg; do not replay a known REST 404 for every probe.
      if (distinctMappings[0]?.toolLifecycle.first?.transport === 'compat') common.compatOnly = true;
      cacheEvidence = await discoverCache(common, input.route, Math.min(input.maxCompletionTokens, 2048),
        distinctMappings.flatMap((item) => [item.reasoningProbe, item.toolLifecycle.first, item.toolLifecycle.replay]).filter(Boolean), groups[0].semantic);
      accounting.logicalProbes += cacheEvidence.observations.length;
      for (const observation of cacheEvidence.observations) addEvidence(accounting, observation);
      // The dedicated discovery screen returns per-contract diagnostics even
      // when no profile qualifies. Keep cache failures as actionable as tool
      // failures; a cache-only 403 must not disappear into an empty list.
      cacheEvidence.observations.forEach((observation, index) => {
        const stage = index === 0 ? 'cache-fill' : 'cache-read';
        const failure = probeDiagnostic(observation, groups[0].levels, stage);
        if (failure) diagnostics.push({ ...failure, cacheReadAttempted: cacheEvidence!.observations.length > 1 });
        else if (!observation.valid) diagnostics.push({ levels: groups[0].levels, stage, code: observation.effectiveFinishReason === 'length' ? 'completion_limit' : 'incomplete_final_response', cacheReadAttempted: cacheEvidence!.observations.length > 1 });
      });
      stopDiscovery ||= diagnostics.some(stopsDiscovery);
      if (!cacheEvidence.backendConsistent) diagnostics.push({ levels: [], stage: 'branch-correlation', code: 'backend_changed' });
      else if (cacheEvidence.cache === 'inconclusive' && cacheEvidence.observations.length === 2 && cacheEvidence.observations.every((item) => item.valid)) {
        diagnostics.push({ levels: [], stage: 'cache-read', code: 'cache_reuse_unobserved' });
      }
    }
    // Backend identity is independent of cache qualification. Optional failures
    // with no identity cannot erase identified lifecycle evidence, but conflicting
    // known observations can never be combined into a fictitious capable path.
    const lifecycleObservations = distinctMappings.flatMap((item) => [item.reasoningProbe, item.toolLifecycle.first, item.toolLifecycle.replay]).filter(Boolean);
    const observations = [...lifecycleObservations, ...(cacheEvidence?.observations ?? [])];
    const backendConsistent = ['provider', 'model'].every((key) => new Set(observations.map((item) => item.backend?.[key]).filter(Boolean)).size <= 1);
    const backendIdentified = lifecycleObservations.length > 0 && lifecycleObservations.every((item) => item.backend?.provider && item.backend?.model);
    if (!backendConsistent || (assignable && input.requireBackendIdentity && !backendIdentified)) {
      assignable = false;
      stopDiscovery = true;
      const code = !backendConsistent ? 'backend_changed' : 'observed_backend_unidentified';
      if (!diagnostics.some((item) => item.code === code)) diagnostics.push({ levels: [], stage: 'branch-correlation', code });
    }
    const incremental = common.compatibility?.response !== 'buffered' && observations.some((item) => item.status === 200
      && item.malformedEvents === 0 && item.valid !== false && item.cacheStatus !== 'HIT' && item.transport !== 'bedrock-invoke'
      && item.publicDeltaTimes?.length >= 2 && item.publicDeltaTimes[0] + 5 < item.publicDeltaTimes.at(-1)
      && item.publicDeltaTimes[0] + 5 < item.eofTime);
    const item = distinctMappings[0];
    const reasoning: CapabilityMapping['reasoning'] = profile.reasoningMode === 'provider-default' ? 'provider-default'
      : off === 'verified-disabled' ? 'verified-disabled'
        : item?.reasoningProbe?.reasoningTokens > 0 || item?.reasoningProbe?.reasoningLength > 0 || item?.reasoningProbe?.nativeThinkingObserved === true
          ? 'observed-enabled' : item?.reasoningProbe?.status === 200 ? 'accepted-unverified' : 'not-tested';
    const observedTransport = item?.toolLifecycle.first?.transport ?? item?.reasoningProbe?.transport;
    const nativeEffort = groups[0].semantic.mapping.output_config as PlainObject | undefined;
    const configured = input.native?.transport === 'aig-bedrock-anthropic-auto' ? 'auto'
      : input.native?.transport === 'aig-bedrock-anthropic-eventstream' ? 'eventstream' : 'invoke';
    const transport: CapabilityMapping['transport'] = observedTransport ?? (input.native
      ? selectBedrockAnthropicTransport(configured, nativeEffort?.effort as string | undefined) === 'invoke' ? 'bedrock-invoke' : 'bedrock-eventstream'
      : common.compatOnly ? 'compat' : 'rest');
    capabilitySummary = { schemaVersion: 2, mappings: [{ levels: [...groups[0].levels], transport,
      tools: Boolean(item?.toolLifecycle.first?.status === 200 && item.toolLifecycle.first.malformedEvents === 0
        && item.toolLifecycle.first.toolCallCount === 1 && item.toolLifecycle.first.toolNames?.[0] === CANARY_TOOL_NAME
        && item.toolLifecycle.first.effectiveFinishReason === 'tool_calls' && item.toolLifecycle.stage !== 'tool-call-validation'),
      replay: allToolsPassed, cache: cacheEvidence?.cache ?? 'not-tested', reasoning,
      streaming: incremental ? 'incremental' : 'not-observed' }] };
    assignable &&= !stopDiscovery;
    if (stopDiscovery || (!assignable && backendConsistent === false)) classification = 'Inconclusive';
  }
  replay.clear(); // No signed/provider state in reports, receipts, logs or persistent discovery storage.
  return {
    schemaVersion: 1,
    canaryVersion: PI_WIRE_CANARY_VERSION,
    profileId: profile.id,
    route: input.route,
    requestedCompletionCeiling: input.maxCompletionTokens,
    distinctMappings,
    diagnostics,
    compatibleLevels,
    stopDiscovery,
    piCompatibility: { status: piStatus, verifiedLevels, failedLevels },
    reasoningConfiguration: {
      off,
      offCandidateEvidence,
      graduatedEffort: 'not-proven-by-discovery',
      routeHealthVerified: !reasoningTransportFailures && !stopped,
    },
    classification,
    assignable,
    ...(capabilitySummary && { capabilitySummary, cacheEvidence }),
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
