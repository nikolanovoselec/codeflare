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

async function installGitHubRelease(mode: 'valid' | 'bad-provenance') {
  const bundle = JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, compatibilityDate: '2026-02-05', compatibilityFlags: ['nodejs_compat'],
    mainModule: 'index.js', modules: { 'index.js': { js: 'export default { fetch() { return new Response("ok") } }' } } });
  const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const bundleDigest = await digest(bundle);
  const manifest = JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, id: 'review-operator', name: 'Review operator', description: 'Review',
    coreVersion: '1', intentVersion: '1', profile: 'conductor', inputSchema: { type: 'object' }, requiredCapabilities: [],
    artifact: { path: '/operator-bundle.json', sha256: bundleDigest } });
  const manifestDigest = await digest(manifest);
  const provenance = JSON.stringify({ repositoryId: mode === 'valid' ? 417 : 418, workflow: { id: 9, ref: '.github/workflows/release.yml@refs/heads/main' },
    sourceCommit: 'a'.repeat(40), manifestDigest, bundleDigest });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname.endsWith('/releases')) return Response.json([{ id: 81, target_commitish: 'a'.repeat(40), assets: [
      { name: 'operator-manifest.json', browser_download_url: 'https://github.com/acme/review-operator/releases/download/v1/operator-manifest.json', digest: `sha256:${manifestDigest}` },
      { name: 'operator-bundle.json', browser_download_url: 'https://github.com/acme/review-operator/releases/download/v1/operator-bundle.json', digest: `sha256:${bundleDigest}` },
      { name: 'operator-provenance.json', browser_download_url: 'https://github.com/acme/review-operator/releases/download/v1/operator-provenance.json' },
    ] }]);
    if (url.pathname.endsWith('operator-manifest.json')) return new Response(manifest, { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('operator-bundle.json')) return new Response(bundle, { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('operator-provenance.json')) return new Response(provenance, { headers: { 'content-type': 'application/json' } });
    return Response.json({ id: 417, full_name: 'acme/review-operator', html_url: registration.repositoryUrl });
  });
}

describe('REQ-OPERATOR-044: GitHub immutable package acquisition', () => {
  it('stores a canonical repository identity without returning its acquisition-only PAT, then discovers a matching immutable release without enabling it', async () => withManagementApi(async request => {
    await installGitHubRelease('valid');
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

  it('rejects repository/provenance mismatches without enabling an installation or disclosing the PAT', async () => withManagementApi(async request => {
    await installGitHubRelease('bad-provenance');
    const registered = await request('/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(503);
    expect(await refreshed.text()).not.toContain(registration.githubPat);
    const detail = await request(`/operators/${operator.operatorId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ releases: [], installations: [] });
  }));
});
