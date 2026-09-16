/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Route integration with native durable storage and controlled authentication/distribution boundaries.
 * Tests distinguish enterprise/admin/human denial, safe projections, explicit mutations and conflicts.
 * Signed-token cryptography and real distribution transport have independent primitive suites;
 * this harness does not claim live Access audience or deployment verification.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { env, runInDurableObject } from 'cloudflare:test';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import { AppError, AuthError, ForbiddenError } from '../../lib/error-types';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { createMockKV } from '../helpers/mock-kv';
import { OperatorRegistry } from '../../operators/registry';
import routes from '../../routes/admin/operators';

const state = vi.hoisted(() => ({ role: 'admin', authenticated: true, human: true, claimEmail: 'admin@example.test', discoveryFails: false }));
const policy = { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
  storage: { readPrefixes: [], writePrefixes: [] }, inference: { routeIds: [], defaultRouteId: null,
    reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } };
vi.mock('../../operators/distribution-client', () => ({
  fetchOperatorManifest: async () => {
    if (state.discoveryFails) throw new Error('Fixture discovery unavailable');
    return { schemaVersion: 1, interfaceVersion: 1, id: 'new-operator', name: 'Example', description: 'Fixture',
      coreVersion: '1', intentVersion: '1', inputSchema: {}, requiredCapabilities: [],
      artifact: { path: '/bundle.json', url: 'https://operator.example.test/bundle.json', sha256: 'c'.repeat(64) } };
  },
  fetchOperatorBundle: async () => ({ schemaVersion: 1, interfaceVersion: 1, compatibilityDate: '2026-02-05',
    compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js', modules: { 'index.js': { js: 'export default {}' } } }),
}));
vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    if (!state.authenticated) throw new AuthError();
    c.set('user', { email: 'admin@example.test', role: state.role, authenticated: true });
    return next();
  },
  requireAdmin: async (_c: any, next: any) => {
    if (state.role !== 'admin') throw new ForbiddenError();
    return next();
  },
}));
vi.mock('../../lib/jwt', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/jwt')>(),
  verifyHumanAccessJWT: async () => state.human ? {
    subject: 'human', email: state.claimEmail, issuer: 'https://example.cloudflareaccess.com',
    audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt: Math.floor(Date.now() / 1000) + 60,
  } : null,
}));
beforeEach(() => { state.role = 'admin'; state.authenticated = true; state.human = true; state.claimEmail = 'admin@example.test'; state.discoveryFails = false; });

async function withApi(test: (request: (path: string, method?: string, body?: unknown, enterprise?: boolean) => Promise<Response>, registry: OperatorRegistry) => Promise<void>) {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    await registry.create('operator');
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.AUTH_DOMAIN, 'example.cloudflareaccess.com');
    kv._store.set(SETUP_KEYS.ACCESS_AUD, 'audience');
    const app = new Hono();
    app.onError((error, c) => error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as ContentfulStatusCode)
      : c.json({ error: 'Internal error' }, 500));
    app.route('/api/admin/operators', routes);
    const request = async (path: string, method = 'GET', body?: unknown, enterprise = true) => app.request(`/api/admin/operators${path === '/' ? '' : path}`, {
      method, headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': 'fixture-human-token' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, { KV: kv, ENCRYPTION_KEY: btoa('k'.repeat(32)), ENTERPRISE_MODE: enterprise ? 'active' : 'inactive',
      OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env);
    await test(request, registry);
  });
}

describe('REQ-OPERATOR-002: enterprise human-admin operator routes', () => {
  it.each(['/', '/operator/webhook-key', '/operator/enable', '/operator/policy'])('is unavailable outside enterprise: %s', path => withApi(async request => {
    expect((await request(path, path === '/' ? 'GET' : 'POST', undefined, false)).status).toBe(404);
  }));
  it('rejects unauthenticated users, non-admins and service identities', () => withApi(async request => {
    state.authenticated = false;
    expect((await request('/')).status).toBe(401);
    state.authenticated = true; state.role = 'user';
    expect((await request('/')).status).toBe(403);
    state.role = 'admin'; state.human = false;
    expect((await request('/')).status).toBe(403);
    state.human = true; state.claimEmail = 'another@example.test';
    expect((await request('/')).status).toBe(403);
  }));
  it('lists safe registration projections for a verified human administrator', () => withApi(async request => {
    const response = await request('/');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ operators: [{ operatorId: 'operator', revision: 1, enabled: false, approvedArtifactDigest: null }] });
  }));
  it('returns a generated key only on successful rotation, never on listing or stale retry', () => withApi(async request => {
    const rotated = await request('/operator/webhook-key', 'POST', { expectedRevision: 1 });
    expect(rotated.status).toBe(200);
    const result = await rotated.json() as { key: string };
    expect(result.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await (await request('/')).text()).not.toContain(result.key);
    expect((await request('/operator/webhook-key', 'POST', { expectedRevision: 1 })).status).toBe(409);
  }));
  it('preserves separate approval and enablement, and reports stale revision conflicts', () => withApi(async (request, registry) => {
    expect((await request('/operator/enable', 'POST', { expectedRevision: 1, enabled: true })).status).toBe(409);
    await registry.approve('operator', 'a'.repeat(64), 1);
    expect((await request('/operator/enable', 'POST', { expectedRevision: 2, enabled: true })).status).toBe(200);
    expect((await request('/operator/enable', 'POST', { expectedRevision: 2, enabled: false })).status).toBe(409);
  }));
  it('registers authenticated discovery without implicit approval, rejects collisions and separately approves', () => withApi(async (request, registry) => {
    const body = { endpoint: 'https://operator.example.test/discovery', connectionSecret: 'private-connection', policy };
    const registered = await request('/', 'POST', body);
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ operatorId: 'new-operator', revision: 1, enabled: false, approvedArtifactDigest: null });
    expect(await registry.getApprovedManifest('new-operator')).toBeNull();
    expect(await registry.getDiscoveredManifest('new-operator')).not.toBeNull();
    const discovery = await request('/new-operator/discover', 'POST', {});
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ manifestJson: expect.any(String) });
    expect(await registry.getApprovedManifest('new-operator')).toBeNull();
    expect((await request('/', 'POST', body)).status).toBe(409);
    expect((await request('/new-operator/approve', 'POST', { expectedRevision: 1, artifactDigest: 'd'.repeat(64) })).status).toBe(409);
    const approved = await request('/new-operator/approve', 'POST', { expectedRevision: 1, artifactDigest: 'c'.repeat(64) });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ enabled: false, approvedArtifactDigest: 'c'.repeat(64) });
    expect(await (await request('/')).text()).not.toContain('private-connection');
  }));
  it('does not create registration when discovery fails', () => withApi(async (request, registry) => {
    state.discoveryFails = true;
    const response = await request('/', 'POST', { endpoint: 'https://operator.example.test/discovery', connectionSecret: 'private-connection', policy });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.text()).not.toContain('private-connection');
    expect((await registry.listRegistrations()).map(item => item.operatorId)).toEqual(['operator']);
  }));
  it('replaces endpoint credentials without leaking them or retaining approval', () => withApi(async (request, registry) => {
    await registry.approve('operator', 'a'.repeat(64), 1);
    await registry.setEnabled('operator', true, 2);
    const response = await request('/operator/distribution', 'POST', { expectedRevision: 3,
      endpoint: 'https://operator.example.test/discovery', connectionSecret: 'new-private-secret' });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('new-private-secret');
    expect(JSON.parse(body)).toMatchObject({ revision: 4, enabled: false, approvedArtifactDigest: null });
  }));
  it('updates policy only at the current revision and keeps the registration disabled', () => withApi(async (request, registry) => {
    expect((await request('/operator/policy', 'POST', { expectedRevision: 1, policy })).status).toBe(200);
    expect(await registry.getPolicy('operator')).toBe(JSON.stringify(policy));
    expect((await request('/operator/policy', 'POST', { expectedRevision: 1, policy })).status).toBe(409);
  }));
  it('reads metadata and configured-secret flags without decrypting or contacting discovery', () => withApi(async (request, registry) => {
    await registry.setDistribution('operator', 'https://operator.example.test/discovery', 'private-connection', 1);
    const rotated = await registry.rotateWebhookKey('operator', 2);
    if (!rotated.ok) throw new Error('Expected rotation');
    state.discoveryFails = true;
    const response = await request('/operator');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ registration: { operatorId: 'operator', revision: 3 },
      endpoint: 'https://operator.example.test/discovery', connectionSecretConfigured: true, webhookKeyConfigured: true });
    expect(body).not.toContain('private-connection');
    expect(body).not.toContain(rotated.value.key);
    expect(body).not.toContain(await registry.getEncryptedWebhookKey('operator'));
    expect((await request('/missing')).status).toBe(404);
  }));
  it('rejects malformed revisions and child-supplied owner fields', () => withApi(async request => {
    expect((await request('/operator/webhook-key', 'POST', { expectedRevision: -1 })).status).toBe(400);
    expect((await request('/operator/webhook-key', 'POST', { expectedRevision: 1, owner: 'other' })).status).toBe(400);
  }));
});
