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
  requireAdmin: async (_c: any, next: any) => next(),
}));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: 'manager@example.test', role: 'admin', authenticated: true }, bucketName: 'manager' }),
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
    const controls = await request('/access', 'POST', { revision: 0, managers: registration.managers,
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
      interfaceVersion: 1, approved: false, provenance: expect.objectContaining({ compilerCommit: 'c'.repeat(40) }) })] });
  }));

  it('REQ-OPERATOR-048: acquires only the strict generated Dispatcher artifact and binds its source to provenance', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ profile: 'dispatcher' });
    vi.stubGlobal('fetch', fixture.fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', { ...registration, profile: 'dispatcher' });
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({ items: [expect.objectContaining({
      sourceCommit: fixture.sourceCommit, bundleDigest: fixture.bundleDigest,
    })] });
  }));

  it.each([
    { ref: 'refs/heads/main', accepted: true },
    { ref: 'refs/heads/develop', accepted: false },
    { ref: '.github/workflows/other.yml@refs/heads/main', accepted: false },
  ])('REQ-OPERATOR-044: binds Dispatcher provenance $ref to the approved workflow', async ({ ref, accepted }) => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ profile: 'dispatcher', provenanceWorkflowRef: ref });
    vi.stubGlobal('fetch', fixture.fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', { ...registration, profile: 'dispatcher' });
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(accepted ? 200 : 503);
    const detail = await request(`/operators/${operator.operatorId}`);
    expect(detail.status).toBe(200);
    const state = await detail.json() as { releases: Array<{ bundleDigest: string; approved: boolean }> };
    expect(state.releases).toEqual(accepted ? [expect.objectContaining({
      bundleDigest: fixture.bundleDigest, approved: false,
    })] : []);
  }));

  it('REQ-OPERATOR-048: rejects a generated Dispatcher artifact whose embedded source differs from provenance', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ profile: 'dispatcher', dispatcherSourceMismatch: true });
    vi.stubGlobal('fetch', fixture.fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', { ...registration, profile: 'dispatcher' });
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(503);
    const detail = await request(`/operators/${operator.operatorId}`);
    await expect(detail.json()).resolves.toMatchObject({ releases: [] });
  }));

  it.each(['provenance-repository', 'provenance-compiler', 'mutable-release', 'failed-run', 'build-bytes', 'unsafe-redirect'] as const)(
    'rejects %s without admitting release bytes or disclosing the PAT', async fault => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ fault });
    vi.stubGlobal('fetch', fixture.fetcher);
    const controls = await request('/access', 'POST', { revision: 0, managers: registration.managers,
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

  it.each(['productionresultssa1.blob.core.windows.net', 'productionresultssa3.blob.core.windows.net',
    'productionresultssa8.blob.core.windows.net', 'productionresultssa16.blob.core.windows.net'] as const)(
    'REQ-OPERATOR-044: release CDN transport via %s succeeds without forwarding acquisition credentials', async artifactCdnHost => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ useCdn: true, artifactCdnHost });
    vi.stubGlobal('fetch', fixture.fetcher);
    const controls = await request('/access', 'POST', { revision: 0, managers: registration.managers,
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
    const cdnRequests = fixture.requests.filter(outbound => outbound.origin === 'https://release-assets.githubusercontent.com'
      || outbound.origin === `https://${artifactCdnHost}`);
    expect(cdnRequests.some(outbound => outbound.origin === 'https://release-assets.githubusercontent.com')).toBe(true);
    expect(cdnRequests.some(outbound => outbound.origin === `https://${artifactCdnHost}`)).toBe(true);
    expect(cdnRequests.every(outbound => outbound.authorization === null)).toBe(true);
    expect(fixture.requests.some(outbound => outbound.origin === 'https://api.github.com'
      && outbound.authorization === `Bearer ${registration.githubPat}`)).toBe(true);
    expect(JSON.stringify(discovered)).not.toContain(registration.githubPat);
  }));
});
