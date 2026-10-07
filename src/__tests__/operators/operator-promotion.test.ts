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
    const legacyFixture = await createOperatorGitHubFixture({ omitCompilerCommit: true });
    const row = ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=?', release.id).one();
    const legacy = JSON.parse(row.data) as { assets: Array<{ name: string; digest: string; id: number }>;
      provenance: { compilerCommit?: string; artifactDigest: string } };
    delete legacy.provenance.compilerCommit;
    legacy.assets = legacy.assets.map(asset => ({ ...asset,
      digest: legacyFixture.assets.find(candidate => candidate.name === asset.name)!.digest.slice('sha256:'.length) }));
    legacy.provenance.artifactDigest = legacyFixture.artifactDigest;
    ctx.storage.sql.exec('UPDATE operator_releases SET data=? WHERE id=?', JSON.stringify(legacy), release.id);
    vi.stubGlobal('fetch', legacyFixture.fetcher);
    const detail = await request(`/operators/${operator.operatorId}`);
    const revision = (await detail.json() as { operator: { revision: number } }).operator.revision;

    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision });

    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({ items: [expect.objectContaining({ id: release.id,
      provenance: expect.not.objectContaining({ compilerCommit: expect.anything() }) })] });
  }));

  it('enriches a legacy retained release with verified publication metadata without changing its installation or enablement', async () => withManagementApi(async (request, ctx) => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture()).fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const created = await request('/operators', 'POST', registration);
    const operator = await created.json() as { operatorId: string; revision: number };
    const first = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(first.status).toBe(200);
    const release = (await first.json() as { items: Array<{ id: string }> }).items[0]!;
    const detail = await request(`/operators/${operator.operatorId}`);
    const current = await detail.json() as { operator: { revision: number } };
    const installed = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'integration', policy, revision: current.operator.revision,
    });
    const installation = await installed.json() as { id: string; revision: number };
    const promoted = await request(`/installations/${installation.id}/promote`, 'POST', { releaseId: release.id, revision: installation.revision });
    const pinned = await promoted.json() as { revision: number };
    expect((await request(`/installations/${installation.id}/enable`, 'POST', { revision: pinned.revision, enabled: true })).status).toBe(200);
    const row = ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=?', release.id).one();
    const legacy = JSON.parse(row.data) as { tagName?: string; publishedAt?: string };
    delete legacy.tagName; delete legacy.publishedAt;
    ctx.storage.sql.exec('UPDATE operator_releases SET data=? WHERE id=?', JSON.stringify(legacy), release.id);
    const before = await request(`/operators/${operator.operatorId}`);
    const state = await before.json() as { operator: { revision: number } };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: state.operator.revision });
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({ items: [expect.objectContaining({
      id: release.id, tagName: 'v1', publishedAt: '2026-09-21T12:00:00Z',
    })] });
    const after = await request(`/operators/${operator.operatorId}`);
    await expect(after.json()).resolves.toMatchObject({ releases: [expect.objectContaining({
      id: release.id, tagName: 'v1', publishedAt: '2026-09-21T12:00:00Z',
    })], installations: [expect.objectContaining({ id: installation.id, releaseId: release.id, enabled: true })] });
  }));

  it('rejects missing compiler provenance for a release that was not previously retained', async () => withManagementApi(async request => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture({ omitCompilerCommit: true })).fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', registration);
    const operator = await registered.json() as { operatorId: string; revision: number };

    expect((await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', {
      revision: operator.revision,
    })).status).toBe(503);
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


describe('REQ-OPERATOR-061: configured Renovate run settings', () => {
  async function setup(request: (path: string, method?: string, body?: unknown) => Promise<Response>) {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture({ profile: 'dispatcher', repositoryName: 'codeflare-operator-dispatcher', repositoryOwner: 'nikolanovoselec', packageId: 'renovate-dispatcher', intentVersion: '3', inputSchema: { type: 'object', additionalProperties: false, required: ['repository'], properties: { repository: { type: 'string', maxLength: 201, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' } } } })).fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const response = await request('/operators', 'POST', { ...registration, profile: 'dispatcher',
      repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher' });
    expect(response.status).toBe(201);
    const operator = await response.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    const release = (await refreshed.json() as { items: Array<{ id: string }> }).items[0];
    const current = await (await request(`/operators/${operator.operatorId}`)).json() as { operator: { revision: number } };
    return { ...operator, revision: current.operator.revision, releaseId: release.id };
  }
  it('persists independent configuration through CAS save/read and disables only the selected installation without changing policy', () => withManagementApi(async request => {
    const operator = await setup(request);
    const configuration = { unrelated: { labels: ['keep'], nested: { allowed: true } }, renovate: {
      repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 900 } };
    const created = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'primary', revision: operator.revision, policy, configuration });
    expect(created.status).toBe(201);
    const first = await created.json() as { id: string; revision: number };
    const promoted = await request(`/installations/${first.id}/promote`, 'POST', { revision: first.revision, releaseId: operator.releaseId });
    expect(promoted.status).toBe(200);
    const pinned = await promoted.json() as { revision: number };
    const enabled = await request(`/installations/${first.id}/enable`, 'POST', { revision: pinned.revision, enabled: true });
    expect(enabled.status).toBe(200);
    first.revision = (await enabled.json() as { revision: number }).revision;
    const detail = await (await request(`/operators/${operator.operatorId}`)).json() as { operator: { revision: number } };
    const otherResponse = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'other', revision: detail.operator.revision, policy, configuration: { renovate: {
        repository: 'other/updates', automaticRuns: false, repetitionIntervalSeconds: 7200 } } });
    expect(otherResponse.status).toBe(201);
    const other = await otherResponse.json();
    const next = { ...configuration, renovate: { ...configuration.renovate, automaticRuns: false, repetitionIntervalSeconds: 7200 } };
    const saved = await request(`/installations/${first.id}/configure`, 'POST', { revision: first.revision, policy, configuration: next });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ id: first.id, revision: first.revision + 1, enabled: false, policy, configuration: next });
    expect((await request(`/installations/${first.id}/configure`, 'POST', { revision: first.revision, policy, configuration })).status).toBe(409);
    expect(await (await request(`/operators/${operator.operatorId}`)).json()).toMatchObject({ installations: expect.arrayContaining([
      expect.objectContaining({ id: first.id, enabled: false, configuration: next, policy }), other,
    ]) });
  }));
  it.each([
    { repository: '' }, { repository: 'acme' }, { repository: 'acme/../updates' }, { repository: './updates' },
    { repository: 'acme/..' }, { repository: 'acme/%75pdates' }, { repository: 'https://github.com/acme/updates' },
    { repository: 'acme/updates?override=1' }, { repository: 'acme/updates#branch' },
    { repository: 'a'.repeat(202) + '/updates' }, { repository: ' acme/updates' },
    { repetitionIntervalSeconds: 0 }, { repetitionIntervalSeconds: -1 }, { repetitionIntervalSeconds: 1.5 },
    { repetitionIntervalSeconds: '900' }, { repetitionIntervalSeconds: Number.MAX_SAFE_INTEGER + 1 }, { repetitionIntervalSeconds: Number.MAX_SAFE_INTEGER },
    { repetitionIntervalSeconds: 8_640_000_000_000 }, { repetitionIntervalSeconds: null },
    { automaticRuns: 'true' }, { extraAuthority: true },
  ])('rejects malformed reserved settings %j without changing retained installation', patch => withManagementApi(async request => {
    const operator = await setup(request);
    const configuration = { unrelated: { keep: true }, renovate: {
      repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 900 } };
    const created = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'primary', revision: operator.revision, policy, configuration });
    expect(created.status).toBe(201);
    const installation = await created.json() as { id: string; revision: number };
    const invalid = await request(`/installations/${installation.id}/configure`, 'POST', {
      revision: installation.revision, policy, configuration: { ...configuration, renovate: { ...configuration.renovate, ...patch } } });
    expect(invalid.status).toBe(400);
    expect(await (await request(`/operators/${operator.operatorId}`)).json()).toMatchObject({ installations: [expect.objectContaining({
      id: installation.id, revision: installation.revision, configuration, enabled: false, policy })] });
  }));
  it.each([1, 900, 7200, 31_536_000, 1_000_000_000_000])('accepts valid %i-second cadence without inventing an hourly or short business cap', interval => withManagementApi(async request => {
    const operator = await setup(request);
    const configuration = { renovate: { repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: interval } };
    const created = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'primary', revision: operator.revision, policy, configuration });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ configuration, enabled: false });
  }));
  it('validates reserved settings at the Registry RPC boundary and retains state on rejection', () => withManagementApi(async (request, ctx) => {
    const operator = await setup(request);
    const configuration = { renovate: { repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 900 } };
    const created = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'primary', revision: operator.revision, policy, configuration });
    expect(created.status).toBe(201);
    const installation = await created.json() as { id: string; revision: number };
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const current = await registry.getManagementOperator(operator.operatorId);
    if (!current.ok) throw Error('Operator unavailable');
    const controls = await registry.getManagementControls();
    await expect(registry.configureManagementInstallation(installation.id, { revision: installation.revision, policy,
      configurationJson: JSON.stringify({ renovate: { repository: 'acme/../other', automaticRuns: true, repetitionIntervalSeconds: 0 } }) },
      { operatorRevision: current.value.revision, controlsRevision: controls.revision, expiresAt: Date.now() + 60000 }))
      .rejects.toBeDefined();
    expect(await registry.getManagementInstallation(installation.id)).toMatchObject({ ok: true, value: {
      revision: installation.revision, configurationJson: JSON.stringify(configuration) } });
  }));

});
