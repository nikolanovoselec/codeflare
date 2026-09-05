import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';

const { PROFILE_HASH, BUILTIN_IDS } = vi.hoisted(() => ({
  PROFILE_HASH: 'a'.repeat(64),
  BUILTIN_IDS: [
    'openai-gpt-chat-tools-reasoning',
    'openai-gpt-chat-tools-off',
    'workers-ai-gemma-thinking',
    'workers-ai-kimi-k-thinking',
    'workers-ai-glm-thinking',
    'codeflare-inference-mesh-binary-thinking',
  ],
}));

let role = 'admin';
let authReject = false;
let gatewayConfig: { gatewayUrl?: string; token?: string } = {
  gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/gateway',
  token: 'gateway-secret',
};

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (authReject) throw new AppError('AUTH_ERROR', 401, 'Not authenticated');
    c.set('user', { email: 'admin@example.com', authenticated: true, role });
    c.set('bucketName', 'admin-bucket');
    return next();
  }),
  requireAdmin: vi.fn(async (c: any, next: any) => role === 'admin' ? next() : c.json({ error: 'Access denied', code: 'FORBIDDEN' }, 403)),
}));

vi.mock('../../lib/aig-config', () => ({
  getAigConfig: vi.fn(async () => gatewayConfig),
}));

vi.mock('../../lib/reasoning-profiles', () => {
  const profiles = BUILTIN_IDS.map((id) => ({
    id,
    name: id,
    revision: 1,
    hash: PROFILE_HASH,
    enabled: true,
    ingressContract: 'ai-gateway-chat-completions',
    supportedLevels: ['off'],
    unsupportedLevels: [],
    removePaths: [],
    levels: { off: [{ path: 'reasoning_effort', value: null }] },
    aliases: {},
    offSemantics: { status: 'explicit-value', path: 'reasoning_effort', value: null },
    recognizedResponseFields: { content: ['choices[].message.content'], tools: ['choices[].message.tool_calls'] },
    limitations: [],
  }));
  return {
    REASONING_PROFILE_IDS: BUILTIN_IDS,
    BUILT_IN_REASONING_PROFILES: profiles,
    getBuiltInProfile: (id: string) => profiles.find((profile) => profile.id === id),
    getBuiltInProfileRef: (id: string) => ({ id, revision: 1, hash: PROFILE_HASH }),
    isPiReasoningLevel: (value: unknown) => ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(value)),
    normalizeCustomProfile: (value: unknown) => value,
    validateRequestPath: (value: unknown) => value,
    canonicalHash: (value: unknown) => value && typeof value === 'object' && 'supportedLevels' in value
      ? JSON.stringify(value)
      : PROFILE_HASH,
    canonicalJson: (value: unknown) => JSON.stringify(value),
    PI_REASONING_LEVELS: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    COMPATIBILITY_NOTICES: [
      { id: 'gpt-oss-tool-replay', assignable: false, summary: 'Tool replay unsupported' },
      { id: 'gemini-chat-completions-tools', assignable: false, summary: 'Tools unsupported' },
      { id: 'gpt-6-astra-tools', assignable: false, summary: 'Tools unsupported' },
      { id: 'responses-required', assignable: false, summary: 'Responses is not assignable' },
    ],
  };
});

async function createApp(envOverrides: Partial<Env> = {}) {
  const { default: routes } = await import('../../routes/admin/reasoning');
  const kv = createMockKV();
  const env = { KV: kv as unknown as KVNamespace, ENTERPRISE_MODE: 'active', CLOUDFLARE_API_TOKEN: 'management-secret', ...envOverrides } as Env;
  kv._set(SETUP_KEYS.DYNAMIC_ROUTES, ['codeflare-mesh']);
  kv._set('setup:reasoning_configuration', {
    schemaVersion: 1,
    customProfileRevisions: [],
    routeAssignments: {
      'codeflare-mesh': {
        activeProfile: { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: PROFILE_HASH },
        routeVersion: 'route-v1',
        legs: [{
          nodeId: 'mesh',
          provider: 'custom-codeflare-inference-mesh',
          declaredModel: 'codeflare-mesh',
          customProviderBackend: 'ornith-ai/Ornith-1.5-9B-GGUF',
          profileRef: { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: PROFILE_HASH },
          evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' },
        }],
      },
    },
  });
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => { c.env = env; return next(); });
  app.route('/admin/reasoning', routes);
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json(error.toJSON(), error.statusCode as ContentfulStatusCode);
    return c.json({ error: 'Unexpected test error' }, 500);
  });
  return { app, kv };
}

function discoveryBody(overrides: Record<string, unknown> = {}) {
  return {
    route: 'codeflare-mesh',
    profileRef: { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: PROFILE_HASH },
    maxCompletionTokens: 32,
    ...overrides,
  };
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function mockSuccessfulProvider() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if ((init?.method ?? 'GET') === 'GET') {
      if (String(input).endsWith('/routes')) {
        return Response.json({ data: { routes: [{ id: 'route-id', name: 'codeflare-mesh' }] } });
      }
      return Response.json({
        success: true,
        result: {
          version: {
            version_id: 'route-v1',
            active: 'true',
            data: JSON.stringify([
              { id: 'start', type: 'start', outputs: { next: { elementId: 'split' } } },
              { id: 'split', type: 'conditional', outputs: { true: { elementId: 'mesh' }, false: { elementId: 'glm' } } },
              { id: 'mesh', type: 'model', properties: { provider: 'custom-codeflare-inference-mesh', model: 'codeflare-mesh' }, outputs: { success: { elementId: 'end' }, fallback: { elementId: 'glm' } } },
              { id: 'glm', type: 'model', properties: { provider: 'workers-ai', model: '@cf/zai-org/glm-5.3' }, outputs: { success: { elementId: 'END' } } },
            ]),
          },
        },
      });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    if (!body.tools) return sse([{ choices: [{ delta: { content: 'generated-answer' }, finish_reason: 'stop' }] }, '[DONE]']);
    if (!body.messages.some((message: { role?: string }) => message.role === 'tool')) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'private-call', type: 'function', function: { name: 'codeflare_profile_canary', arguments: '{"value":"ok"}' } }] }, finish_reason: 'tool_calls' }] }, '[DONE]']);
    }
    return sse([{ choices: [{ delta: { content: 'generated-final' }, finish_reason: 'stop' }] }, '[DONE]']);
  });
}

describe('REQ-ENTERPRISE-033 Administration reasoning API', () => {
  beforeEach(() => {
    vi.useRealTimers();
    role = 'admin';
    authReject = false;
    gatewayConfig = {
      gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/gateway',
      token: 'gateway-secret',
    };
    vi.restoreAllMocks();
  });

  it('exposes exactly catalog, route inventory, and one-target discovery', async () => {
    const { app } = await createApp();
    mockSuccessfulProvider();
    expect((await app.request('/admin/reasoning/catalog')).status).toBe(200);
    expect((await app.request('/admin/reasoning/routes/codeflare-mesh/inventory')).status).toBe(200);
    expect((await app.request('/admin/reasoning/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(discoveryBody()),
    })).status).toBe(200);
    expect((await app.request('/admin/reasoning/profiles', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/admin/reasoning/routes', { method: 'POST' })).status).toBe(404);
  });

  it('returns exact authentication and authorization statuses on every endpoint', async () => {
    const { app } = await createApp();
    authReject = true;
    expect((await app.request('/admin/reasoning/catalog')).status).toBe(401);
    authReject = false;
    role = 'user';
    expect(await (await app.request('/admin/reasoning/catalog')).json()).toEqual({ error: 'Access denied', code: 'FORBIDDEN' });
    expect((await app.request('/admin/reasoning/routes/codeflare-mesh/inventory')).status).toBe(403);
    expect((await app.request('/admin/reasoning/discover', { method: 'POST' })).status).toBe(403);
  });

  it('accepts documented data.routes and returns the exact sanitized catalog schema', async () => {
    const { app } = await createApp({ AIG_TOKEN: 'deployment-secret-must-not-leak' });
    mockSuccessfulProvider();
    const response = await app.request('/admin/reasoning/catalog');
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(Object.keys(body).sort()).toEqual(['notices', 'profiles', 'routeCatalogStatus', 'routes', 'schemaVersion', 'usage']);
    expect(body.schemaVersion).toBe(1);
    expect(body.profiles.map((profile: any) => profile.id)).toEqual(BUILTIN_IDS);
    expect(body.profiles).toHaveLength(6);
    expect(body.notices).toHaveLength(4);
    expect(body.notices.every((notice: any) => notice.assignable === false)).toBe(true);
    expect(body.routes).toEqual(['codeflare-mesh']);
    expect(body.routeCatalogStatus).toBe('ready');
    expect(body.usage).toEqual([{
      profileRef: { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: PROFILE_HASH },
      routes: ['codeflare-mesh'],
    }]);
    expect(text).not.toContain('deployment-secret-must-not-leak');
    expect(text).not.toContain('gateway-secret');
    expect(text).not.toContain('management-secret');
  });

  it('reuses the saved gateway credential and accepts the compatible result.routes envelope', async () => {
    const { app } = await createApp();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      success: true,
      result: { routes: [{ id: 'route-id', name: 'codeflare-mesh' }] },
    }));

    const response = await app.request('/admin/reasoning/catalog');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ routeCatalogStatus: 'ready', routes: ['codeflare-mesh'] });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringMatching(/\/routes$/),
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer gateway-secret' }) }),
    );
  });

  it('returns a sanitized unavailable route-catalog status without hiding the profile catalog', async () => {
    const { app } = await createApp();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ errors: [{ message: 'private management error' }] }, { status: 403 }));
    const response = await app.request('/admin/reasoning/catalog');
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body.routes).toEqual([]);
    expect(body.routeCatalogStatus).toBe('unavailable');
    expect(body.profiles).toHaveLength(6);
    expect(text).not.toContain('private management error');
  });

  it('prefers one compatible superset protocol over its matching off-only subset', async () => {
    const { selectUnambiguousCandidateMatch } = await import('../../routes/admin/reasoning');
    const full = {
      profile: {
        supportedLevels: ['off', 'low'],
        removePaths: ['reasoning_effort'],
        levels: { off: [{ path: 'reasoning_effort', value: 'none' }], low: [{ path: 'reasoning_effort', value: 'low' }] },
      },
      report: { assignable: true },
    };
    const offOnly = {
      profile: {
        supportedLevels: ['off'],
        removePaths: ['reasoning_effort'],
        levels: { off: [{ path: 'reasoning_effort', value: 'none' }] },
      },
      report: { assignable: true },
    };

    expect(selectUnambiguousCandidateMatch([offOnly, full])).toBe(full);
  });

  it('keeps divergent compatible protocols ambiguous', async () => {
    const { selectUnambiguousCandidateMatch } = await import('../../routes/admin/reasoning');
    const first = { profile: { supportedLevels: ['off'], removePaths: [], levels: { off: [{ path: 'reasoning_effort', value: 'none' }] } }, report: { assignable: true } };
    const second = { profile: { supportedLevels: ['off'], removePaths: [], levels: { off: [{ path: 'thinking', value: false }] } }, report: { assignable: true } };

    expect(selectUnambiguousCandidateMatch([first, second])).toBeNull();
  });

  it('does not let a superset dominate when its shared mapping differs', async () => {
    const { selectUnambiguousCandidateMatch } = await import('../../routes/admin/reasoning');
    const full = { profile: { supportedLevels: ['off', 'low'], removePaths: [], levels: { off: [{ path: 'thinking', value: false }], low: [{ path: 'thinking', value: true }] } }, report: { assignable: true } };
    const offOnly = { profile: { supportedLevels: ['off'], removePaths: [], levels: { off: [{ path: 'reasoning_effort', value: 'none' }] } }, report: { assignable: true } };

    expect(selectUnambiguousCandidateMatch([offOnly, full])).toBeNull();
  });

  it('REQ-ENTERPRISE-034 AC5: returns an ambiguous non-activating result when compatible candidate mappings diverge', async () => {
    const { app, kv } = await createApp();
    const profilesModule = await import('../../lib/reasoning-profiles');
    const candidate = profilesModule.BUILT_IN_REASONING_PROFILES[1] as any;
    const originalLevels = candidate.levels;
    candidate.levels = { off: [{ path: 'thinking', value: false }] };
    mockSuccessfulProvider();
    vi.mocked(kv.put).mockClear();

    try {
      const response = await app.request('/admin/reasoning/discover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route: 'codeflare-mesh', maxCompletionTokens: 32 }),
      });
      const body = await response.json() as any;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        route: 'codeflare-mesh',
        classification: 'Inconclusive',
        assignable: false,
        warnings: ['ambiguous_profile_mapping'],
      });
      expect(body).not.toHaveProperty('profileDraft');
      expect(vi.mocked(kv.put).mock.calls.some(([key]) => key === SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
    } finally {
      candidate.levels = originalLevels;
    }
  });

  it('discovers a route-only matching protocol and returns a non-activating custom profile draft', async () => {
    const { app, kv } = await createApp();
    mockSuccessfulProvider();
    vi.mocked(kv.put).mockClear();

    const response = await app.request('/admin/reasoning/discover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ route: 'codeflare-mesh', maxCompletionTokens: 32 }),
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      route: 'codeflare-mesh',
      classification: 'Verified',
      assignable: true,
      matchedCandidateProfileId: BUILTIN_IDS[0],
      profileDraft: {
        schemaVersion: 1,
        enabled: true,
        supportedLevels: ['off'],
        levels: { off: [{ path: 'reasoning_effort', value: null }] },
        originallyCreatedAgainst: { route: 'codeflare-mesh' },
      },
    });
    expect(body.profileDraft).not.toHaveProperty('id');
    expect(body.profileDraft).not.toHaveProperty('name');
    expect(body.profileDraft).toMatchObject({
      classification: 'Compatible, unverified',
      toolCompatibility: { status: 'unverified', levels: [] },
      validatedTransports: [],
    });
    const actualProfiles = await vi.importActual<typeof import('../../lib/reasoning-profiles')>('../../lib/reasoning-profiles');
    const normalized = actualProfiles.normalizeCustomProfile({
      ...body.profileDraft,
      id: 'custom-generated',
      name: 'Generated profile',
      revision: 1,
    });
    expect(normalized).toMatchObject({
      classification: 'Compatible, unverified',
      toolCompatibility: { status: 'unverified', levels: [] },
      validatedTransports: [],
    });
    expect(vi.mocked(kv.put).mock.calls.some(([key]) => key === SETUP_KEYS.REASONING_CONFIGURATION)).toBe(false);
  });

  it('returns exact active-version leg/path summaries and only administrator-owned custom-provider identity', async () => {
    const { app } = await createApp();
    const fetcher = mockSuccessfulProvider();
    const response = await app.request('/admin/reasoning/routes/codeflare-mesh/inventory');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      route: 'codeflare-mesh',
      routeVersion: 'route-v1',
      legs: [
        {
          nodeId: 'mesh',
          provider: 'custom-codeflare-inference-mesh',
          declaredModel: 'codeflare-mesh',
          customProviderBackend: 'ornith-ai/Ornith-1.5-9B-GGUF',
          provenance: 'administrator-declared',
          profileRef: { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: PROFILE_HASH },
          evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' },
        },
        { nodeId: 'glm', provider: 'workers-ai', declaredModel: '@cf/zai-org/glm-5.3' },
      ],
      paths: [
        { modelNodeId: 'mesh', branches: ['true'] },
        { modelNodeId: 'glm', branches: ['true', 'fallback'] },
        { modelNodeId: 'glm', branches: ['false'] },
      ],
      commonLevels: [],
      warnings: ['missing_leg_evidence'],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/\/routes$/);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('/routes/route-id');
  });

  it('derives and returns common levels from current byte-identical per-leg evidence', async () => {
    const { app, kv } = await createApp();
    const profileRef = { id: 'codeflare-inference-mesh-binary-thinking', revision: 1, hash: PROFILE_HASH };
    kv._set(SETUP_KEYS.REASONING_CONFIGURATION, {
      schemaVersion: 1,
      customProfileRevisions: [],
      routeAssignments: {
        'codeflare-mesh': {
          activeProfile: profileRef,
          routeVersion: 'route-v1',
          legs: [
            { nodeId: 'mesh', provider: 'custom-codeflare-inference-mesh', declaredModel: 'codeflare-mesh', customProviderBackend: 'ornith', profileRef, evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' } },
            { nodeId: 'glm', provider: 'workers-ai', declaredModel: '@cf/zai-org/glm-5.3', profileRef, evidence: { current: true, toolReplay: true, ingress: 'ai-gateway-chat-completions' } },
          ],
        },
      },
    });
    mockSuccessfulProvider();
    const body = await (await app.request('/admin/reasoning/routes/codeflare-mesh/inventory')).json() as any;
    expect(body.commonLevels).toEqual(['off']);
    expect(body.commonMapping).toEqual({
      levels: { off: { removePaths: [], writes: [{ path: 'reasoning_effort', value: null }] } },
      digest: PROFILE_HASH,
    });
    expect(body.warnings).toEqual([]);
  });

  it('sanitizes management API failures and rejects unknown routes with exact schemas', async () => {
    const { app } = await createApp();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ errors: [{ message: 'credential and graph secret' }] }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ data: { routes: [] } }));
    const failed = await app.request('/admin/reasoning/routes/codeflare-mesh/inventory');
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'Dynamic route inventory unavailable', code: 'inventory_unavailable' });

    const missing = await app.request('/admin/reasoning/routes/not-configured/inventory');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Dynamic route not found', code: 'not_found' });
  });

  it.each([
    ['empty', () => new Response(null, { status: 200 })],
    ['malformed', () => new Response('{"data":', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['oversized', () => new Response('private-management-payload'.repeat(50_000), { status: 200 })],
  ])('REQ-ENTERPRISE-033: keeps the catalog available after an %s management response', async (_case, response) => {
    const { app } = await createApp();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response());

    const result = await app.request('/admin/reasoning/catalog');
    const text = await result.text();
    const body = JSON.parse(text);
    expect(result.status).toBe(200);
    expect(body).toMatchObject({ routeCatalogStatus: 'unavailable', routes: [], schemaVersion: 1 });
    expect(body.profiles).toHaveLength(6);
    expect(text).not.toContain('private-management-payload');
  });

  it('REQ-ENTERPRISE-033: rejects a malformed active route version with the sanitized inventory contract', async () => {
    const { app } = await createApp();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: { routes: [{ id: 'route-id', name: 'codeflare-mesh' }] } }))
      .mockResolvedValueOnce(Response.json({ result: { version: { version_id: 'route-v1', active: false, data: [{ private: 'graph-secret' }] } } }));

    const result = await app.request('/admin/reasoning/routes/codeflare-mesh/inventory');
    const text = await result.text();
    expect(result.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ error: 'Dynamic route inventory unavailable', code: 'inventory_unavailable' });
    expect(text).not.toContain('graph-secret');
  });

  it('REQ-ENTERPRISE-033: returns sanitized discovery evidence for an upstream provider failure', async () => {
    const { app } = await createApp();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: { routes: [{ id: 'route-id', name: 'codeflare-mesh' }] } }))
      .mockResolvedValueOnce(Response.json({ errors: [{ code: 'provider_unavailable', message: 'private-provider-detail' }] }, { status: 503 }));

    const result = await app.request('/admin/reasoning/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(discoveryBody()),
    });
    const text = await result.text();
    const body = JSON.parse(text);
    expect(result.status).toBe(200);
    expect(body).toMatchObject({
      classification: 'Inconclusive',
      assignable: false,
      accounting: { logicalProbes: 1, httpAttempts: 1 },
      distinctMappings: [{ reasoningProbe: { status: 503, code: 'provider_unavailable' }, toolLifecycle: { stage: 'not-run' } }],
    });
    expect(text).not.toContain('private-provider-detail');
    expect(text).not.toContain('gateway-secret');
  });

  it('aborts bounded management requests and maps timeouts through sanitized existing responses', async () => {
    vi.useFakeTimers();
    const { app } = await createApp();
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private management timeout')), { once: true });
    }));

    const inventoryPending = app.request('/admin/reasoning/routes/codeflare-mesh/inventory');
    await vi.advanceTimersByTimeAsync(10_000);
    const inventory = await inventoryPending;
    expect(inventory.status).toBe(502);
    expect(await inventory.json()).toEqual({ error: 'Dynamic route inventory unavailable', code: 'inventory_unavailable' });

    const discoveryPending = app.request('/admin/reasoning/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(discoveryBody()),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const discovery = await discoveryPending;
    expect(discovery.status).toBe(502);
    expect(await discovery.json()).toEqual({ error: 'Reasoning discovery unavailable', code: 'discovery_unavailable' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('validates a single target and exact profile revision before any provider I/O', async () => {
    const { app } = await createApp();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const malformed = await app.request('/admin/reasoning/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(discoveryBody({ selector: 'force-fallback', maxCompletionTokens: 16_385 })),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'Invalid discovery request', code: 'validation_error' });
    expect(fetcher).not.toHaveBeenCalled();

    const missing = await app.request('/admin/reasoning/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(discoveryBody({ profileRef: { id: 'missing', revision: 1, hash: 'b'.repeat(64) } })),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Reasoning profile revision not found', code: 'not_found' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns sanitized non-activating discovery evidence and never writes profile, assignment, or evidence state', async () => {
    const { app, kv } = await createApp();
    const fetcher = mockSuccessfulProvider();
    vi.mocked(kv.put).mockClear();
    const response = await app.request('/admin/reasoning/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(discoveryBody()),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      schemaVersion: 1,
      canaryVersion: 'pi-openai-completions-0.84.4-canary-v1',
      profileId: 'codeflare-inference-mesh-binary-thinking',
      route: 'dynamic/codeflare-mesh',
      requestedCompletionCeiling: 32,
      classification: 'Verified',
      accounting: { logicalProbes: 2, httpAttempts: 3 },
      normalizedDraft: { schemaVersion: 1, profileId: 'codeflare-inference-mesh-binary-thinking', classification: 'Verified' },
    });
    for (const forbidden of ['gateway-secret', 'generated-answer', 'generated-final', 'private-call']) expect(text).not.toContain(forbidden);
    expect(body).not.toHaveProperty('activated');
    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/\/routes$/);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(kv.put).not.toHaveBeenCalledWith('setup:reasoning_configuration', expect.anything());
    expect(kv.put).not.toHaveBeenCalledWith(expect.stringContaining('evidence'), expect.anything());
  });

  it('rate limits discovery before provider I/O with the existing exact 429 error contract', async () => {
    const { app } = await createApp();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.request('/admin/reasoning/discover', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(response.status).toBe(400);
    }
    const limited = await app.request('/admin/reasoning/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Please slow down and try again.', code: 'RATE_LIMIT_ERROR' });
    expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns the exact unavailable status when Worker-side gateway credentials cannot be resolved', async () => {
    gatewayConfig = {};
    const { app } = await createApp();
    const discovery = await app.request('/admin/reasoning/discover', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(discoveryBody()),
    });
    expect(discovery.status).toBe(503);
    expect(await discovery.json()).toEqual({ error: 'AI Gateway credentials unavailable', code: 'gateway_unavailable' });

    const inventory = await app.request('/admin/reasoning/routes/codeflare-mesh/inventory');
    expect(inventory.status).toBe(503);
    expect(await inventory.json()).toEqual({ error: 'AI Gateway credentials unavailable', code: 'gateway_unavailable' });
  });
});
