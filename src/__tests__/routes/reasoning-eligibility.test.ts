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
import { encryptForKV, importEncryptionKey } from '../../lib/kv-crypto';
import { LlmInterceptor } from '../../llm-interceptor';
import { nativeTargetHandle, parseNativeAiTargets } from '../../lib/native-ai-targets';
import reasoningRoutes from '../../routes/admin/reasoning';
import setupRoutes from '../../routes/setup';
import { AppError } from '../../lib/error-types';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => { c.set('user', { email: 'admin@example.com', role: 'admin' }); return next(); }),
  requireAdmin: vi.fn(async (_c: any, next: any) => next()),
}));

const gatewayUrl = 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/gateway';
const accountApiUrl = 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/';
const token = 'test-gateway-token';
const profileRef = getBuiltInProfileRef('openai-gpt-chat-tools-off');
const bedrockProfileRef = getBuiltInProfileRef('bedrock-anthropic-compat');
const model = { id: 'model', type: 'model', properties: { provider: 'openai', model: 'test-model' }, outputs: { success: { elementId: 'end' } } };
const topology = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } }, model];
let version: string;
let elements: unknown[];
let providerMode: 'ok' | 'partial' | 'failed' | 'off-reasons' | 'empty-replay' | 'non-sse-replay' | 'error-replay' | 'unsupported' | 'candidates-unsupported';
let managementStatus: number;
let customProviderStatus: number;
let providerCalls: number;
let providerConfigAlias: string | undefined;
let nativeProviderSlug: string;
let observedProviderAliases: Array<string | null>;
let observedProviderModels: string[];
let observedProviderUrls: string[];
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
  version = 'version-1'; elements = structuredClone(topology); providerMode = 'ok'; managementStatus = 200; customProviderStatus = 200;
  providerCalls = 0; providerConfigAlias = undefined; nativeProviderSlug = 'aws-bedrock';
  observedProviderAliases = []; observedProviderModels = []; observedProviderUrls = []; driftDuringCheck = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const method = input instanceof Request ? input.method : init?.method ?? 'GET';
    const url = input instanceof Request ? input.url : String(input);
    if (method === 'GET') {
      if (url.includes('/custom-providers?') && customProviderStatus !== 200) return Response.json({ secret: 'private custom-provider error' }, { status: customProviderStatus });
      if (managementStatus !== 200) return Response.json({ secret: 'private error' }, { status: managementStatus });
      if (url.endsWith('/ai-gateway/gateways')) return Response.json({ result: [{ id: 'gateway' }] });
      if (url.includes('/provider_configs?')) return Response.json({ success: true, result: [{ id: nativeProviderSlug === 'aws-bedrock' ? 'bedrock-default' : 'provider-default', provider_slug: nativeProviderSlug, gateway_id: 'gateway', default_config: true, ...(providerConfigAlias && { alias: providerConfigAlias }) }], result_info: { page: 1, count: 1, per_page: 100, total_count: 1 } });
      if (url.includes('/custom-providers?')) return Response.json({ success: true, result: [], result_info: { page: 1, count: 0, per_page: 100, total_count: 0 } });
      return url.endsWith('/routes')
        ? Response.json({ result: { routes: ['working', 'other'].map((name) => ({ id: name, name })) } })
        : Response.json({ result: { version: { id: version, active: true, data: elements } } });
    }
    providerCalls++;
    observedProviderAliases.push(new Headers(input instanceof Request ? input.headers : init?.headers).get('cf-aig-byok-alias'));
    observedProviderUrls.push(url);
    if (driftDuringCheck) version = 'version-2';
    if (providerMode === 'failed') return Response.json({}, { status: 503 });
    const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body));
    observedProviderModels.push(String(body.model));
    if (!body.tools) return stream({ content: '2399', ...(providerMode === 'off-reasons' ? { reasoning_content: 'thinking' } : {}) });
    const candidateToolProbe = Object.hasOwn(body, 'reasoning_effort') || Object.hasOwn(body, 'chat_template_kwargs');
    if (providerMode === 'unsupported' || (providerMode === 'candidates-unsupported' && candidateToolProbe)) return stream({ content: 'no tool call' });
    if (providerMode === 'partial') return stream({ content: 'unfinished' }, 'length');
    if (body.messages.some((message: any) => message.role === 'tool')) {
      if (providerMode === 'empty-replay') return new Response('');
      if (providerMode === 'non-sse-replay') return new Response('<html>private provider failure</html>');
      if (providerMode === 'error-replay') return new Response('data: {"error":{"message":"private provider failure"}}\n\n');
      return stream({ content: 'DONE' });
    }
    return stream({ tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] }, 'tool_calls');
  });
});
afterEach(() => vi.restoreAllMocks());

describe('REQ-ENTERPRISE-047/-048 native target authority', () => {
  it('REQ-ENTERPRISE-055: applies the discovered provider alias during native verification', async () => {
    const f = setup();
    providerConfigAlias = 'bedrock-live';
    const response = await f.post('native/discover', {
      target: { label: 'Claude aliased', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: bedrockProfileRef, enabled: false },
      maxCompletionTokens: 32,
    });
    expect(response.status).toBe(200);
    expect(observedProviderAliases.length).toBeGreaterThan(0);
    expect(new Set(observedProviderAliases)).toEqual(new Set(['bedrock-live']));
  });

  it('REQ-ENTERPRISE-052: discovers and verifies an OpenAI native selector through the real compat helper', async () => {
    const f = setup();
    nativeProviderSlug = 'openai';
    const openaiProfileRef = getBuiltInProfileRef('native-openai-compat');
    const target = {
      label: 'GPT-5.6 Terra',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      contextWindow: 200000,
      enabled: false,
    };

    const discovered = await f.post('native/profile-discovery', {
      target,
      maxCompletionTokens: 32,
    });
    expect(discovered.status).toBe(200);
    expect(observedProviderModels.length).toBeGreaterThan(0);
    expect(new Set(observedProviderModels)).toEqual(new Set(['openai/gpt-5.6-terra']));
    expect(observedProviderUrls.every((url) => url.includes('/compat/chat/completions'))).toBe(true);

    observedProviderModels = [];
    observedProviderUrls = [];
    const verified = await f.post('native/discover', {
      target: { ...target, profileRef: openaiProfileRef },
      maxCompletionTokens: 32,
    });
    const body = await verified.json() as any;
    expect(verified.status).toBe(200);
    expect(body).toMatchObject({
      classification: 'Verified',
      assignable: true,
      verification: { method: 'automated', current: true },
    });
    expect(body.targetId).toEqual(expect.any(String));
    expect(body.checkId).toEqual(expect.any(String));
    expect(new Set(observedProviderModels)).toEqual(new Set(['openai/gpt-5.6-terra']));
    expect(observedProviderUrls.every((url) => url.includes('/compat/chat/completions'))).toBe(true);
  });

  it('REQ-ENTERPRISE-055: rejects invalid native target data before any routing write', async () => {
    const f = setup();
    const validated = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      nativeTargets: [{ label: 'Invalid target', provider: 'aws-bedrock', model: 'valid-model', contextWindow: 16384, profileRef: bedrockProfileRef, enabled: false }],
      nativeChecks: {},
    }));
    expect(validated.values).toBeUndefined();
    expect(validated.fieldErrors).toBeDefined();
    const unavailable = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      nativeTargets: [{ label: 'Unavailable target', provider: 'openai', model: 'gpt-5.6-sol', contextWindow: 200000, profileRef: getBuiltInProfileRef('native-openai-compat'), enabled: false }],
      nativeChecks: {},
    }));
    expect(unavailable.values).toBeUndefined();
    expect(unavailable.fieldErrors).toBeDefined();
    expect(f.kv.put).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-055: rejects a Dynamic Route that collides with a submitted native handle before any routing write', async () => {
    const f = setup();
    const id = '11111111-1111-4111-8111-111111111111';
    const handle = nativeTargetHandle(id);
    const validated = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      dynamicRoutes: ['working', handle],
      nativeTargets: [{ id, label: 'Claude', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: bedrockProfileRef, enabled: false }],
      nativeChecks: {},
      groupRouting: [{ accessGroup: 'engineering', routes: ['working', handle], defaultRoute: 'working', reasoning: 'off' }],
    }));
    expect(validated.values).toBeUndefined();
    expect(validated.fieldErrors?.dynamicRoutes).toContain('A Dynamic Route cannot use a native target handle');
    expect(f.kv.put).not.toHaveBeenCalled();
  });

  it('REQ-ENTERPRISE-055: validates a native-shaped Dynamic Route as a Dynamic Route when no native target owns it', async () => {
    const f = setup();
    const route = nativeTargetHandle('11111111-1111-4111-8111-111111111111');
    const validated = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      dynamicRoutes: [route],
      defaultRoute: { route, reasoning: 'high' },
      routeContextWindows: { [route]: 10000 },
      groupRouting: [{ accessGroup: 'engineering', routes: [route], defaultRoute: route, reasoning: 'high' }],
      reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: { [route]: { activeProfile: profileRef } } },
    }));
    expect(validated.values).toBeUndefined();
    expect(validated.fieldErrors?.reasoningConfiguration).toContain('Global default reasoning level is not mapped by its default route profile');
    expect(f.kv.put).not.toHaveBeenCalled();
  });

  it('keeps built-in discovery, validation, and reauthorization available when custom-provider lookup fails', async () => {
    const f = setup();
    await activate(f);
    customProviderStatus = 503;
    const checked = await (await f.post('native/discover', {
      target: { label: 'Claude automated', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: bedrockProfileRef, enabled: true },
      maxCompletionTokens: 32,
    })).json() as any;
    expect(checked).toMatchObject({ classification: 'Verified', assignable: true, verification: { method: 'automated', current: true } });
    const handle = nativeTargetHandle(checked.targetId);
    const proposed = values({
      nativeTargets: [{ id: checked.targetId, label: 'Claude automated', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: bedrockProfileRef, enabled: true }],
      nativeChecks: { [checked.targetId]: checked.checkId },
      groupRouting: [{ accessGroup: 'engineering', routes: ['working', handle], defaultRoute: handle, reasoning: 'off' }],
      defaultRoute: { route: handle, reasoning: 'off' },
    });
    const validated = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', proposed);
    expect(validated.fieldErrors).toBeUndefined();
    await executeConfigurationTask(f.env, 'configure_model_routing', validated.values!, { mode: 'enterprise', requestUrl: 'https://codeflare.example.com', resultingRevision: 1 });
    const savedTarget = parseNativeAiTargets(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS)).targets[0];
    expect(savedTarget.customProvider).toBeUndefined();
    expect(savedTarget.verification?.capabilities).toEqual({ streaming: true, tools: true, replay: true });
    expect((await loadEnterpriseRouteConfig(f.env, ['engineering'])).routeCatalog).toContain(handle);
  });

  it.each([
    ['completed', 'candidates-unsupported', 2],
    ['unsupported', 'unsupported', 1],
  ] as const)('combines candidate and prepared-profile accounting for %s native profile discovery', async (_case, mode, preparedAttempts) => {
    const f = setup();
    customProviderStatus = 503;
    providerMode = mode;

    const response = await f.post('native/profile-discovery', {
      target: { label: 'Claude profile', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, enabled: true },
      maxCompletionTokens: 32,
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.route).toBe('aws-bedrock/eu.anthropic.claude-sonnet-5');
    expect(body.outcome).toBe(mode === 'candidates-unsupported' ? 'existing-profile' : 'unsupported');
    expect(body.accounting.logicalProbes).toBeGreaterThan(1);
    expect(body.accounting.httpAttempts).toBeGreaterThan(preparedAttempts);
  });

  it('REQ-ENTERPRISE-057: rebinds saved native authority after replacement credentials preserve provider identity', async () => {
    const f = setup();
    f.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    await activate(f);
    const checked = await (await f.post('native/discover', {
      target: { label: 'Claude rotated', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: bedrockProfileRef, enabled: true },
      administratorConfirmed: true, maxCompletionTokens: 32,
    })).json() as any;
    const handle = nativeTargetHandle(checked.targetId);
    const nativeDraft = { id: checked.targetId, label: 'Claude rotated', provider: 'aws-bedrock', model: 'eu.anthropic.claude-sonnet-5', contextWindow: 200000, profileRef: bedrockProfileRef, enabled: true };
    const initial = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      nativeTargets: [nativeDraft], nativeChecks: { [checked.targetId]: checked.checkId },
      groupRouting: [{ accessGroup: 'engineering', routes: [handle], defaultRoute: handle, reasoning: 'off' }],
      defaultRoute: { route: handle, reasoning: 'off' },
    }));
    expect(initial.fieldErrors).toBeUndefined();
    await executeConfigurationTask(f.env, 'configure_model_routing', initial.values!, { mode: 'enterprise', requestUrl: 'https://codeflare.example.com', resultingRevision: 2 });
    const before = parseNativeAiTargets(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS)).targets[0].verification!;

    const otherGateway = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/other-gateway/', replacementToken: 'rotated-token', dynamicRoutes: [], routeContextWindows: {},
      nativeTargets: [nativeDraft], nativeChecks: {},
      groupRouting: [{ accessGroup: 'engineering', routes: [handle], defaultRoute: handle, reasoning: 'off' }],
      defaultRoute: { route: handle, reasoning: 'off' },
    }));
    expect(otherGateway.fieldErrors?.nativeTargets).toContain('must be verified');
    const changedProvider = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      gatewayUrl: accountApiUrl, gatewayId: 'gateway', replacementToken: 'rotated-token', dynamicRoutes: [], routeContextWindows: {},
      nativeTargets: [{ ...nativeDraft, provider: 'openai', model: 'gpt-5.6-terra', profileRef: getBuiltInProfileRef('native-openai-compat') }], nativeChecks: {},
      groupRouting: [{ accessGroup: 'engineering', routes: [handle], defaultRoute: handle, reasoning: 'off' }],
      defaultRoute: { route: handle, reasoning: 'off' },
    }));
    expect(changedProvider.fieldErrors?.nativeTargets).toContain('must be verified');

    const rotated = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      gatewayUrl: accountApiUrl, gatewayId: 'gateway', replacementToken: 'rotated-token', dynamicRoutes: [], routeContextWindows: {},
      nativeTargets: [nativeDraft], nativeChecks: {},
      groupRouting: [{ accessGroup: 'engineering', routes: [handle], defaultRoute: handle, reasoning: 'off' }],
      defaultRoute: { route: handle, reasoning: 'off' },
    }));
    expect(rotated.fieldErrors).toBeUndefined();
    const rebound = parseNativeAiTargets(rotated.values?.nativeTargets).targets[0].verification!;
    expect(rebound).toMatchObject({ targetId: checked.targetId, providerConfigId: 'bedrock-default', model: nativeDraft.model, profileRef: bedrockProfileRef });
    expect(rebound.connectionFingerprint).not.toBe(before.connectionFingerprint);
    expect(Date.parse(rebound.checkedAt)).toBeGreaterThanOrEqual(Date.parse(before.checkedAt));
    const preview = await buildConfigurationPreview(f.env, 'aiRouting', 'enterprise', 2, 2, rotated.values!);
    expect(preview.tasks.map((task) => task.id)).toEqual(['configure_ai_gateway', 'configure_model_routing']);
    await executeConfigurationTask(f.env, 'configure_ai_gateway', rotated.values!, { mode: 'enterprise', requestUrl: 'https://codeflare.example.com', resultingRevision: 3 });
    await executeConfigurationTask(f.env, 'configure_model_routing', rotated.values!, { mode: 'enterprise', requestUrl: 'https://codeflare.example.com', resultingRevision: 3 });
    expect(parseNativeAiTargets(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS)).targets[0].verification).toEqual(rebound);
  });

  it('REQ-ENTERPRISE-054: administrator confirmation issues server identity, persists authority, and leaves it unchanged on route-only Save', async () => {
    const f = setup();
    await activate(f);
    providerConfigAlias = 'bedrock-live';
    const checked = await (await f.post('native/discover', {
      target: { label: 'Claude exact', provider: 'aws-bedrock', model: 'eu.anthropic.claude-future-profile', contextWindow: 200000, profileRef: bedrockProfileRef, enabled: true },
      administratorConfirmed: true, maxCompletionTokens: 32,
    })).json() as any;
    expect(checked).toMatchObject({ classification: 'Administrator-confirmed', assignable: true });
    const handle = nativeTargetHandle(checked.targetId);
    const proposed = values({
      nativeTargets: [{ id: checked.targetId, label: 'Claude exact', provider: 'aws-bedrock', model: 'eu.anthropic.claude-future-profile', contextWindow: 200000, profileRef: bedrockProfileRef, enabled: true }],
      nativeChecks: { [checked.targetId]: checked.checkId },
      groupRouting: [{ accessGroup: 'engineering', routes: ['working', handle], defaultRoute: handle, reasoning: 'off' }],
      defaultRoute: { route: handle, reasoning: 'off' },
    });
    const validated = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', proposed);
    expect(validated.fieldErrors).toBeUndefined();
    const context = { mode: 'enterprise' as const, requestUrl: 'https://codeflare.example.com', resultingRevision: 1 };
    await executeConfigurationTask(f.env, 'configure_model_routing', validated.values!, context);
    const saved = parseNativeAiTargets(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS));
    expect(saved.targets[0]).toMatchObject({ id: checked.targetId, providerConfigId: 'bedrock-default', providerConfigAlias: 'bedrock-live', model: 'eu.anthropic.claude-future-profile', verification: { method: 'administrator', providerConfigAlias: 'bedrock-live' } });
    await executeConfigurationTask(f.env, 'configure_model_routing', values(), context);
    expect(parseNativeAiTargets(await f.kv.get(SETUP_KEYS.NATIVE_AI_TARGETS))).toEqual(saved);
  });
});

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
  it('REQ-ENTERPRISE-057/063: accepts the account API base URL and configured gateway name for Dynamic Route inspection', async () => {
    const f = setup();
    const response = await f.post('catalog', { gateway: { gatewayUrl: accountApiUrl, gatewayId: 'gateway', replacementToken: 'draft-token' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ routeCatalogStatus: 'ready', routes: ['working', 'other'] });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai-gateway/gateways/gateway/routes',
      expect.objectContaining({ method: 'GET' }),
    );
  });
  it('REQ-ENTERPRISE-057/063: accepts the legacy gateway URL for Dynamic Route inspection', async () => {
    const f = setup();
    const response = await f.post('catalog', { gateway: { gatewayUrl, replacementToken: 'draft-token' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ routeCatalogStatus: 'ready', routes: ['working', 'other'] });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai-gateway/gateways/gateway/routes',
      expect.objectContaining({ method: 'GET' }),
    );
  });
  it('reuses the saved encrypted token for draft inspection without changing storage', async () => {
    const f = setup();
    f.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    const savedToken = 'saved-inspection-token';
    const encrypted = await encryptForKV(JSON.stringify({ token: savedToken }), await importEncryptionKey(f.env.ENCRYPTION_KEY), SETUP_KEYS.AIG_TOKEN);
    f.kv._store.set(SETUP_KEYS.AIG_TOKEN, encrypted);
    const before = new Map(f.kv._store);
    const response = await f.post('catalog', { gateway: { gatewayUrl } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connection: { status: 'ready' } });
    expect(fetch).toHaveBeenCalled();
    for (const [input, init] of vi.mocked(fetch).mock.calls) {
      expect(new Headers(input instanceof Request ? input.headers : init?.headers).get('authorization')).toBe(`Bearer ${savedToken}`);
    }
    expect(f.kv._store).toEqual(before);
    expect(f.kv.put).not.toHaveBeenCalled();
  });
  it('does not substitute a deployment token for an unreadable saved encrypted credential', async () => {
    const f = setup(); f.kv._set(SETUP_KEYS.AIG_TOKEN, 'v1:corrupted');
    expect((await getAigConfig(f.env)).token).toBeUndefined();
  });
});

describe('REQ-ENTERPRISE-043 server-issued verification', () => {
  it('confirms an administrator-selected profile without paid probes and preserves authority through Save and runtime loading', async () => {
    const f = setup();
    elements = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'model' } } },
      { ...model, properties: { provider: 'custom-mesh', model: 'mesh' }, outputs: { success: { elementId: 'end' }, fallback: { elementId: 'second' } } },
      { ...model, id: 'second', outputs: { success: { elementId: 'end' }, fallback: { elementId: 'third' } } }, { ...model, id: 'third' }];
    const response = await f.check({ administratorConfirmed: true });
    expect(response.status).toBe(200);
    const receipt = await response.json() as any;
    expect(receipt).toMatchObject({ classification: 'Administrator-confirmed', assignable: true, verification: { method: 'administrator', profileRef, scope: 'observed-path' } });
    expect(receipt).not.toHaveProperty('piCompatibility');
    expect(providerCalls).toBe(0);
    expect(f.kv._store.has(SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ routeChecks: { working: receipt.checkId } }));
    expect(result.fieldErrors).toBeUndefined();
    const preview = await buildConfigurationPreview(f.env, 'aiRouting', 'enterprise', 0, 0, result.values!);
    expect(preview.warnings).toContainEqual(expect.objectContaining({ code: 'administrator_confirmed' }));
    expect(preview.warnings).not.toContainEqual(expect.objectContaining({ code: 'observed_path_only' }));
    const context = { mode: 'enterprise' as const, requestUrl: 'https://codeflare.example.com', resultingRevision: 1 };
    await executeConfigurationTask(f.env, 'configure_ai_gateway', result.values!, context);
    await executeConfigurationTask(f.env, 'configure_model_routing', result.values!, context);
    expect((await loadEnterpriseRouteConfig(f.env, ['engineering'])).routeCatalog).toEqual(['working']);
    expect((await loadEnterpriseRouteConfig(f.env, ['unknown'])).routeCatalog).toEqual([]);
    const stored = JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!);
    expect(stored.routeAssignments.working.verification.method).toBe('administrator');
    expect(providerCalls).toBe(0);
    version = 'version-2';
    const stale = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ routeChecks: { working: receipt.checkId } }));
    expect(stale.fieldErrors).toBeDefined();
  });
  it('requires a canonical selected profile for administrator confirmation before external I/O', async () => {
    const f = setup();
    const response = await f.post('discover', { route: 'working', administratorConfirmed: true });
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not accept browser-fabricated administrator confirmation as saved authority', async () => {
    const f = setup();
    const receipt = await (await f.check({ administratorConfirmed: true })).json() as any;
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ reasoningConfiguration: {
      schemaVersion: 1, customProfileRevisions: [], routeAssignments: { working: { activeProfile: profileRef, verification: receipt.verification } },
    } }));
    expect(result.fieldErrors).toBeDefined();
    expect(providerCalls).toBe(0);
  });
  it('REQ-ENTERPRISE-057/063: discovers and verifies a Dynamic Route profile through the account API URL', async () => {
    const f = setup();
    const response = await f.check({ gateway: { gatewayUrl: `${accountApiUrl}ai/v1/chat/completions`, gatewayId: 'gateway', replacementToken: 'draft-token' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ classification: 'Verified', verification: { profileRef } });
    const providerRequests = vi.mocked(fetch).mock.calls.filter(([input, init]) => (input instanceof Request ? input.method : init?.method) === 'POST');
    expect(providerRequests).toHaveLength(3);
    expect(providerRequests.every(([input]) => String(input instanceof Request ? input.url : input) === `${accountApiUrl}ai/v1/chat/completions`)).toBe(true);
    expect(providerRequests.every(([input, init]) => new Headers(input instanceof Request ? input.headers : init?.headers).get('cf-aig-gateway-id') === 'gateway')).toBe(true);
  });
  it('REQ-ENTERPRISE-057/063: discovers and verifies a Dynamic Route profile through the legacy URL', async () => {
    const f = setup();
    const response = await f.check({ gateway: { gatewayUrl, replacementToken: 'draft-token' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ classification: 'Verified', verification: { profileRef } });
    const providerRequests = vi.mocked(fetch).mock.calls.filter(([input, init]) => (input instanceof Request ? input.method : init?.method) === 'POST');
    expect(providerRequests).toHaveLength(3);
    expect(providerRequests.every(([input]) => String(input instanceof Request ? input.url : input) === `${accountApiUrl}ai/v1/chat/completions`)).toBe(true);
    expect(providerRequests.every(([input, init]) => new Headers(input instanceof Request ? input.headers : init?.headers).get('cf-aig-gateway-id') === 'gateway')).toBe(true);
  });
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
  it('REQ-ENTERPRISE-031: verifies canonical custom scalar paths beyond discovery candidate roots', async () => {
    const f = setup();
    const draft = normalizeCustomProfile({
      schemaVersion: 1, id: 'custom-thinking-mode', name: 'Custom thinking mode', revision: 1, enabled: true,
      supportedLevels: ['off'], removePaths: ['thinking_mode', 'vendor_options.reasoning.enabled'],
      levels: { off: [{ path: 'thinking_mode', value: 'disabled' }, { path: 'vendor_options.reasoning.enabled', value: false }] },
      offSemantics: { status: 'explicit-value', path: 'thinking_mode', value: 'disabled' },
    });
    const ref = { id: draft.id, revision: draft.revision, hash: draft.hash };
    const response = await f.check({ profileRef: ref, profileDraft: draft });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.checkId).toEqual(expect.any(String));
    expect(body.verification).toMatchObject({ profileRef: ref, supportedLevels: ['off'] });
    expect(providerCalls).toBe(3);
    for (const [, init] of vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')) {
      expect(JSON.parse(String(init?.body))).toMatchObject({ thinking_mode: 'disabled', vendor_options: { reasoning: { enabled: false } } });
    }
    expect(f.kv._store.has(SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
  });
  it('returns not_found without paid checks for a missing selected route', async () => {
    const f = setup(); const response = await f.check({ route: 'missing' });
    expect(response.status).toBe(404); expect(await response.json()).toMatchObject({ code: 'not_found' });
    expect(providerCalls).toBe(0);
  });
  it.each(['failed', 'partial', 'off-reasons', 'empty-replay', 'non-sse-replay', 'error-replay'] as const)('issues no receipt for %s checks', async (mode) => {
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
  it('verifies an undescribed custom backend without inventing inherited provenance', async () => {
    const f = setup();
    elements = [{ id: 'start', type: 'start', outputs: { next: { elementId: 'toString' } } }, { ...model, id: 'toString', properties: { provider: 'custom-enterprise', model: 'alias' } }];
    const response = await f.check();
    expect(response.status).toBe(200); expect(providerCalls).toBe(3);
    const body = await response.json() as any;
    expect(body.verification.scope).toBe('observed-path');
    expect(body.verification).not.toHaveProperty('method');
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
  it('REQ-ENTERPRISE-057: rebinds saved route authority after a replacement connection passes management topology validation', async () => {
    const f = setup(); await activate(f);
    f.env.ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      gatewayUrl: accountApiUrl, gatewayId: 'gateway', replacementToken: 'rotated-token',
    }));
    expect(result.fieldErrors).toBeUndefined();
    const verification = (result.values!.reasoningConfiguration as any).routeAssignments.working.verification;
    expect(verification.connectionFingerprint).not.toBe((JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!) as any).routeAssignments.working.verification.connectionFingerprint);
    expect(verification.inventoryDigest).toBe((JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!) as any).routeAssignments.working.verification.inventoryDigest);
    expect(providerCalls).toBe(3);
  });
  it.each(['route', 'profile', 'inventory', 'provenance'].flatMap((identity) => [
    { identity, administratorConfirmed: false }, { identity, administratorConfirmed: true },
  ]))('rejects a receipt after $identity identity changes (administrator: $administratorConfirmed)', async ({ identity, administratorConfirmed }) => {
    const f = setup(); const checked = await (await f.check(administratorConfirmed ? { administratorConfirmed: true } : {})).json() as any;
    const proposed = values({ routeChecks: { working: checked.checkId } });
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
    expect((result.values?.reasoningConfiguration as any)?.routeAssignments?.unfinished).toEqual({ activeProfile: profileRef });
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
  it('persists reconciled backend identities after successful re-verification of a changed model', async () => {
    const f = setup();
    await activate(f, { reasoningConfiguration: { schemaVersion: 1, customProfileRevisions: [], routeAssignments: {
      working: { activeProfile: profileRef, legs: [{ nodeId: 'model', provider: 'openai', declaredModel: 'test-model', profileRef }] },
    } } });
    const configuration = JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!);
    version = 'version-2';
    elements = [structuredClone(topology[0]), { ...structuredClone(model), properties: { provider: 'openai', model: 'replacement-model' } }];
    const checked = await (await f.check()).json() as any;
    expect(checked.checkId).toBeDefined();
    configuration.routeAssignments.working = { ...configuration.routeAssignments.working,
      routeVersion: checked.verification.routeVersion,
      legs: [{ nodeId: 'model', provider: 'openai', declaredModel: 'replacement-model', profileRef }],
    };
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({
      reasoningConfiguration: configuration, routeChecks: { working: checked.checkId },
    }));
    expect(result.fieldErrors).toBeUndefined();
    await executeConfigurationTask(f.env, 'configure_model_routing', result.values!, { mode: 'enterprise', requestUrl: 'https://codeflare.example.com', resultingRevision: 2 });
    const saved = JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!);
    expect(saved.routeAssignments.working.legs).toEqual([{ nodeId: 'model', provider: 'openai', declaredModel: 'replacement-model', profileRef }]);
    expect(saved.routeAssignments.working.verification).toEqual(checked.verification);
    expect((await loadEnterpriseRouteConfig(f.env, ['engineering'])).routeCatalog).toEqual(['working']);
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
    expect((result.values?.reasoningConfiguration as any)?.routeAssignments?.working?.verification).toEqual(receipt.verification);
    expect((await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', { ...proposed, routeChecks: { working: null } })).values).toBeUndefined();
  });
  it('null clears inactive authority without blocking a different verified group route', async () => {
    const f = setup(); const { receipt } = await activate(f);
    const configuration = JSON.parse(f.kv._store.get(SETUP_KEYS.REASONING_CONFIGURATION)!);
    configuration.routeAssignments.other = configuration.routeAssignments.working;
    f.kv._set(SETUP_KEYS.REASONING_CONFIGURATION, configuration);
    const result = await validateConfigurationValues(f.env, 'aiRouting', 'enterprise', values({ reasoningConfiguration: configuration, routeChecks: { other: null } }));
    expect(result.fieldErrors).toBeUndefined();
    const inactive = (result.values?.reasoningConfiguration as any)?.routeAssignments?.other;
    expect(inactive).toEqual({ activeProfile: profileRef, routeVersion: receipt.verification.routeVersion });
    expect(inactive).not.toHaveProperty('verification');
    expect(result.values?.dynamicRoutes).toEqual(['working']);
    expect((result.values?.reasoningConfiguration as any)?.routeAssignments?.working?.verification).toEqual(receipt.verification);
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
    const fetcher = vi.mocked(fetch); fetcher.mockClear(); fetcher.mockResolvedValueOnce(Response.json({ output: [] }));
    const requestBody = { model: 'working', input: 'hello', reasoning: { effort: 'high' }, store: true };
    const allowed = await new LlmInterceptor({ props: { ...props, token } } as unknown as ExecutionContext, f.env).fetch(new Request('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(requestBody) }));
    expect(allowed.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const upstream = fetcher.mock.calls.at(-1)![0] as Request;
    expect(upstream.method).toBe('POST');
    expect(await upstream.json()).toEqual({ ...requestBody, model: 'dynamic/working' });
  });
});
