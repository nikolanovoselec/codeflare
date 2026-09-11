export const NATIVE_MODEL_MAX_TOKENS = 16_384;
export const NATIVE_CONTEXT_WINDOW_MAX = 4_000_000;
export const NATIVE_MODEL_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._:/-]*$/;
export const NATIVE_PROVIDER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const NATIVE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
export const NATIVE_HASH_PATTERN = /^[a-f0-9]{64}$/;

const FORBIDDEN_IDENTIFIERS = ['__proto__', 'prototype', 'constructor'];
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
  return Boolean(value
    && (value.id === undefined || typeof value.id === 'string' && UUID_PATTERN.test(value.id))
    && typeof value.label === 'string' && value.label.trim().length >= 1 && value.label.trim().length <= 128 && NATIVE_TEXT_PATTERN.test(value.label.trim())
    && typeof value.provider === 'string' && nativeProviderIdentifierValid(value.provider)
    && typeof value.model === 'string' && nativeProviderModelValid(value.provider, value.model)
    && typeof value.contextWindow === 'number' && Number.isInteger(value.contextWindow) && value.contextWindow > NATIVE_MODEL_MAX_TOKENS && value.contextWindow <= NATIVE_CONTEXT_WINDOW_MAX
    && typeof value.enabled === 'boolean'
    && profile && typeof profile.id === 'string' && profile.id.length >= 1 && profile.id.length <= 64
    && typeof profile.revision === 'number' && Number.isInteger(profile.revision) && profile.revision > 0
    && typeof profile.hash === 'string' && NATIVE_HASH_PATTERN.test(profile.hash));
}
