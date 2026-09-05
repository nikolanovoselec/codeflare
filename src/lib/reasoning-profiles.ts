export const PI_REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PiReasoningLevel = typeof PI_REASONING_LEVELS[number];
export type ScalarValue = string | number | boolean | null;

export interface ScalarWrite {
  path: string;
  value: ScalarValue;
}

export interface ProfileRevisionRef {
  id: string;
  revision: number;
  hash: string;
}

export interface NormalizedLevelMapping {
  removePaths: string[];
  writes: ScalarWrite[];
}

export interface NormalizedReasoningProfile {
  id: string;
  name: string;
  description?: string;
  operatorNotes?: string;
  family: string;
  schemaVersion: 1;
  revision: number;
  hash: string;
  enabled: boolean;
  ingressContract: 'ai-gateway-chat-completions';
  supportedLevels: PiReasoningLevel[];
  unsupportedLevels: PiReasoningLevel[];
  removePaths: string[];
  levels: Partial<Record<PiReasoningLevel, ScalarWrite[]>>;
  aliases: Partial<Record<PiReasoningLevel, PiReasoningLevel>>;
  offSemantics: Record<string, unknown>;
  toolCompatibility: { status: 'verified' | 'unsupported' | 'unverified'; levels: PiReasoningLevel[]; evidence?: string };
  recognizedResponseFields: Record<string, string[]>;
  validatedTransports: Array<'rest' | 'compat'>;
  classification: 'Verified' | 'Compatible, unverified' | 'Heterogeneous' | 'Unsupported' | 'Inconclusive';
  limitations: string[];
  originallyCreatedAgainst?: Record<string, unknown>;
  validatedAgainst?: Array<Record<string, unknown>>;
  evidence?: Array<Record<string, unknown>>;
  builtIn: boolean;
}

export const REASONING_PROFILE_IDS = [
  'openai-gpt-chat-tools-reasoning',
  'openai-gpt-chat-tools-off',
  'workers-ai-gemma-thinking',
  'workers-ai-kimi-k-thinking',
  'workers-ai-glm-thinking',
  'codeflare-inference-mesh-binary-thinking',
] as const;
export type ReasoningProfileId = typeof REASONING_PROFILE_IDS[number];

const MAX_ID = 64;
const MAX_NAME = 128;
const MAX_TEXT = 512;
const MAX_LIMITATIONS = 16;
const MAX_PATHS = 16;
const MAX_PATH_LENGTH = 128;
const MAX_PATH_SEGMENTS = 4;
const MAX_SCALAR_STRING = 256;
const MAX_EVIDENCE_SUMMARIES = 20;
const PROTECTED_ROOTS = new Set([
  'model', 'messages', 'input', 'tools', 'tool_choice', 'stream', 'headers', 'header',
  'authorization', 'api_key', 'apikey', 'url', 'urls', 'base_url', 'baseurl', 'endpoint',
  'credentials', 'credential', 'provider', 'transport', 'gateway', 'gateway_id',
  'gateway_metadata', 'metadata', 'cf_aig_gateway_id', 'cf_aig_metadata', 'cf_aig_authorization',
]);
const DANGEROUS_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const RESPONSE_PATHS = new Set([
  'choices[].message.reasoning_content',
  'choices[].message.reasoning',
  'choices[].message.content',
  'choices[].message.tool_calls',
  'usage.completion_tokens_details.reasoning_tokens',
]);

export function isPiReasoningLevel(value: unknown): value is PiReasoningLevel {
  return typeof value === 'string' && (PI_REASONING_LEVELS as readonly string[]).includes(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.length === 0) || value.length > max) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function validateId(value: unknown): string {
  const id = boundedString(value, 'profile id', MAX_ID)!;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)) throw new Error('profile id is invalid');
  return id;
}

export function validateRequestPath(value: unknown): string {
  const path = boundedString(value, 'request path', MAX_PATH_LENGTH)!;
  const segments = path.split('.');
  if (segments.length > MAX_PATH_SEGMENTS || segments.some((segment) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) {
    throw new Error('request path uses an unsupported path form');
  }
  if (segments.some((segment) => DANGEROUS_PATH_SEGMENTS.has(segment.toLowerCase()))) throw new Error('request path contains a protected segment');
  if (PROTECTED_ROOTS.has(segments[0].toLowerCase())) throw new Error(`request path uses protected root ${segments[0]}`);
  return path;
}

function validateScalar(value: unknown): ScalarValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= MAX_SCALAR_STRING) return value;
  throw new Error('mapping values must be bounded scalar literals');
}

function validateWrites(value: unknown, label: string): ScalarWrite[] {
  if (!Array.isArray(value) || value.length > MAX_PATHS) throw new Error(`${label} must contain at most ${MAX_PATHS} writes`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry, `${label}[${index}]`);
    if (Object.keys(record).some((key) => key !== 'path' && key !== 'value')) throw new Error(`${label}[${index}] has unknown fields`);
    const path = validateRequestPath(record.path);
    if (seen.has(path)) throw new Error(`${label} contains duplicate path ${path}`);
    seen.add(path);
    return { path, value: validateScalar(record.value) };
  });
}

function validateRemovePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PATHS) throw new Error(`removePaths must contain at most ${MAX_PATHS} paths`);
  const paths = value.map(validateRequestPath);
  if (new Set(paths).size !== paths.length) throw new Error('removePaths must be unique');
  return paths;
}

function validateLevels(value: unknown, label: string): PiReasoningLevel[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PI_REASONING_LEVELS.length) throw new Error(`${label} is invalid`);
  const levels = value.map((level) => {
    if (!isPiReasoningLevel(level)) throw new Error(`${label} contains an unsupported level`);
    return level;
  });
  if (new Set(levels).size !== levels.length) throw new Error(`${label} must be unique`);
  return PI_REASONING_LEVELS.filter((level) => levels.includes(level));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

// Synchronous SHA-256 keeps profile normalization usable at Zod/KV boundaries in Workers.
export function canonicalHash(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const words: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) words[i >> 2] = (words[i >> 2] || 0) | bytes[i] << (24 - (i % 4) * 8);
  const bitLength = bytes.length * 8;
  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | 0x80 << (24 - bitLength % 32);
  words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const rotr = (value: number, count: number) => value >>> count | value << (32 - count);
  let hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = new Array<number>(64);
    for (let i = 0; i < 16; i += 1) schedule[i] = words[offset + i] | 0;
    for (let i = 16; i < 64; i += 1) {
      const a = schedule[i - 15]; const b = schedule[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ a >>> 3;
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ b >>> 10;
      schedule[i] = (schedule[i - 16] + s0 + schedule[i - 7] + s1) | 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = e & f ^ ~e & g;
      const t1 = (h + s1 + ch + constants[i] + schedule[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const t2 = (s0 + maj) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    hash = hash.map((value, i) => (value + [a,b,c,d,e,f,g,h][i]) | 0);
  }
  return hash.map((value) => (value >>> 0).toString(16).padStart(8, '0')).join('');
}

function flattenMapping(value: Record<string, unknown>, prefix = ''): ScalarWrite[] {
  const writes: ScalarWrite[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) writes.push(...flattenMapping(child as Record<string, unknown>, path));
    else writes.push({ path, value: validateScalar(child) });
  }
  return writes;
}

interface BuiltInDraft extends Omit<NormalizedReasoningProfile, 'hash' | 'schemaVersion' | 'enabled' | 'builtIn' | 'aliases' | 'levels'> {
  levelMappings: Partial<Record<PiReasoningLevel, Record<string, unknown>>>;
  aliases?: Partial<Record<PiReasoningLevel, PiReasoningLevel>>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function makeBuiltIn(draft: BuiltInDraft): NormalizedReasoningProfile {
  const supportedLevels = validateLevels(draft.supportedLevels, `${draft.id}.supportedLevels`);
  const mappingKeys = Object.keys(draft.levelMappings);
  if (supportedLevels.some((level) => !mappingKeys.includes(level)) || mappingKeys.some((level) => !supportedLevels.includes(level as PiReasoningLevel))) {
    throw new Error(`built-in profile ${draft.id} must map exactly its supported levels`);
  }
  const levels = Object.fromEntries(Object.entries(draft.levelMappings).map(([level, mapping]) => [
    level,
    validateWrites(flattenMapping(mapping!), `${draft.id}.levels.${level}`),
  ]));
  const { levelMappings: _levelMappings, ...metadata } = draft;
  const core = {
    ...metadata,
    supportedLevels,
    unsupportedLevels: PI_REASONING_LEVELS.filter((level) => !supportedLevels.includes(level)),
    removePaths: validateRemovePaths(draft.removePaths),
    schemaVersion: 1 as const,
    enabled: true,
    builtIn: true,
    aliases: draft.aliases ?? {},
    levels,
  };
  return deepFreeze({ ...core, hash: canonicalHash(core) }) as NormalizedReasoningProfile;
}

const COMMON_REMOVALS = ['reasoning_effort', 'reasoning', 'thinking', 'chat_template_kwargs.enable_thinking', 'chat_template_kwargs.thinking'];
const WORKERS_REMOVALS = [...COMMON_REMOVALS, 'chat_template_kwargs.clear_thinking'];
const ALL_LEVELS = [...PI_REASONING_LEVELS];
const GRADUATED_ALIASES = { minimal: 'low', xhigh: 'high', max: 'high' } as const;
const workersMapping = (effort: 'low' | 'medium' | 'high', enabled = true) => ({
  reasoning_effort: effort,
  chat_template_kwargs: { enable_thinking: enabled, clear_thinking: false },
});

export const BUILT_IN_REASONING_PROFILES: readonly NormalizedReasoningProfile[] = Object.freeze([
  makeBuiltIn({
    id: 'openai-gpt-chat-tools-reasoning', name: 'GPT Chat + tools + reasoning', family: 'OpenAI GPT', revision: 1,
    ingressContract: 'ai-gateway-chat-completions', supportedLevels: ALL_LEVELS, unsupportedLevels: [], removePaths: COMMON_REMOVALS,
    levelMappings: { off: { reasoning_effort: 'none' }, minimal: { reasoning_effort: 'low' }, low: { reasoning_effort: 'low' }, medium: { reasoning_effort: 'medium' }, high: { reasoning_effort: 'high' }, xhigh: { reasoning_effort: 'high' }, max: { reasoning_effort: 'high' } },
    aliases: GRADUATED_ALIASES, offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: 'none' },
    toolCompatibility: { status: 'verified', levels: ALL_LEVELS, evidence: 'Three complete final-profile Pi tool-call and exact replay runs.' },
    recognizedResponseFields: { reasoning: ['usage.completion_tokens_details.reasoning_tokens'], content: ['choices[].message.content'], tools: ['choices[].message.tool_calls'] },
    validatedTransports: ['rest'], classification: 'Verified', limitations: ['Pi minimal aliases provider low; Pi xhigh and max alias provider high.', 'Reasoning is reported through usage reasoning tokens rather than reasoning text.', 'Only REST transport was validated.'],
    originallyCreatedAgainst: { modelId: 'gpt-5.1', provider: 'openai', route: 'dynamic/code_review', activeRouteVersion: '71606b55-425c-4767-a645-23547a70c51f', observedAt: '2026-09-05' },
  }),
  makeBuiltIn({
    id: 'openai-gpt-chat-tools-off', name: 'GPT Chat + tools, reasoning off', family: 'OpenAI GPT', revision: 1,
    ingressContract: 'ai-gateway-chat-completions', supportedLevels: ['off'], unsupportedLevels: PI_REASONING_LEVELS.filter((level) => level !== 'off'), removePaths: COMMON_REMOVALS,
    levelMappings: { off: { reasoning_effort: 'none' } }, offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: 'none' },
    toolCompatibility: { status: 'verified', levels: ['off'], evidence: 'GPT-5.6 SOL completed the off-only lifecycle 3/3 times.' },
    recognizedResponseFields: { content: ['choices[].message.content'], tools: ['choices[].message.tool_calls'] }, validatedTransports: ['rest'], classification: 'Verified',
    limitations: ['Only reasoning off is supported.', 'Enabled reasoning with function tools failed before inference.', 'Responses-required models cannot use this profile through a dynamic route.', 'Only REST transport was validated.'],
    originallyCreatedAgainst: { modelId: 'gpt-5.5', provider: 'openai', route: 'dynamic/code_review', activeRouteVersion: '32684874-e364-4a92-b0b4-ff7bf5e5f8a7', observedAt: '2026-09-05' },
  }),
  makeBuiltIn({
    id: 'workers-ai-gemma-thinking', name: 'Gemma thinking + tools', family: 'Google Gemma', revision: 1,
    ingressContract: 'ai-gateway-chat-completions', supportedLevels: ALL_LEVELS, unsupportedLevels: [], removePaths: WORKERS_REMOVALS,
    levelMappings: { off: { reasoning_effort: null, chat_template_kwargs: { enable_thinking: false, clear_thinking: false } }, minimal: workersMapping('low'), low: workersMapping('low'), medium: workersMapping('medium'), high: workersMapping('high'), xhigh: workersMapping('high'), max: workersMapping('high') },
    aliases: GRADUATED_ALIASES, offSemantics: { status: 'explicit-toggle', path: 'chat_template_kwargs.enable_thinking', value: false }, toolCompatibility: { status: 'verified', levels: ALL_LEVELS },
    recognizedResponseFields: { reasoning: ['choices[].message.reasoning_content', 'choices[].message.reasoning'], content: ['choices[].message.content'] }, validatedTransports: ['rest'], classification: 'Compatible, unverified',
    limitations: ['Graduated effort fidelity remains compatible but unverified.', 'Workers AI streams rely on Codeflare terminator repair.', 'Only REST transport was validated.'],
    originallyCreatedAgainst: { modelId: '@cf/google/gemma-4-26b-a4b-it', route: 'dynamic/documentation', routeRevisionLabel: '84f493a6b0ca', observedAt: '2026-09-05' },
  }),
  makeBuiltIn({
    id: 'workers-ai-kimi-k-thinking', name: 'Kimi K-series thinking + tools', family: 'Moonshot Kimi K-series', revision: 1,
    ingressContract: 'ai-gateway-chat-completions', supportedLevels: PI_REASONING_LEVELS.filter((level) => level !== 'off'), unsupportedLevels: ['off'], removePaths: WORKERS_REMOVALS,
    levelMappings: { minimal: workersMapping('low'), low: workersMapping('low'), medium: workersMapping('medium'), high: workersMapping('high'), xhigh: workersMapping('high'), max: workersMapping('high') }, aliases: GRADUATED_ALIASES,
    offSemantics: { status: 'unsupported' }, toolCompatibility: { status: 'verified', levels: PI_REASONING_LEVELS.filter((level) => level !== 'off') },
    recognizedResponseFields: { reasoning: ['choices[].message.reasoning_content'], content: ['choices[].message.content'] }, validatedTransports: ['rest'], classification: 'Compatible, unverified',
    limitations: ['Explicit off is unavailable on the observed ingress.', 'Graduated effort fidelity remains compatible but unverified.', 'Workers AI streams rely on Codeflare terminator repair.', 'Only REST transport was validated.'],
    originallyCreatedAgainst: { modelId: '@cf/moonshotai/kimi-k2.7-code', route: 'dynamic/general_usage', routeRevisionLabel: 'd6eaffc75d3f', observedAt: '2026-09-05' },
  }),
  makeBuiltIn({
    id: 'workers-ai-glm-thinking', name: 'GLM thinking + tools', family: 'Zhipu GLM', revision: 1,
    ingressContract: 'ai-gateway-chat-completions', supportedLevels: ALL_LEVELS, unsupportedLevels: [], removePaths: WORKERS_REMOVALS,
    levelMappings: { off: { reasoning_effort: null, chat_template_kwargs: { enable_thinking: false, clear_thinking: false } }, minimal: workersMapping('low'), low: workersMapping('low'), medium: workersMapping('medium'), high: workersMapping('high'), xhigh: workersMapping('high'), max: workersMapping('high') }, aliases: GRADUATED_ALIASES,
    offSemantics: { status: 'explicit-toggle', path: 'chat_template_kwargs.enable_thinking', value: false }, toolCompatibility: { status: 'verified', levels: ALL_LEVELS },
    recognizedResponseFields: { reasoning: ['choices[].message.reasoning_content'], content: ['choices[].message.content'] }, validatedTransports: ['rest'], classification: 'Verified',
    limitations: ['Workers AI streams rely on Codeflare terminator repair.', 'Only REST transport was validated.'],
    originallyCreatedAgainst: { modelId: '@cf/zai-org/glm-5.3', route: 'dynamic/development', routeRevisionLabel: '0946fd8dfc31', observedAt: '2026-09-05' },
  }),
  makeBuiltIn({
    id: 'codeflare-inference-mesh-binary-thinking', name: 'Inference Mesh binary thinking + tools', family: 'Codeflare Inference Mesh', revision: 1,
    ingressContract: 'ai-gateway-chat-completions', supportedLevels: ALL_LEVELS, unsupportedLevels: [], removePaths: WORKERS_REMOVALS,
    levelMappings: { off: { chat_template_kwargs: { enable_thinking: false } }, minimal: { chat_template_kwargs: { enable_thinking: true } }, low: { chat_template_kwargs: { enable_thinking: true } }, medium: { chat_template_kwargs: { enable_thinking: true } }, high: { chat_template_kwargs: { enable_thinking: true } }, xhigh: { chat_template_kwargs: { enable_thinking: true } }, max: { chat_template_kwargs: { enable_thinking: true } } },
    aliases: { low: 'minimal', medium: 'minimal', high: 'minimal', xhigh: 'minimal', max: 'minimal' }, offSemantics: { status: 'explicit-toggle', path: 'chat_template_kwargs.enable_thinking', value: false }, toolCompatibility: { status: 'verified', levels: ALL_LEVELS },
    recognizedResponseFields: { reasoning: ['choices[].message.reasoning_content'], content: ['choices[].message.content'], tools: ['choices[].message.tool_calls'] }, validatedTransports: ['rest'], classification: 'Verified',
    limitations: ['All non-off Pi levels are equivalent provider-default-on aliases.', 'Backend changes require revalidation.', 'The configured research fallback was inactive.', 'Only REST transport was validated.'],
    originallyCreatedAgainst: { modelId: 'Qwen 3.6 35B (administrator-declared)', provider: 'custom-codeflare-inference-mesh', route: 'dynamic/codeflare-mesh', activeRouteVersion: '872da3ad-bf4c-47d2-91ed-1715794359f5', observedAt: '2026-09-05' },
  }),
]);

export const COMPATIBILITY_NOTICES = Object.freeze([
  { id: 'gpt-oss-tool-replay', title: 'GPT-OSS tool replay unsupported', assignable: false, classification: 'Unsupported' },
  { id: 'gemini-chat-completions-tools', title: 'Gemini Chat Completions tools unsupported', assignable: false, classification: 'Unsupported' },
  { id: 'gpt-6-astra-tools', title: 'GPT-6 Astra tools unsupported', assignable: false, classification: 'Unsupported' },
  { id: 'responses-required', title: 'Responses-required behavior is not assignable', assignable: false, classification: 'Unsupported' },
] as const);

const BUILT_INS_BY_ID = new Map(BUILT_IN_REASONING_PROFILES.map((profile) => [profile.id, profile]));

export function getBuiltInProfile(id: string): NormalizedReasoningProfile | undefined {
  return BUILT_INS_BY_ID.get(id);
}

export function getBuiltInProfileRef(id: ReasoningProfileId): ProfileRevisionRef {
  const profile = BUILT_INS_BY_ID.get(id);
  if (!profile) throw new Error(`Unknown built-in reasoning profile ${id}`);
  return { id: profile.id, revision: profile.revision, hash: profile.hash };
}

function sanitizeSummaryRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value, label);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`${label} has an invalid field`);
    if (typeof child === 'string') result[key] = boundedString(child, `${label}.${key}`, MAX_TEXT)!;
    else if (typeof child === 'number' && Number.isFinite(child) || typeof child === 'boolean' || child === null) result[key] = child;
    else if (Array.isArray(child) && child.length <= MAX_EVIDENCE_SUMMARIES && child.every((item) => typeof item === 'string' && item.length <= MAX_TEXT)) result[key] = [...child];
    else throw new Error(`${label} must contain sanitized scalar summaries`);
  }
  return result;
}

export function normalizeCustomProfile(input: unknown): NormalizedReasoningProfile {
  const value = asRecord(input, 'custom profile');
  const allowedFields = new Set([
    'id', 'name', 'description', 'operatorNotes', 'family', 'schemaVersion', 'revision', 'hash', 'enabled', 'ingressContract',
    'supportedLevels', 'unsupportedLevels', 'removePaths', 'levels', 'levelMappings', 'aliases', 'offSemantics',
    'toolCompatibility', 'recognizedResponseFields', 'validatedTransports', 'classification', 'limitations',
    'originallyCreatedAgainst', 'provenance', 'validatedAgainst', 'evidence', 'builtIn',
  ]);
  const unknownField = Object.keys(value).find((key) => !allowedFields.has(key));
  if (unknownField) throw new Error(`custom profile has unknown field ${unknownField}`);
  const id = validateId(value.id);
  if ((REASONING_PROFILE_IDS as readonly string[]).includes(id)) throw new Error('custom profile id conflicts with a built-in profile');
  const name = boundedString(value.name, 'profile name', MAX_NAME)!;
  const description = boundedString(value.description, 'profile description', MAX_TEXT, false);
  const operatorNotes = boundedString(value.operatorNotes, 'operator notes', MAX_TEXT, false);
  if (value.schemaVersion !== 1) throw new Error('custom profile schemaVersion must be 1');
  const revision = value.revision === undefined ? 1 : value.revision;
  if (!Number.isInteger(revision) || (revision as number) < 1 || (revision as number) > Number.MAX_SAFE_INTEGER) throw new Error('custom profile revision is invalid');
  if (typeof value.enabled !== 'boolean') throw new Error('custom profile enabled must be boolean');
  if (value.ingressContract !== undefined && value.ingressContract !== 'ai-gateway-chat-completions') throw new Error('custom profile ingress contract is unsupported');
  const supportedLevels = validateLevels(value.supportedLevels, 'supportedLevels');
  const unsupportedLevels = PI_REASONING_LEVELS.filter((level) => !supportedLevels.includes(level));
  const removePaths = validateRemovePaths(value.removePaths ?? []);
  const rawLevels = asRecord(value.levels ?? value.levelMappings, 'levels');
  const rawAliases = value.aliases === undefined ? {} : asRecord(value.aliases, 'aliases');
  const aliases: Partial<Record<PiReasoningLevel, PiReasoningLevel>> = {};
  const levels: Partial<Record<PiReasoningLevel, ScalarWrite[]>> = {};
  for (const level of supportedLevels) {
    const alias = rawAliases[level] ?? (typeof rawLevels[level] === 'string' ? rawLevels[level] : undefined);
    if (alias !== undefined) {
      if (!isPiReasoningLevel(alias) || !supportedLevels.includes(alias) || alias === level) throw new Error(`alias for ${level} is invalid`);
      if (level === 'off') throw new Error('off cannot alias an enabled reasoning level');
      aliases[level] = alias;
      continue;
    }
    levels[level] = validateWrites(rawLevels[level], `levels.${level}`);
  }
  for (const key of Object.keys(rawLevels)) if (!isPiReasoningLevel(key) || !supportedLevels.includes(key)) throw new Error(`levels contains unsupported key ${key}`);
  for (const [level, target] of Object.entries(aliases)) {
    const seen = new Set([level]);
    let cursor: PiReasoningLevel = target;
    while (aliases[cursor]) {
      if (seen.has(cursor)) throw new Error('profile aliases contain a cycle');
      seen.add(cursor);
      cursor = aliases[cursor]!;
    }
    const targetWrites = levels[cursor];
    if (!targetWrites) throw new Error(`alias ${level} has no concrete mapping`);
    levels[level as PiReasoningLevel] = targetWrites.map((write) => ({ ...write }));
  }
  let offSemantics: Record<string, unknown>;
  if (supportedLevels.includes('off')) {
    if (!levels.off || levels.off.length === 0) throw new Error('off requires an explicit literal disable mapping');
    const declared = asRecord(value.offSemantics, 'off semantics');
    if (Object.keys(declared).some((key) => !['status', 'path', 'value'].includes(key))
      || !['explicit-toggle', 'explicit-value'].includes(String(declared.status))) {
      throw new Error('off semantics declaration is invalid');
    }
    const path = validateRequestPath(declared.path);
    const scalarValue = validateScalar(declared.value);
    if (!levels.off.some((write) => write.path === path && Object.is(write.value, scalarValue))) {
      throw new Error('off semantics must match an explicit off mapping write');
    }
    if (path.endsWith('enable_thinking') && scalarValue !== false) {
      throw new Error('off semantics enable_thinking toggle must be false');
    }
    offSemantics = { status: declared.status, path, value: scalarValue };
  } else {
    if (value.offSemantics !== undefined) {
      const declared = asRecord(value.offSemantics, 'off semantics');
      if (Object.keys(declared).some((key) => key !== 'status') || declared.status !== 'unsupported') {
        throw new Error('off semantics must be unsupported when off is not mapped');
      }
    }
    offSemantics = { status: 'unsupported' };
  }
  const responseRecord = asRecord(value.recognizedResponseFields ?? {}, 'recognizedResponseFields');
  const recognizedResponseFields: Record<string, string[]> = {};
  for (const [kind, paths] of Object.entries(responseRecord)) {
    if (!['reasoning', 'content', 'tools', 'usage'].includes(kind) || !Array.isArray(paths) || paths.length > MAX_PATHS) throw new Error('recognized response fields are invalid');
    recognizedResponseFields[kind] = paths.map((path) => {
      if (typeof path !== 'string' || !RESPONSE_PATHS.has(path)) throw new Error('recognized response path is unsupported');
      return path;
    });
  }
  const limitations = value.limitations === undefined ? [] : value.limitations;
  if (!Array.isArray(limitations) || limitations.length > MAX_LIMITATIONS || !limitations.every((entry) => typeof entry === 'string' && entry.length <= MAX_TEXT)) throw new Error('limitations are invalid');
  const evidence = value.evidence === undefined ? [] : value.evidence;
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE_SUMMARIES) throw new Error('evidence summaries are invalid');
  const sanitizedEvidence = evidence.map((entry, index) => sanitizeSummaryRecord(entry, `evidence[${index}]`));
  if (value.originallyCreatedAgainst !== undefined && value.provenance !== undefined) throw new Error('custom profile has duplicate provenance');
  const rawProvenance = value.originallyCreatedAgainst ?? value.provenance;
  const originallyCreatedAgainst = rawProvenance === undefined
    ? undefined
    : sanitizeSummaryRecord(rawProvenance, 'originallyCreatedAgainst');
  const validatedAgainstInput = value.validatedAgainst === undefined ? [] : value.validatedAgainst;
  if (!Array.isArray(validatedAgainstInput) || validatedAgainstInput.length + evidence.length > MAX_EVIDENCE_SUMMARIES) throw new Error('validation summaries are invalid');
  const validatedAgainst = validatedAgainstInput.map((entry, index) => sanitizeSummaryRecord(entry, `validatedAgainst[${index}]`));
  const family = boundedString(value.family, 'profile family', MAX_NAME, false) ?? 'Custom';
  const core = {
    id, name, ...(description !== undefined && { description }), ...(operatorNotes !== undefined && { operatorNotes }), family, schemaVersion: 1 as const, revision: revision as number,
    enabled: value.enabled, ingressContract: 'ai-gateway-chat-completions' as const, supportedLevels, unsupportedLevels,
    removePaths, levels, aliases, offSemantics,
    toolCompatibility: { status: 'unverified' as const, levels: [] as PiReasoningLevel[] }, recognizedResponseFields,
    validatedTransports: [] as Array<'rest' | 'compat'>, classification: 'Compatible, unverified' as const,
    limitations: [...limitations] as string[],
    ...(originallyCreatedAgainst && { originallyCreatedAgainst }),
    ...(validatedAgainst.length > 0 && { validatedAgainst }),
    ...(sanitizedEvidence.length > 0 && { evidence: sanitizedEvidence }), builtIn: false,
  };
  const hash = canonicalHash(core);
  if (value.hash !== undefined && value.hash !== hash) throw new Error('custom profile canonical hash does not match its revision');
  return { ...core, hash };
}

function deletePath(target: Record<string, unknown>, path: string): void {
  const segments = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const child = cursor[segments[i]];
    if (!child || typeof child !== 'object' || Array.isArray(child)) return;
    cursor = child as Record<string, unknown>;
  }
  delete cursor[segments.at(-1)!];
}

function writePath(target: Record<string, unknown>, write: ScalarWrite): void {
  const segments = write.path.split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const existing = cursor[segments[i]];
    if (existing === undefined) cursor[segments[i]] = {};
    else if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error(`reasoning mapping cannot descend through ${segments[i]}`);
    cursor = cursor[segments[i]] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = write.value;
}

export interface RouteSettings {
  contextWindows: Record<string, number>;
  reasoningProfiles: Record<string, string>;
}

/** Read the historical combined route settings without blessing legacy profile IDs. */
export function parseRouteSettings(raw: unknown): RouteSettings {
  const contextWindows: Record<string, number> = {};
  const reasoningProfiles: Record<string, string> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { contextWindows, reasoningProfiles };
  for (const [route, value] of Object.entries(raw)) {
    if (!route || route.length > 256 || route.includes('/') || DANGEROUS_PATH_SEGMENTS.has(route.toLowerCase())) continue;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      contextWindows[route] = value;
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.contextWindow === 'number' && Number.isInteger(entry.contextWindow) && entry.contextWindow > 0) {
      contextWindows[route] = entry.contextWindow;
    }
    if (typeof entry.reasoningProfile === 'string' && entry.reasoningProfile.length <= 64) {
      reasoningProfiles[route] = entry.reasoningProfile;
    }
  }
  return { contextWindows, reasoningProfiles };
}

/** Context windows retain their original numeric-only KV shape. */
export function serializeRouteSettings(contextWindows: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(contextWindows).filter(([, value]) => Number.isInteger(value) && value > 0));
}

export function translateReasoningRequest(payload: Record<string, unknown>, profile: NormalizedReasoningProfile, level: PiReasoningLevel): Record<string, unknown> {
  if (!profile.enabled) throw new Error('reasoning profile is disabled');
  const writes = profile.levels[level];
  if (!writes || !profile.supportedLevels.includes(level)) throw new Error(`reasoning level ${level} is not mapped by profile ${profile.id}`);
  const translated = structuredClone(payload);
  for (const path of profile.removePaths) deletePath(translated, path);
  for (const write of writes) writePath(translated, write);
  return translated;
}
