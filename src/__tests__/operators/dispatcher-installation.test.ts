/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { OperatorRegistry } from '../../operators/registry';
import { openOperatorSecret } from '../../operators/protected-secrets';
import { createMockKV } from '../helpers/mock-kv';
import { createOperatorGitHubFixture } from '../helpers/operator-github-fixture';
import { connectionSecret, normalDeployment } from './fixtures/normal-dispatcher';

let callerEmail = 'manager@example.test';
vi.mock('../../middleware/auth', async original => ({ ...await original<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: callerEmail, role: callerEmail === 'manager@example.test' ? 'admin' : 'user', authenticated: true }); return next();
  },
}));
vi.mock('../../lib/access', async original => ({ ...await original<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: callerEmail, role: callerEmail === 'manager@example.test' ? 'admin' : 'user', authenticated: true }, bucketName: 'manager' }),
  requireOperatorHumanContext: async () => ({ human: { subject: callerEmail, email: callerEmail,
    issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: 1, expiresAt: 2_000_000_000 }, accessJwt: 'fixture-access-jwt' }),
}));
import worker from '../../index';

afterEach(() => { callerEmail = 'manager@example.test'; vi.unstubAllGlobals(); });
const encryption = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };
const policy = { capabilities: [], resourceProfileId: null };
const grant = { users: ['manager@example.test'], groups: [] };
type Installation = { id: string; revision: number; enabled: boolean; releaseId: string | null;
  dispatcherConnection?: { connectionRevision: number; workerVersionId: string } };
type Release = { id: string; manifestDigest: string; bundleDigest: string; sourceCommit: string;
  provenance: { compilerCommit: string } };

async function withInstallation(test: (f: {
  request: (path: string, method?: string, body?: unknown, csrf?: boolean) => Promise<Response>;
  operatorId: string; installation: Installation; release: Release; connection: Record<string, unknown>;
  registry: OperatorRegistry; ctx: DurableObjectState;
}) => Promise<void>) {
  callerEmail = 'manager@example.test';
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, encryption);
    const request = (path: string, method = 'GET', body?: unknown, csrf = true) => worker.fetch(new Request(
      `https://enterprise.example.test/api/operator-management${path}`, { method, headers: {
        'content-type': 'application/json', 'cf-access-authenticated-user-email': callerEmail,
        ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { ...encryption, KV: createMockKV(), ENTERPRISE_MODE: 'active',
      OPERATOR_REGISTRY: { getByName: () => registry } } as unknown as Env,
    { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext);
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture({ profile: 'dispatcher', normalDispatcher: true })).fetcher);
    expect((await request('/access', 'POST', { revision: 0, managers: grant,
      ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
    const registered = await request('/operators', 'POST', { repositoryUrl: 'https://github.com/acme/review-operator',
      githubPat: 'acquisition-only-pat', profile: 'dispatcher', realm: 'internal', managers: grant, invokers: grant, policy });
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number };
    const refreshed = await request(`/operators/${operator.operatorId}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    const release = (await refreshed.json() as { items: Release[] }).items[0]!;
    const detail = await (await request(`/operators/${operator.operatorId}`)).json() as { operator: { revision: number } };
    const created = await request(`/operators/${operator.operatorId}/installations`, 'POST', {
      name: 'normal Integration', policy, revision: detail.operator.revision });
    expect(created.status).toBe(201);
    const initial = await created.json() as Installation;
    const promoted = await request(`/installations/${initial.id}/promote`, 'POST', { revision: initial.revision, releaseId: release.id });
    expect(promoted.status).toBe(200);
    const installation = await promoted.json() as Installation;
    await test({ request, operatorId: operator.operatorId, installation, registry, ctx, release,
      connection: { revision: installation.revision, connectionSecret, ...normalDeployment, releaseId: release.id,
        manifestDigest: release.manifestDigest, bundleDigest: release.bundleDigest } });
  });
}

describe('normal Dispatcher installation connection', () => {
  it('REQ-OPERATOR-046: AC1/2 connection configuration and rotation disable starts and reject stale revisions', () => withInstallation(async f => {
    const path = `/installations/${f.installation.id}/dispatcher-connection`;
    const configured = await f.request(path, 'POST', f.connection);
    expect(configured.status).toBe(200);
    const saved = await configured.json() as Installation;
    expect(saved).toMatchObject({ id: f.installation.id, releaseId: f.release.id,
      revision: f.installation.revision + 1, enabled: false,
      dispatcherConnection: { connectionRevision: 1, workerVersionId: normalDeployment.workerVersionId } });
    const enabled = await f.request(`/installations/${saved.id}/enable`, 'POST', { revision: saved.revision, enabled: true });
    expect(enabled.status).toBe(200);
    const active = await enabled.json() as Installation;
    const rotated = await f.request(path, 'POST', { ...f.connection, revision: active.revision, connectionSecret: 'rotated-installation-secret' });
    expect(rotated.status).toBe(200);
    const current = await rotated.json() as Installation;
    expect(current).toMatchObject({ revision: active.revision + 1, enabled: false,
      dispatcherConnection: { connectionRevision: 2, workerVersionId: normalDeployment.workerVersionId } });
    expect((await f.request(path, 'POST', f.connection)).status).toBe(409);
    const readback = await (await f.request(`/operators/${f.operatorId}`)).json();
    expect(readback).toMatchObject({ installations: [expect.objectContaining(current)] });
  }));

  it('REQ-OPERATOR-049: AC2 connection secret is encrypted for its installation and never returned in management readback', () => withInstallation(async f => {
    const configured = await f.request(`/installations/${f.installation.id}/dispatcher-connection`, 'POST', f.connection);
    expect(configured.status).toBe(200);
    const projection = await configured.text();
    expect(projection).not.toContain(connectionSecret);
    expect(projection).not.toContain('connectionSecretCiphertext');
    const raw = f.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE id=?', f.installation.id).one().data;
    expect(raw).not.toContain(connectionSecret);
    // Verify retained authenticated encryption without prescribing a new Registry API or nesting layout.
    const envelopes = (value: unknown): string[] => typeof value === 'string' ? value.startsWith('v1:') ? [value] : []
      : value && typeof value === 'object' ? Object.values(value).flatMap(envelopes) : [];
    const ciphertexts = envelopes(JSON.parse(raw));
    const opened = await Promise.all(ciphertexts.map(ciphertext => openOperatorSecret(ciphertext, encryption,
      { purpose: 'connection', recordId: f.installation.id }).catch(() => null)));
    expect(opened).toContain(connectionSecret);
    for (const ciphertext of ciphertexts) await expect(openOperatorSecret(ciphertext, encryption,
      { purpose: 'connection', recordId: 'another-installation' })).rejects.toThrow('Operator secret protection failed');
    const detail = await f.request(`/operators/${f.operatorId}`);
    expect(detail.status).toBe(200);
    const readback = await detail.text();
    expect(readback).not.toContain(connectionSecret);
    for (const ciphertext of ciphertexts) expect(readback).not.toContain(ciphertext);
  }));

  it('REQ-OPERATOR-045: AC2 unauthorized CSRF-less and substituted deployment mutations leave the installed pin unchanged', () => withInstallation(async f => {
    const path = `/installations/${f.installation.id}/dispatcher-connection`;
    const before = await (await f.request(`/operators/${f.operatorId}`)).json();
    callerEmail = 'outsider@example.test';
    expect((await f.request(path, 'POST', f.connection)).status).toBe(404);
    callerEmail = 'manager@example.test';
    expect((await f.request(path, 'POST', f.connection, false)).status).toBe(403);
    for (const field of ['releaseId', 'manifestDigest', 'bundleDigest', 'sourceCommit', 'compilerCommit']) {
      const changed = field.endsWith('Commit') ? 'b'.repeat(40) : field.endsWith('Digest') ? 'b'.repeat(64) : 'other-release';
      expect((await f.request(path, 'POST', { ...f.connection, [field]: changed })).status).toBe(409);
    }
    expect(await (await f.request(`/operators/${f.operatorId}`)).json()).toEqual(before);
  }));
});
