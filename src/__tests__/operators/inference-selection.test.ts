/// <reference types="@cloudflare/vitest-plugin/types" />
/** REQ-OPERATOR-007: selection narrows current verified user eligibility; it never grants routes. */
import { describe, expect, it } from 'vitest';
import { resolveOperatorInference } from '../../operators/inference-selection';
import type { OperatorPolicy } from '../../operators/policy';

const policy: OperatorPolicy = { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
  storage: { readPrefixes: [], writePrefixes: [] }, inference: { routeIds: ['production'],
    defaultRouteId: 'production', reasoningLevels: ['off', 'high'], defaultReasoningLevel: 'off',
    inheritUserDefaults: false } };
const eligible = { routeIds: ['development', 'production'], defaultRouteId: 'development', defaultReasoningLevel: 'medium' };

describe('REQ-OPERATOR-007: operator inference intersection', () => {
  it('uses the registered default inside current eligibility without inheriting human defaults', () => {
    expect(resolveOperatorInference({ eligible, policy })).toEqual({ routeId: 'production', reasoningLevel: 'off' });
  });

  it('accepts only trusted invocation selections inside both eligibility and restrictions', () => {
    expect(resolveOperatorInference({ eligible, policy, trusted: { routeId: 'production', reasoningLevel: 'high' } }))
      .toEqual({ routeId: 'production', reasoningLevel: 'high' });
    expect(() => resolveOperatorInference({ eligible, policy, trusted: { routeId: 'development', reasoningLevel: 'high' } }))
      .toThrow(/route.*not eligible/i);
    expect(() => resolveOperatorInference({ eligible, policy, trusted: { routeId: 'production', reasoningLevel: 'low' } }))
      .toThrow(/reasoning.*not eligible/i);
  });

  it('inherits human defaults only explicitly and never substitutes another allowed route', () => {
    const noDefaults = { ...policy, inference: { ...policy.inference, defaultRouteId: null,
      defaultReasoningLevel: null } };
    expect(() => resolveOperatorInference({ eligible, policy: noDefaults })).toThrow(/route selection required/i);
    expect(() => resolveOperatorInference({ eligible, policy: { ...noDefaults,
      inference: { ...noDefaults.inference, inheritUserDefaults: true } } })).toThrow(/route.*not eligible/i);
    expect(resolveOperatorInference({ eligible: { ...eligible, defaultRouteId: 'production', defaultReasoningLevel: 'high' },
      policy: { ...noDefaults, inference: { ...noDefaults.inference, inheritUserDefaults: true } } }))
      .toEqual({ routeId: 'production', reasoningLevel: 'high' });
  });

  it('keeps provider-default distinct from Off when no reasoning default is selected', () => {
    const providerDefault = { ...policy, inference: { ...policy.inference, defaultReasoningLevel: null } };
    expect(resolveOperatorInference({ eligible, policy: providerDefault })).toEqual({ routeId: 'production', reasoningLevel: null });
  });
});


describe('REQ-OPERATOR-007: parent-prepared native inference narrowing', () => {
  const native = { source: 'pi-native', provider: 'openai-codex', model: 'gpt-6.1-sol',
    api: 'openai-codex-responses', reasoningLevel: 'low', profileDigest: 'a'.repeat(64) };
  const nativePolicy: OperatorPolicy = { ...policy, inference: { ...policy.inference,
    allowedSources: ['managed', 'pi-native'], reasoningLevels: ['low', 'high'], defaultReasoningLevel: 'high' } };
  const nativeEligible = { ...eligible, piDefaultSource: 'pi-native', allowPersonalPiProviders: true };

  it('retains the authorized native model and operator Low rather than substituting managed defaults', () => {
    expect(resolveOperatorInference({ eligible: nativeEligible, policy: nativePolicy, trusted: native }))
      .toMatchObject(native);
  });

  it('requires explicit installed native approval even when the human native default is enabled', () => {
    expect(() => resolveOperatorInference({ eligible: nativeEligible, policy,
      trusted: { ...native, reasoningLevel: 'high' } })).toThrow();
  });

  it('does not turn a native default into personal-provider permission', () => {
    const deniedEligibility = { ...nativeEligible, allowPersonalPiProviders: false };
    expect(() => resolveOperatorInference({ eligible: deniedEligibility,
      policy: nativePolicy, trusted: native })).toThrow();
  });

  it('rejects native reasoning outside the installed restriction without selecting a managed fallback', () => {
    expect(() => resolveOperatorInference({ eligible: nativeEligible, policy: nativePolicy,
      trusted: { ...native, reasoningLevel: 'medium' } })).toThrow();
  });
});
