import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { validateConfigurationValues } from '../../lib/admin-configuration';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { parseCapabilitySummary } from '../../lib/ai-capability-discovery/contract';
import { capabilityCandidates } from '../../lib/ai-capability-discovery';
import { checkedRouteInventory, connectionFingerprint, verificationMatches } from '../../lib/reasoning-verification';
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

  it('REQ-ENTERPRISE-043: incomplete automated replay cannot replace executable evidence', () => {
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

afterEach(() => vi.restoreAllMocks());

describe('Browser input is not administrator authority', () => {
  it.each([
    { label: 'generated namespace alone', method: undefined, capabilities: undefined },
    { label: 'administrator method alone', method: 'administrator', capabilities: undefined },
    { label: 'fabricated automated observations', method: undefined, capabilities: evidence },
    { label: 'administrator method plus fabricated observations', method: 'administrator', capabilities: evidence },
  ])('REQ-ENTERPRISE-043: Save rejects $label without an issued receipt', async ({ method, capabilities }) => {
    const kv = createMockKV();
    const env = { KV: kv, ENTERPRISE_MODE: 'active', AIG_GATEWAY_URL: connection.gatewayUrl,
      AIG_GATEWAY_ID: connection.gatewayId, AIG_TOKEN: connection.token } as unknown as Env;
    const elements = [
      { id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } },
      { id: 'model', type: 'model', properties: { provider: 'unlisted-provider', model: 'synthetic-future-2099' }, outputs: { success: { elementId: 'end' } } },
      { id: 'end', type: 'end', outputs: {} },
    ];
    const inventory = checkedRouteInventory({ versionId: 'synthetic-version', elements });
    const modelRequests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if ((init?.method ?? 'GET') !== 'GET') {
        modelRequests.push(String(url));
        return Response.json({ error: 'No implicit verification' }, { status: 503 });
      }
      if (String(url).endsWith('/routes')) return Response.json({ result: { routes: [{ id: 'id', name: 'future' }] } });
      return Response.json({ result: { version: { version_id: 'synthetic-version', active: true, data: elements } } });
    });
    const forged = { ...verification(evidence), inventoryDigest: inventory.inventoryDigest, scope: inventory.scope,
      checkedAt: new Date().toISOString(), method, capabilities };
    const result = await validateConfigurationValues(env, 'aiRouting', 'enterprise', {
      gatewayUrl: connection.gatewayUrl, gatewayId: connection.gatewayId, replacementToken: '', dynamicRoutes: ['future'],
      defaultRoute: { route: '', reasoning: 'off' }, routeContextWindows: { future: 200000 },
      groupRouting: [{ accessGroup: 'engineering', routes: ['future'], defaultRoute: 'future', reasoning: 'off' }],
      fallbackRouting: { enabled: false }, reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [defaultProfile],
        routeAssignments: { future: { activeProfile: forged.profileRef, verification: forged } } },
    });
    // Every identity field is valid. The missing server receipt, not a bad hash,
    // timestamp, namespace or inventory, must deny browser-created authority.
    expect(result.fieldErrors).toEqual({ reasoningConfiguration: [expect.stringContaining('requires a successful check')] });
    expect(result.values).toBeUndefined();
    expect(kv._store.has(SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
    expect(modelRequests).toEqual([]);
  });
});
