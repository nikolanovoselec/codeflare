/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { OperatorRegistry } from '../../operators/registry';
import { createMockKV } from '../helpers/mock-kv';

vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => { c.set('user', { email: 'manager@example.test', role: 'admin', authenticated: true }); return next(); },
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
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const request = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(
      `https://enterprise.example.test/api/operator-management${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { KV: createMockKV(), ENTERPRISE_MODE: 'active', OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
    await test(request);
  });
}

async function installReleaseFixture() {
  const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const bundle = JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, compatibilityDate: '2026-02-05', compatibilityFlags: ['nodejs_compat'],
    mainModule: 'index.js', modules: { 'index.js': { js: 'export default {}' } } });
  const bundleDigest = await digest(bundle);
  const manifest = JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, id: 'review-operator', name: 'Review operator', description: 'Review',
    coreVersion: '1', intentVersion: '1', profile: 'conductor', inputSchema: { type: 'object' }, requiredCapabilities: [], artifact: { path: '/operator-bundle.json', sha256: bundleDigest } });
  const manifestDigest = await digest(manifest);
  const provenance = JSON.stringify({ repositoryId: 417, workflow: { id: 9, ref: '.github/workflows/release.yml@refs/heads/main' }, sourceCommit: 'a'.repeat(40), manifestDigest, bundleDigest });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const value = input instanceof Request ? input.url : input.toString();
    const url = new URL(value);
    if (url.pathname.endsWith('/releases')) return Response.json([{ id: 81, target_commitish: 'a'.repeat(40), assets: [
      { name: 'operator-manifest.json', browser_download_url: 'https://github.com/acme/review-operator/releases/download/v1/operator-manifest.json', digest: `sha256:${manifestDigest}` },
      { name: 'operator-bundle.json', browser_download_url: 'https://github.com/acme/review-operator/releases/download/v1/operator-bundle.json', digest: `sha256:${bundleDigest}` },
      { name: 'operator-provenance.json', browser_download_url: 'https://github.com/acme/review-operator/releases/download/v1/operator-provenance.json' },
    ] }]);
    if (url.pathname.endsWith('operator-manifest.json')) return new Response(manifest);
    if (url.pathname.endsWith('operator-bundle.json')) return new Response(bundle);
    if (url.pathname.endsWith('operator-provenance.json')) return new Response(provenance);
    return Response.json({ id: 417, full_name: 'acme/review-operator', html_url: registration.repositoryUrl });
  });
}

describe('REQ-OPERATOR-046: explicit, revision-safe release promotion', () => {
  it('keeps discovery and promotion disabled, rejects a stale mutation, and selects a retained approved release for rollback', async () => withManagementApi(async request => {
    await installReleaseFixture();
    const registered = await request('/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    const release = (await refreshed.json() as { items: Array<{ id: string; approved: boolean }> }).items[0]!;
    expect(release.approved).toBe(false);

    const created = await request(`/operators/${operator.operatorId}/installations`, 'POST', { name: 'production', policy, revision: operator.revision });
    expect(created.status).toBe(201);
    const installation = await created.json() as { id: string; revision: number; enabled: boolean; releaseId: string | null };
    expect(installation).toMatchObject({ revision: 1, enabled: false, releaseId: null });

    const isolated = await request(`/operators/${operator.operatorId}/installations`, 'POST', { name: 'staging', policy, revision: operator.revision });
    expect(isolated.status).toBe(201);
    const untouched = await isolated.json() as { id: string; revision: number; releaseId: string | null; enabled: boolean };

    const promoted = await request(`/installations/${installation.id}/promote`, 'POST', { releaseId: release.id, revision: installation.revision });
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ id: installation.id, releaseId: release.id, revision: 2, enabled: false });
    const detail = await request(`/operators/${operator.operatorId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ installations: expect.arrayContaining([
      expect.objectContaining({ id: untouched.id, revision: untouched.revision, releaseId: null, enabled: false }),
    ]) });
    expect((await request(`/installations/${installation.id}/promote`, 'POST', { releaseId: release.id, revision: installation.revision })).status).toBe(409);

    const enabled = await request(`/installations/${installation.id}/enable`, 'POST', { revision: 2, enabled: true });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ id: installation.id, releaseId: release.id, revision: 3, enabled: true });
    const rollback = await request(`/installations/${installation.id}/promote`, 'POST', { releaseId: release.id, revision: 3 });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ id: installation.id, releaseId: release.id, revision: 4, enabled: false });
  }));
});
