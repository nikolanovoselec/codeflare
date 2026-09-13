import { describe, expect, it } from 'vitest';
import { BEDROCK_NATIVE_ADAPTER_VERSION, createNativeTarget, nativeTargetDraftSchema, nativeVerificationMatches, nativePromptCacheSupported } from '../../lib/native-ai-targets';
import { connectionFingerprint } from '../../lib/reasoning-verification';
import { getBuiltInProfile, translateRuntimeReasoningRequest } from '../../lib/reasoning-profiles';
import { buildBedrockAnthropicRequest } from '../../lib/bedrock-anthropic-native-adapter';

const profileId = 'bedrock-anthropic-native-provider-default';
// Future identifier is deliberately synthetic. Acceptance proves absence of a
// release-name gate, NOT AWS availability, entitlement, or live capabilities.
const models = ['anthropic.claude-3-7-sonnet-20250219-v1:0', 'eu.anthropic.claude-sonnet-4-6',
  'eu.anthropic.claude-opus-4-8', 'eu.anthropic.claude-sonnet-5', 'anthropic.claude-fable-5-1',
  'eu.anthropic.claude-synthetic-future-2099-v1:0'];
const draft = (model: string) => ({ label: 'Synthetic contract target', provider: 'aws-bedrock', model,
  contextWindow: 200000, profileRef: { id: profileId, revision: 1, hash: getBuiltInProfile(profileId)?.hash ?? 'a'.repeat(64) },
  transport: 'aig-bedrock-anthropic-auto' as const, region: 'eu-central-1', enabled: false });

describe('reusable Bedrock Messages contract', () => {
  it.each(['eu.anthropic.claude-sonnet-50', 'eu.anthropic.claude-opus-5-future'])('REQ-ENTERPRISE-074: %s cannot inherit a legacy reasoning/cache certification by substring', (model) => {
    const profile = getBuiltInProfile(model.includes('sonnet') ? 'bedrock-anthropic-native-sonnet' : 'bedrock-anthropic-native-opus-auto')!;
    expect(nativeTargetDraftSchema.safeParse({ ...draft(model), profileRef: { id: profile.id, revision: profile.revision, hash: profile.hash } }).success).toBe(false);
  });
  it('REQ-ENTERPRISE-074: a generic profile/ref and administrator assertion do not certify unknown capabilities', () => {
    const target = createNativeTarget({ ...draft(models.at(-1)!), providerConfigId: 'synthetic-binding' });
    const connection = { gatewayUrl: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/`, gatewayId: 'synthetic', token: 'synthetic-token' };
    const proof = { schemaVersion: 1 as const, method: 'administrator' as const, targetId: target.id, model: target.model,
      providerConfigId: target.providerConfigId, connectionFingerprint: connectionFingerprint(connection)!, profileRef: target.profileRef,
      transport: target.transport, region: target.region, adapterVersion: BEDROCK_NATIVE_ADAPTER_VERSION as typeof BEDROCK_NATIVE_ADAPTER_VERSION, checkedAt: new Date().toISOString() };
    expect(nativeVerificationMatches(target, connection)).toBe(false);
    expect(nativeVerificationMatches({ ...target, verification: { ...proof, method: undefined } }, connection)).toBe(false);
    const confirmed = { ...target, verification: proof };
    expect(nativeVerificationMatches(confirmed, connection)).toBe(true);
    expect(nativePromptCacheSupported(confirmed)).toBe(false);
    expect(nativeVerificationMatches({ ...confirmed, model: models[0] }, connection)).toBe(false);
    expect(nativeVerificationMatches(confirmed, { ...connection, gatewayId: 'another-gateway' })).toBe(false);
  });
  it.each(models)('REQ-ENTERPRISE-074: selects %s without a model-specific profile entry', (model) => {
    expect(nativeTargetDraftSchema.safeParse(draft(model)).success).toBe(true);
    expect(createNativeTarget({ ...draft(model), providerConfigId: 'synthetic-binding' }).model).toBe(model);
  });

  it('REQ-ENTERPRISE-074: provider default normalizes all seven preferences without claiming Off', () => {
    const profile = getBuiltInProfile(profileId);
    expect(profile).toBeDefined();
    for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(translateRuntimeReasoningRequest({ messages: [], reasoning_effort: level,
        thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'max' } }, profile!, level))
        .toEqual({ messages: [] });
    }
    expect(profile!.supportedLevels).toEqual([]); // Executable overrides, not the Pi preference selector.
  });

  it.each(['amazon.nova-pro-v1:0', 'openai.gpt-oss-120b-1:0', 'malicious.anthropic.claude-test', 'claude-test'])
    ('REQ-ENTERPRISE-074: %s cannot acquire Anthropic Runtime dispatch from a profile ID', (model) => {
      expect(nativeTargetDraftSchema.safeParse(draft(model)).success).toBe(false);
    });

  it.each([undefined, { type: 'disabled' }, { type: 'adaptive' }])
    ('REQ-ENTERPRISE-073: active replay requires authentic state even with thinking=%j', async (thinking) => {
      await expect(buildBedrockAnthropicRequest({ ...(thinking && { thinking }), messages: [
        { role: 'user', content: 'Synthetic canary' },
        { role: 'assistant', tool_calls: [{ id: 'synthetic-call', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'synthetic-call', content: 'synthetic result' },
      ] }, { load: async () => null, save: async () => {} })).rejects.toThrow('state is unavailable');
    });
});
