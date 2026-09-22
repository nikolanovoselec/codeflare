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

async function withManagementApi(test: (request: (path: string, method?: string, body?: unknown) => Promise<Response>,
  ctx: DurableObjectState) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const request = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(
      `https://enterprise.example.test/api/operator-management${path}`, { method, headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest', 'cf-access-authenticated-user-email': 'manager@example.test' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { KV: createMockKV(), ENCRYPTION_KEY: btoa('k'.repeat(32)), ENTERPRISE_MODE: 'active', OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
    await test(request, ctx);
  });
}

describe('REQ-OPERATOR-046: explicit, revision-safe release promotion', () => {
  it('preserves an exact release acquired before compiler provenance became mandatory', async () => withManagementApi(async (request, ctx) => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture()).fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', registration);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const first = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(first.status).toBe(200);
    const release = (await first.json() as { items: Array<{ id: string }> }).items[0]!;
    const row = ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=?', release.id).one();
    const legacy = JSON.parse(row.data) as { provenance: { compilerCommit?: string } };
    delete legacy.provenance.compilerCommit;
    ctx.storage.sql.exec('UPDATE operator_releases SET data=? WHERE id=?', JSON.stringify(legacy), release.id);
    const detail = await request(`/operators/${operator.operatorId}`);
    const revision = (await detail.json() as { operator: { revision: number } }).operator.revision;

    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision });

    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({ items: [expect.objectContaining({ id: release.id,
      provenance: expect.not.objectContaining({ compilerCommit: expect.anything() }) })] });
  }));

  it('keeps discovery and promotion disabled, rejects a stale mutation, and preserves an independent installation', async () => withManagementApi(async request => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture()).fetcher);
    const controls = await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } });
    expect(controls.status).toBe(200);
    const registered = await request('/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    const release = (await refreshed.json() as { items: Array<{ id: string; approved: boolean }> }).items[0]!;
    expect(release.approved).toBe(false);
    const discoveredDetail = await request(`/operators/${operator.operatorId}`);
    expect(discoveredDetail.status).toBe(200);
    const discovered = await discoveredDetail.json() as { operator: { revision: number } };

    const created = await request(`/operators/${operator.operatorId}/installations`, 'POST', { name: 'production', policy,
      revision: discovered.operator.revision, configuration: { review: { paths: ['src'], failClosed: true } } });
    expect(created.status).toBe(201);
    const installation = await created.json() as { id: string; revision: number; enabled: boolean; releaseId: string | null; configuration: unknown; configurationJson?: unknown };
    expect(installation).toMatchObject({ revision: 1, enabled: false, releaseId: null,
      configuration: { review: { paths: ['src'], failClosed: true } } });
    expect(installation.configurationJson).toBeUndefined();
    const configured = await request(`/installations/${installation.id}/configure`, 'POST', {
      revision: 1, policy, configuration: { review: { paths: ['src', 'host'], failClosed: true } },
    });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({ id: installation.id, revision: 2, enabled: false,
      configuration: { review: { paths: ['src', 'host'], failClosed: true } } });
    expect((await request(`/installations/${installation.id}/configure`, 'POST', {
      revision: 1, policy, configuration: { review: { paths: ['stale'] } },
    })).status).toBe(409);

    const currentDetail = await request(`/operators/${operator.operatorId}`);
    expect(currentDetail.status).toBe(200);
    const current = await currentDetail.json() as { operator: { revision: number } };
    const isolated = await request(`/operators/${operator.operatorId}/installations`, 'POST', { name: 'staging', policy, revision: current.operator.revision });
    expect(isolated.status).toBe(201);
    const untouched = await isolated.json() as { id: string; revision: number; releaseId: string | null; enabled: boolean };

    const promoted = await request(`/installations/${installation.id}/promote`, 'POST', { releaseId: release.id, revision: 2 });
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ id: installation.id, releaseId: release.id, revision: 3, enabled: false });
    const detail = await request(`/operators/${operator.operatorId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ installations: expect.arrayContaining([
      expect.objectContaining({ id: installation.id, configuration: { review: { paths: ['src', 'host'], failClosed: true } } }),
      expect.objectContaining({ id: untouched.id, revision: untouched.revision, releaseId: null, enabled: false }),
    ]) });
    expect((await request(`/installations/${installation.id}/promote`, 'POST', { releaseId: release.id, revision: installation.revision })).status).toBe(409);

    const enabled = await request(`/installations/${installation.id}/enable`, 'POST', { revision: 3, enabled: true });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ id: installation.id, releaseId: release.id, revision: 4, enabled: true });
    const rollback = await request(`/installations/${installation.id}/promote`, 'POST', { releaseId: release.id, revision: 4 });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ id: installation.id, releaseId: release.id, revision: 5, enabled: false });
  }));

  it('rejects release capabilities outside installation policy and the current management ceiling', async () => withManagementApi(async request => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture({ requiredCapabilities: ['fetch'] })).fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: ['fetch'], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', { ...registration,
      policy: { capabilities: ['fetch'], resourceProfileId: null } });
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    const release = (await refreshed.json() as { items: Array<{ id: string }> }).items[0]!;
    const detail = await request(`/operators/${operator.operatorId}`);
    const revision = (await detail.json() as { operator: { revision: number } }).operator.revision;

    const narrow = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'narrow', policy, revision,
    });
    const narrowInstallation = await narrow.json() as { id: string; revision: number };
    expect((await request(`/installations/${narrowInstallation.id}/promote`, 'POST', {
      releaseId: release.id, revision: narrowInstallation.revision,
    })).status).toBe(400);

    const currentDetail = await request(`/operators/${operator.operatorId}`);
    const currentRevision = (await currentDetail.json() as { operator: { revision: number } }).operator.revision;
    const matching = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'matching', policy: { capabilities: ['fetch'], resourceProfileId: null }, revision: currentRevision,
    });
    const matchingInstallation = await matching.json() as { id: string; revision: number };
    const promoted = await request(`/installations/${matchingInstallation.id}/promote`, 'POST', {
      releaseId: release.id, revision: matchingInstallation.revision,
    });
    const promotedInstallation = await promoted.json() as { id: string; revision: number };
    expect(promoted.status).toBe(200);
    expect((await request('/access', 'POST', { revision: 1, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    expect((await request(`/installations/${promotedInstallation.id}/enable`, 'POST', {
      revision: promotedInstallation.revision, enabled: true,
    })).status).toBe(404);
  }));
});
