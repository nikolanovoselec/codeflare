import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { ADMIN_CONFIGURATION_KEYS, SETUP_KEYS } from '../../lib/kv-keys';
import { encryptForKV, importEncryptionKey } from '../../lib/kv-crypto';
import { getBuiltInProfileRef, normalizeCustomProfile } from '../../lib/reasoning-profiles';
import { connectionFingerprint } from '../../lib/reasoning-verification';
import { nativeTargetHandle, nativeTargetAdapterVersion, type NativeAiTarget } from '../../lib/native-ai-targets';
import { loadEnterpriseRouteConfig } from '../../lib/access';
import { createMockKV, type MockKV } from '../helpers/mock-kv';
import { routingGatewayUrl, routingInventoryFixtures, verifiedRoutingConfiguration } from '../helpers/verified-routing';
import reasoningRoutes from '../../routes/admin/reasoning';
import configurationRoutes from '../../routes/admin/configuration';
import configurationRunRoutes from '../../routes/admin/configuration-runs';
import configurationPreviewRoutes from '../../routes/admin/configuration-previews';

// Authentication is the request boundary; routing, admission, parsing, crypto and persistence are real.
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: 'admin@example.com', authenticated: true, role: 'admin' });
    return next();
  },
  requireAdmin: async (_c: any, next: any) => next(),
}));

const catalogPath = '/admin/reasoning/catalog';
const token = 'fixture-saved-management-token';
const connection = { gatewayUrl: routingGatewayUrl, token };
const liveNativeId = '11111111-1111-4111-8111-111111111111';
const goneNativeId = '22222222-2222-4222-8222-222222222222';
// This looks native but has no owner in NATIVE_AI_TARGETS: it is a Dynamic Route.
const nativeShapedDynamic = 'cf-native-33333333-3333-4333-8333-333333333333';
const liveHandle = nativeTargetHandle(liveNativeId);
const goneHandle = nativeTargetHandle(goneNativeId);
const removedDynamic = ['gone', 'inactive-gone', 'policy-gone', 'window-gone'];
const dynamicRef = (route: string) => ({ kind: 'dynamic-route' as const, route });
const nativeRef = (targetId: string) => ({ kind: 'native-target' as const, targetId });
const routingKeys = [SETUP_KEYS.DYNAMIC_ROUTES, SETUP_KEYS.NATIVE_AI_TARGETS, SETUP_KEYS.DEFAULT_ROUTE,
  SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, SETUP_KEYS.REASONING_CONFIGURATION, SETUP_KEYS.GROUP_ROUTING];

type ProviderRow = { id: string; provider_slug: string; gateway_id: string; default_config: boolean; alias?: string };
const providerRow = (id: string, provider = 'openai', extra: Partial<ProviderRow> = {}): ProviderRow => ({
  id, provider_slug: provider, gateway_id: 'gateway', default_config: true, ...extra,
});
function providerPage(rows: ProviderRow[], page = 1, total = rows.length): Response {
  return Response.json({ success: true, result: rows,
    result_info: { page, count: rows.length, per_page: 100, total_count: total } });
}
function dynamicPage(names: string[]): Response {
  return Response.json({ success: true, result: { routes: names.map((name) => ({ id: name, name })) } });
}
function savedNative(id: string, providerConfigId: string, provider = 'openai'): NativeAiTarget {
  const profileRef = getBuiltInProfileRef(provider === 'aws-bedrock' ? 'bedrock-anthropic-compat' : 'native-openai-compat');
  const model = provider === 'aws-bedrock' ? 'eu.anthropic.claude-sonnet-5' : 'fixture-tool-model';
  return {
    id, label: `Saved ${provider}`, provider, providerConfigId, model, profileRef,
    transport: 'aig-legacy-compat', contextWindow: 200000, enabled: true,
    verification: {
      schemaVersion: 1, method: 'administrator', targetId: id, provider, providerConfigId, model, profileRef,
      transport: 'aig-legacy-compat', adapterVersion: nativeTargetAdapterVersion(provider),
      connectionFingerprint: connectionFingerprint(connection)!, checkedAt: '2026-09-01T00:00:00.000Z',
    },
  };
}
function mount(kv: MockKV, env: Env) {
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => { c.env = env; return next(); });
  app.route('/admin/reasoning', reasoningRoutes);
  app.route('/admin/configuration', configurationRoutes);
  app.route('/admin/configuration-runs', configurationRunRoutes);
  app.route('/admin/configuration-previews', configurationPreviewRoutes);
  app.onError((error, c) => error instanceof AppError
    ? c.json(error.toJSON(), error.statusCode as ContentfulStatusCode)
    : c.json({ error: 'Unexpected test error' }, 500));
  return { app, kv, env };
}
type Fixture = ReturnType<typeof mount>;
function post(f: Fixture, path: string, body: unknown) {
  return f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function reconcile(f: Fixture, baseRevision = 7) {
  return post(f, catalogPath, { reconcileSaved: true, baseRevision });
}
async function routingSnapshot(kv: MockKV) {
  return Object.fromEntries(await Promise.all(routingKeys.map(async (key) => [key, await kv.get(key)])));
}
async function reload(f: Fixture) {
  // A new Hono instance must reconstruct the result from persisted KV, not a response-only overlay.
  const response = await mount(f.kv, f.env).app.request('/admin/configuration');
  expect(response.status).toBe(200);
  return await response.json() as any;
}
async function setup() {
  const kv = createMockKV();
  const encryptionKey = Buffer.alloc(32, 19).toString('base64');
  const env = { KV: kv, ENTERPRISE_MODE: 'active', ENCRYPTION_KEY: encryptionKey } as unknown as Env;
  kv._store.set(SETUP_KEYS.AIG_GATEWAY_URL, routingGatewayUrl);
  kv._store.set(SETUP_KEYS.AIG_TOKEN, await encryptForKV(JSON.stringify({ token }), await importEncryptionKey(encryptionKey), SETUP_KEYS.AIG_TOKEN));
  kv._store.set(ADMIN_CONFIGURATION_KEYS.REVISION, '7');
  kv._store.set(SETUP_KEYS.STRICT_EGRESS, 'active');
  kv._store.set('admin:reasoning-check:retained-history', 'historical-receipt');
  const sharedDraft = {
    schemaVersion: 1, id: 'custom-shared', name: 'Shared reasoning', enabled: true,
    supportedLevels: ['medium', 'high'], removePaths: [],
    levels: { medium: [{ path: 'reasoning_effort', value: 'medium' }], high: [{ path: 'reasoning_effort', value: 'high' }] },
    offSemantics: { status: 'unsupported' },
  };
  const shared = normalizeCustomProfile({ ...sharedDraft, revision: 1 });
  const newer = normalizeCustomProfile({ ...sharedDraft, revision: 2 });
  const activeProfile = { id: shared.id, revision: shared.revision, hash: shared.hash };
  const reasoning = verifiedRoutingConfiguration({
    schemaVersion: 1, customProfileRevisions: [shared, newer],
    routeAssignments: Object.fromEntries(['gone', 'live', 'inactive-gone', nativeShapedDynamic].map((route) => [route, {
      activeProfile, routeVersion: 'fixture-version', legs: [{ nodeId: 'primary', provider: 'openai', declaredModel: 'fixture-model',
        profileRef: activeProfile, evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' } }],
    }])),
    fallbackRouting: { enabled: true, routes: ['gone', goneHandle], defaultRoute: goneHandle, reasoning: 'high',
      targets: [dynamicRef('gone'), nativeRef(goneNativeId)], defaultTarget: nativeRef(goneNativeId) },
  }, connection);
  kv._set(SETUP_KEYS.REASONING_CONFIGURATION, reasoning);
  kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['gone', 'live', nativeShapedDynamic]);
  kv._set(SETUP_KEYS.NATIVE_AI_TARGETS, { schemaVersion: 1, targets: [savedNative(liveNativeId, 'openai-live'), savedNative(goneNativeId, 'bedrock-old', 'aws-bedrock')] });
  kv._set(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, {
    gone: 10000, live: 20000, 'inactive-gone': { contextWindow: 30000, reasoningProfile: 'legacy-profile' },
    'window-gone': { contextWindow: 40000, reasoningProfile: 'legacy-profile' }, [nativeShapedDynamic]: 50000,
  });
  kv._set(SETUP_KEYS.DEFAULT_ROUTE, { route: 'gone', reasoning: 'high' });
  kv._set(SETUP_KEYS.GROUP_ROUTING, {
    deny: { routes: ['gone', goneHandle, 'policy-gone'], defaultRoute: goneHandle, reasoning: 'high',
      targets: [dynamicRef('gone'), nativeRef(goneNativeId), dynamicRef('policy-gone')], defaultTarget: nativeRef(goneNativeId) },
    engineering: { routes: ['gone', 'live', liveHandle, nativeShapedDynamic], defaultRoute: 'gone', reasoning: 'high',
      targets: [dynamicRef('gone'), dynamicRef('live'), nativeRef(liveNativeId), dynamicRef(nativeShapedDynamic)], defaultTarget: dynamicRef('gone') },
    stable: { routes: ['live'], defaultRoute: 'live', reasoning: 'high', targets: [dynamicRef('live')], defaultTarget: dynamicRef('live') },
    native: { routes: ['gone', liveHandle], defaultRoute: 'gone', reasoning: 'high',
      targets: [dynamicRef('gone'), nativeRef(liveNativeId)], defaultTarget: dynamicRef('gone') },
  });
  return { ...mount(kv, env), reasoning };
}

let routesReply: (url: URL) => Response | Promise<Response>;
let providersReply: (url: URL) => Response | Promise<Response>;
let customReply: () => Response;
let duringManagement: (() => void | Promise<void>) | undefined;
let unexpectedRequests: string[];
let observedConnections: Array<{ gateway: string; authorization: string | null }>;

beforeEach(() => {
  routingInventoryFixtures.clear();
  unexpectedRequests = [];
  observedConnections = [];
  duringManagement = undefined;
  routesReply = () => dynamicPage(['live', nativeShapedDynamic]);
  providersReply = () => providerPage([providerRow('openai-live')]);
  customReply = () => Response.json({ success: true, result: [], result_info: { page: 1, count: 0, per_page: 100, total_count: 0 } });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const gateway = /\/ai-gateway\/gateways\/([^/]+)\//.exec(url.pathname)?.[1];
    if (method !== 'GET' || url.origin !== 'https://api.cloudflare.com') {
      unexpectedRequests.push(`${method} ${url}`);
      throw new Error('No inference, paid probes or live network allowed');
    }
    const hook = duringManagement;
    duringManagement = undefined;
    await hook?.();
    if (gateway) observedConnections.push({ gateway, authorization: headers.get('authorization') });
    if (url.pathname.endsWith('/routes')) return routesReply(url);
    if (url.pathname.endsWith('/provider_configs')) return providersReply(url);
    if (url.pathname.endsWith('/custom-providers')) return customReply();
    const route = url.pathname.split('/routes/')[1];
    const active = route && routingInventoryFixtures.get(decodeURIComponent(route));
    if (active) return Response.json({ success: true, result: { version: { id: active.versionId, active: true, data: active.elements } } });
    unexpectedRequests.push(`${method} ${url}`);
    throw new Error('Unexpected management endpoint');
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  // A caught fetch error must not conceal an attempted paid request.
  expect(unexpectedRequests).toEqual([]);
});

describe('live saved-connection routing reconciliation', () => {
  it.each([
    { label: 'empty first page', pages: [[]] },
    { label: 'short first page', pages: [['live']] },
    { label: 'full page followed by empty page', pages: [['live', nativeShapedDynamic], []] },
    { label: 'saved route on a later page', pages: [['new-route', nativeShapedDynamic], ['live']] },
    { label: 'full last page proven by explicit totals', pages: [['live', nativeShapedDynamic]], counted: true },
  ])('REQ-ENTERPRISE-034: Cloudflare page/per_page inventory remains connected and prunes only after completion ($label)', async ({ pages, counted }) => {
    const f = await setup();
    const credentials = await f.kv.get(SETUP_KEYS.AIG_TOKEN);
    const nativeBefore = await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS);
    const requests: number[] = [];
    routesReply = (url) => {
      const page = Number(url.searchParams.get('page') ?? 1);
      requests.push(page);
      return Response.json({ success: true, data: { page, per_page: 2, order_by: 'name', order_by_direction: 'asc',
        ...(counted && { count: pages[page - 1]?.length ?? 0, total_count: pages.flat().length, total_pages: pages.length }),
        routes: (pages[page - 1] ?? []).map((name) => ({ id: name, name, gateway_id: 'gateway' })) } });
    };
    providersReply = () => Response.json({}, { status: 503 });
    const response = await reconcile(f);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ routeCatalogStatus: 'ready', connection: { status: 'ready' }, routes: pages.flat(),
      reconciliation: { status: 'applied', removedNativeTargetIds: [], revision: 8 } });
    expect(requests).toEqual(pages.map((_, index) => index + 1));
    const retained = ['live', nativeShapedDynamic].filter((name) => pages.flat().includes(name));
    expect(await f.kv.get(SETUP_KEYS.DYNAMIC_ROUTES, 'json')).toEqual(retained);
    const configuration = await f.kv.get(SETUP_KEYS.REASONING_CONFIGURATION, 'json') as any;
    expect(Object.keys(configuration.routeAssignments).sort()).toEqual([...retained].sort());
    for (const name of retained) expect(configuration.routeAssignments[name]).toEqual(f.reasoning.routeAssignments[name]);
    expect(await f.kv.get(SETUP_KEYS.AIG_TOKEN)).toBe(credentials);
    expect(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS)).toBe(nativeBefore);
    expect((await reload(f)).revision).toBe(8);
  });

  it.each(['unavailable', 'repeated page', 'changed page size', 'duplicate route', 'page bound'] as const)(
    'REQ-ENTERPRISE-047: an incomplete Cloudflare paged inventory preserves all saved settings (%s)', async (failure) => {
      const f = await setup();
      const before = await routingSnapshot(f.kv);
      const requests: number[] = [];
      routesReply = (url) => {
        const page = Number(url.searchParams.get('page') ?? 1);
        requests.push(page);
        if (page > 1 && failure === 'unavailable') return Response.json({}, { status: 503 });
        return Response.json({ success: true, data: {
          page: page > 1 && failure === 'repeated page' ? 1 : page,
          per_page: page > 1 && failure === 'changed page size' ? 2 : 1,
          routes: [{ id: failure === 'duplicate route' ? 'same' : `id-${page}`,
            name: failure === 'duplicate route' ? 'live' : `route-${page}`, gateway_id: 'gateway' }],
        } });
      };
      providersReply = () => Response.json({}, { status: 503 });
      const response = await reconcile(f);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ routeCatalogStatus: 'unavailable',
        reconciliation: { status: 'unchanged', removedDynamicRoutes: [], removedNativeTargetIds: [], revision: 7 } });
      expect(requests).toEqual(Array.from({ length: failure === 'page bound' ? 10 : 2 }, (_, index) => index + 1));
      expect(await routingSnapshot(f.kv)).toEqual(before);
      expect((await reload(f)).revision).toBe(7);
    });

  it('REQ-ENTERPRISE-034: permanently prunes absent Dynamic settings and owned Native policy references without widening access', async () => {
    const f = await setup();
    const nativeBefore = await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS, 'json') as any;
    const credentialBefore = await f.kv.get(SETUP_KEYS.AIG_TOKEN);
    const response = await reconcile(f);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.reconciliation).toEqual({ status: 'applied', removedDynamicRoutes: expect.arrayContaining(removedDynamic), removedNativeTargetIds: [goneNativeId], revision: 8 });
    expect([...body.reconciliation.removedDynamicRoutes].sort()).toEqual([...removedDynamic].sort());
    expect(body.routes).toEqual(['live', nativeShapedDynamic]);
    expect(body.usage).toEqual([{ profileRef: f.reasoning.routeAssignments.live.activeProfile, routes: [nativeShapedDynamic, 'live'].sort() }]);
    expect(await f.kv.get(SETUP_KEYS.DYNAMIC_ROUTES, 'json')).toEqual(['live', nativeShapedDynamic]);
    expect(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS, 'json')).toEqual({ schemaVersion: 1, targets: [nativeBefore.targets[0]] });
    expect(await f.kv.get(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, 'json')).toEqual({ live: 20000, [nativeShapedDynamic]: 50000 });
    const savedReasoning = await f.kv.get(SETUP_KEYS.REASONING_CONFIGURATION, 'json') as any;
    expect(savedReasoning).toEqual({ ...f.reasoning, routeAssignments: {
      live: f.reasoning.routeAssignments.live, [nativeShapedDynamic]: f.reasoning.routeAssignments[nativeShapedDynamic],
    }, fallbackRouting: { enabled: false } });
    expect(await f.kv.get(SETUP_KEYS.DEFAULT_ROUTE, 'json')).toEqual({ route: '', reasoning: 'off' });
    const groups = await f.kv.get(SETUP_KEYS.GROUP_ROUTING, 'json') as any;
    expect(Object.keys(groups)).toEqual(['deny', 'engineering', 'stable', 'native']);
    expect(groups.deny).toEqual({ routes: [], defaultRoute: '', reasoning: 'off', targets: [] });
    expect(groups.engineering).toEqual({ routes: ['live', liveHandle, nativeShapedDynamic], defaultRoute: 'live', reasoning: 'medium',
      targets: [dynamicRef('live'), nativeRef(liveNativeId), dynamicRef(nativeShapedDynamic)], defaultTarget: dynamicRef('live') });
    expect(groups.stable).toEqual({ routes: ['live'], defaultRoute: 'live', reasoning: 'high', targets: [dynamicRef('live')], defaultTarget: dynamicRef('live') });
    expect(groups.native).toEqual({ routes: [liveHandle], defaultRoute: liveHandle, reasoning: 'off', targets: [nativeRef(liveNativeId)], defaultTarget: nativeRef(liveNativeId) });
    expect((await loadEnterpriseRouteConfig(f.env, ['deny', 'engineering'])).routeCatalog).toEqual([]);
    expect((await loadEnterpriseRouteConfig(f.env, ['engineering'])).routeCatalog).toEqual(['live', liveHandle, nativeShapedDynamic]);
    expect((await loadEnterpriseRouteConfig(f.env, ['unmatched'])).routeCatalog).toEqual([]);
    const fresh = await reload(f);
    expect(fresh.revision).toBe(8);
    expect(fresh.sections.aiRouting).toMatchObject({ dynamicRoutes: ['live', nativeShapedDynamic], routeContextWindows: { live: 20000, [nativeShapedDynamic]: 50000 },
      routeReasoningProfiles: { live: 'custom-shared', [nativeShapedDynamic]: 'custom-shared' }, reasoningConfiguration: savedReasoning, groupRouting: groups });
    expect(fresh.sections.aiRouting.nativeTargets).toEqual([expect.objectContaining({ id: liveNativeId, handle: liveHandle, enabled: true, verification: expect.objectContaining({ current: true }) })]);
    expect(await f.kv.get(SETUP_KEYS.AIG_TOKEN)).toBe(credentialBefore);
    expect(await f.kv.get(SETUP_KEYS.STRICT_EGRESS)).toBe('active');
    expect(await f.kv.get('admin:reasoning-check:retained-history')).toBe('historical-receipt');
    expect(await f.kv.get(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN)).toBeNull();
  });

  it('REQ-ENTERPRISE-044: complete empty inventories persist deny-only groups and disabled fallback, then reconcile idempotently', async () => {
    const f = await setup();
    routesReply = () => dynamicPage([]);
    providersReply = () => providerPage([]);
    const response = await reconcile(f);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ routes: [], providers: [], routeCatalogStatus: 'ready', providerCatalogStatus: 'ready',
      reconciliation: { status: 'applied', revision: 8, removedNativeTargetIds: expect.arrayContaining([liveNativeId, goneNativeId]) } });
    expect(await f.kv.get(SETUP_KEYS.DYNAMIC_ROUTES, 'json')).toEqual([]);
    expect(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS, 'json')).toEqual({ schemaVersion: 1, targets: [] });
    expect(await f.kv.get(SETUP_KEYS.REASONING_CONFIGURATION, 'json')).toEqual({ schemaVersion: 1,
      customProfileRevisions: f.reasoning.customProfileRevisions, routeAssignments: {}, fallbackRouting: { enabled: false } });
    const fresh = await reload(f);
    expect(fresh.sections.aiRouting).toMatchObject({ dynamicRoutes: [], nativeTargets: [], routeContextWindows: {}, routeReasoningProfiles: {},
      defaultRoute: { route: '', reasoning: 'off' }, fallbackRouting: { enabled: false } });
    expect(fresh.sections.aiRouting.groupRouting).toEqual(Object.fromEntries(['deny', 'engineering', 'stable', 'native'].map((name) => [name,
      { routes: [], defaultRoute: '', reasoning: 'off', targets: [] }])));
    expect((await loadEnterpriseRouteConfig(f.env, ['unmatched'])).routeCatalog).toEqual([]);
    const before = await routingSnapshot(f.kv);
    const again = await reconcile(f, 8);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ reconciliation: { status: 'unchanged', removedDynamicRoutes: [], removedNativeTargetIds: [], revision: 8 } });
    expect(await routingSnapshot(f.kv)).toEqual(before);
    expect((await reload(f)).revision).toBe(8);
  });

  it('REQ-ENTERPRISE-047: only a complete domain authorizes deletion when the other inventory is unavailable', async () => {
    for (const failedDomain of ['dynamic', 'native'] as const) {
      const f = await setup();
      const before = await routingSnapshot(f.kv);
      routesReply = failedDomain === 'dynamic' ? () => Response.json({ private: token }, { status: 403 }) : () => dynamicPage([]);
      providersReply = failedDomain === 'native' ? () => { throw new Error('fixture network failure'); } : () => providerPage([]);
      const response = await reconcile(f);
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body).toMatchObject({ routeCatalogStatus: failedDomain === 'dynamic' ? 'unavailable' : 'ready',
        providerCatalogStatus: failedDomain === 'native' ? 'unavailable' : 'ready', reconciliation: { status: 'applied', revision: 8 } });
      expect(JSON.stringify(body)).not.toContain(token);
      if (failedDomain === 'dynamic') {
        expect(body.reconciliation.removedDynamicRoutes).toEqual([]);
        expect(await f.kv.get(SETUP_KEYS.DYNAMIC_ROUTES)).toBe(before[SETUP_KEYS.DYNAMIC_ROUTES]);
        expect(await f.kv.get(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS)).toBe(before[SETUP_KEYS.ROUTE_CONTEXT_WINDOWS]);
        expect(await f.kv.get(SETUP_KEYS.REASONING_CONFIGURATION, 'json')).toMatchObject({ routeAssignments: f.reasoning.routeAssignments });
        expect(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS, 'json')).toEqual({ schemaVersion: 1, targets: [] });
      } else {
        expect(body.reconciliation.removedNativeTargetIds).toEqual([]);
        expect(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS)).toBe(before[SETUP_KEYS.NATIVE_AI_TARGETS]);
        expect(await f.kv.get(SETUP_KEYS.DYNAMIC_ROUTES, 'json')).toEqual([]);
      }
      expect((await reload(f)).revision).toBe(8);
    }
  });

  it('REQ-ENTERPRISE-047: errors and incomplete or incoherent pages never prove absence', async () => {
    const invalidInventories = [
      { routes: () => Response.json({}, { status: 401 }), providers: () => Response.json({}, { status: 503 }) },
      { routes: () => Response.json({ result: { routes: [{ id: 'bad', name: null }] } }),
        providers: () => providerPage([providerRow('foreign', 'openai', { gateway_id: 'another-gateway' })]) },
      // Advertised pages cannot be ignored; the next Dynamic page remains unavailable.
      { routes: (url: URL) => url.search ? Response.json({}, { status: 503 }) : Response.json({ success: true, result: { routes: [] },
        result_info: { page: 1, count: 0, per_page: 100, total_count: 1, total_pages: 2 } }),
        providers: (url: URL) => Number(url.searchParams.get('page')) === 1 ? providerPage([providerRow('duplicate')], 1, 2) : providerPage([providerRow('duplicate')], 2, 2) },
      { routes: () => new Response('not-json'), providers: (url: URL) => Number(url.searchParams.get('page')) === 1
        ? providerPage([providerRow('first')], 1, 3) : providerPage([providerRow('second')], 2, 2) },
    ];
    for (const inventory of invalidInventories) {
      const f = await setup();
      const before = await routingSnapshot(f.kv);
      routesReply = inventory.routes;
      providersReply = inventory.providers;
      const response = await reconcile(f);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ routeCatalogStatus: 'unavailable', providerCatalogStatus: 'unavailable',
        reconciliation: { status: 'unchanged', removedDynamicRoutes: [], removedNativeTargetIds: [], revision: 7 } });
      expect(await routingSnapshot(f.kv)).toEqual(before);
      expect((await reload(f)).revision).toBe(7);
    }
  });

  it.each([
    { result: { routes: [], total_count: 1 } },
    { result: { routes: [], result_info: { page: 1, count: 0, per_page: 100, total_count: 0, total_pages: 2 } } },
    { result: { routes: [], has_more: true } },
    { result: { routes: [{ id: 'same', name: 'one' }, { id: 'same', name: 'two' }] } },
    { result: { routes: [{ id: 'one', name: 'same' }, { id: 'two', name: 'same' }] } },
    { result: { routes: [{ id: 'foreign', name: 'live', gateway_id: 'other' }] } },
  ])('REQ-ENTERPRISE-047: incomplete or incoherent Dynamic inventories never authorize cleanup (%j)', async (body) => {
    const f = await setup();
    const before = await routingSnapshot(f.kv);
    routesReply = () => Response.json(body);
    providersReply = () => Response.json({}, { status: 503 });
    const response = await reconcile(f);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ routeCatalogStatus: 'unavailable', providerCatalogStatus: 'unavailable',
      reconciliation: { status: 'unchanged', removedDynamicRoutes: [], removedNativeTargetIds: [], revision: 7 } });
    expect(await routingSnapshot(f.kv)).toEqual(before);
  });

  it.each([...routingKeys, ADMIN_CONFIGURATION_KEYS.REVISION])('REQ-SETUP-018: a failed %s write cannot report committed cleanup', async (failedKey) => {
    const f = await setup();
    const before = await f.kv.get(failedKey);
    const credentialBefore = await f.kv.get(SETUP_KEYS.AIG_TOKEN);
    const put = f.kv.put.getMockImplementation()!;
    f.kv.put.mockImplementation(async (key, value, options) => {
      if (key === failedKey) throw new Error(`private storage error: ${token}`);
      return put(key, value, options);
    });
    const response = await reconcile(f);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'configuration_task_failed' });
    expect(body).not.toHaveProperty('reconciliation');
    expect(JSON.stringify(body)).not.toContain(token);
    expect(await f.kv.get(failedKey)).toBe(before);
    expect(await f.kv.get(ADMIN_CONFIGURATION_KEYS.REVISION)).toBe('7');
    expect(await f.kv.get(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN)).toBeNull();
    expect(await f.kv.get(SETUP_KEYS.AIG_TOKEN)).toBe(credentialBefore);
    expect(await f.kv.get('admin:reasoning-check:retained-history')).toBe('historical-receipt');
    const history = await f.app.request('/admin/configuration-runs');
    expect(history.status).toBe(200);
    const activity = await history.json() as any;
    expect(activity.items).toEqual([expect.objectContaining({ state: 'failed', baseRevision: 7,
      error: expect.objectContaining({ code: 'configuration_task_failed' }),
      tasks: [expect.objectContaining({ state: 'failed' })] })]);
    expect(JSON.stringify(activity)).not.toContain(token);
  });

  it('REQ-ENTERPRISE-055: exact binding presence retains ambiguous or unsupported targets but a replacement binding cannot retain a deleted target', async () => {
    const f = await setup();
    const unsupportedId = '44444444-4444-4444-8444-444444444444';
    const disabledMissingId = '55555555-5555-4555-8555-555555555555';
    const targets = [savedNative(liveNativeId, 'openai-live'), savedNative(goneNativeId, 'bedrock-old', 'aws-bedrock'),
      savedNative(unsupportedId, 'groq-present', 'groq'), { ...savedNative(disabledMissingId, 'disabled-missing'), enabled: false }];
    f.kv._set(SETUP_KEYS.NATIVE_AI_TARGETS, { schemaVersion: 1, targets });
    routesReply = () => dynamicPage(['gone', 'live', 'inactive-gone', 'policy-gone', 'window-gone', nativeShapedDynamic]);
    providersReply = () => providerPage([
      providerRow('openai-live', 'openai', { default_config: false, alias: 'changed-alias' }),
      providerRow('openai-other', 'openai', { default_config: false }),
      providerRow('bedrock-replacement', 'aws-bedrock'), providerRow('groq-present', 'groq'),
    ]);
    customReply = () => Response.json({}, { status: 503 });
    const response = await reconcile(f);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.reconciliation).toEqual({ status: 'applied', revision: 8, removedDynamicRoutes: [],
      removedNativeTargetIds: expect.arrayContaining([goneNativeId, disabledMissingId]) });
    expect(body.reconciliation.removedNativeTargetIds).toHaveLength(2);
    expect(body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'openai', supported: false }), expect.objectContaining({ provider: 'groq', supported: false }),
    ]));
    expect(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS, 'json')).toEqual({ schemaVersion: 1, targets: [targets[0], targets[2]] });
    expect(await f.kv.get(SETUP_KEYS.DYNAMIC_ROUTES, 'json')).toEqual(['gone', 'live', nativeShapedDynamic]);
    const fresh = await reload(f);
    expect(fresh.sections.aiRouting.nativeTargets).toEqual([
      expect.objectContaining({ id: liveNativeId, handle: liveHandle, verification: expect.objectContaining({ current: false }) }),
      expect.objectContaining({ id: unsupportedId, verification: expect.objectContaining({ current: false }) }),
    ]);
    for (const projected of fresh.sections.aiRouting.nativeTargets) {
      expect(projected).not.toHaveProperty('providerConfigId');
      expect(projected).not.toHaveProperty('providerConfigAlias');
    }
  });

  it('REQ-ENTERPRISE-042: GET and draft catalog checks remain read-only and cannot smuggle edits into reconciliation', async () => {
    const f = await setup();
    routesReply = () => dynamicPage([]);
    providersReply = () => providerPage([]);
    const before = new Map(f.kv._store);
    const gateway = { gatewayUrl: routingGatewayUrl.replace(/\/gateway$/, '/overlay'), replacementToken: 'fixture-overlay-token' };
    for (const body of [undefined, {}, { gateway }]) {
      const response = body === undefined ? await f.app.request(catalogPath) : await post(f, catalogPath, body);
      expect(response.status).toBe(200);
      const result = await response.json() as any;
      expect(result).toMatchObject({ routes: [], providers: [], routeCatalogStatus: 'ready', providerCatalogStatus: 'ready' });
      expect(result).not.toHaveProperty('reconciliation');
      expect(new Map(f.kv._store)).toEqual(before);
    }
    expect(observedConnections).toEqual(expect.arrayContaining([
      { gateway: 'gateway', authorization: `Bearer ${token}` }, { gateway: 'overlay', authorization: 'Bearer fixture-overlay-token' },
    ]));
    for (const extra of [{ gateway }, { replacementToken: 'injected' }, { removedDynamicRoutes: ['live'] }, { values: { dynamicRoutes: [] } }]) {
      const response = await post(f, catalogPath, { reconcileSaved: true, baseRevision: 7, ...extra });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'validation_error' });
      expect(new Map(f.kv._store)).toEqual(before);
    }
    const fresh = await reload(f);
    expect(fresh.revision).toBe(7);
    expect(fresh.sections.aiRouting.dynamicRoutes).toEqual(['gone', 'live', nativeShapedDynamic]);
    expect(fresh.sections.aiRouting.nativeTargets).toEqual([]);
    expect(new Map(f.kv._store)).toEqual(before);
  });

  it('REQ-SETUP-018: reconciliation shares admission and invalidates a previously reviewed configuration revision', async () => {
    for (const guard of ['revision', 'setup', 'active'] as const) {
      const f = await setup();
      if (guard === 'setup') f.kv._store.set(SETUP_KEYS.CONFIGURING, String(Date.now()));
      if (guard === 'active') f.kv._set(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN, {
        runId: 'incumbent-run', updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
      const before = new Map(f.kv._store);
      const response = await reconcile(f, guard === 'revision' ? 6 : 7);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject(guard === 'revision'
        ? { code: 'configuration_revision_conflict', currentRevision: 7 }
        : guard === 'setup' ? { code: 'setup_configuration_active' } : { code: 'configuration_run_active', activeRunId: 'incumbent-run' });
      expect(new Map(f.kv._store)).toEqual(before);
    }
    const f = await setup();
    // Revision is global: even a review in another section must not overwrite a newer routing baseline.
    const draft = { section: 'github', baseRevision: 7, values: { providerType: 'app', appClientId: 'reviewed-client',
      appReplacementSecret: '', oauthClientId: '', oauthReplacementSecret: '' } };
    const preview = await post(f, '/admin/configuration-previews', draft);
    expect(preview.status).toBe(200);
    const reviewed = await preview.json() as any;
    expect(reviewed.changes).not.toEqual([]);
    const cleaned = await reconcile(f);
    expect(cleaned.status).toBe(200);
    expect(await cleaned.json()).toMatchObject({ reconciliation: { status: 'applied', revision: 8 } });
    const after = await routingSnapshot(f.kv);
    const staleSave = await post(f, '/admin/configuration-runs', { ...draft,
      confirmedWarnings: reviewed.warnings.map((warning: { code: string }) => warning.code) });
    expect(staleSave.status).toBe(409);
    expect(await staleSave.json()).toMatchObject({ code: 'configuration_revision_conflict', currentRevision: 8 });
    expect(await f.kv.get(SETUP_KEYS.GITHUB_APP_CLIENT_ID)).toBeNull();
    expect(await routingSnapshot(f.kv)).toEqual(after);
    expect((await reload(f)).revision).toBe(8);
  });

  it('REQ-SETUP-018: revision, connection, setup and run-ownership drift during management I/O abort before routing writes', async () => {
    for (const drift of ['revision', 'connection', 'setup', 'ownership'] as const) {
      const f = await setup();
      const before = await routingSnapshot(f.kv);
      let changed = false;
      duringManagement = () => {
        changed = true;
        if (drift === 'revision') f.kv._store.set(ADMIN_CONFIGURATION_KEYS.REVISION, '8');
        if (drift === 'connection') f.kv._store.set(SETUP_KEYS.AIG_GATEWAY_URL, routingGatewayUrl.replace(/\/gateway$/, '/rotated'));
        if (drift === 'setup') f.kv._store.set(SETUP_KEYS.CONFIGURING, String(Date.now()));
        if (drift === 'ownership') f.kv._set(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN, {
          runId: 'new-owner', updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(),
        });
      };
      const response = await reconcile(f);
      expect(response.status).toBe(409);
      expect(changed).toBe(true);
      expect(await routingSnapshot(f.kv)).toEqual(before);
      expect(await f.kv.get(ADMIN_CONFIGURATION_KEYS.REVISION)).toBe(drift === 'revision' ? '8' : '7');
      if (drift === 'ownership') expect(await f.kv.get(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN, 'json')).toMatchObject({ runId: 'new-owner' });
      const fresh = await reload(f);
      expect(fresh.sections.aiRouting.dynamicRoutes).toEqual(['gone', 'live', nativeShapedDynamic]);
      expect(await routingSnapshot(f.kv)).toEqual(before);
    }
  });
});
