/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { OperatorRegistry } from '../../operators/registry';
import { createMockKV } from '../helpers/mock-kv';

const identity = vi.hoisted(() => ({ email: 'manager@example.test' }));
vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: identity.email, role: 'admin', authenticated: true });
    return next();
  },
  requireAdmin: async (_c: any, next: any) => next(),
}));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireOperatorHumanContext: async () => ({ human: { subject: 'manager', email: identity.email,
    issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: 1, expiresAt: 2_000_000_000 }, accessJwt: 'test-access-jwt' }),
}));

import worker from '../../index';

afterEach(() => { identity.email = 'manager@example.test'; vi.unstubAllGlobals(); });

const policy = { capabilities: [], resourceProfileId: null };
const registration = { repositoryUrl: 'https://github.com/acme/review-operator', githubPat: 'acquisition-only-pat',
  profile: 'conductor', realm: 'internal', managers: { users: ['manager@example.test'], groups: [] },
  invokers: { users: ['manager@example.test'], groups: [] }, policy };

async function withManagementApi(test: (request: (path: string, method?: string, body?: unknown) => Promise<Response>) => Promise<void>) {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const kv = createMockKV();
    const request = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(
      `https://enterprise.example.test/api/operator-management${path}`, { method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { KV: kv, ENTERPRISE_MODE: 'active', OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
    await test(request);
  });
}

describe('REQ-OPERATOR-043: catalog and independently configured installations', () => {
  it('creates distinct operator and installation identities', async () => withManagementApi(async request => {
    vi.stubGlobal('fetch', async () => Response.json({ id: 417, full_name: 'acme/review-operator', html_url: registration.repositoryUrl }));
    const registered = await request('/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number; enabled: boolean };
    expect(operator).toMatchObject({ operatorId: expect.any(String), revision: expect.any(Number), enabled: false });
    expect(await (await request('/operators?limit=50')).json()).toMatchObject({ items: [expect.objectContaining({ operatorId: operator.operatorId })], cursor: null });
    identity.email = 'ungranted@example.test';
    expect(await (await request('/operators?limit=50')).json()).toEqual({ items: [], cursor: null });
    identity.email = 'manager@example.test';

    const first = await request(`/operators/${operator.operatorId}/installations`, 'POST', { name: 'production', policy, revision: operator.revision });
    expect(first.status).toBe(201);
    const firstInstallation = await first.json() as { id: string; revision: number; releaseId: string | null; enabled: boolean };
    expect(firstInstallation).toMatchObject({ id: expect.any(String), revision: 1, releaseId: null, enabled: false });

    const second = await request(`/operators/${operator.operatorId}/installations`, 'POST', { name: 'staging', policy, revision: operator.revision });
    expect(second.status).toBe(201);
    const secondInstallation = await second.json() as { id: string; revision: number; releaseId: string | null; enabled: boolean };
    expect(secondInstallation).toMatchObject({ id: expect.any(String), revision: 1, releaseId: null, enabled: false });
    expect(secondInstallation.id).not.toBe(firstInstallation.id);

  }));

  it('returns only authorized catalog records in bounded cursor pages', async () => withManagementApi(async request => {
    expect((await request('/operators?limit=101')).status).toBe(400);
    const page = await request('/operators?limit=50&query=review&profile=conductor&realm=internal&state=disabled');
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ items: [], cursor: null });
  }));
});
