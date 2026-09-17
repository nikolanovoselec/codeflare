/// <reference types="@cloudflare/vitest-pool-workers/types" />
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
