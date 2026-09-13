import { describe, expect, it } from 'vitest';
import { CapabilitySummarySchema, ReasoningDiscoveryResultSchema, ReasoningRouteVerificationSchema } from '../../lib/schemas';
import { TargetDiscoveryResultSchema } from '../../lib/target-capability-contract';
import { getBuiltInProfile } from '../../../../src/lib/reasoning-profiles';

const profile = getBuiltInProfile('bedrock-anthropic-native-provider-default')!;
const capabilities = { schemaVersion: 2, mappings: [{ levels: [], transport: 'bedrock-eventstream', tools: true,
  replay: true, reasoning: 'provider-default', streaming: 'incremental', cache: 'inconclusive' }] };
const profileRef = { id: profile.id, revision: profile.revision, hash: profile.hash };
const verification = { schemaVersion: 1, profileRef, routeVersion: 'v1', inventoryDigest: 'a'.repeat(64),
  connectionFingerprint: 'b'.repeat(64), canaryVersion: 'synthetic', supportedLevels: [], scope: 'observed-path',
  checkedAt: '2026-09-13T12:00:00Z', capabilities };
const result = { schemaVersion: 1, assignable: true, classification: 'Verified', explanation: 'Ready for review', profile,
  capabilities, attempts: [], accounting: { httpAttempts: 4 }, checkId: '11111111-1111-4111-8111-111111111111',
  targetId: '22222222-2222-4222-8222-222222222222',
  nativeVerification: { method: 'automated', checkedAt: verification.checkedAt, current: true, discovery: capabilities } };

describe('REQ-ENTERPRISE-074 shared browser capability evidence', () => {
  it('retains independent results through discovery and route receipt decoding without inventing cache success', () => {
    expect(CapabilitySummarySchema.parse(capabilities)).toEqual(capabilities);
    expect(ReasoningRouteVerificationSchema.parse(verification).capabilities).toEqual(capabilities);
    expect(ReasoningDiscoveryResultSchema.parse({ classification: 'Inconclusive', assignable: false, capabilitySummary: capabilities }).capabilitySummary).toEqual(capabilities);
    const decoded = TargetDiscoveryResultSchema.parse(result);
    expect(decoded.capabilities).toEqual(capabilities);
    expect(decoded.nativeVerification?.discovery).toEqual(capabilities);
    expect(decoded.profile).toEqual(profile);
    expect(decoded.checkId).toBe(result.checkId);
    expect(decoded.accounting.httpAttempts).toBe(4);
  });

  it('preserves legacy evidence verbatim instead of promoting its authority or fabricating mapping rows', () => {
    const legacy = { schemaVersion: 1, tools: true, replay: true, nativePromptCache: false, cache: 'inconclusive',
      reasoning: 'provider-default', streaming: 'incremental', grade: 'Not qualified' };
    expect(CapabilitySummarySchema.parse(legacy)).toEqual(legacy);
    expect(ReasoningRouteVerificationSchema.parse({ ...verification, capabilities: legacy }).capabilities).toEqual(legacy);
  });

  it.each([
    { ...capabilities, grade: 'Optimal' },
    { ...capabilities, mappings: [{ ...capabilities.mappings[0], privateSignature: 'must-not-pass' }] },
    { ...capabilities, mappings: [{ ...capabilities.mappings[0], streaming: 'verified' }] },
    { ...capabilities, mappings: [{ ...capabilities.mappings[0], cache: 'gateway-hit' }] },
    { ...capabilities, mappings: [{ ...capabilities.mappings[0], transport: 'arbitrary-endpoint' }] },
    { ...capabilities, mappings: [{ ...capabilities.mappings[0], levels: ['off'] }] },
  ])('rejects unsupported or private evidence at both response boundaries', (invalid) => {
    expect(CapabilitySummarySchema.safeParse(invalid).success).toBe(false);
    expect(ReasoningRouteVerificationSchema.safeParse({ ...verification, capabilities: invalid }).success).toBe(false);
    expect(TargetDiscoveryResultSchema.safeParse({ ...result, capabilities: invalid }).success).toBe(false);
    expect(TargetDiscoveryResultSchema.safeParse({ ...result, nativeVerification: { ...result.nativeVerification, discovery: invalid } }).success).toBe(false);
  });

  it('still requires a target-bound receipt before a successful discovery response is accepted', () => {
    expect(TargetDiscoveryResultSchema.safeParse({ ...result, checkId: undefined }).success).toBe(false);
    expect(TargetDiscoveryResultSchema.safeParse({ ...result, targetId: undefined }).success).toBe(false);
    expect(TargetDiscoveryResultSchema.safeParse({ ...result, nativeVerification: undefined }).success).toBe(false);
  });
});
