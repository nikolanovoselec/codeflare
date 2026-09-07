import { describe, it, expect, vi } from 'vitest';
import { loadEnterpriseRouteConfig } from '../../lib/access';
import { loadActiveRouteVersion } from '../../lib/ai-gateway-management';
import { createMockKV, type MockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';
import { getBuiltInProfileRef, normalizeCustomProfile } from '../../lib/reasoning-profiles';
import { routingGatewayUrl, routingInventoryFixtures, verifiedRoutingConfiguration } from '../helpers/verified-routing';
import { SETUP_KEYS } from '../../lib/kv-keys';

vi.mock('../../lib/ai-gateway-management', async (original) => ({
  ...await original<typeof import('../../lib/ai-gateway-management')>(),
  loadActiveRouteVersion: vi.fn(async (_account: string, _gateway: string, route: string) => routingInventoryFixtures.get(route)),
}));
function makeEnv(kv: MockKV, enterprise = true): Env {
  return { KV: kv, ENTERPRISE_MODE: enterprise ? 'active' : undefined, AIG_GATEWAY_URL: routingGatewayUrl, AIG_TOKEN: 'fixture-token' } as unknown as Env;
}
function saved(kv = createMockKV()) {
  const routes = ['general_usage', 'development', 'code_review'];
  kv._set(SETUP_KEYS.DYNAMIC_ROUTES, routes);
  const configuration = verifiedRoutingConfiguration({ schemaVersion: 1, customProfileRevisions: [], routeAssignments: {
    general_usage: { activeProfile: getBuiltInProfileRef('workers-ai-glm-thinking') },
    development: { activeProfile: getBuiltInProfileRef('workers-ai-kimi-k-thinking') },
    code_review: { activeProfile: getBuiltInProfileRef('openai-gpt-chat-tools-off') },
  }, fallbackRouting: { enabled: true, routes, defaultRoute: 'development', reasoning: 'medium' } }, { gatewayUrl: routingGatewayUrl, token: 'fixture-token' });
  kv._set(SETUP_KEYS.REASONING_CONFIGURATION, configuration);
  kv._set(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, { general_usage: 262144, development: 262144, code_review: 10000 });
  return { kv, configuration, env: makeEnv(kv) };
}

describe('loadEnterpriseRouteConfig (REQ-ENTERPRISE-043/-044)', () => {
  it('AC5: returns empty config when ENTERPRISE_MODE is not active', async () => {
    const cfg = await loadEnterpriseRouteConfig(makeEnv(createMockKV(), false));
    expect(cfg).toEqual({ routeCatalog: [], defaultRoute: '', defaultReasoning: '', routeContextWindows: {}, routeReasoningLevels: {} });
  });
  it('returns only the allowed verified routes with exact profile levels and scope defaults', async () => {
    const { env } = saved();
    const cfg = await loadEnterpriseRouteConfig(env);
    expect(cfg.routeCatalog).toEqual(['general_usage', 'development', 'code_review']);
    expect(cfg.defaultRoute).toBe('development'); expect(cfg.defaultReasoning).toBe('medium');
    expect(cfg.routeReasoningLevels.general_usage).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(cfg.routeReasoningLevels.development).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    expect(cfg.routeReasoningLevels.code_review).toEqual(['off']);
  });
  it.each(['workers-ai-glm-5.3', 'workers-ai-gpt-oss'])('does not silently grandfather legacy %s evidence into authority', async (reasoningProfile) => {
    const kv = createMockKV(); kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['legacy']);
    kv._set(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, { legacy: { contextWindow: 10000, reasoningProfile } });
    expect((await loadEnterpriseRouteConfig(makeEnv(kv))).routeCatalog).toEqual([]);
    expect(kv.put).not.toHaveBeenCalled();
  });
  it('uses saved authority without management I/O even when remote topology changes', async () => {
    const { env } = saved();
    routingInventoryFixtures.set('development', { ...routingInventoryFixtures.get('development')!, versionId: 'changed' });
    vi.mocked(loadActiveRouteVersion).mockClear();
    const cfg = await loadEnterpriseRouteConfig(env);
    expect(cfg.routeCatalog).toEqual(['general_usage', 'development', 'code_review']);
    expect(cfg.defaultRoute).toBe('development');
    expect(loadActiveRouteVersion).not.toHaveBeenCalled();
  });
  it.each(['medium', 'off', 'low'] as const)('prefers Medium then Off then first supported when default drifts: %s', async (expected) => {
    const kv = createMockKV();
    const custom = normalizeCustomProfile({ schemaVersion: 1, id: 'custom-low', name: 'Low', enabled: true, revision: 1, supportedLevels: ['low'], levels: { low: [{ path: 'reasoning_effort', value: 'low' }] }, removePaths: [], offSemantics: { status: 'unsupported' } });
    const ref = expected === 'medium' ? getBuiltInProfileRef('workers-ai-glm-thinking') : expected === 'off' ? getBuiltInProfileRef('openai-gpt-chat-tools-off') : { id: custom.id, revision: custom.revision, hash: custom.hash };
    kv._set(SETUP_KEYS.REASONING_CONFIGURATION, verifiedRoutingConfiguration({ schemaVersion: 1, customProfileRevisions: [custom], routeAssignments: { available: { activeProfile: ref } } }, { gatewayUrl: routingGatewayUrl, token: 'fixture-token' }));
    kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['available']);
    kv._set(SETUP_KEYS.GROUP_ROUTING, { engineering: { routes: ['available'], defaultRoute: 'gone', reasoning: 'high' } });
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv), ['engineering']);
    expect(cfg.defaultRoute).toBe('available'); expect(cfg.defaultReasoning).toBe(expected);
  });
  it.each([SETUP_KEYS.DYNAMIC_ROUTES, SETUP_KEYS.GROUP_ROUTING, SETUP_KEYS.REASONING_CONFIGURATION])('fails closed on malformed %s JSON', async (key) => {
    const { kv, env } = saved(); kv._store.set(key, '{not json');
    expect((await loadEnterpriseRouteConfig(env)).routeCatalog).toEqual([]);
  });
  it('ignores non-string catalog entries without granting unverified routes', async () => {
    const { kv, env } = saved(); kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['general_usage', 42, null, 'unchecked']);
    expect((await loadEnterpriseRouteConfig(env)).routeCatalog).toEqual(['general_usage']);
  });
  it('saved authority does not expire with the temporary receipt lifetime', async () => {
    const { kv, env, configuration } = saved();
    for (const assignment of Object.values(configuration.routeAssignments)) assignment.verification!.checkedAt = '2020-01-01T00:00:00.000Z';
    kv._set(SETUP_KEYS.REASONING_CONFIGURATION, configuration);
    expect((await loadEnterpriseRouteConfig(env)).routeCatalog).toHaveLength(3);
  });
});

describe('first matching group and optional fallback (REQ-ENTERPRISE-013/-044)', () => {
  it('selects the first matching group before eligibility filtering', async () => {
    const { kv, env } = saved();
    kv._set(SETUP_KEYS.GROUP_ROUTING, { developers: { routes: ['development'], defaultRoute: 'development', reasoning: 'high' }, ops: { routes: ['general_usage'], defaultRoute: 'general_usage', reasoning: 'low' } });
    const cfg = await loadEnterpriseRouteConfig(env, ['ops', 'developers']);
    expect(cfg.routeCatalog).toEqual(['general_usage']); expect(cfg.defaultReasoning).toBe('low');
  });
  it.each([{ routes: [] }, { routes: ['unverified'] }])('does not fall through from the first group with routes %j', async ({ routes }) => {
    const { kv, env } = saved();
    kv._set(SETUP_KEYS.GROUP_ROUTING, { first: { routes, defaultRoute: '', reasoning: 'off' }, second: { routes: ['development'], defaultRoute: 'development', reasoning: 'medium' } });
    expect((await loadEnterpriseRouteConfig(env, ['first', 'second'])).routeCatalog).toEqual([]);
  });
  it('unmatched users use only the enabled fallback subset', async () => {
    const { kv, env, configuration } = saved();
    configuration.fallbackRouting = { enabled: true, routes: ['code_review'], defaultRoute: 'code_review', reasoning: 'off' };
    kv._set(SETUP_KEYS.REASONING_CONFIGURATION, configuration);
    expect((await loadEnterpriseRouteConfig(env, ['unknown'])).routeCatalog).toEqual(['code_review']);
  });
  it.each([true, false])('disabled or absent fallback denies unmatched users (absent=%s)', async (absent) => {
    const { kv, env, configuration } = saved();
    if (absent) delete configuration.fallbackRouting; else configuration.fallbackRouting = { enabled: false };
    kv._set(SETUP_KEYS.REASONING_CONFIGURATION, configuration);
    expect((await loadEnterpriseRouteConfig(env, ['unknown'])).routeCatalog).toEqual([]);
  });
  it('non-enterprise ignores groups and returns empty config', async () => {
    const { kv } = saved();
    const cfg = await loadEnterpriseRouteConfig(makeEnv(kv, false), ['developers']);
    expect(cfg).toEqual({ routeCatalog: [], defaultRoute: '', defaultReasoning: '', routeContextWindows: {}, routeReasoningLevels: {} });
  });
});
