/// <reference types="@cloudflare/vitest-plugin/types" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../../types';
import { OperatorRegistry } from '../../operators/registry';
import { createMockKV } from '../helpers/mock-kv';
import { createOperatorGitHubFixture } from '../helpers/operator-github-fixture';

const identity = vi.hoisted(() => ({ email: 'manager@example.test', role: 'user',
  issuer: 'https://access.example.test', groups: [] as string[] }));
vi.mock('../../middleware/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../../middleware/auth')>(),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', { email: identity.email, role: identity.role, authenticated: true });
    return next();
  },
  requireAdmin: async (_c: any, next: any) => next(),
}));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  authenticateRequest: async () => ({ user: { email: identity.email, role: identity.role, authenticated: true }, bucketName: identity.email }),
  requireOperatorHumanContext: async () => ({ human: { subject: 'manager', email: identity.email,
    issuer: identity.issuer, groups: identity.groups, audiences: ['audience'], issuedAt: 1, expiresAt: 2_000_000_000 }, accessJwt: 'test-access-jwt' }),
}));

import worker from '../../index';

afterEach(() => { identity.email = 'manager@example.test'; identity.role = 'user'; identity.groups = [];
  identity.issuer = 'https://access.example.test'; vi.unstubAllGlobals(); });

const policy = { capabilities: [], resourceProfileId: null };
const registration = { repositoryUrl: 'https://github.com/acme/review-operator', githubPat: 'acquisition-only-pat',
  profile: 'conductor', realm: 'internal', managers: { users: ['manager@example.test'], groups: [] },
  invokers: { users: ['manager@example.test'], groups: [] }, policy };

async function withManagementApi(test: (request: (path: string, method?: string, body?: unknown) => Promise<Response>, ctx: DurableObjectState) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const kv = createMockKV();
    const request = (path: string, method = 'GET', body?: unknown) => worker.fetch(new Request(
      `https://enterprise.example.test${path.startsWith('/api/') ? path : `/api/operator-management${path}`}`, { method, headers: {
        'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest',
        'cf-access-authenticated-user-email': identity.email,
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { KV: kv, ENCRYPTION_KEY: btoa('k'.repeat(32)), ENTERPRISE_MODE: 'active', OPERATOR_REGISTRY: { getByName: () => registry },
      OPERATOR_ACTIVITY: { getByName: () => { throw new Error('Installed reads must not access Activities'); } } } as unknown as Env,
    { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext);
    await test(request, ctx);
  });
}

async function configureControls(request: (path: string, method?: string, body?: unknown) => Promise<Response>) {
  identity.role = 'admin';
  const controls = await request('/access', 'POST', {
    revision: 0, managers: registration.managers, ceiling: { capabilities: [], resourceProfileIds: [] },
  });
  identity.role = 'user';
  expect(controls.status).toBe(200);
}

async function installedInventory(request: (path: string, method?: string, body?: unknown) => Promise<Response>) {
  vi.stubGlobal('fetch', (await createOperatorGitHubFixture()).fetcher);
  await configureControls(request);
  const visible: Array<{ id: string; operatorId: string; installationName: string }> = [];
  const hidden: string[] = [];
  for (const [label, count, allowed] of [['First', 7, true], ['Hidden', 6, false], ['Empty', 0, true], ['Second', 6, true]] as const) {
    const response = await request('/operators', 'POST', { ...registration, invokers: allowed
      ? { users: ['invoke-only@example.test'], groups: [{ issuer: 'https://access.example.test', id: 'invokers' }] }
      : { users: [], groups: [] } });
    expect(response.status).toBe(201);
    const operator = await response.json() as { id: string; revision: number };
    for (let index = 0; index < count; index += 1) {
      const name = `${label} installation ${index + 1}`;
      const installed = await request(`/operators/${operator.id}/installations`, 'POST', { name, policy, revision: operator.revision });
      expect(installed.status).toBe(201);
      const value = await installed.json() as { id: string };
      if (allowed) visible.push({ id: value.id, operatorId: operator.id, installationName: name });
      else hidden.push(value.id);
    }
  }
  return { visible: visible.sort((a, b) => a.id.localeCompare(b.id)), hidden };
}

describe('REQ-OPERATOR-086 AC2/5: five-installation pages through the real Registry', () => {
  it('enumerates every authorized installation in five-entry pages across operators without empty operator pages or skipped configurations', async () => withManagementApi(async request => {
    const inventory = await installedInventory(request);
    identity.email = 'invoke-only@example.test';
    const seen: Array<{ id: string; operatorId: string; installationName: string }> = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page += 1) {
      const response = await request(`/api/operator-activities/installations${cursor ? `?cursor=${cursor}` : ''}`);
      expect(response.status).toBe(200);
      const value = await response.json() as { items: Array<{ id: string; operatorId: string; installationName: string }>; cursor: string | null };
      sizes.push(value.items.length);
      expect(value.items.length).toBeGreaterThan(0);
      expect(value.items.length).toBeLessThanOrEqual(5);
      for (const item of value.items) {
        expect(item).toMatchObject({ enabled: false, approved: false, canInvoke: true, canManage: false, version: null });
        seen.push({ id: item.id, operatorId: item.operatorId, installationName: item.installationName });
      }
      expect(JSON.stringify(value)).not.toContain('acquisition-only-pat');
      cursor = value.cursor;
      if (!cursor) break;
      // Intentional opaque-cursor contract: last returned installation, never its operator ID.
      expect(cursor).toBe(value.items.at(-1)!.id);
    }
    expect(sizes).toEqual([5, 5, 3]);
    expect(seen).toEqual(inventory.visible);
    expect(new Set(seen.map(item => item.id)).size).toBe(13);
    for (const id of inventory.hidden) expect(seen.some(item => item.id === id)).toBe(false);
    expect(cursor).toBeNull();
  }));

  it.each([
    { email: 'group-only@example.test', groups: ['invokers'], issuer: 'https://access.example.test', visible: true },
    { email: 'group-only@example.test', groups: [], issuer: 'https://access.example.test', visible: false },
    { email: 'group-only@example.test', groups: ['invokers'], issuer: 'https://foreign.example.test', visible: false },
  ])('filters issuer-bound group visibility before the five-entry page: $issuer, groups=$groups', async example => withManagementApi(async request => {
    const inventory = await installedInventory(request);
    identity.email = example.email; identity.groups = example.groups; identity.issuer = example.issuer;
    const response = await request('/api/operator-activities/installations');
    expect(response.status).toBe(200);
    const value = await response.json() as { items: Array<{ id: string; canInvoke: boolean; canManage: boolean }>; cursor: string | null };
    if (example.visible) {
      expect(value.items.map(item => item.id)).toEqual(inventory.visible.slice(0, 5).map(item => item.id));
      expect(value.items.every(item => item.canInvoke && !item.canManage)).toBe(true);
    } else expect(value).toEqual({ items: [], cursor: null });
  }));

  it.each(['eligible-manager', 'ineligible-manager', 'platform-admin'])('keeps management visibility and invocation independent for %s', async access => withManagementApi(async request => {
    await installedInventory(request);
    if (access === 'ineligible-manager') {
      identity.role = 'admin';
      expect((await request('/access', 'POST', { revision: 1, managers: { users: [], groups: [] },
        ceiling: { capabilities: [], resourceProfileIds: [] } })).status).toBe(200);
      identity.role = 'user';
    } else if (access === 'platform-admin') { identity.email = 'admin@example.test'; identity.role = 'admin'; }
    const response = await request('/api/operator-activities/installations');
    expect(response.status).toBe(200);
    const value = await response.json() as { items: Array<{ canInvoke: boolean; canManage: boolean }>; cursor: string | null };
    if (access === 'ineligible-manager') expect(value).toEqual({ items: [], cursor: null });
    else {
      expect(value.items).toHaveLength(5);
      expect(value.items.every(item => item.canManage && !item.canInvoke)).toBe(true);
      expect(value.cursor).not.toBeNull();
    }
  }));

  it('rejects unknown, foreign and newly revoked installation cursors without leaking hidden records', async () => withManagementApi(async request => {
    const inventory = await installedInventory(request);
    identity.email = 'invoke-only@example.test';
    for (const cursor of ['missing-installation', inventory.hidden[0]]) {
      const response = await request(`/api/operator-activities/installations?cursor=${cursor}`);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Hidden installation');
    }
    const first = await (await request('/api/operator-activities/installations')).json() as { cursor: string };
    expect(inventory.visible.some(item => item.id === first.cursor)).toBe(true);
    const operatorId = inventory.visible.find(item => item.id === first.cursor)!.operatorId;
    identity.email = 'manager@example.test';
    const current = await (await request(`/operators/${operatorId}`)).json() as { operator: { revision: number } };
    expect((await request(`/operators/${operatorId}/grants`, 'POST', { revision: current.operator.revision,
      managers: registration.managers, invokers: { users: [], groups: [] } })).status).toBe(200);
    identity.email = 'invoke-only@example.test';
    expect((await request(`/api/operator-activities/installations?cursor=${first.cursor}`)).status).toBe(404);
  }));

  it('keeps original remaining installation identities reachable when another installation arrives between pages', async () => withManagementApi(async request => {
    const inventory = await installedInventory(request);
    identity.email = 'invoke-only@example.test';
    const first = await (await request('/api/operator-activities/installations')).json() as { items: Array<{ id: string }>; cursor: string };
    expect(first.items).toHaveLength(5);
    identity.email = 'manager@example.test';
    const operatorId = inventory.visible[0].operatorId;
    const current = await (await request(`/operators/${operatorId}`)).json() as { operator: { revision: number } };
    expect((await request(`/operators/${operatorId}/installations`, 'POST', { name: 'New arrival', policy,
      revision: current.operator.revision })).status).toBe(201);
    identity.email = 'invoke-only@example.test';
    const seen = first.items.map(item => item.id);
    let cursor: string | null = first.cursor;
    for (let page = 0; cursor && page < 4; page += 1) {
      const response = await request(`/api/operator-activities/installations?cursor=${cursor}`);
      expect(response.status).toBe(200);
      const value = await response.json() as { items: Array<{ id: string }>; cursor: string | null };
      expect(value.items.length).toBeLessThanOrEqual(5);
      seen.push(...value.items.map(item => item.id)); cursor = value.cursor;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(seen.length);
    for (const item of inventory.visible) expect(seen).toContain(item.id);
  }));
});

describe('REQ-OPERATOR-086 AC5: installed activity catalog visibility', () => {
  it('selects invoker-only operators before pagination without changing the management catalog', async () => withManagementApi(async (request, ctx) => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture()).fetcher);
    await configureControls(request);
    const registered = await request('/operators', 'POST', { ...registration,
      invokers: { users: ['invoke-only@example.test'], groups: [{ issuer: 'https://access.example.test', id: 'invoke-group' }] } });
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { id: string };
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const query = { email: 'invoke-only@example.test', issuer: 'https://access.example.test', groups: [],
      platformAdmin: false, limit: 1, cursor: null };
    expect(await registry.listManagementOperators(query)).toEqual({ items: [], cursor: null });
    expect(await registry.listManagementOperators(Object.assign({}, query, { includeInvokers: true, managersEligible: false })))
      .toMatchObject({ items: [{ id: operator.id }], cursor: null });
    const groupQuery = Object.assign({}, query, { email: 'group-only@example.test', groups: ['invoke-group'], includeInvokers: true, managersEligible: false });
    expect(await registry.listManagementOperators(groupQuery)).toMatchObject({ items: [{ id: operator.id }], cursor: null });
    expect(await registry.listManagementOperators({ ...groupQuery, issuer: 'https://foreign.example.test' })).toEqual({ items: [], cursor: null });
    expect(await registry.listManagementOperators({ ...groupQuery, groups: [] })).toEqual({ items: [], cursor: null });
  }));

  it('excludes globally ineligible manager-only operators before choosing an activity cursor', async () => withManagementApi(async (request, ctx) => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture()).fetcher);
    await configureControls(request);
    expect((await request('/operators', 'POST', { ...registration, invokers: { users: [], groups: [] } })).status).toBe(201);
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    const query = { email: 'manager@example.test', issuer: 'https://access.example.test', groups: [], platformAdmin: false, limit: 1, cursor: null };
    expect(await registry.listManagementOperators(Object.assign({}, query, { includeInvokers: true, managersEligible: false })))
      .toEqual({ items: [], cursor: null });
    expect((await registry.listManagementOperators(Object.assign({}, query, { includeInvokers: true, managersEligible: true }))).items)
      .toEqual([expect.objectContaining({ repositoryUrl: registration.repositoryUrl })]);
  }));
});

describe('REQ-OPERATOR-043: catalog and independently configured installations', () => {
  it('creates distinct operator and installation identities', async () => withManagementApi(async request => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture()).fetcher);
    await configureControls(request);
    const registered = await request('/operators', 'POST', registration);
    expect(registered.status).toBe(201);
    const operator = await registered.json() as { operatorId: string; revision: number; enabled: boolean };
    expect(operator).toMatchObject({ operatorId: expect.any(String), revision: expect.any(Number), enabled: false });
    expect(await (await request('/operators?limit=50')).json()).toMatchObject({ items: [expect.objectContaining({ operatorId: operator.operatorId })], cursor: null });
    identity.email = 'ungranted@example.test';
    expect((await request('/operators?limit=50')).status).toBe(404);
    identity.email = 'manager@example.test';

    const first = await request(`/operators/${operator.operatorId}/installations`, 'POST', { name: 'production', policy, revision: operator.revision });
    expect(first.status).toBe(201);
    const firstInstallation = await first.json() as { id: string; revision: number; releaseId: string | null; enabled: boolean };
    expect(firstInstallation).toMatchObject({ id: expect.any(String), revision: 1, releaseId: null, enabled: false });

    const detail = await request(`/operators/${operator.operatorId}`);
    expect(detail.status).toBe(200);
    const current = await detail.json() as { operator: { revision: number } };
    const second = await request(`/operators/${operator.operatorId}/installations`, 'POST', { name: 'staging', policy, revision: current.operator.revision });
    expect(second.status).toBe(201);
    const secondInstallation = await second.json() as { id: string; revision: number; releaseId: string | null; enabled: boolean };
    expect(secondInstallation).toMatchObject({ id: expect.any(String), revision: 1, releaseId: null, enabled: false });
    expect(secondInstallation.id).not.toBe(firstInstallation.id);

  }));

  it('projects the uniquely enabled pinned version rather than an arbitrary other release for multiple installations', async () => withManagementApi(async (request, ctx) => {
    vi.stubGlobal('fetch', (await createOperatorGitHubFixture()).fetcher);
    await configureControls(request);
    const registered = await request('/operators', 'POST', registration);
    const operator = await registered.json() as { id: string; revision: number };
    const refreshed = await request(`/operators/${operator.id}/releases/refresh`, 'POST', { revision: operator.revision });
    expect(refreshed.status).toBe(200);
    const release = (await refreshed.json() as { items: Array<{ id: string; githubReleaseId: number }> }).items[0]!;
    const current = await request(`/operators/${operator.id}`);
    const currentRevision = (await current.json() as { operator: { revision: number } }).operator.revision;
    const first = await request(`/operators/${operator.id}/installations`, 'POST', { name: 'inactive', policy, revision: currentRevision });
    expect(first.status).toBe(201);
    const next = await request(`/operators/${operator.id}`);
    const nextRevision = (await next.json() as { operator: { revision: number } }).operator.revision;
    const second = await request(`/operators/${operator.id}/installations`, 'POST', { name: 'active', policy, revision: nextRevision });
    const active = await second.json() as { id: string; revision: number };
    expect(second.status).toBe(201);
    const promoted = await request(`/installations/${active.id}/promote`, 'POST', { releaseId: release.id, revision: active.revision });
    expect(promoted.status).toBe(200);
    const pinned = await promoted.json() as { revision: number };
    const enabled = await request(`/installations/${active.id}/enable`, 'POST', { enabled: true, revision: pinned.revision });
    expect(enabled.status).toBe(200);
    const enabledRevision = (await enabled.json() as { revision: number }).revision;
    const sourceRow = ctx.storage.sql.exec<{ data: string; manifest: string }>('SELECT data,manifest FROM operator_releases WHERE id=?', release.id).one();
    const verifiedPurpose = (JSON.parse(sourceRow.manifest) as { description: string }).description;
    ctx.storage.sql.exec('INSERT INTO operator_releases VALUES(?,?,?,?)', 'zz-other-release', operator.id,
      JSON.stringify({ ...JSON.parse(sourceRow.data), id: 'zz-other-release' }),
      JSON.stringify({ ...JSON.parse(sourceRow.manifest), name: 'Wrong version', description: 'An unrelated version with a different purpose.' }));
    const catalog = await request('/operators');
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ items: [expect.objectContaining({ id: operator.id, installationCount: 2,
      installedGithubReleaseId: release.githubReleaseId, installedTagName: 'v1', installedPublishedAt: '2026-09-21T12:00:00Z', description: verifiedPurpose })] });
    // Simulate a catalog written before package-authored metadata was searchable.
    ctx.storage.sql.exec('UPDATE operator_catalog SET search=? WHERE id=?', `${registration.repositoryUrl} ${operator.id}`, operator.id);
    ctx.storage.sql.exec('DELETE FROM operator_search WHERE id=?', operator.id);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS operator_search_schema (version INTEGER PRIMARY KEY)');
    ctx.storage.sql.exec('DELETE FROM operator_search_schema');
    for (const term of ['Review operator', 'Review fixture']) {
      const results = await request(`/operators?query=${encodeURIComponent(term)}`);
      expect(results.status).toBe(200);
      expect(await results.json()).toMatchObject({ items: [expect.objectContaining({ id: operator.id })], cursor: null });
    }
    expect(await (await request('/operators?query=Wrong%20version')).json()).toMatchObject({ items: [], cursor: null });
    identity.email = 'ungranted@example.test';
    expect((await request('/operators?query=Review%20operator')).status).toBe(404);
    identity.email = 'manager@example.test';
    const disabled = await request(`/installations/${active.id}/enable`, 'POST', { enabled: false, revision: enabledRevision });
    expect(disabled.status).toBe(200);
    expect(await (await request('/operators?query=Review%20operator')).json()).toMatchObject({ items: [], cursor: null });
    // REQ-OPERATOR-086 AC6/7: configuration inspection does not confer execution readiness.
    const registry = new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) });
    expect(await registry.resolveManagementExecution(active.id)).toEqual({ ok: false, reason: 'disabled' });
    expect(await registry.resolveManagementConfiguration(active.id)).toMatchObject({ ok: true, value: {
      installation: { id: active.id, enabled: false, releaseId: release.id }, release: { id: release.id },
      manifestJson: sourceRow.manifest,
    } });
    ctx.storage.sql.exec('UPDATE operator_releases SET data=? WHERE id=?',
      JSON.stringify({ ...JSON.parse(sourceRow.data), approved: false }), release.id);
    expect(await registry.resolveManagementConfiguration(active.id)).toEqual({ ok: false, reason: 'artifact-unapproved' });
  }));

  it('returns only authorized catalog records in bounded cursor pages', async () => withManagementApi(async request => {
    await configureControls(request);
    expect((await request('/operators?limit=101')).status).toBe(400);
    const page = await request('/operators?limit=50&query=review&profile=conductor&realm=internal&state=disabled');
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ items: [], cursor: null });
  }));
});
