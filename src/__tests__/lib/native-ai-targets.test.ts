import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeTarget, nativeTargetHandle, nativeVerificationMatches, parseNativeAiTargets,
  reconcileNativeTargets, sanitizeNativeTarget,
} from '../../lib/native-ai-targets';
import { defaultBedrockProvider, listNativeProviderConfigs } from '../../lib/ai-gateway-management';
import { connectionFingerprint } from '../../lib/reasoning-verification';
import { getBuiltInProfileRef } from '../../lib/reasoning-profiles';

const profileRef = getBuiltInProfileRef('bedrock-anthropic-compat');
const connection = { gatewayUrl: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/`, gatewayId: 'gateway', token: 'secret-token' };
const fingerprint = connectionFingerprint(connection)!;
const envelope = (result: unknown[], page = 1, total = result.length) => ({ success: true, result, result_info: { page, count: result.length, per_page: 100, total_count: total } });

describe('native AI targets', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('REQ-ENTERPRISE-047: discovers only the unique default Bedrock provider through bounded sanitized pages', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope([{ id: 'bedrock-default', provider_slug: 'aws-bedrock', gateway_id: 'gateway', default_config: true, secret: 'never-return' }], 1, 2))))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope([{ id: 'other', provider_slug: 'openai', gateway_id: 'gateway', default_config: false }], 2, 2))));
    vi.stubGlobal('fetch', fetchMock);
    const configs = await listNativeProviderConfigs('a'.repeat(32), 'gateway', 'secret-token');
    expect(defaultBedrockProvider(configs)).toEqual({ id: 'bedrock-default', provider: 'aws-bedrock', gatewayId: 'gateway', defaultSelection: true });
    expect(JSON.stringify(configs)).not.toContain('secret');
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    expect(() => defaultBedrockProvider([
      { id: 'one', provider: 'aws-bedrock', gatewayId: 'gateway', defaultSelection: true },
      { id: 'two', provider: 'aws-bedrock', gatewayId: 'gateway', defaultSelection: true },
    ])).toThrow('provider_config_ambiguous');
  });

  it('REQ-ENTERPRISE-047: accepts an exact model absent from suggestions and derives a stable opaque handle', () => {
    const target = createNativeTarget({ id: '11111111-1111-4111-8111-111111111111', label: 'Claude', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, providerConfigId: 'raw-provider', profileRef });
    expect(target.model).toBe('eu.anthropic.claude-sonnet-5');
    expect(nativeTargetHandle(target.id)).toBe('cf-native-11111111-1111-4111-8111-111111111111');
    expect(() => createNativeTarget({ label: 'Bad', model: '../escape', contextWindow: 200000, providerConfigId: 'raw-provider', profileRef })).toThrow();
    expect(() => createNativeTarget({ label: 'Small', model: 'valid.model', contextWindow: 16384, providerConfigId: 'raw-provider', profileRef })).toThrow();
  });

  it('REQ-ENTERPRISE-047: browser projection excludes provider authority and sensitive discovery fields', () => {
    const target = createNativeTarget({ id: '11111111-1111-4111-8111-111111111111', label: 'Claude', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, providerConfigId: 'raw-provider', profileRef });
    const projected = sanitizeNativeTarget(target);
    expect(projected).toMatchObject({ handle: nativeTargetHandle(target.id), label: 'Claude', model: target.model });
    expect(JSON.stringify(projected)).not.toContain('raw-provider');
    expect(projected).not.toHaveProperty('providerConfigId');
  });

  it('REQ-ENTERPRISE-048: every native verification identity change invalidates authority', () => {
    const target = createNativeTarget({ id: '11111111-1111-4111-8111-111111111111', label: 'Claude', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, providerConfigId: 'raw-provider', profileRef });
    const verification = { schemaVersion: 1 as const, targetId: target.id, model: target.model, providerConfigId: target.providerConfigId, connectionFingerprint: fingerprint, profileRef, transport: 'aig-legacy-compat' as const, adapterVersion: 'bedrock-anthropic-compat-v1' as const, checkedAt: new Date().toISOString(), capabilities: { streaming: true as const, tools: true as const, replay: true as const } };
    const verified = { ...target, verification };
    expect(nativeVerificationMatches(verified, connection)).toBe(true);
    for (const changed of [
      { ...verified, model: 'eu.anthropic.claude-opus-5' },
      { ...verified, providerConfigId: 'new-provider' },
      { ...verified, id: '22222222-2222-4222-8222-222222222222' },
    ]) expect(nativeVerificationMatches(changed, connection)).toBe(false);
  });

  it('REQ-ENTERPRISE-047: label and context edits preserve identity while model or provider drift clears proof', () => {
    const current = parseNativeAiTargets({ schemaVersion: 1, targets: [{
      ...createNativeTarget({ id: '11111111-1111-4111-8111-111111111111', label: 'Old', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, providerConfigId: 'raw-provider', profileRef }),
      verification: { schemaVersion: 1, method: 'administrator', targetId: '11111111-1111-4111-8111-111111111111', model: 'eu.anthropic.claude-sonnet-5', providerConfigId: 'raw-provider', connectionFingerprint: 'b'.repeat(64), profileRef, transport: 'aig-legacy-compat', adapterVersion: 'bedrock-anthropic-compat-v1', checkedAt: new Date().toISOString() },
    }] });
    const edited = reconcileNativeTargets([{ id: current.targets[0].id, label: 'New', model: current.targets[0].model, contextWindow: 240000, profileId: profileRef.id, enabled: false }], current, 'raw-provider', profileRef);
    expect(edited.targets[0]).toMatchObject({ id: current.targets[0].id, label: 'New', contextWindow: 240000, verification: current.targets[0].verification });
    const drifted = reconcileNativeTargets([{ id: current.targets[0].id, label: 'New', model: current.targets[0].model, contextWindow: 240000, profileId: profileRef.id, enabled: false }], current, 'new-provider', profileRef);
    expect(drifted.targets[0].verification).toBeUndefined();
  });
});
