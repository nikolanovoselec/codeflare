import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { AppError } from '../../lib/error-types';
import routes from '../../routes/operator-management';
import { createMockKV } from '../helpers/mock-kv';

const state = vi.hoisted(() => ({ email: 'invoker@example.test', current: true, owned: true,
  regime: 'ready', revokeOnRead: false, settings: {} as Record<string, unknown> | null,
  reads: [] as Array<{ url: string; method: string }>,
  routes: { piDefaultSource: 'pi-native', allowPersonalPiProviders: true, routeCatalog: ['installed-route', 'account-default'],
    defaultRoute: 'account-default', defaultReasoning: 'high', routeContextWindows: {},
    routeReasoningLevels: { 'installed-route': ['off', 'low', 'high'], 'account-default': ['high'] }, modelDisplayNames: {} },
}));
vi.mock('../../middleware/auth', () => ({ authMiddleware: async (c: any, next: () => Promise<void>) => {
  c.set('user', { email: state.email, role: 'admin' }); c.set('bucketName', 'invoker-bucket'); await next();
} }));
vi.mock('../../lib/access', async original => ({
  ...await original<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: state.email, role: 'admin' }, bucketName: 'invoker-bucket' }),
  requireOperatorHumanContext: async () => {
    if (!state.current) throw new AppError('FORBIDDEN', 403, 'Expired');
    return { human: { subject: state.email, email: state.email, issuer: 'https://access.example.test', audiences: ['aud'],
      groups: [], issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: 'PRIVATE_JWT' };
  },
  loadEnterpriseRouteConfig: async () => structuredClone(state.routes),
}));
vi.mock('../../lib/r2-regime-state', () => ({ getRegimeState: async () => ({ status: state.regime, regime: 'plain', generation: 1 }) }));
vi.mock('../../lib/r2-client', async original => ({
  ...await original<typeof import('../../lib/r2-client')>(),
  createR2Client: () => ({ fetch: async (request: Request) => {
    state.reads.push({ url: request.url, method: request.method });
    if (state.revokeOnRead) state.current = false;
    return state.settings === null ? new Response(null, { status: 404 }) : Response.json(state.settings);
  } }),
}));

function fixture() {
  const inference = { allowedSources: ['managed', 'pi-native'], routeIds: ['installed-route'], defaultRouteId: 'installed-route' as string | null,
    reasoningLevels: ['off', 'low', 'high'], defaultReasoningLevel: 'low' as string | null, inheritUserDefaults: false };
  const policy = { capabilities: ['inference'], resourceProfileId: null, inference };
  const operator = { id: 'operator-1', profile: 'dispatcher', revision: 3,
    managers: { users: ['creator@example.test'], groups: [] }, invokers: { users: [state.email], groups: [] }, policy };
  const installation = { id: 'installation-1', operatorId: operator.id, revision: 7, enabled: true,
    policy: structuredClone(policy), piReasoningOverride: 'high' };
  const controls = { revision: 1, managers: { users: [], groups: [] }, ceiling: { capabilities: ['inference'], resourceProfileIds: [] } };
  const registry = {
    getManagementControls: async () => controls,
    getManagementInstallation: async (id: string) => id === installation.id ? { ok: true, value: installation } : { ok: false, reason: 'not-found' },
    getManagementOperator: async () => ({ ok: true, value: operator }),
    resolveManagementConfiguration: async () => ({ ok: true, value: { operator, installation, controlsRevision: 1,
      release: { id: 'release-1', bundleDigest: 'a'.repeat(64) } } }),
  };
  const env = { ENTERPRISE_MODE: 'active', KV: createMockKV(), R2_ENDPOINT: 'https://r2.example.test',
    OPERATOR_REGISTRY: { getByName: () => registry }, CONTAINER: { idFromName: (name: string) => name,
      get: () => ({ claimBucketOwner: async (email: string, allowInitialClaim: boolean) =>
        state.owned && email === state.email && !allowInitialClaim ? 'owned' : 'conflict' }) },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => error instanceof AppError ? c.json(error.toJSON(), error.statusCode as never) : c.json({ error: 'Internal error' }, 500));
  app.route('/api/operator-management', routes);
  const request = (query = '?installationId=installation-1') => app.request(`https://enterprise.example.test/api/operator-management/options${query}`, {}, env);
  return { request, installation, operator, env };
}
beforeEach(() => {
  state.email = 'invoker@example.test'; state.current = true; state.owned = true; state.regime = 'ready'; state.revokeOnRead = false;
  state.routes.piDefaultSource = 'pi-native'; state.routes.allowPersonalPiProviders = true;
  state.settings = { defaultProvider: 'owner-provider', defaultModel: 'owner-model', defaultThinkingLevel: 'high',
    modelThinkingLevels: { 'owner-provider/owner-model': 'off' }, unrelated: 'PRIVATE_SETTINGS' };
  state.reads = [];
});

describe('REQ-OPERATOR-096 AC1/2/3/6: current caller next-manual-run inference options', () => {
  it('projects caller R2 selection, not creator or legacy override, through a GET-only settings allowlist', async () => {
    const f = fixture(); const response = await f.request();
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    const value = await response.json();
    expect(value.inference).toEqual({ source: 'pi-native', status: 'selected', provider: 'owner-provider', model: 'owner-model', reasoningLevel: 'off' });
    // Intentional security contract: the only permitted storage I/O is the caller's settings GET.
    expect([...new Set(state.reads.map(read => `${read.method} ${new URL(read.url).pathname}`))])
      .toEqual(['GET /invoker-bucket/.pi/agent/settings.json']);
    for (const secret of ['PRIVATE_SETTINGS', 'PRIVATE_JWT', 'creator@example.test', 'auth.json']) expect(JSON.stringify(value)).not.toContain(secret);
  });
  it.each([
    { settings: { defaultThinkingLevel: 'low' }, reasoningLevel: 'low' },
    { settings: {}, reasoningLevel: null },
  ])('retains saved global or provider-default reasoning without the legacy installation override: $reasoningLevel', async item => {
    state.settings = { defaultProvider: 'owner-provider', defaultModel: 'owner-model', ...item.settings };
    expect((await (await fixture().request()).json()).inference).toMatchObject({ status: 'selected', reasoningLevel: item.reasoningLevel });
  });
  it('returns caller-owned profile metadata without claiming installation eligibility when context is absent', async () => {
    expect((await (await fixture().request('')).json()).inference).toMatchObject({ status: 'profile', source: 'pi-native', model: 'owner-model' });
  });
  it('uses the installation managed pair, not the account default, without reading R2', async () => {
    state.routes.piDefaultSource = 'managed'; const f = fixture();
    expect((await (await f.request()).json()).inference).toEqual({ source: 'managed', status: 'selected',
      provider: 'codeflare-gateway', model: 'installed-route', routeId: 'installed-route', reasoningLevel: 'low' });
    expect(state.reads).toEqual([]);
    f.installation.policy.inference.defaultRouteId = null;
    expect((await (await f.request()).json()).inference).toEqual({ source: 'managed', status: 'unconfigured' });
  });
  it.each([null, 'off'])('keeps managed provider-default and Off distinct: %s', async reasoningLevel => {
    state.routes.piDefaultSource = 'managed'; const f = fixture();
    f.installation.policy.inference.defaultReasoningLevel = reasoningLevel;
    expect((await (await f.request()).json()).inference).toMatchObject({ status: 'selected', source: 'managed', reasoningLevel });
  });
  it('does not substitute the account default for an installation route outside its approvals', async () => {
    state.routes.piDefaultSource = 'managed'; const f = fixture();
    f.installation.policy.inference.defaultRouteId = 'account-default';
    expect((await (await f.request()).json()).inference).toEqual({ source: 'managed', status: 'blocked', reason: 'policy-denied' });
    expect(state.reads).toEqual([]);
  });
  it('does not turn admin management access into invocation authority or read another owner profile', async () => {
    const f = fixture(); f.operator.invokers.users = [];
    expect((await (await f.request()).json()).inference).toEqual({ source: 'pi-native', status: 'blocked', reason: 'invocation-denied' });
    expect(state.reads).toEqual([]);
    expect((await f.request('?installationId=foreign')).status).toBe(404);
  });
  it.each(['disabled', 'native-not-approved', 'reasoning-not-approved'] as const)('truthfully reports %s without fallback', async condition => {
    const f = fixture();
    if (condition === 'disabled') f.installation.enabled = false;
    if (condition === 'native-not-approved') f.operator.policy.inference.allowedSources = ['managed'];
    if (condition === 'reasoning-not-approved') f.operator.policy.inference.reasoningLevels = ['low'];
    expect((await (await f.request()).json()).inference).toMatchObject({ source: 'pi-native', status: 'blocked',
      reason: condition === 'disabled' ? 'installation-disabled' : 'policy-denied' });
  });
  it.each(['missing-settings', 'missing-model'] as const)('reports %s as unconfigured, not a storage or authentication failure', async failure => {
    state.settings = failure === 'missing-settings' ? null : { defaultProvider: 'owner-provider' };
    expect((await (await fixture().request()).json()).inference).toEqual({ source: 'pi-native', status: 'unconfigured' });
  });
  it.each(['malformed-settings', 'owner-conflict', 'migration', 'revoked-during-read'] as const)('fails closed for %s without substituting managed or legacy settings', async failure => {
    const f = fixture();
    if (failure === 'malformed-settings') state.settings = { defaultProvider: 'owner-provider', defaultModel: 'owner-model', defaultThinkingLevel: 'unsupported' };
    if (failure === 'owner-conflict') state.owned = false;
    if (failure === 'migration') state.regime = 'migrating';
    if (failure === 'revoked-during-read') state.revokeOnRead = true;
    expect((await (await f.request()).json()).inference).toEqual({ source: 'pi-native', status: 'unavailable' });
  });
  it.each(['?installationId=bad/id', '?installationId=installation-1&installationId=foreign', '?owner=creator'])('rejects invalid context %s', async query => {
    expect((await fixture().request(query)).status).toBe(400);
    expect(state.reads).toEqual([]);
  });
  it('keeps expired authority and non-Enterprise access denied', async () => {
    const f = fixture(); state.current = false; expect((await f.request()).status).toBe(403);
    state.current = true; f.env.ENTERPRISE_MODE = undefined; expect((await f.request()).status).toBe(404);
  });
});
