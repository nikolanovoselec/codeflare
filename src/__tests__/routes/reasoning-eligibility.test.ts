import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { getBuiltInProfile, getBuiltInProfileRef, normalizeCustomProfile } from '../../lib/reasoning-profiles';
import { validateConfigurationValues, buildConfigurationPreview, executeConfigurationTask } from '../../lib/admin-configuration';
import { loadEnterpriseRouteConfig } from '../../lib/access';
import { getAigConfig } from '../../lib/aig-config';
import { LlmInterceptor } from '../../llm-interceptor';
import reasoningRoutes from '../../routes/admin/reasoning';
import setupRoutes from '../../routes/setup';
import { AppError } from '../../lib/error-types';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => { c.set('user', { email: 'admin@example.com', role: 'admin' }); return next(); }),
  requireAdmin: vi.fn(async (_c: any, next: any) => next()),
}));

const gatewayUrl = 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/gateway';
const token = 'test-gateway-token';
const profileRef = getBuiltInProfileRef('openai-gpt-chat-tools-off');
const model = { id: 'model', type: 'model', properties: { provider: 'openai', model: 'test-model' }, outputs: { success: { elementId: 'end' } } };
const topology = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } }, model];
let version: string;
let elements: unknown[];
let providerMode: 'ok' | 'partial' | 'failed' | 'off-reasons';
let managementStatus: number;
let providerCalls: number;
let driftDuringCheck: boolean;

function stream(delta: unknown, finish_reason = 'stop') {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
function setup() {
  const kv = createMockKV();
  const env = { KV: kv, ENTERPRISE_MODE: 'active', AIG_GATEWAY_URL: gatewayUrl, AIG_TOKEN: token } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => { c.env = env; return next(); });
  app.route('/api/admin/reasoning', reasoningRoutes);
  app.route('/api/setup', setupRoutes);
  app.onError((error, c) => error instanceof AppError ? c.json(error.toJSON(), error.statusCode as ContentfulStatusCode) : c.json({ error: 'Unexpected test error' }, 500));
  const post = async (path: string, body: unknown) => app.request(`/api/admin/reasoning/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const check = (extra: Record<string, unknown> = {}) => post('discover', { route: 'working', profileRef, maxCompletionTokens: 32, ...extra });
  return { kv, env, app, post, check };
}
function values(extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    gatewayUrl, replacementToken: '', dynamicRoutes: ['working'],
    defaultRoute: { route: 'working', reasoning: 'off' }, routeContextWindows: { working: 10000 },
    groupRouting: [{ accessGroup: 'engineering', routes: ['working'], defaultRoute: 'working', reasoning: 'off' }],
    fallbackRouting: { enabled: false },
    reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: { working: { activeProfile: profileRef } } },
    ...extra,
  };
}
async function activate(fixture: ReturnType<typeof setup>, extra: Record<string, unknown> = {}) {
  const receipt = await (await fixture.check()).json() as any;
  const validated = await validateConfigurationValues(fixture.env, 'aiRouting', 'enterprise', values({ routeChecks: { working: receipt.checkId }, ...extra }));
  expect(validated.fieldErrors).toBeUndefined();
  const context = { mode: 'enterprise' as const, requestUrl: 'https://codeflare.example.com', resultingRevision: 1 };
  await executeConfigurationTask(fixture.env, 'configure_ai_gateway', validated.values!, context);
  await executeConfigurationTask(fixture.env, 'configure_model_routing', validated.values!, context);
  return { receipt, validated };
}

beforeEach(() => {
  version = 'version-1'; elements = structuredClone(topology); providerMode = 'ok'; managementStatus = 200; providerCalls = 0; driftDuringCheck = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    const url = input instanceof Request ? input.url : String(input);
    if (method === 'GET') {
      if (managementStatus !== 200) return Response.json({ secret: 'private error' }, { status: managementStatus });
      return url.endsWith('/routes')
        ? Response.json({ result: { routes: ['working', 'other'].map((name) => ({ id: name, name })) } })
        : Response.json({ result: { version: { id: version, active: true, data: elements } } });
    }
    providerCalls++;
    if (driftDuringCheck) version = 'version-2';
    if (providerMode === 'failed') return Response.json({}, { status: 503 });
    const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body));
    if (!body.tools) return stream({ content: '2399', ...(providerMode === 'off-reasons' ? { reasoning_content: 'thinking' } : {}) });
    if (providerMode === 'partial') return stream({ content: 'unfinished' }, 'length');
    if (body.messages.some((message: any) => message.role === 'tool')) return stream({ content: 'DONE' });
    return stream({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] }, 'tool_calls');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('REQ-ENTERPRISE-042 draft gateway connection', () => {
  it.each([401, 403])('reports sanitized permission-denied for management %s without asserting the exact missing scope', async (status) => {
    const f = setup(); managementStatus = status;
    const response = await f.post('catalog', { gateway: { gatewayUrl, replacementToken: 'draft-token' } });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ routeCatalogStatus: 'unavailable', connection: { status: 'permission-denied' } });
    expect(body.connection.message).toMatch(/valid.*token.*AI Gateway Read/i);
    expect(JSON.stringify(body)).not.toMatch(/draft-token|private error/);
    expect(f.kv.put).not.toHaveBeenCalled();
  });
  it('rejects draft gateway credentials, unsafe hosts and provenance before external I/O', async () => {
    const f = setup();
    for (const gateway of [{ gatewayUrl: 'https://evil.example/v1/account/gateway' }, { gatewayUrl, replacementToken: 'bad\r\ntoken' }]) {
      expect((await f.post('catalog', { gateway })).status).toBe(400);
    }
    expect((await f.post('routes/working/inventory', { backendDescriptions: { model: 'bad\nvalue' } })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not substitute a deployment token for an unreadable saved encrypted credential', async () => {
    const f = setup(); f.kv._set(SETUP_KEYS.AIG_TOKEN, 'v1:corrupted');
    expect((await getAigConfig(f.env)).token).toBeUndefined();
  });
});

describe('REQ-ENTERPRISE-043 server-issued verification', () => {
  it('verifies an unsaved canonical custom profile and draft gateway without activation', async () => {
    const f = setup();
    const base = getBuiltInProfile(profileRef.id)!;
    const draft = normalizeCustomProfile({ schemaVersion: 1, id: 'custom-draft', name: 'Draft', revision: 1, enabled: true, supportedLevels: base.supportedLevels, removePaths: base.removePaths, levels: base.levels, aliases: base.aliases, offSemantics: base.offSemantics });
    const ref = { id: draft.id, revision: draft.revision, hash: draft.hash };
    const response = await f.check({ profileRef: ref, profileDraft: draft, gateway: { gatewayUrl, replacementToken: 'draft-token' } });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.checkId).toEqual(expect.any(String));
    expect(body.verification).toMatchObject({ schemaVersion: 1, profileRef: ref, routeVersion: version, scope: 'single-model', supportedLevels: ['off'] });
    expect(f.kv.put.mock.calls.filter(([key]) => String(key).includes(body.checkId))).toHaveLength(1);
    expect(f.kv._store.has(SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
    expect(f.kv._store.has(SETUP_KEYS.AIG_TOKEN)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('draft-token');
  });
  it('returns not_found without paid checks for a missing selected route', async () => {
    const f = setup(); const response = await f.check({ route: 'missing' });
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'not_found' });
    expect(providerCalls).toBe(0);
  });
  it.each(['failed', 'partial', 'off-reasons'] as const)('issues no receipt for %s checks', async (mode) => {
    const f = setup(); providerMode = mode;
    const body = await (await f.check()).json() as any;
    expect(body).not.toHaveProperty('checkId'); expect(body).not.toHaveProperty('verification');
  });
  it('issues no receipt when inventory drifts during an otherwise complete canary', async () => {
    const f = setup(); driftDuringCheck = true;
    const body = await (await f.check()).json() as any;
    expect(body).not.toHaveProperty('checkId'); expect(body).not.toHaveProperty('verification');
    expect(body.warnings).toContain('route_inventory_changed');
  });
  it('issues observed-path authority with an all-legs-unverified warning for a conditional route', async () => {
    const f = setup();
    elements = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'condition' } } }, { id: 'condition', type: 'conditional', outputs: { yes: { elementId: 'model' }, no: { elementId: 'second' } } }, model, { ...model, id: 'second' }];
    const body = await (await f.check()).json() as any;
    expect(body.checkId).toEqual(expect.any(String)); expect(body.verification.scope).toBe('observed-path');
    expect(body.warnings).toContain('observed_path_only');
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ routeChecks: { working: body.checkId } }));
    expect(result.fieldErrors).toBeUndefined();
    const preview = await buildConfigurationPreview(f.env, 'aiRouting', 'enterprise', 0, 0, result.values!);
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: 'observed_path_only' }));
  });
  it('uses unique immutable receipt keys with a bounded TTL and never rewrites an earlier check', async () => {
    const f = setup();
    const first = await (await f.check()).json() as any;
    const second = await (await f.check()).json() as any;
    expect(first.checkId).not.toBe(second.checkId);
    for (const checkId of [first.checkId, second.checkId]) {
      const puts = f.kv.put.mock.calls.filter(([key]) => key.endsWith(checkId));
      expect(puts).toHaveLength(1); expect(puts[0][2]).toEqual({ expirationTtl: 15 * 60 });
    }
  });
  it('does not treat inherited object properties as custom backend provenance', async () => {
    const f = setup();
    elements = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'toString' } } }, { ...model, id: 'toString', properties: { provider: 'custom-enterprise', model: 'alias' } }];
    const response = await f.check();
    expect(response.status).toBe(400); expect(providerCalls).toBe(0);
  });
  it('inventory digests exclude legacy evidence and warnings but bind declared custom backend provenance', async () => {
    const f = setup();
    elements = [topology[0], { ...model, properties: { provider: 'custom-enterprise', model: 'alias' } }];
    const first = await (await f.post('routes/working/inventory', { backendDescriptions: { model: 'backend-a' } })).json() as any;
    f.kv._set(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: [], routeAssignments: { working: {
      activeProfile: profileRef, routeVersion: 'stale', legs: [{ nodeId: 'model', provider: 'custom-enterprise', declaredModel: 'alias', customProviderBackend: 'backend-a', profileRef, evidence: { current: true, toolReplay: true } }],
    } } });
    const evidenceChanged = await (await f.post('routes/working/inventory', {})).json() as any;
    expect(evidenceChanged.inventoryDigest).toBe(first.inventoryDigest);
    expect(evidenceChanged).not.toHaveProperty('verification');
    const changed = await (await f.post('routes/working/inventory', { backendDescriptions: { model: 'backend-b' } })).json() as any;
    expect(changed.inventoryDigest).not.toBe(first.inventoryDigest);
  });
  it('route-only Map never creates an eligibility receipt', async () => {
    const f = setup(); const body = await (await f.check({ profileRef: undefined })).json() as any;
    expect(body).not.toHaveProperty('checkId'); expect(body).not.toHaveProperty('verification');
  });
  it('rejects invalid, mismatched and mutated or disabled existing custom drafts before provider I/O', async () => {
    const f = setup(); const base = getBuiltInProfile(profileRef.id)!;
    const draft = normalizeCustomProfile({ schemaVersion: 1, id: 'custom-draft', name: 'Draft', revision: 1, enabled: true, supportedLevels: base.supportedLevels, removePaths: base.removePaths, levels: base.levels, offSemantics: base.offSemantics });
    const ref = { id: draft.id, revision: 1, hash: draft.hash };
    for (const profileDraft of [{ ...draft, levels: { off: [{ path: 'model', value: 'escape' }] } }, { ...draft, hash: 'a'.repeat(64) }]) {
      expect((await f.check({ profileRef: ref, profileDraft })).status).toBe(400);
    }
    f.kv._set(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: [draft], routeAssignments: {} });
    const mutated = normalizeCustomProfile({ ...draft, hash: undefined, name: 'Mutated revision' });
    expect((await f.check({ profileRef: { ...ref, hash: mutated.hash }, profileDraft: mutated })).status).toBe(400);
    f.kv._set(SETUP_KEYS.REASONING_CONFIGURATION, { schemaVersion: 1, customProfileRevisions: [normalizeCustomProfile({ ...draft, hash: undefined, enabled: false })], routeAssignments: {} });
    expect((await f.check({ profileRef: ref, profileDraft: draft })).status).toBe(400);
    expect(providerCalls).toBe(0);
  });
  it('never trusts forged verification or legacy evidence flags in Save', async () => {
    const f = setup(); const checked = await (await f.check()).json() as any;
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: { working: { activeProfile: profileRef, verification: checked.verification, routeVersion: version, legs: [{ nodeId: 'model', provider: 'openai', declaredModel: 'test-model', profileRef, evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' } }] } } } }));
    expect(result.values).toBeUndefined(); expect(f.kv._store.has(SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
  });
  it('rejects forged verification at the legacy Setup boundary before external work', async () => {
    const f = setup(); const checked = await (await f.check()).json() as any;
    vi.mocked(fetch).mockClear();
    const response = await f.app.request('/api/setup/configure', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      customDomain: 'codeflare.example.com', adminUsers: ['admin@example.com'], allowedUsers: ['admin@example.com'],
      dynamicRoutes: ['working'], defaultRoute: { route: 'working', reasoning: 'off' }, routeContextWindows: { working: 10000 },
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: { working: { activeProfile: profileRef, verification: checked.verification } } },
    }) });
    expect(response.status).toBe(400); expect(fetch).not.toHaveBeenCalled();
    expect(f.kv._store.has(SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
  });
  it('fails closed on delayed receipt visibility with retry advice and no automatic paid checks', async () => {
    const f = setup(); const checked = await (await f.check()).json() as any;
    const key = f.kv.put.mock.calls.find(([key]) => String(key).includes(checked.checkId))![0];
    f.kv._store.delete(key);
    const calls = providerCalls;
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ routeChecks: { working: checked.checkId } }));
    expect(JSON.stringify(result.fieldErrors)).toMatch(/retry.*without.*check/i); expect(providerCalls).toBe(calls);
  });
  it.each(['route', 'gateway', 'profile', 'inventory', 'provenance'])('rejects a receipt after %s identity changes', async (identity) => {
    const f = setup(); const checked = await (await f.check()).json() as any;
    const proposed = values({ routeChecks: { working: checked.checkId } });
    if (identity === 'gateway') {
      proposed.replacementToken = 'different-token';
      f.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    }
    if (identity === 'inventory') version = 'version-2';
    if (identity === 'profile') proposed.reasoningConfiguration = { schemaVersion: 1, customProfileRevisions: [], routeAssignments: { working: { activeProfile: getBuiltInProfileRef('workers-ai-glm-thinking') } } };
    if (identity === 'provenance') model.properties.model = 'different-model';
    if (identity === 'route') Object.assign(proposed, { dynamicRoutes: ['other'], routeChecks: { other: checked.checkId }, defaultRoute: { route: 'other', reasoning: 'off' }, routeContextWindows: { other: 10000 }, groupRouting: [{ accessGroup: 'engineering', routes: ['other'], defaultRoute: 'other', reasoning: 'off' }], reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: { other: { activeProfile: profileRef } } } });
    if (identity === 'provenance') elements = structuredClone(topology);
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', proposed);
    expect(result.values).toBeUndefined(); expect(JSON.stringify(result.fieldErrors)).toMatch(/check/i); model.properties.model = 'test-model';
  });
  it('copies inventory verification only while current connection and topology still match', async () => {
    const f = setup(); const { receipt } = await activate(f);
    const current = await (await f.post('routes/working/inventory', {})).json() as any;
    expect(current.verification).toEqual(receipt.verification); expect(current.inventoryDigest).toBe(receipt.verification.inventoryDigest);
    version = 'version-2';
    expect(await (await f.post('routes/working/inventory', {})).json()).not.toHaveProperty('verification');
    version = 'version-1';
    expect(await (await f.post('routes/working/inventory', { gateway: { gatewayUrl, replacementToken: 'other-token' } })).json()).not.toHaveProperty('verification');
  });
});

describe('REQ-ENTERPRISE-044 minimum routing and optional fallback', () => {
  it('saves one verified group route despite inactive drafts and invalid inactive context inputs', async () => {
    const f = setup(); const body = await (await f.check()).json() as any;
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ routeChecks: { working: body.checkId }, routeContextWindows: { working: 10000, unfinished: 'not-a-number', '': -1 }, reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: { working: { activeProfile: profileRef }, unfinished: { activeProfile: profileRef } } } }));
    expect(result.fieldErrors).toBeUndefined(); expect(result.values?.dynamicRoutes).toEqual(['working']);
    expect((result.values?.reasoningConfiguration as any).routeAssignments.unfinished).toEqual({ activeProfile: profileRef });
  });
  it('preserves valid inactive draft context windows and ignores invalid replacements without exposing inactive routes', async () => {
    const f = setup(); const checked = await (await f.check()).json() as any;
    f.kv._set(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS, { retained: 24000, unfinished: 32000, removed: 9000 });
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      routeChecks: { working: checked.checkId }, routeContextWindows: { working: 10000, retained: 48000, unfinished: 'invalid' },
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: Object.fromEntries(['working', 'retained', 'unfinished'].map((route) => [route, { activeProfile: profileRef }])) },
    }));
    expect(result.fieldErrors).toBeUndefined();
    expect(result.values?.routeContextWindows).toEqual({ working: 10000, retained: 48000, unfinished: 32000 });
    expect(result.values?.dynamicRoutes).toEqual(['working']);
    await executeConfigurationTask(f.env, 'configure_model_routing', result.values!, { mode: 'enterprise', requestUrl: 'https://codeflare.example.com', resultingRevision: 1 });
    expect(JSON.parse(f.kv._store.get(SETUP_KEYS.ROUTE_CONTEXT_WINDOWS)!)).toEqual({ working: 10000, retained: 48000, unfinished: 32000 });
    expect((await loadEnterpriseRouteConfig(f.env, ['engineering'])).routeContextWindows).toEqual({ working: 10000 });
  });
  it('persists a newly checked inactive draft without granting policy access or repeating paid checks', async () => {
    const f = setup(); await activate(f);
    const checked = await (await f.check({ route: 'other' })).json() as any;
    const configuration = JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!);
    configuration.routeAssignments.other = { activeProfile: profileRef };
    const calls = providerCalls;
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      reasoningConfiguration: configuration, routeChecks: { other: checked.checkId },
    }));
    expect(result.fieldErrors).toBeUndefined();
    await executeConfigurationTask(f.env, 'configure_model_routing', result.values!, { mode: 'enterprise', requestUrl: 'https://codeflare.example.com', resultingRevision: 2 });
    const saved = JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!);
    expect(saved.routeAssignments.other.verification).toEqual(checked.verification);
    expect((await loadEnterpriseRouteConfig(f.env, ['engineering'])).routeCatalog).toEqual(['working']);
    expect(providerCalls).toBe(calls);
  });
  it('requires a group assignment rather than fallback alone', async () => {
    const f = setup(); const body = await (await f.check()).json() as any;
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ routeChecks: { working: body.checkId }, groupRouting: [], fallbackRouting: { enabled: true, routes: ['working'], defaultRoute: 'working', reasoning: 'off' } }));
    expect(result.values).toBeUndefined();
  });
  it('disabled fallback denies unmatched users and enabled fallback exposes only its allowed verified subset', async () => {
    const f = setup(); await activate(f);
    expect((await loadEnterpriseRouteConfig(f.env, ['unknown'])).routeCatalog).toEqual([]);
    const configuration = JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!);
    configuration.fallbackRouting = { enabled: true, routes: ['working'], defaultRoute: 'working', reasoning: 'off' };
    f.kv._set(SETUP_KEYS.REASONING_CONFIGURATION, configuration); f.kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['working', 'other']);
    expect((await loadEnterpriseRouteConfig(f.env, ['unknown'])).routeCatalog).toEqual(['working']);
  });
  it('saves and retains an explicit empty deny-only first group alongside a working group', async () => {
    const f = setup();
    await activate(f, { groupRouting: [
      { accessGroup: 'deny', routes: [], defaultRoute: '', reasoning: 'off' },
      { accessGroup: 'engineering', routes: ['working'], defaultRoute: 'working', reasoning: 'off' },
    ] });
    expect(JSON.parse(f.kv._store.get(SETUP_KEYS.GROUP_ROUTING)!)).toEqual({
      deny: { routes: [], defaultRoute: '', reasoning: 'off' },
      engineering: { routes: ['working'], defaultRoute: 'working', reasoning: 'off' },
    });
    expect((await loadEnterpriseRouteConfig(f.env, ['deny', 'engineering'])).routeCatalog).toEqual([]);
    expect((await loadEnterpriseRouteConfig(f.env, ['engineering'])).routeCatalog).toEqual(['working']);
  });
  it('cannot Save deny-only groups without a nonempty working group', async () => {
    const f = setup();
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ groupRouting: [{ accessGroup: 'deny', routes: [], defaultRoute: '', reasoning: 'off' }] }));
    expect(result.values).toBeUndefined();
  });
  it('does not fall through from the first matching policy when its routes become ineligible', async () => {
    const f = setup(); await activate(f);
    f.kv._set(SETUP_KEYS.GROUP_ROUTING, { first: { routes: ['other'], defaultRoute: 'other', reasoning: 'off' }, second: { routes: ['working'], defaultRoute: 'working', reasoning: 'off' } });
    expect((await loadEnterpriseRouteConfig(f.env, ['first', 'second'])).routeCatalog).toEqual([]);
  });
  it('preserves unchanged existing server authority on ID-only Save but null clears it', async () => {
    const f = setup(); const { receipt } = await activate(f);
    const proposed = values({ reasoningConfiguration: undefined, routeReasoningProfiles: { working: profileRef.id } });
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', proposed);
    expect((result.values?.reasoningConfiguration as any).routeAssignments.working.verification).toEqual(receipt.verification);
    expect((await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', { ...proposed, routeChecks: { working: null } })).values).toBeUndefined();
  });
  it('null clears inactive authority without blocking a different verified group route', async () => {
    const f = setup(); const { receipt } = await activate(f);
    const configuration = JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!);
    configuration.routeAssignments.other = configuration.routeAssignments.working;
    f.kv._set(SETUP_KEYS.REASONING_CONFIGURATION, configuration);
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ reasoningConfiguration: configuration, routeChecks: { other: null } }));
    expect(result.fieldErrors).toBeUndefined();
    expect((result.values?.reasoningConfiguration as any).routeAssignments.other).not.toHaveProperty('verification');
    expect((result.values?.reasoningConfiguration as any).routeAssignments.working.verification).toEqual(receipt.verification);
  });
  it('stores gateway credentials before activating routing and requires an encryption key for replacement', async () => {
    const f = setup(); const { validated } = await activate(f);
    const preview = await buildConfigurationPreview(f.env, 'aiRouting', 'enterprise', 0, 0, validated.values!);
    expect(preview.tasks.map((task) => task.id)).toEqual(['configure_ai_gateway', 'configure_model_routing']);
    const before = f.kv.put.mock.calls.length;
    await expect(executeConfigurationTask(f.env, 'configure_ai_gateway', { ...validated.values, replacementToken: 'replacement-token' }, { mode: 'enterprise', requestUrl: 'https://codeflare.example.com', resultingRevision: 2 })).rejects.toThrow(/Encryption key/);
    expect(f.kv.put.mock.calls).toHaveLength(before);
  });
  it.each(['/v1/chat/completions', '/v1/responses'])('denies an empty catalog on %s before any upstream I/O', async (path) => {
    const f = setup(); const interceptor = new LlmInterceptor({ props: { user: 'user@example.com' } } as unknown as ExecutionContext, f.env);
    const response = await interceptor.fetch(new Request(`https://api.openai.com${path}`, { method: 'POST', body: '{"model":"working","input":"hello"}' }));
    expect(response.status).toBe(403); expect(fetch).not.toHaveBeenCalled();
  });
  it('denies inference rather than reviving an unreadable saved credential from props or env', async () => {
    const f = setup(); await activate(f);
    f.kv._store.set(SETUP_KEYS.AIG_TOKEN, 'v1:corrupted'); vi.mocked(fetch).mockClear();
    const response = await new LlmInterceptor({ props: { user: 'user@example.com', groups: ['engineering'], gatewayUrl, token } } as unknown as ExecutionContext, f.env).fetch(new Request('https://api.openai.com/v1/responses', { method: 'POST', body: '{"model":"working","input":"hello"}' }));
    expect(response.status).toBe(503); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses actual interceptor props identity and preserves allowed Responses payload semantics', async () => {
    const f = setup(); await activate(f); providerCalls = 0;
    const props = { user: 'user@example.com', groups: ['engineering'], gatewayUrl, token: 'different-token' };
    const denied = await new LlmInterceptor({ props } as unknown as ExecutionContext, f.env).fetch(new Request('https://api.openai.com/v1/responses', { method: 'POST', body: '{"model":"working","input":"hello"}' }));
    expect(denied.status).toBe(403); expect(providerCalls).toBe(0);
    const fetcher = vi.mocked(fetch); fetcher.mockResolvedValueOnce(Response.json({ result: { routes: [{ id: 'working', name: 'working' }] } })).mockResolvedValueOnce(Response.json({ result: { version: { id: version, active: true, data: elements } } })).mockResolvedValueOnce(Response.json({ output: [] }));
    const requestBody = { model: 'working', input: 'hello', reasoning: { effort: 'high' }, store: true };
    const allowed = await new LlmInterceptor({ props: { ...props, token } } as unknown as ExecutionContext, f.env).fetch(new Request('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(requestBody) }));
    expect(allowed.status).toBe(200);
    const upstream = fetcher.mock.calls.at(-1)![0] as Request;
    expect(await upstream.json()).toEqual({ ...requestBody, model: 'dynamic/working' });
  });
});
