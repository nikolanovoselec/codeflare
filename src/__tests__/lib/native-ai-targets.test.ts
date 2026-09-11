import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeTarget, nativeProfileRefKey, nativeProviderSelector, nativeTargetDraftSchema, nativeTargetHandle, nativeVerificationMatches,
  parseNativeAiTargets, reconcileNativeTargets, sanitizeNativeTarget,
} from '../../lib/native-ai-targets';
import { defaultBedrockProvider, listCustomProviderSlugs, listCustomProviderSlugsForProviders, listNativeProviderConfigs, selectNativeProviderConfig } from '../../lib/ai-gateway-management';
import { connectionFingerprint } from '../../lib/reasoning-verification';
import { getBuiltInProfileRef } from '../../lib/reasoning-profiles';
import { nativeTargetDraftShapeValid } from '../../lib/native-ai-target-draft';

const profileRef = getBuiltInProfileRef('bedrock-anthropic-compat');
const connection = { gatewayUrl: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/`, gatewayId: 'gateway', token: 'secret-token' };
const fingerprint = connectionFingerprint(connection)!;
const authority = { 'aws-bedrock': { id: 'raw-provider', customProvider: false } };
const validRefs = new Set([nativeProfileRefKey(profileRef)]);
const envelope = (result: unknown[], page = 1, total = result.length) => ({ success: true, result, result_info: { page, count: result.length, per_page: 100, total_count: total } });

describe('native AI targets', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('REQ-ENTERPRISE-047: discovers all sanitized provider bindings through bounded gateway-scoped pages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope([{ id: 'bedrock-default', provider_slug: 'aws-bedrock', gateway_id: 'gateway', default_config: true, secret: 'never-return' }], 1, 2))))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope([{ id: 'other', provider_slug: 'openai', gateway_id: 'gateway', default_config: false, alias: 'openai-live' }], 2, 2))));
    vi.stubGlobal('fetch', fetchMock);
    const configs = await listNativeProviderConfigs('a'.repeat(32), 'gateway', 'secret-token');
    expect(defaultBedrockProvider(configs)).toEqual({ id: 'bedrock-default', provider: 'aws-bedrock', gatewayId: 'gateway', defaultSelection: true });
    expect(selectNativeProviderConfig(configs, 'openai')).toEqual({ id: 'other', provider: 'openai', gatewayId: 'gateway', alias: 'openai-live', defaultSelection: false });
    expect(JSON.stringify(configs)).not.toContain('secret');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('REQ-ENTERPRISE-047: discovers sanitized custom-provider slugs independently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope([{ slug: 'codeflare-inference-mesh', endpoint: 'secret' }, { slug: 'ollama' }])))));
    expect(await listCustomProviderSlugs('a'.repeat(32), 'secret-token')).toEqual(new Set(['codeflare-inference-mesh', 'ollama']));
  });

  it('uses failed custom-provider lookup only as a built-in classification fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(null, { status: 503 })));
    for (const provider of ['aws-bedrock', 'google-ai-studio', 'openai']) {
      await expect(listCustomProviderSlugsForProviders('a'.repeat(32), 'secret-token', [provider])).resolves.toEqual(new Set());
    }
    for (const provider of ['codeflare-inference-mesh', 'unknown-provider']) {
      await expect(listCustomProviderSlugsForProviders('a'.repeat(32), 'secret-token', [provider])).rejects.toThrow('management_request_failed');
    }
  });

  it('REQ-ENTERPRISE-047: rejects malformed, over-budget, cross-gateway and ambiguous provider discovery', async () => {
    for (const body of [
      { success: true, result: [], result_info: { page: 2, count: 0, per_page: 100, total_count: 0 } },
      envelope([{ id: 'x', provider_slug: 'aws-bedrock', gateway_id: 'other', default_config: true }]),
      { success: true, result: [], result_info: { page: 1, count: 0, per_page: 100, total_count: 1001 } },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
      await expect(listNativeProviderConfigs('a'.repeat(32), 'gateway', 'secret-token')).rejects.toThrow('provider_config_list_malformed');
    }
    expect(() => selectNativeProviderConfig([
      { id: 'one', provider: 'openai', gatewayId: 'gateway', defaultSelection: false },
      { id: 'two', provider: 'openai', gatewayId: 'gateway', defaultSelection: false },
    ], 'openai')).toThrow('provider_config_ambiguous');
  });

  it.each([
    ['aws-bedrock', false, 'eu.anthropic.claude-sonnet-5', 'aws-bedrock/eu.anthropic.claude-sonnet-5'],
    ['google-ai-studio', false, 'gemini-2.5-pro', 'google-ai-studio/gemini-2.5-pro'],
    ['openai', false, 'gpt-5', 'openai/gpt-5'],
    ['codeflare-inference-mesh', true, 'codeflare-mesh', 'custom-codeflare-inference-mesh/codeflare-mesh'],
  ])('REQ-ENTERPRISE-053: derives an opaque UUID handle while preserving generic provider identity for %s', (provider, customProvider, model, selector) => {
    const ref = getBuiltInProfileRef(provider === 'aws-bedrock' ? 'bedrock-anthropic-compat' : provider === 'google-ai-studio' ? 'native-google-ai-studio-compat' : provider === 'codeflare-inference-mesh' ? 'native-codeflare-inference-mesh-compat' : 'native-openai-compat');
    const target = createNativeTarget({ id: '11111111-1111-4111-8111-111111111111', label: provider, provider, customProvider, model, contextWindow: 200000, providerConfigId: 'raw-provider', profileRef: ref });
    expect(target).toMatchObject({ provider, ...(customProvider && { customProvider: true }), model, profileRef: ref });
    expect(nativeProviderSelector(provider, customProvider)).toBe(selector.slice(0, -(model.length + 1)));
    expect(nativeTargetHandle(target.id)).toBe('cf-native-11111111-1111-4111-8111-111111111111');
  });

  const legacyDraft = { label: 'Legacy Bedrock draft', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef, enabled: false };

  it('REQ-ENTERPRISE-066: browser validation treats an omitted provider as AWS Bedrock', () => {
    expect(nativeTargetDraftShapeValid(legacyDraft)).toBe(true);
    expect(nativeTargetDraftShapeValid({ ...legacyDraft, model: 'arn:aws:bedrock:eu-central-1:123456789012:inference-profile/example' })).toBe(false);
  });

  it('REQ-ENTERPRISE-066: API validation defaults an omitted provider to AWS Bedrock', () => {
    expect(nativeTargetDraftSchema.parse(legacyDraft).provider).toBe('aws-bedrock');
  });

  it('REQ-ENTERPRISE-066: browser validation rejects undeclared native draft fields', () => {
    expect(nativeTargetDraftShapeValid({ ...legacyDraft, unexpected: true })).toBe(false);
  });

  it('REQ-ENTERPRISE-066: API validation rejects undeclared native draft fields', () => {
    expect(nativeTargetDraftSchema.safeParse({ ...legacyDraft, unexpected: true }).success).toBe(false);
  });

  it('REQ-ENTERPRISE-060: enforces the Bedrock model boundary without restricting custom-provider model syntax', () => {
    for (const model of ['../escape', 'family/model', 'https://example.com/model', 'arn:aws:bedrock:eu-central-1:123456789012:inference-profile/example', 'model%2Fchild', 'model?query', 'model#fragment', 'model*']) {
      expect(() => createNativeTarget({ label: 'Bad', model, contextWindow: 200000, providerConfigId: 'raw-provider', profileRef })).toThrow();
    }
    const custom = createNativeTarget({ label: 'Custom', provider: 'custom-provider', customProvider: true, model: 'family/model:tag', contextWindow: 200000, providerConfigId: 'raw-provider', profileRef: getBuiltInProfileRef('native-codeflare-inference-mesh-compat') });
    expect(custom.model).toBe('family/model:tag');
    expect(() => createNativeTarget({ label: 'Small', model: 'valid.model', contextWindow: 16384, providerConfigId: 'raw-provider', profileRef })).toThrow();
  });

  it('REQ-ENTERPRISE-061: browser projection excludes exact provider authority and aliases', () => {
    const target = createNativeTarget({ id: '11111111-1111-4111-8111-111111111111', label: 'Claude', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, providerConfigId: 'raw-provider', providerConfigAlias: 'private-alias', profileRef });
    const projected = sanitizeNativeTarget(target);
    expect(projected).toMatchObject({ handle: nativeTargetHandle(target.id), label: 'Claude', provider: 'aws-bedrock', model: target.model, profileRef });
    expect(JSON.stringify(projected)).not.toContain('raw-provider');
    expect(JSON.stringify(projected)).not.toContain('private-alias');
  });

  it('REQ-ENTERPRISE-055: changed target or connection authority fails verification matching', () => {
    const target = createNativeTarget({ id: '11111111-1111-4111-8111-111111111111', label: 'GPT', provider: 'openai', model: 'gpt-5', contextWindow: 200000, providerConfigId: 'raw-provider', providerConfigAlias: 'openai-live', profileRef: getBuiltInProfileRef('native-openai-compat') });
    const verification = { schemaVersion: 1 as const, targetId: target.id, provider: 'openai', model: target.model, providerConfigId: target.providerConfigId, providerConfigAlias: 'openai-live', connectionFingerprint: fingerprint, profileRef: target.profileRef, transport: 'aig-legacy-compat' as const, adapterVersion: 'native-openai-compat-v1' as const, checkedAt: new Date().toISOString(), capabilities: { streaming: true as const, tools: true as const, replay: true as const } };
    const verified = { ...target, verification };
    expect(nativeVerificationMatches(verified, connection)).toBe(true);
    for (const changed of [
      { ...verified, provider: 'google-ai-studio' }, { ...verified, model: 'gpt-6' }, { ...verified, providerConfigId: 'new-provider' },
      { ...verified, providerConfigAlias: 'other' }, { ...verified, id: '22222222-2222-4222-8222-222222222222' },
      { ...verified, profileRef }, { ...verified, transport: 'other-transport' },
      { ...verified, verification: { ...verification, adapterVersion: 'bedrock-anthropic-compat-v1' } },
    ]) expect(nativeVerificationMatches(changed as typeof verified, connection)).toBe(false);
    expect(nativeVerificationMatches(verified, { ...connection, token: 'rotated-token' })).toBe(false);
  });

  const savedVerifiedTarget = () => parseNativeAiTargets({ schemaVersion: 1, targets: [{
    ...createNativeTarget({ id: '11111111-1111-4111-8111-111111111111', label: 'Old', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, providerConfigId: 'raw-provider', profileRef }),
    verification: { schemaVersion: 1, method: 'administrator', targetId: '11111111-1111-4111-8111-111111111111', model: 'eu.anthropic.claude-sonnet-5', providerConfigId: 'raw-provider', connectionFingerprint: 'b'.repeat(64), profileRef, transport: 'aig-legacy-compat', adapterVersion: 'bedrock-anthropic-compat-v1', checkedAt: new Date().toISOString() },
  }] });

  it('REQ-ENTERPRISE-055: unchanged provider authority retains identity and proof across label and context edits', () => {
    const current = savedVerifiedTarget();
    const edited = reconcileNativeTargets([{ id: current.targets[0].id, label: 'New', provider: 'aws-bedrock', model: current.targets[0].model, contextWindow: 240000, profileRef, enabled: false }], current, authority, validRefs);
    expect(edited.targets[0]).toMatchObject({ id: current.targets[0].id, label: 'New', contextWindow: 240000, verification: current.targets[0].verification });
  });

  it('REQ-ENTERPRISE-055: changed provider authority invalidates proof', () => {
    const current = savedVerifiedTarget();
    const drifted = reconcileNativeTargets([{ id: current.targets[0].id, label: 'New', provider: 'aws-bedrock', model: current.targets[0].model, contextWindow: 240000, profileRef, enabled: false }], current, { 'aws-bedrock': { id: 'new-provider', customProvider: false } }, validRefs);
    expect(drifted.targets[0]).toMatchObject({ id: current.targets[0].id, providerConfigId: 'raw-provider' });
    expect(drifted.targets[0].verification).toBeUndefined();
  });
});
