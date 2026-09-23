/// <reference types="@cloudflare/vitest-pool-workers/types" />
/** REQ-OPERATOR-045: real registry + HTTP authorization; authentication is an explicit trusted boundary fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import worker from '../../index';
import type { Env } from '../../types';
import { OperatorRegistry } from '../../operators/registry';
import { createMockKV } from '../helpers/mock-kv';
import { createOperatorGitHubFixture } from '../helpers/operator-github-fixture';

const actor = vi.hoisted(() => ({ email: 'manager@example.test', role: 'user', groups: ['operators'] as string[] | undefined }));
vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: actor.email, role: actor.role, authenticated: true });
    return next();
  },
}));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: actor.email, role: actor.role, authenticated: true }, bucketName: actor.email }),
  requireOperatorHumanContext: async () => ({
    human: { subject: actor.email, email: actor.email, issuer: 'https://issuer.example.test', audiences: ['operator-management'],
      groups: actor.groups, issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt: Math.floor(Date.now() / 1000) + 300 },
    accessJwt: `verified-${actor.email}`,
  }),
}));

type RequestApi = (path: string, method?: string, body?: unknown, csrf?: boolean) => Promise<Response>;
const registration = {
  repositoryUrl: 'https://github.com/acme/release-operator', githubPat: 'write-only-fixture-pat',
  profile: 'conductor', realm: 'internal',
  managers: { users: ['manager@example.test'], groups: [{ issuer: 'https://issuer.example.test', id: 'operators' }] },
  invokers: { users: ['invoker@example.test'], groups: [] },
  policy: { capabilities: [], resourceProfileId: null },
};
async function withApi(test: (request: RequestApi) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const kv = createMockKV();
    const request: RequestApi = (path, method = 'GET', body, csrf = true) => worker.fetch(new Request(`https://operators.example.test${path}`, {
      method, headers: { 'content-type': 'application/json', 'cf-access-authenticated-user-email': actor.email,
        ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}), 'cf-access-jwt-assertion': 'verified-access-token' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { KV: kv, ENCRYPTION_KEY: btoa('k'.repeat(32)), ENTERPRISE_MODE: 'active',
      OPERATOR_REGISTRY: { getByName: () => registry },
      // Activity persistence is exercised natively elsewhere; this boundary acknowledges admitted preparation only.
      OPERATOR_ACTIVITY: { getByName: () => ({ prepareAuthorized: async () => ({ ok: true, phase: 'prepared' }) }) },
    } as unknown as Env, { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture({ repositoryName: 'release-operator' })).fetcher);
    await test(request);
  });
}
function conductorInvocation(operatorId: string) {
  return { schemaVersion: 1, interfaceVersion: 1, consumerId: 'operator-access-test', activityId: 'pending-activity',
    operatorId, runId: 'operator-access-run', source: { kind: 'direct', reference: 'operator-access-test' },
    revision: { reference: 'test-head', digest: 'a'.repeat(64) }, inputDigest: 'b'.repeat(64),
    input: { repository: 'acme/release-operator' }, attachments: [],
    resources: { inference: null, session: null, storage: null } };
}
async function delegate(request: RequestApi) {
  actor.role = 'admin';
  const result = await request('/api/operator-management/access', 'POST', {
    revision: 0, managers: registration.managers, ceiling: { capabilities: [], resourceProfileIds: [] },
  });
  expect(result.status).toBe(200);
  actor.role = 'user';
}
async function enabledInstallation(request: RequestApi, operator: { id: string; revision: number }): Promise<string> {
  const refreshed = await request(`/api/operator-management/operators/${operator.id}/releases/refresh`, 'POST', { revision: operator.revision });
  expect(refreshed.status).toBe(200);
  const release = (await refreshed.json() as { items: Array<{ id: string }> }).items[0]!;
  const detail = await request(`/api/operator-management/operators/${operator.id}`);
  expect(detail.status).toBe(200);
  const current = await detail.json() as { operator: { revision: number } };
  const created = await request(`/api/operator-management/operators/${operator.id}/installations`, 'POST', {
    revision: current.operator.revision, name: 'access-fixture', policy: registration.policy,
  });
  expect(created.status).toBe(201);
  const installation = await created.json() as { id: string; revision: number };
  const promoted = await request(`/api/operator-management/installations/${installation.id}/promote`, 'POST', {
    revision: installation.revision, releaseId: release.id,
  });
  expect(promoted.status).toBe(200);
  const approved = await promoted.json() as { revision: number };
  expect((await request(`/api/operator-management/installations/${installation.id}/enable`, 'POST', {
    revision: approved.revision, enabled: true,
  })).status).toBe(200);
  return installation.id;
}

beforeEach(() => { actor.email = 'manager@example.test'; actor.role = 'user'; actor.groups = ['operators']; });
afterEach(() => vi.unstubAllGlobals());

describe('REQ-OPERATOR-045: delegated management and invocation', () => {
  it('binds target Action trust only through current platform-admin controls and retains it on unrelated edits', async () => withApi(async request => {
    const action = { repositoryId: 138, installationId: 'review-install', workflowId: 531,
      workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
      workflowDigest: 'a'.repeat(64), events: ['pull_request'] };
    const controls = { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] }, boundaryActions: [action] };
    expect((await request('/api/operator-management/access', 'POST', controls)).status).toBe(404);
    actor.role = 'admin';
    const approved = await request('/api/operator-management/access', 'POST', controls);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ revision: 1, boundaryActions: [action] });
    actor.role = 'user';
    expect((await request('/api/operator-management/access', 'POST', { ...controls, revision: 1,
      boundaryActions: [] })).status).toBe(404);
    actor.role = 'admin';
    const unrelated = await request('/api/operator-management/access', 'POST', {
      revision: 1, managers: registration.managers, ceiling: controls.ceiling,
    });
    expect(unrelated.status).toBe(200);
    expect(await unrelated.json()).toMatchObject({ revision: 2, boundaryActions: [action] });
  }));
  it('rejects a cross-origin simple management mutation before it can self-nominate authority', async () => withApi(async request => {
    const denied = await request('/api/operator-management/operators', 'POST', registration, false);
    expect(denied.status).toBe(403);
    expect((await request('/api/operator-management/operators')).status).toBe(404);
  }));

  it('does not derive global management eligibility from self-nominated registration ACLs', async () => withApi(async request => {
    const denied = await request('/api/operator-management/operators', 'POST', registration);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain(registration.githubPat);
    expect((await request('/api/operator-management/access', 'POST', {
      revision: 0, managers: registration.managers, ceiling: { capabilities: [], resourceProfileIds: [] },
    })).status).toBe(404);
  }));

  it('allows a manager to manage an operator and an independent invoker to prepare its approved enabled installation', async () => withApi(async request => {
    await delegate(request);
    const created = await request('/api/operator-management/operators', 'POST', registration);
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number; enabled: boolean };
    expect(operator).toMatchObject({ id: expect.any(String), enabled: false });
    const installationId = await enabledInstallation(request, operator);
    const catalog = await request('/api/operator-management/operators');
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ items: [expect.objectContaining({ id: operator.id })], cursor: null });

    const detail = await request(`/api/operator-management/operators/${operator.id}`);
    expect(detail.status).toBe(200);
    const current = await detail.json() as { operator: { revision: number } };
    const transferred = await request(`/api/operator-management/operators/${operator.id}/grants`, 'POST', {
      managers: { users: ['other-manager@example.test'], groups: [] }, invokers: registration.invokers, revision: current.operator.revision,
    });
    expect(transferred.status).toBe(200);
    const revised = await transferred.json() as { revision: number };
    const deniedMutation = await request(`/api/operator-management/operators/${operator.id}/grants`, 'POST', {
      managers: registration.managers, invokers: registration.invokers, revision: revised.revision,
    }, false);
    expect(deniedMutation.status).toBe(404);
    expect(await deniedMutation.text()).not.toContain(operator.id);

    actor.email = 'invoker@example.test'; actor.groups = [];
    const deniedCatalog = await request('/api/operator-management/operators');
    expect(deniedCatalog.status).toBe(404);
    expect(await deniedCatalog.text()).not.toContain(operator.id);
    const invoked = await request('/api/operator-activities', 'POST', {
      installationId, invocation: conductorInvocation(operator.id),
    });
    expect(invoked.status).toBe(201);
    expect(await invoked.json()).toMatchObject({ activityId: expect.any(String), startCapability: expect.any(String) });

    actor.email = 'manager@example.test'; actor.groups = ['operators'];
    const missing = await request('/api/operator-activities', 'POST', {
      installationId: 'missing-installation', invocation: conductorInvocation(operator.id),
    });
    expect(missing.status).toBe(404);
    const missingBody = await missing.json();
    const unauthorized = await request('/api/operator-activities', 'POST', {
      installationId, invocation: conductorInvocation(operator.id),
    });
    expect(unauthorized.status).toBe(missing.status);
    expect(await unauthorized.json()).toEqual(missingBody);
  }));

  it('rechecks issuer-bound group eligibility and denies revoked or unavailable membership', async () => withApi(async request => {
    await delegate(request);
    expect((await request('/api/operator-management/operators', 'POST', registration)).status).toBe(201);
    actor.email = 'group-member@example.test'; actor.groups = ['operators'];
    const allowed = await request('/api/operator-management/operators');
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ items: [expect.objectContaining({ id: expect.any(String) })] });
    for (const membership of [[], undefined]) {
      actor.groups = membership;
      const denied = await request('/api/operator-management/operators');
      expect(denied.status).toBe(404);
      expect(await denied.json()).not.toHaveProperty('items');
    }
  }));
});
