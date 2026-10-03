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
      interfaceVersion: 1, approved: false, tagName: 'v1', publishedAt: '2026-09-21T12:00:00Z',
      provenance: expect.objectContaining({ compilerCommit: 'c'.repeat(40) }) })] });
    const readback = await request(`/operators/${operator.operatorId}`);
    await expect(readback.json()).resolves.toMatchObject({ releases: [expect.objectContaining({
      tagName: 'v1', publishedAt: '2026-09-21T12:00:00Z',
    })] });
  }));

  it('refreshes a fifth immutable release without reacquiring four retained bundles or changing an enabled pin', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ bundlePaddingBytes: 3_400_000, releaseCount: 4 });
    vi.stubGlobal('fetch', fixture.fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', registration);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const first = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(first.status).toBe(200);
    const initial = await (await request(`/operators/${operator.operatorId}`)).json() as {
      operator: { revision: number }; releases: Array<{ id: string; githubReleaseId: number; bundleDigest: string }>;
    };
    expect(initial.releases).toHaveLength(4);
    const installed = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'integration', policy, revision: initial.operator.revision,
    });
    expect(installed.status).toBe(201);
    const installation = await installed.json() as { id: string; revision: number };
    const promoted = await request(`/installations/${installation.id}/promote`, 'POST', {
      releaseId: initial.releases[0]!.id, revision: installation.revision,
    });
    expect(promoted.status).toBe(200);
    const pinned = await promoted.json() as { revision: number };
    expect((await request(`/installations/${installation.id}/enable`, 'POST', { revision: pinned.revision, enabled: true })).status).toBe(200);
    fixture.setReleaseCount(5);
    const before = await (await request(`/operators/${operator.operatorId}`)).json() as { operator: { revision: number } };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: before.operator.revision });
    expect(refreshed.status).toBe(200);
    const after = await (await request(`/operators/${operator.operatorId}`)).json() as {
      releases: Array<{ id: string; githubReleaseId: number; bundleDigest: string; approved: boolean }>;
      installations: Array<{ id: string; releaseId: string; enabled: boolean }>;
    };
    expect(after.releases).toHaveLength(5);
    expect(after.releases.filter(release => initial.releases.some(old => old.id === release.id)))
      .toMatchObject(initial.releases.map(old => expect.objectContaining({ id: old.id, bundleDigest: old.bundleDigest })));
    expect(after.releases).toEqual(expect.arrayContaining([expect.objectContaining({ githubReleaseId: 85, approved: false })]));
    expect(after.installations).toEqual(expect.arrayContaining([expect.objectContaining({
      id: installation.id, releaseId: initial.releases[0]!.id, enabled: true,
    })]));
  }));

  it.each(['operator-bundle.json', 'operator-provenance.json'] as const)(
    'rejects a changed retained %s without admitting a new release or changing an enabled pin', async assetName => withManagementApi(async request => {
      const fixture = await createOperatorGitHubFixture({ releaseCount: 4 });
      vi.stubGlobal('fetch', fixture.fetcher);
      expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
        ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
      const created = await request('/operators', 'POST', registration);
      expect(created.status).toBe(201);
      const operator = await created.json() as { operatorId: string; revision: number };
      expect((await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision })).status).toBe(200);
      const discovered = await (await request(`/operators/${operator.operatorId}`)).json() as {
        operator: { revision: number }; releases: Array<{ id: string }>;
      };
      const installed = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
        name: 'integration', policy, revision: discovered.operator.revision,
      });
      expect(installed.status).toBe(201);
      const installation = await installed.json() as { id: string; revision: number };
      const promoted = await request(`/installations/${installation.id}/promote`, 'POST', {
        releaseId: discovered.releases[0]!.id, revision: installation.revision,
      });
      expect(promoted.status).toBe(200);
      const pinned = await promoted.json() as { revision: number };
      expect((await request(`/installations/${installation.id}/enable`, 'POST', { revision: pinned.revision, enabled: true })).status).toBe(200);
      const before = await (await request(`/operators/${operator.operatorId}`)).json() as {
        operator: { revision: number }; releases: unknown[]; installations: unknown[];
      };
      fixture.setReleaseCount(5);
      fixture.changeRetainedAsset(assetName);
      expect((await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: before.operator.revision })).status).toBe(503);
      expect(await (await request(`/operators/${operator.operatorId}`)).json()).toEqual(before);
    }));

  it('rejects a moved retained tag rather than reusing its formerly verified source', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture();
    vi.stubGlobal('fetch', fixture.fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const created = await request('/operators', 'POST', registration);
    expect(created.status).toBe(201);
    const operator = await created.json() as { operatorId: string; revision: number };
    expect((await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision })).status).toBe(200);
    const before = await (await request(`/operators/${operator.operatorId}`)).json() as { operator: { revision: number } };
    fixture.moveRetainedTag();
    expect((await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: before.operator.revision })).status).toBe(503);
    expect(await (await request(`/operators/${operator.operatorId}`)).json()).toEqual(before);
  }));

  it('reacquires a release under a changed trusted source revision without inheriting approval', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture();
    vi.stubGlobal('fetch', fixture.fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const created = await request('/operators', 'POST', registration);
    expect(created.status).toBe(201);
    const operator = await created.json() as { operatorId: string; revision: number };
    expect((await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision })).status).toBe(200);
    const first = await (await request(`/operators/${operator.operatorId}`)).json() as {
      operator: { revision: number }; releases: Array<{ id: string; approved: boolean }>;
    };
    const installed = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'integration', policy, revision: first.operator.revision,
    });
    expect(installed.status).toBe(201);
    const installation = await installed.json() as { id: string; revision: number };
    const promoted = await request(`/installations/${installation.id}/promote`, 'POST', {
      releaseId: first.releases[0]!.id, revision: installation.revision,
    });
    expect(promoted.status).toBe(200);
    const pinned = await promoted.json() as { revision: number };
    expect((await request(`/installations/${installation.id}/enable`, 'POST', { revision: pinned.revision, enabled: true })).status).toBe(200);
    const approved = await (await request(`/operators/${operator.operatorId}`)).json() as {
      operator: { revision: number }; releases: Array<{ id: string; approved: boolean }>;
    };
    expect(approved.releases[0]?.approved).toBe(true);
    const changed = await request(`/operators/${operator.operatorId}/source`, 'POST', {
      revision: approved.operator.revision, repositoryUrl: registration.repositoryUrl, githubPat: registration.githubPat,
    });
    expect(changed.status).toBe(200);
    const current = await (await request(`/operators/${operator.operatorId}`)).json() as { operator: { revision: number } };
    expect((await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: current.operator.revision })).status).toBe(200);
    const after = await (await request(`/operators/${operator.operatorId}`)).json() as {
      releases: Array<{ id: string; sourceRevision: number; approved: boolean }>;
      installations: Array<{ id: string; releaseId: string; enabled: boolean }>;
    };
    expect(after.releases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.releases[0]!.id, sourceRevision: 1, approved: true }),
      expect.objectContaining({ sourceRevision: 2, approved: false }),
    ]));
    expect(after.releases).toHaveLength(2);
    expect(after.installations).toEqual(expect.arrayContaining([expect.objectContaining({
      id: installation.id, releaseId: first.releases[0]!.id, enabled: false,
    })]));
  }));

  it('fails closed on newly acquired bytes exceeding the aggregate budget without partially admitting releases', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ bundlePaddingBytes: 3_400_000, releaseCount: 5 });
    vi.stubGlobal('fetch', fixture.fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const created = await request('/operators', 'POST', registration);
    const operator = await created.json() as { operatorId: string; revision: number };
    expect((await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision })).status).toBe(503);
    const after = await (await request(`/operators/${operator.operatorId}`)).json() as { releases: unknown[] };
    expect(after.releases).toEqual([]);
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

  it.each(['productionresultssa1.blob.core.windows.net', 'productionresultssa2.blob.core.windows.net',
    'productionresultssa3.blob.core.windows.net', 'productionresultssa6.blob.core.windows.net', 'productionresultssa8.blob.core.windows.net',
    'productionresultssa16.blob.core.windows.net', 'productionresultssa22.blob.core.windows.net',
    'productionresultssa66.blob.core.windows.net'] as const)(
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
    expect(discovered.items).toEqual([expect.objectContaining({ sourceCommit: fixture.sourceCommit,
      bundleDigest: fixture.bundleDigest, manifestDigest: fixture.manifestDigest, approved: false })]);
    const detail = await (await request(`/operators/${operator.operatorId}`)).json();
    expect(detail).toMatchObject({ releases: discovered.items, installations: [] });
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

  it.each(['productionresultssa2.blob.core.windows.net.attacker.example'] as const)(
    'rejects unapproved Actions artifact CDN host %s without forwarding the PAT or committing a release', async artifactCdnHost => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ useCdn: true, artifactCdnHost });
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
    const detail = await (await request(`/operators/${operator.operatorId}`)).json() as { releases: unknown[] };
    expect(detail.releases).toHaveLength(0);
    expect(fixture.requests.some(outbound => outbound.origin === `https://${artifactCdnHost}`)).toBe(false);
  }));

  it('rejects mismatched build bytes from the approved Actions CDN without admitting a release', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ useCdn: true,
      artifactCdnHost: 'productionresultssa2.blob.core.windows.net', fault: 'build-bytes' });
    vi.stubGlobal('fetch', fixture.fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(503);
    const detail = await (await request(`/operators/${operator.operatorId}`)).json();
    expect(detail).toMatchObject({ releases: [], installations: [] });
    expect(fixture.requests.some(outbound => outbound.origin === 'https://productionresultssa2.blob.core.windows.net')).toBe(true);
    expect(fixture.requests.filter(outbound => outbound.origin !== 'https://api.github.com')
      .every(outbound => outbound.authorization === null)).toBe(true);
  }));

  it('rejects an approved CDN response that crosses the acquisition deadline without committing a release', async () => withManagementApi(async request => {
    const fixture = await createOperatorGitHubFixture({ useCdn: true,
      artifactCdnHost: 'productionresultssa2.blob.core.windows.net' });
    const clock = vi.spyOn(Date, 'now');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fixture.fetcher(input, init);
      if (new URL(new Request(input, init).url).origin === 'https://productionresultssa2.blob.core.windows.net') {
        clock.mockReturnValue(Date.now() + 31_000);
      }
      return response;
    });
    try {
      expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
        ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
      const registered = await request('/operators', 'POST', registration);
      expect(registered.status).toBe(201);
      const operator = await registered.json() as { operatorId: string; revision: number };
      const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
      expect(refreshed.status).toBe(503);
      const detail = await (await request(`/operators/${operator.operatorId}`)).json();
      expect(detail).toMatchObject({ releases: [], installations: [] });
      expect(fixture.requests.some(outbound => outbound.origin === 'https://productionresultssa2.blob.core.windows.net')).toBe(true);
    } finally { clock.mockRestore(); }
  }));
});
