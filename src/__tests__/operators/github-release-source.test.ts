/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { OperatorRegistry } from '../../operators/registry';
import { createMockKV } from '../helpers/mock-kv';
import { createOperatorGitHubFixture } from '../helpers/operator-github-fixture';

vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => { c.set('user', { email: 'manager@example.test', role: 'admin', authenticated: true }); return next(); },
  authenticateRequest: async () => ({ user: { email: 'manager@example.test', role: 'admin', authenticated: true }, bucketName: 'manager' }),
  requireAdmin: async (_c: any, next: any) => next(),
}));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireOperatorHumanContext: async () => ({ human: { subject: 'manager', email: 'manager@example.test', issuer: 'https://access.example.test',
    audiences: ['audience'], issuedAt: 1, expiresAt: 2_000_000_000 }, accessJwt: 'test-access-jwt' }),
}));

import worker from '../../index';

afterEach(() => vi.unstubAllGlobals());

const policy = { capabilities: [], resourceProfileId: null };
const registration = { repositoryUrl: 'https://github.com/acme/review-operator', githubPat: 'acquisition-only-pat', profile: 'conductor', realm: 'internal',
  managers: { users: ['manager@example.test'], groups: [] }, invokers: { users: ['manager@example.test'], groups: [] }, policy };

async function withManagementApi(test: (request: (path: string, method?: string, body?: unknown) => Promise<Response>) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const request = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(
      `https://enterprise.example.test/api/operator-management${path}`, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', 'cf-access-authenticated-user-email': 'manager@example.test' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { KV: createMockKV(), ENCRYPTION_KEY: btoa('k'.repeat(32)), ENTERPRISE_MODE: 'active', OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
    await test(request);
  });
}

describe('REQ-OPERATOR-044: GitHub immutable package acquisition', () => {
  it('stores a canonical repository identity without returning its acquisition-only PAT, then discovers a matching immutable release without enabling it', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture();
    vi.stubGlobal('fetch', fixture.fetcher);
    const controls = await request('/access', 'POST', { revision: 0, managers: { users: [], groups: [] },
      ceiling: { capabilities: [], resourceProfileIds: [] } });
    expect(controls.status).toBe(200);
    const registered = await request('/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const detail = await request(`/operators/${operator.operatorId}`);
    expect(detail.status).toBe(200);
    expect(await detail.text()).not.toContain(registration.githubPat);

    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ items: [expect.objectContaining({ operatorId: operator.operatorId, githubReleaseId: 81,
      sourceCommit: 'a'.repeat(40), manifestDigest: expect.stringMatching(/^[0-9a-f]{64}$/), bundleDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      interfaceVersion: 1, approved: false })] });
  }));

  it.each(['provenance-repository', 'mutable-release', 'failed-run', 'build-bytes', 'unsafe-redirect'] as const)(
    'rejects %s without admitting release bytes or disclosing the PAT', async fault => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ fault });
    vi.stubGlobal('fetch', fixture.fetcher);
    const controls = await request('/access', 'POST', { revision: 0, managers: { users: [], groups: [] },
      ceiling: { capabilities: [], resourceProfileIds: [] } });
    expect(controls.status).toBe(200);
    const registered = await request('/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(503);
    expect(await refreshed.text()).not.toContain(registration.githubPat);
    const detail = await request(`/operators/${operator.operatorId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ releases: [], installations: [] });
    expect(fixture.requests.every(outbound => outbound.origin === 'https://api.github.com')).toBe(true);
  }));

  it('REQ-OPERATOR-044: release CDN transport succeeds without forwarding acquisition credentials', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ useCdn: true });
    vi.stubGlobal('fetch', fixture.fetcher);
    const controls = await request('/access', 'POST', { revision: 0, managers: { users: [], groups: [] },
      ceiling: { capabilities: [], resourceProfileIds: [] } });
    expect(controls.status).toBe(200);
    const registered = await request('/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    const discovered = await refreshed.json() as { items: unknown[] };
    expect(discovered.items).toHaveLength(1);
    // The outbound origin/header contract is intentional security evidence, not private-call counting.
    const cdnRequests = fixture.requests.filter(outbound => outbound.origin === 'https://release-assets.githubusercontent.com');
    expect(cdnRequests.length).toBeGreaterThan(0);
    expect(cdnRequests.every(outbound => outbound.authorization === null)).toBe(true);
    expect(fixture.requests.some(outbound => outbound.origin === 'https://api.github.com'
      && outbound.authorization === `Bearer ${registration.githubPat}`)).toBe(true);
    expect(JSON.stringify(discovered)).not.toContain(registration.githubPat);
  }));
});
