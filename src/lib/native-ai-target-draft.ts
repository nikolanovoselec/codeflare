export const NATIVE_MODEL_MAX_TOKENS = 16_384;
export const NATIVE_CONTEXT_WINDOW_MAX = 4_000_000;
export const NATIVE_MODEL_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._:/-]*$/;
export const NATIVE_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const NATIVE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
export const NATIVE_HASH_PATTERN = /^[a-f0-9]{64}$/;
export const NATIVE_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
export const NATIVE_TRANSPORTS = ['aig-legacy-compat', 'aig-bedrock-anthropic-invoke', 'aig-bedrock-anthropic-eventstream', 'aig-bedrock-anthropic-auto'] as const;
export const BEDROCK_MESSAGES_DEFAULT_PROFILE = 'bedrock-anthropic-native-provider-default';

/** A protocol candidate, never a claim of availability or capabilities. The
 * namespace admits new releases without a source change; authenticated binding
 * and an explicit, target-bound tool/cache check still gate authorization. */
export function bedrockAnthropicCandidate(model: string): boolean {
  return nativeProviderModelValid('aws-bedrock', model)
    && /^(?:(?:eu|us|apac|global)\.)?anthropic\.claude-[a-z0-9][a-z0-9.:-]*$/.test(model);
}

const FORBIDDEN_IDENTIFIERS = ['__proto__', 'prototype', 'constructor'];
const NATIVE_TARGET_DRAFT_KEYS = new Set(['id', 'label', 'provider', 'model', 'contextWindow', 'profileRef', 'enabled', 'transport', 'region']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;

export function nativeModelIdentifierValid(model: string): boolean {
  const value = model.trim();
  return value.length >= 1 && value.length <= 256 && NATIVE_MODEL_PATTERN.test(value)
    && !value.includes('..') && !FORBIDDEN_IDENTIFIERS.includes(value.toLowerCase());
}

export function nativeProviderIdentifierValid(provider: string): boolean {
  return NATIVE_PROVIDER_PATTERN.test(provider) && !FORBIDDEN_IDENTIFIERS.includes(provider);
}

export function nativeProviderModelValid(provider: string, model: string): boolean {
  const value = model.trim();
  return nativeModelIdentifierValid(value) && (provider !== 'aws-bedrock' || (!value.includes('/') && !/^arn:/i.test(value)));
}

export function nativeTargetDraftShapeValid(input: unknown): boolean {
  const value = record(input);
  const profile = record(value?.profileRef);
  const provider = value?.provider === undefined ? 'aws-bedrock' : value.provider;
  const transport = value?.transport === undefined ? 'aig-legacy-compat' : value.transport;
  const nativeBedrock = transport === 'aig-bedrock-anthropic-invoke' || transport === 'aig-bedrock-anthropic-eventstream' || transport === 'aig-bedrock-anthropic-auto';
  return Boolean(value
    && Object.keys(value).every((key) => NATIVE_TARGET_DRAFT_KEYS.has(key))
    && (value.id === undefined || typeof value.id === 'string' && UUID_PATTERN.test(value.id))
    && typeof value.label === 'string' && value.label.trim().length >= 1 && value.label.trim().length <= 128 && NATIVE_TEXT_PATTERN.test(value.label.trim())
    && typeof provider === 'string' && nativeProviderIdentifierValid(provider)
    && typeof transport === 'string' && (NATIVE_TRANSPORTS as readonly string[]).includes(transport)
    && (!nativeBedrock || provider === 'aws-bedrock')
    && (nativeBedrock ? typeof value.region === 'string' && NATIVE_REGION_PATTERN.test(value.region) : value.region === undefined)
    && typeof value.model === 'string' && nativeProviderModelValid(provider as string, value.model)
    && typeof value.contextWindow === 'number' && Number.isInteger(value.contextWindow) && value.contextWindow > NATIVE_MODEL_MAX_TOKENS && value.contextWindow <= NATIVE_CONTEXT_WINDOW_MAX
    && typeof value.enabled === 'boolean'
    && profile && typeof profile.id === 'string' && profile.id.length >= 1 && profile.id.length <= 64
    && typeof profile.revision === 'number' && Number.isInteger(profile.revision) && profile.revision > 0
    && typeof profile.hash === 'string' && NATIVE_HASH_PATTERN.test(profile.hash));
}

/** Collection-level upgrades must not force unrelated old targets to disappear.
 * An unavailable revision can be retained exactly as saved, disabled only. This
 * exception permits neither edits nor activation, and creates no new evidence. */
export function preservesDisabledNativeTarget(input: unknown, saved: unknown): boolean {
  const draft = record(input); const prior = record(saved);
  const ref = record(draft?.profileRef); const oldRef = record(prior?.profileRef);
  return Boolean(draft && prior && draft.enabled === false && typeof draft.id === 'string' && draft.id === prior.id
    && ['label', 'provider', 'model', 'transport', 'region', 'contextWindow'].every((field) => draft[field] === prior[field])
    && ref && oldRef && ['id', 'revision', 'hash'].every((field) => ref[field] === oldRef[field]));
}
