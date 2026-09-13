import { describe, expect, it } from 'vitest';
import { parseCapabilitySummary } from '../../lib/ai-capability-discovery/contract';
import { capabilityCandidates } from '../../lib/ai-capability-discovery';
import { connectionFingerprint, verificationMatches } from '../../lib/reasoning-verification';
import { PI_WIRE_CANARY_VERSION } from '../../lib/reasoning-discovery';
import { normalizeCustomProfile } from '../../lib/reasoning-profiles';

const connection = { gatewayUrl: `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/`, gatewayId: 'synthetic', token: 'synthetic-token' };
const defaultProfile = capabilityCandidates(false)[0];
const mapping = { levels: [], transport: 'compat', tools: true, replay: true, reasoning: 'provider-default', streaming: 'incremental', cache: 'inconclusive' };
const evidence = { schemaVersion: 2, mappings: [mapping] };
const legacy = { schemaVersion: 1, tools: true, replay: true, cache: 'inconclusive', nativePromptCache: false,
  reasoning: 'provider-default', streaming: 'incremental', grade: 'Not qualified' };
const verification = (raw: unknown, profile = defaultProfile) => ({ schemaVersion: 1 as const,
  profileRef: { id: profile.id, revision: profile.revision, hash: profile.hash },
  routeVersion: 'synthetic-version', inventoryDigest: 'b'.repeat(64), connectionFingerprint: connectionFingerprint(connection)!,
  canaryVersion: PI_WIRE_CANARY_VERSION, supportedLevels: profile.supportedLevels, scope: 'single-model' as const,
  checkedAt: '2026-09-13T16:00:00.000Z', capabilities: parseCapabilitySummary(raw) });

describe('REQ-ENTERPRISE-035/043: independent evidence remains exact server-owned authority', () => {
  it('round-trips per-mapping evidence and authorizes verified tools without input cache evidence', () => {
    expect(parseCapabilitySummary(evidence)).toEqual(evidence);
    expect(verificationMatches(verification(evidence), defaultProfile, connection)).toBe(true);
  });

  it('retains legacy failed evidence for reading without upgrading it to current usable authority', () => {
    expect(parseCapabilitySummary(legacy)).toEqual(legacy);
    expect(verificationMatches(verification(legacy), defaultProfile, connection)).toBe(false);
    const passed = { ...legacy, cache: 'gateway-response', grade: 'Optimal' };
    expect(verificationMatches(verification(passed), defaultProfile, connection)).toBe(true);
  });

  it.each([
    { schemaVersion: 2, mappings: [mapping], grade: 'Optimal' },
    { schemaVersion: 2, mappings: [{ ...mapping, providerBody: 'synthetic private value' }] },
    { schemaVersion: 2, mappings: [{ ...mapping, cache: 'HIT' }] },
    { schemaVersion: 2, mappings: [{ ...mapping, transport: 'arbitrary-endpoint' }] },
    { schemaVersion: 2, mappings: [{ ...mapping, levels: ['not-a-level'] }] },
  ])('rejects malformed or extra evidence without restoring a grade (%j)', (raw) => {
    expect(() => parseCapabilitySummary(raw)).toThrow();
  });

  it('does not let administrator confirmation or an incomplete replay replace executable evidence', () => {
    const proof = verification(evidence);
    expect(verificationMatches({ ...proof, method: 'administrator' }, defaultProfile, connection)).toBe(false);
    expect(verificationMatches(verification({ ...evidence, mappings: [{ ...mapping, replay: false }] }), defaultProfile, connection)).toBe(false);
  });

  it('binds evidence levels and transport to the actual immutable profile rather than trusting capability booleans', () => {
    const enabled = normalizeCustomProfile({ id: 'discovered-synthetic-enabled', name: 'Synthetic enabled contract', revision: 1, schemaVersion: 1,
      enabled: true, supportedLevels: ['medium'], levels: { medium: [{ path: 'reasoning_effort', value: 'medium' }] }, aliases: {},
      compatibility: { response: 'stream', toolNames: 'strict', transport: 'compat' } });
    const enabledEvidence = { schemaVersion: 2, mappings: [{ ...mapping, levels: ['medium'], reasoning: 'observed-enabled' }] };
    expect(verificationMatches(verification(enabledEvidence, enabled), enabled, connection)).toBe(true);
    expect(verificationMatches(verification({ schemaVersion: 2, mappings: [{ ...enabledEvidence.mappings[0], levels: ['high'] }] }, enabled), enabled, connection)).toBe(false);
    expect(verificationMatches(verification({ schemaVersion: 2, mappings: [{ ...enabledEvidence.mappings[0], transport: 'bedrock-invoke' }] }, enabled), enabled, connection)).toBe(false);
    expect(verificationMatches(verification(enabledEvidence, enabled), enabled, { ...connection, token: 'different-synthetic-token' })).toBe(false);
  });
});
