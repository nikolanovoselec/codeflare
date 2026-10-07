/// <reference types="@cloudflare/vitest-pool-workers/types" />
/** REQ-OPERATOR-045: real registry + HTTP authorization; authentication is an explicit trusted boundary fixture. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import worker from '../../index';
import type { Env } from '../../types';
import { OperatorRegistry, type ManagementPolicy, type ManagementInstallation } from '../../operators/registry';
import { MAX_SOURCE_RESPONSE_BYTES } from '../../operators/dispatcher-source-limits';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
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
async function withApi(test: (request: RequestApi, registry: OperatorRegistry) => Promise<void>, configureKv?: (kv: ReturnType<typeof createMockKV>) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const kv = createMockKV();
    await configureKv?.(kv);
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
    await test(request, registry);
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
async function enabledInstallation(request: RequestApi, operator: { id: string; revision: number }, installedPolicy: ManagementPolicy = registration.policy): Promise<string> {
  const refreshed = await request(`/api/operator-management/operators/${operator.id}/releases/refresh`, 'POST', { revision: operator.revision });
  expect(refreshed.status).toBe(200);
  const release = (await refreshed.json() as { items: Array<{ id: string }> }).items[0]!;
  const detail = await request(`/api/operator-management/operators/${operator.id}`);
  expect(detail.status).toBe(200);
  const current = await detail.json() as { operator: { revision: number } };
  const created = await request(`/api/operator-management/operators/${operator.id}/installations`, 'POST', {
    revision: current.operator.revision, name: 'access-fixture', policy: installedPolicy,
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
  it.each(['conductor', 'dispatcher'] as const)('persists %s execution logging independently of installation restrictions and Environment limits', async profile => withApi(async request => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture({ repositoryName: 'release-operator', profile })).fetcher);
    await delegate(request);
    const created = await request('/api/operator-management/operators', 'POST', { ...registration, profile });
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number; policy: { loggingEnabled?: boolean } };
    expect(operator.policy.loggingEnabled).toBe(true);
    const id = await enabledInstallation(request, operator);
    const detailPath = `/api/operator-management/operators/${operator.id}`;
    const path = `${detailPath}/capabilities`;
    type Detail = { operator: { revision: number; policy: { loggingEnabled?: boolean } }; installations: ManagementInstallation[]; grants: unknown };
    const read = async () => await (await request(detailPath)).json() as Detail;
    const before = await read();
    const revision = before.operator.revision;
    const controls = await (await request('/api/operator-management/access')).json();
    expect((await request(path, 'POST', { revision, capabilities: [], loggingEnabled: true })).status).toBe(200);
    expect(await read()).toEqual(before);
    for (const loggingEnabled of [null, 'false', 0, 1, {}]) {
      expect((await request(path, 'POST', { revision, capabilities: [], loggingEnabled })).status).toBe(400);
    }
    expect((await request(path, 'POST', { revision, capabilities: [], loggingEnabled: false }, false)).status).toBe(403);
    expect((await request(path, 'POST', { revision: revision + 1, capabilities: [], loggingEnabled: false })).status).toBe(409);
    actor.email = 'other@example.test'; actor.groups = [];
    expect((await request(path, 'POST', { revision, capabilities: [], loggingEnabled: false })).status).toBe(404);
    actor.email = 'manager@example.test'; actor.groups = ['operators'];
    expect(await read()).toEqual(before);
    const changed = await request(path, 'POST', { revision, capabilities: [], loggingEnabled: false });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ revision: revision + 1, policy: { loggingEnabled: false } });
    const after = await read();
    expect(after.grants).toEqual(before.grants);
    expect(after.installations[0]).toEqual({ ...before.installations[0], revision: before.installations[0]!.revision + 1, enabled: false });
    expect(await (await request('/api/operator-management/access')).json()).toEqual(controls);
    expect((await request(path, 'POST', { revision, capabilities: [], loggingEnabled: true })).status).toBe(409);
    expect((await request(path, 'POST', { revision: revision + 1, capabilities: [] })).status).toBe(200);
    expect(await read()).toEqual(after);
    expect((await request(`/api/operator-management/installations/${id}/enable`, 'POST', {
      revision: after.installations[0]!.revision, enabled: true,
    })).status).toBe(200);
    const enabled = await read();
    expect(enabled.operator.policy.loggingEnabled).toBe(false);
    expect(enabled.installations[0]!.enabled).toBe(true);
    expect((await request(path, 'POST', { revision: revision + 1, capabilities: [], loggingEnabled: false })).status).toBe(200);
    expect(await read()).toEqual(enabled);
    expect((await request(path, 'POST', { revision: revision + 1, capabilities: [], loggingEnabled: true })).status).toBe(200);
    const restored = await read();
    expect(restored.operator).toMatchObject({ revision: revision + 2, policy: { loggingEnabled: true } });
    expect(restored.installations[0]).toEqual({ ...enabled.installations[0], revision: enabled.installations[0]!.revision + 1, enabled: false });
  }));

  it('REQ-OPERATOR-045: persists operator inference bytes with revision fencing and unchanged installation policy', async () => withApi(async request => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture({ repositoryName: 'release-operator', profile: 'dispatcher' })).fetcher);
    await delegate(request);
    const created = await request('/api/operator-management/operators', 'POST', { ...registration, profile: 'dispatcher' });
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number };
    const id = await enabledInstallation(request, operator);
    const detailPath = `/api/operator-management/operators/${operator.id}`;
    const path = `${detailPath}/capabilities`;
    type Detail = { operator: { revision: number; policy: ManagementPolicy & { inferenceRequestBytes?: number } };
      installations: ManagementInstallation[]; grants: unknown };
    const before = await (await request(detailPath)).json() as Detail;
    const revision = before.operator.revision;
    const noOp = await request(path, 'POST', { revision, capabilities: [], inferenceRequestBytes: 1048576 });
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toMatchObject({ revision, policy: registration.policy });
    expect((await (await request(detailPath)).json() as Detail).installations).toEqual(before.installations);
    for (const inferenceRequestBytes of [0, -1, 1.5, null, '65536', Number.MAX_SAFE_INTEGER + 1]) {
      expect((await request(path, 'POST', { revision, capabilities: [], inferenceRequestBytes })).status).toBe(400);
    }
    expect((await request(path, 'POST', { revision, capabilities: [], inferenceRequestBytes: 1048576 }, false)).status).toBe(403);
    expect((await request(path, 'POST', { revision: revision + 1, capabilities: [], inferenceRequestBytes: 1048576 })).status).toBe(409);
    actor.email = 'other@example.test'; actor.groups = [];
    expect((await request(path, 'POST', { revision, capabilities: [], inferenceRequestBytes: 1048576 })).status).toBe(404);
    actor.email = 'manager@example.test'; actor.groups = ['operators'];
    expect(await (await request(detailPath)).json()).toEqual(before);
    const changed = await request(path, 'POST', { revision, capabilities: [], inferenceRequestBytes: Number.MAX_SAFE_INTEGER });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ revision: revision + 1,
      policy: { ...registration.policy, inferenceRequestBytes: Number.MAX_SAFE_INTEGER } });
    const after = await (await request(detailPath)).json() as Detail;
    expect(after.grants).toEqual(before.grants);
    expect(after.installations[0]).toMatchObject({ id, releaseId: before.installations[0]!.releaseId,
      approvedSourceRevision: before.installations[0]!.approvedSourceRevision,
      policy: before.installations[0]!.policy, enabled: false, revision: before.installations[0]!.revision + 1 });
    const omitted = await request(path, 'POST', { revision: revision + 1, capabilities: [] });
    expect(omitted.status).toBe(200);
    expect(await omitted.json()).toMatchObject({ revision: revision + 1, policy: { inferenceRequestBytes: Number.MAX_SAFE_INTEGER } });
    expect((await request(`/api/operator-management/installations/${id}/enable`, 'POST', {
      revision: after.installations[0]!.revision, enabled: true,
    })).status).toBe(200);
    const enabled = await (await request(detailPath)).json() as Detail;
    expect((await request(path, 'POST', { revision: revision + 1, capabilities: [], inferenceRequestBytes: Number.MAX_SAFE_INTEGER })).status).toBe(200);
    expect(await (await request(detailPath)).json()).toEqual(enabled);
  }));

  it('REQ-OPERATOR-045: persists operator operation limit with revision fencing and unchanged installation policy', async () => withApi(async request => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture({ repositoryName: 'release-operator', profile: 'dispatcher' })).fetcher);
    await delegate(request);
    const created = await request('/api/operator-management/operators', 'POST', { ...registration, profile: 'dispatcher' });
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number };
    const id = await enabledInstallation(request, operator);
    const detailPath = `/api/operator-management/operators/${operator.id}`;
    const path = `${detailPath}/capabilities`;
    type Detail = { operator: { revision: number; policy: ManagementPolicy & { operationLimit?: number } };
      installations: ManagementInstallation[]; grants: unknown };
    const before = await (await request(detailPath)).json() as Detail;
    const revision = before.operator.revision;
    const noOp = await request(path, 'POST', { revision, capabilities: [], operationLimit: 1024 });
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toMatchObject({ revision, policy: registration.policy });
    expect((await (await request(detailPath)).json() as Detail).installations).toEqual(before.installations);
    for (const operationLimit of [0, -1, 1.5, null, '1024', Number.MAX_SAFE_INTEGER + 1]) {
      expect((await request(path, 'POST', { revision, capabilities: [], operationLimit })).status).toBe(400);
    }
    expect((await request(path, 'POST', { revision, capabilities: [], operationLimit: 2048 }, false)).status).toBe(403);
    expect((await request(path, 'POST', { revision: revision + 1, capabilities: [], operationLimit: 2048 })).status).toBe(409);
    actor.email = 'other@example.test'; actor.groups = [];
    expect((await request(path, 'POST', { revision, capabilities: [], operationLimit: 2048 })).status).toBe(404);
    actor.email = 'manager@example.test'; actor.groups = ['operators'];
    expect(await (await request(detailPath)).json()).toEqual(before);
    const changed = await request(path, 'POST', { revision, capabilities: [], operationLimit: Number.MAX_SAFE_INTEGER });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ revision: revision + 1,
      policy: { ...registration.policy, operationLimit: Number.MAX_SAFE_INTEGER } });
    const after = await (await request(detailPath)).json() as Detail;
    expect(after.grants).toEqual(before.grants);
    expect(after.installations[0]).toMatchObject({ id, releaseId: before.installations[0]!.releaseId,
      approvedSourceRevision: before.installations[0]!.approvedSourceRevision,
      policy: before.installations[0]!.policy, enabled: false, revision: before.installations[0]!.revision + 1 });
    const omitted = await request(path, 'POST', { revision: revision + 1, capabilities: [] });
    expect(omitted.status).toBe(200);
    expect(await omitted.json()).toMatchObject({ revision: revision + 1, policy: { operationLimit: Number.MAX_SAFE_INTEGER } });
    expect((await request(`/api/operator-management/installations/${id}/enable`, 'POST', {
      revision: after.installations[0]!.revision, enabled: true,
    })).status).toBe(200);
    const enabled = await (await request(detailPath)).json() as Detail;
    expect((await request(path, 'POST', { revision: revision + 1, capabilities: [], operationLimit: Number.MAX_SAFE_INTEGER })).status).toBe(200);
    expect(await (await request(detailPath)).json()).toEqual(enabled);
  }));

  it('REQ-OPERATOR-045: Dispatcher inference byte settings are not accepted for Conductor', async () => withApi(async request => {
    await delegate(request);
    const created = await request('/api/operator-management/operators', 'POST', registration);
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number };
    expect((await request(`/api/operator-management/operators/${operator.id}/capabilities`, 'POST', {
      revision: operator.revision, capabilities: [], inferenceRequestBytes: 1048576,
    })).status).toBe(400);
  }));

  it('REQ-OPERATOR-045: Dispatcher operation limits are not accepted for Conductor', async () => withApi(async request => {
    await delegate(request);
    const created = await request('/api/operator-management/operators', 'POST', registration);
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number };
    expect((await request(`/api/operator-management/operators/${operator.id}/capabilities`, 'POST', {
      revision: operator.revision, capabilities: [], operationLimit: 1024,
    })).status).toBe(400);
  }));

  it('accepts restrictive source byte limits and requires explicit re-enable after configuration while retaining pins and grants', async () => withApi(async request => {
    actor.role = 'admin';
    expect((await request('/api/operator-management/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [], sourceResponseBytes: 262144 } })).status).toBe(200);
    actor.role = 'user';
    const policy = { ...registration.policy, sourceResponseBytes: 196608 };
    const created = await request('/api/operator-management/operators', 'POST', { ...registration, policy });
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number };
    const installedPolicy = { ...policy, sourceResponseBytes: 131072 };
    const id = await enabledInstallation(request, operator, installedPolicy);
    const detailPath = `/api/operator-management/operators/${operator.id}`;
    const before = await (await request(detailPath)).json() as { operator: { revision: number }; installations: ManagementInstallation[]; grants: unknown };
    const installation = before.installations[0]!;
    expect((await request(`/api/operator-management/installations/${id}/configure`, 'POST', {
      revision: installation.revision, policy: { ...installedPolicy, sourceResponseBytes: 98304 }, configuration: {},
    })).status).toBe(200);
    const after = await (await request(detailPath)).json() as typeof before;
    expect(after.grants).toEqual(before.grants);
    expect(after.installations[0]).toMatchObject({ id, releaseId: installation.releaseId,
      approvedSourceRevision: installation.approvedSourceRevision, enabled: false,
      policy: { ...installedPolicy, sourceResponseBytes: 98304 }, revision: installation.revision + 1 });
    expect((await request(`/api/operator-management/installations/${id}/enable`, 'POST', {
      revision: installation.revision + 1, enabled: true,
    })).status).toBe(200);
    actor.role = 'admin';
    expect((await request('/api/operator-management/access', 'POST', { revision: 1, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [], sourceResponseBytes: 65536 } })).status).toBe(200);
    actor.role = 'user';
    expect((await request(`/api/operator-management/installations/${id}/enable`, 'POST', {
      revision: installation.revision + 2, enabled: true,
    })).status).toBe(404);
    const fenced = await (await request(detailPath)).json() as typeof before;
    expect(fenced.grants).toEqual(before.grants);
    expect(fenced.installations[0]?.releaseId).toBe(installation.releaseId);
    actor.email = 'invoker@example.test'; actor.groups = [];
    expect((await request('/api/operator-activities', 'POST', { installationId: id,
      invocation: conductorInvocation(operator.id) })).status).toBe(404);
  }));

  it('patches source bytes through capabilities, preserving omitted bytes and fencing stale/no-op changes without altering pins or grants', async () => withApi(async request => {
    actor.role = 'admin';
    expect((await request('/api/operator-management/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [], sourceResponseBytes: 262144 } })).status).toBe(200);
    actor.role = 'user';
    const registrationPolicy = { ...registration.policy, sourceResponseBytes: 65536 };
    const registered = await request('/api/operator-management/operators', 'POST', { ...registration, policy: registrationPolicy });
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { id: string; revision: number };
    const id = await enabledInstallation(request, operator, registrationPolicy);
    const detailPath = `/api/operator-management/operators/${operator.id}`;
    const path = `${detailPath}/capabilities`;
    const before = await (await request(detailPath)).json() as { operator: { revision: number; policy: ManagementPolicy }; installations: ManagementInstallation[]; grants: unknown };
    const revision = before.operator.revision;
    const installation = before.installations[0]!;
    const noOp = await request(path, 'POST', { revision, capabilities: [], sourceResponseBytes: 65536 });
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toMatchObject({ revision, policy: registrationPolicy });
    expect((await (await request(detailPath)).json() as typeof before).installations).toEqual(before.installations);
    for (const sourceResponseBytes of [0, -1, 1.5, NaN, '65536', MAX_SOURCE_RESPONSE_BYTES + 1]) {
      expect((await request(path, 'POST', { revision, capabilities: [], sourceResponseBytes })).status).toBe(400);
    }
    expect((await request(path, 'POST', { revision, capabilities: [], sourceResponseBytes: 262145 })).status).toBe(404);
    expect((await request(path, 'POST', { revision: revision + 1, capabilities: [], sourceResponseBytes: 196608 })).status).toBe(409);
    const changed = await request(path, 'POST', { revision, capabilities: [], sourceResponseBytes: 196608 });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ revision: revision + 1, policy: { ...registration.policy, sourceResponseBytes: 196608 } });
    const after = await (await request(detailPath)).json() as typeof before;
    expect(after.grants).toEqual(before.grants);
    expect(after.installations[0]).toMatchObject({ id, releaseId: installation.releaseId,
      approvedSourceRevision: installation.approvedSourceRevision, policy: installation.policy,
      enabled: false, revision: installation.revision + 1 });
    const omitted = await request(path, 'POST', { revision: revision + 1, capabilities: [] });
    expect(omitted.status).toBe(200);
    expect(await omitted.json()).toMatchObject({ revision: revision + 1, policy: { sourceResponseBytes: 196608 } });
    expect((await request(`/api/operator-management/installations/${id}/configure`, 'POST', {
      revision: installation.revision + 1, policy: { ...registration.policy, sourceResponseBytes: 131072 }, configuration: {},
    })).status).toBe(200);
    expect((await request(`/api/operator-management/installations/${id}/enable`, 'POST', {
      revision: installation.revision + 2, enabled: true,
    })).status).toBe(200);
    const enabled = await (await request(detailPath)).json() as typeof before;
    const equalPatch = await request(path, 'POST', { revision: revision + 1, capabilities: [], sourceResponseBytes: 196608 });
    expect(equalPatch.status).toBe(200);
    expect(await equalPatch.json()).toMatchObject({ revision: revision + 1 });
    expect((await (await request(detailPath)).json() as typeof before).installations).toEqual(enabled.installations);
  }));

  it('retains missing policy and ceiling JSON fields and the default byte ceiling', async () => withApi(async request => {
    await delegate(request);
    actor.role = 'admin';
    expect(await (await request('/api/operator-management/access')).json()).toMatchObject({ ceiling: { capabilities: [], resourceProfileIds: [] } });
    expect((await (await request('/api/operator-management/access')).json() as { ceiling: object }).ceiling).not.toHaveProperty('sourceResponseBytes');
    actor.role = 'user';
    expect((await request('/api/operator-management/operators', 'POST', { ...registration,
      policy: { ...registration.policy, sourceResponseBytes: 1048577 } })).status).toBe(400);
    const created = await request('/api/operator-management/operators', 'POST', registration);
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number; policy: ManagementPolicy };
    expect(operator.policy).toEqual(registration.policy);
    const installed = await request(`/api/operator-management/operators/${operator.id}/installations`, 'POST', {
      revision: operator.revision, name: 'default', policy: registration.policy,
    });
    expect(installed.status).toBe(201);
    expect(await installed.json()).toMatchObject({ policy: registration.policy });
    expect((await request(`/api/operator-management/operators/${operator.id}/installations`, 'POST', {
      revision: operator.revision, name: 'explicit-default', policy: { ...registration.policy, sourceResponseBytes: 1048576 },
    })).status).toBe(201);
  }));

  it.each([0, -1, 1.5, NaN, '65536', MAX_SOURCE_RESPONSE_BYTES + 1])('rejects invalid public source byte limit %s for controls and policy', async sourceResponseBytes => withApi(async request => {
    actor.role = 'admin';
    expect((await request('/api/operator-management/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [], sourceResponseBytes } })).status).toBe(400);
    await delegate(request);
    expect((await request('/api/operator-management/operators', 'POST', { ...registration,
      policy: { ...registration.policy, sourceResponseBytes } })).status).toBe(400);
    const created = await request('/api/operator-management/operators', 'POST', registration);
    const operator = await created.json() as { id: string; revision: number };
    expect((await request(`/api/operator-management/operators/${operator.id}/installations`, 'POST', {
      revision: operator.revision, name: 'invalid', policy: { ...registration.policy, sourceResponseBytes },
    })).status).toBe(400);
  }));

  it.each([0, -1, 1.5, NaN, '65536', MAX_SOURCE_RESPONSE_BYTES + 1])('rejects invalid source byte limit %s at typed registry boundaries', async invalid => withApi(async (request, registry) => {
    const sourceResponseBytes = invalid as number;
    await expect(registry.setManagementControls({ revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [], sourceResponseBytes } }, {
      email: actor.email, expiresAt: Date.now() + 300000,
    })).rejects.toThrow();
    await delegate(request);
    const authority = { controlsRevision: 1, expiresAt: Date.now() + 300000 };
    await expect(registry.registerManagement({ ...registration, profile: 'conductor', realm: 'internal',
      repositoryId: 123, approvedWorkflow: { id: 1, ref: 'refs/heads/main' },
      policy: { ...registration.policy, sourceResponseBytes } }, authority)).rejects.toThrow();
    const created = await request('/api/operator-management/operators', 'POST', registration);
    const operator = await created.json() as { id: string; revision: number };
    await expect(registry.createManagementInstallation(operator.id, 'invalid', {
      ...registration.policy, sourceResponseBytes,
    }, { ...authority, operatorRevision: operator.revision })).rejects.toThrow();
    expect(await registry.getManagementInstallations(operator.id)).toEqual([]);
  }));

  it('denies policies above Environment and installation policies above their operator', async () => withApi(async request => {
    actor.role = 'admin';
    expect((await request('/api/operator-management/access', 'POST', { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [], sourceResponseBytes: 262144 } })).status).toBe(200);
    actor.role = 'user';
    expect((await request('/api/operator-management/operators', 'POST', { ...registration,
      policy: { ...registration.policy, sourceResponseBytes: 262145 } })).status).toBe(404);
    const created = await request('/api/operator-management/operators', 'POST', { ...registration,
      policy: { ...registration.policy, sourceResponseBytes: 196608 } });
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number };
    expect((await request(`/api/operator-management/operators/${operator.id}/installations`, 'POST', {
      revision: operator.revision, name: 'too-wide', policy: { ...registration.policy, sourceResponseBytes: 196609 },
    })).status).toBe(400);
    const defaultOperatorResponse = await request('/api/operator-management/operators', 'POST', { ...registration,
      policy: { ...registration.policy, sourceResponseBytes: 65536 } });
    expect(defaultOperatorResponse.status).toBe(201);
    const defaultOperator = await defaultOperatorResponse.json() as { id: string; revision: number };
    expect((await request(`/api/operator-management/operators/${defaultOperator.id}/installations`, 'POST', {
      revision: defaultOperator.revision, name: 'above-default-operator',
      policy: { ...registration.policy, sourceResponseBytes: 65537 },
    })).status).toBe(400);
  }));
  it('edits operator capabilities within Environment limits and disables current runs without changing pins or installation restrictions', async () => withApi(async request => {
    await delegate(request);
    actor.role = 'admin';
    expect((await request('/api/operator-management/access', 'POST', { revision: 1, managers: registration.managers,
      ceiling: { capabilities: ['fetch'], resourceProfileIds: [] } })).status).toBe(200);
    actor.role = 'user';
    const policy = { capabilities: ['fetch'], resourceProfileId: null };
    const registered = await request('/api/operator-management/operators', 'POST', { ...registration, policy });
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { id: string; revision: number };
    const id = await enabledInstallation(request, operator, policy);
    const path = `/api/operator-management/operators/${operator.id}/capabilities`;
    const current = await request(`/api/operator-management/operators/${operator.id}`);
    const before = await current.json() as { operator: { revision: number }; installations: Array<{ id: string; releaseId: string; revision: number; policy: typeof policy; enabled: boolean }> };
    const body = { revision: before.operator.revision, capabilities: [] };
    expect((await request(path, 'POST', body, false)).status).toBe(403);
    actor.email = 'outsider@example.test'; actor.groups = [];
    expect((await request(path, 'POST', body)).status).toBe(404);
    actor.email = 'manager@example.test'; actor.groups = ['operators'];
    expect((await request(path, 'POST', { ...body, capabilities: ['pi'] })).status).toBe(404);
    expect((await request(path, 'POST', { ...body, revision: body.revision + 1 })).status).toBe(409);
    const changed = await request(path, 'POST', body);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ policy: { capabilities: [], resourceProfileId: null }, revision: body.revision + 1 });
    const detail = await request(`/api/operator-management/operators/${operator.id}`);
    const after = await detail.json() as { installations: typeof before.installations };
    expect(after.installations[0]).toMatchObject({ id, releaseId: before.installations[0]!.releaseId,
      policy, revision: before.installations[0]!.revision + 1, enabled: false });
    expect((await request(`/api/operator-management/installations/${id}/enable`, 'POST', {
      revision: after.installations[0]!.revision, enabled: true })).status).toBe(400);
    expect((await request(path, 'POST', { revision: body.revision + 1, capabilities: ['fetch'] })).status).toBe(200);
    expect((await request(`/api/operator-management/installations/${id}/enable`, 'POST', {
      revision: after.installations[0]!.revision, enabled: true })).status).toBe(200);
  }));
  it('projects only verified configured identity options and authorized limits to eligible managers, not Access credentials', async () => withApi(async request => {
    actor.groups = ['operators', 'review-team'];
    await delegate(request);
    actor.role = 'admin';
    const options = await request('/api/operator-management/options');
    expect(options.status).toBe(200);
    expect(await options.json()).toMatchObject({ users: ['invoker@example.test', 'manager@example.test'],
      groups: [{ issuer: 'https://issuer.example.test', id: 'review-team' }], unresolvedGroups: ['Display Team', 'unverified-id'],
      capabilities: ['session', 'pi', 'storage', 'inference', 'fetch'],
      ceiling: { capabilities: [], resourceProfileIds: [] } });
    actor.role = 'user';
    const managerOptions = await request('/api/operator-management/options');
    expect(managerOptions.status).toBe(200);
    expect(await managerOptions.json()).toMatchObject({ users: ['manager@example.test'] });
    actor.email = 'outsider@example.test'; actor.groups = [];
    expect((await request('/api/operator-management/options')).status).toBe(404);
  }, async kv => {
    await kv.put('user:manager@example.test', JSON.stringify({ role: 'user' }));
    await kv.put('user:invoker@example.test', JSON.stringify({ role: 'user' }));
    await kv.put(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'review-team,Display Team,unverified-id');
  }));
  it('REQ-OPERATOR-049 AC2: management registration, detail and catalog never return the stored GitHub credential', async () => withApi(async request => {
    await delegate(request);
    const created = await request('/api/operator-management/operators', 'POST', registration);
    expect(created.status).toBe(201);
    const operator = await created.json() as { id: string; revision: number };
    expect(JSON.stringify(operator)).not.toContain(registration.githubPat);
    expect((await request(`/api/operator-management/operators/${operator.id}/releases/refresh`, 'POST', { revision: operator.revision })).status).toBe(200);
    const detail = await request(`/api/operator-management/operators/${operator.id}`);
    expect(detail.status).toBe(200);
    const data = await detail.json() as { releases: Array<{ description?: string; name?: string }> };
    expect(data.releases[0]?.description).toEqual(expect.any(String));
    expect(data.releases[0]?.description?.length).toBeGreaterThan(8);
    const catalog = await request('/api/operator-management/operators');
    const listing = await catalog.json() as { items: Array<{ description?: string }> };
    expect(listing.items[0]?.description).toBe(data.releases[0]?.description);
    expect(JSON.stringify(data)).not.toContain(registration.githubPat);
    expect(JSON.stringify(listing)).not.toContain(registration.githubPat);
  }));
  it('REQ-OPERATOR-049 AC2: installed release and grant projections do not reveal stored credentials', async () => withApi(async request => {
    await delegate(request);
    const registered = await request('/api/operator-management/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { id: string; revision: number };
    await enabledInstallation(request, operator);
    const detail = await request(`/api/operator-management/operators/${operator.id}`);
    expect(detail.status).toBe(200);
    const value = await detail.json() as { operator: { revision: number }; installations: unknown[] };
    expect(value.installations.length).toBeGreaterThan(0);
    expect(JSON.stringify(value)).not.toContain(registration.githubPat);
    const grants = await request(`/api/operator-management/operators/${operator.id}/grants`, 'POST', {
      managers: registration.managers, invokers: registration.invokers, revision: value.operator.revision,
    });
    expect(grants.status).toBe(200);
    expect(JSON.stringify(await grants.json())).not.toContain(registration.githubPat);
  }));

  it('registers without a realm choice and keeps the legacy internal storage value', async () => withApi(async request => {
    await delegate(request);
    const input = { repositoryUrl: registration.repositoryUrl, githubPat: registration.githubPat,
      profile: registration.profile, managers: registration.managers, invokers: registration.invokers, policy: registration.policy };
    const result = await request('/api/operator-management/operators', 'POST', input);
    expect(result.status).toBe(201);
    expect(await result.json()).toMatchObject({ realm: 'internal' });
  }));
  it('binds target Action trust only through current platform-admin controls and retains it on unrelated edits', async () => withApi(async request => {
    const action = { repositoryId: 138, installationId: 'review-install', workflowId: 531,
      workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
      workflowDigest: 'a'.repeat(64), events: ['pull_request'], enabled: false };
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
  it('REQ-OPERATOR-053: accepts protected pull_request_target registration only for a platform admin with CSRF protection', async () => withApi(async request => {
    const controls = { revision: 0, managers: registration.managers,
      ceiling: { capabilities: [], resourceProfileIds: [] }, boundaryActions: [{
        repositoryId: 138, installationId: 'review-install', workflowId: 531,
        workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
        workflowDigest: 'a'.repeat(64), events: ['pull_request_target'], enabled: false,
      }] };
    actor.role = 'admin';
    expect((await request('/api/operator-management/access', 'POST', controls, false)).status).toBe(403);
    actor.role = 'user';
    expect((await request('/api/operator-management/access', 'POST', controls)).status).toBe(404);
    actor.role = 'admin';
    expect((await request('/api/operator-management/access', 'POST', { ...controls,
      boundaryActions: [{ ...controls.boundaryActions[0], events: ['pull_request_target', 'workflow_dispatch'] }],
    })).status).toBe(400);
    await expect((await request('/api/operator-management/access')).json()).resolves.toMatchObject({ revision: 0 });
    const approved = await request('/api/operator-management/access', 'POST', controls);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ revision: 1, boundaryActions: controls.boundaryActions });
    expect((await request('/api/operator-management/access', 'POST', { ...controls, revision: 1,
      boundaryActions: [{ ...controls.boundaryActions[0], enabled: true }],
    })).status).toBe(400);
  }));
  it('rejects a cross-origin simple management mutation before it can self-nominate authority', async () => withApi(async request => {
    const denied = await request('/api/operator-management/operators', 'POST', registration, false);
    expect(denied.status).toBe(403);
    expect((await request('/api/operator-management/operators')).status).toBe(404);
  }));

  it('REQ-OPERATOR-049 AC1: management route denies self-nominated users outside global eligibility', async () => withApi(async request => {
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
