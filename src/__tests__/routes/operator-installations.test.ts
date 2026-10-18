import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { AppError } from '../../lib/error-types';
import routes from '../../routes/operator-activities';

const identity = vi.hoisted(() => ({ role: 'user', current: true,
  email: 'invoker@example.test', groups: [] as string[] }));
vi.mock('../../lib/access', async original => ({
  ...await original<typeof import('../../lib/access')>(),
  requireOperatorHumanContext: async () => {
    if (!identity.current) throw new AppError('FORBIDDEN', 403, 'Expired');
    return { human: { subject: 'human', email: identity.email, issuer: 'https://access.example.test',
      audiences: ['aud'], groups: identity.groups, issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 300 },
    accessJwt: 'PRIVATE_ACCESS_JWT' };
  },
  authenticateRequest: async () => ({ user: { role: identity.role, email: identity.email }, bucketName: 'bucket' }),
}));
const grant = (users: string[] = []) => ({ users, groups: [] as Array<{ issuer: string; id: string }> });
const schema = { type: 'object', additionalProperties: false, required: ['repository'], properties: {
  repository: { type: 'string', maxLength: 201, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' } } };
function fixture() {
  const operator = { id: 'visible-operator', profile: 'dispatcher', realm: 'internal', enabled: true, revision: 1,
    repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher', repositoryId: 1380652724,
    name: 'Renovate Dispatcher', managers: grant(), invokers: grant([identity.email]) };
  const hidden = { ...operator, id: 'hidden-operator', name: 'PRIVATE_OPERATOR', invokers: grant(), managers: grant() };
  const installed = { id: 'visible-install', operatorId: operator.id, name: 'Updates', revision: 7, enabled: true,
    releaseId: 'release-1', policy: { capabilities: ['fetch'], resourceProfileId: null }, approvedSourceRevision: 1,
    configurationJson: JSON.stringify({ renovate: { repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600 }, private: 'PRIVATE_CONFIGURATION' }) };
  const release = { id: 'release-1', operatorId: operator.id, githubReleaseId: 100, tagName: 'v0.1.27',
    approved: true, sourceRevision: 1, name: 'Renovate Dispatcher', version: '0.1.27',
    bundleDigest: 'a'.repeat(64), requestedCapabilities: ['fetch'] };
  const controls = { revision: 1, managers: grant(), ceiling: { capabilities: ['fetch'], resourceProfileIds: [] } };
  const catalog = { items: [operator, hidden], cursor: null as string | null };
  const manifests = { value: JSON.stringify({ id: 'renovate-dispatcher', profile: 'dispatcher', name: 'Renovate Dispatcher', intentVersion: '4', inputSchema: schema }) };
  const registry = {
    listManagementOperators: async ({ limit }: { limit: number }) => ({ ...catalog, items: catalog.items.slice(0, limit) }),
    listManagementInstallationPage: async () => ({ items: [{ ...installed },
      { ...installed, operatorId: hidden.id, id: 'PRIVATE_INSTALL' }], cursor: catalog.cursor }),
    getManagementInstallation: async (id: string) => id === installed.id ? { ok: true, value: { ...installed } }
      : id === 'PRIVATE_INSTALL' ? { ok: true, value: { ...installed, operatorId: hidden.id, id } }
        : { ok: false, reason: 'not-found' },
    getManagementControls: async () => controls,
    getManagementOperator: async (id: string) => id === operator.id ? { ok: true, value: operator }
      : id === hidden.id ? { ok: true, value: hidden } : { ok: false, reason: 'not-found' },
    getManagementInstallations: async (id: string) => [{ ...installed, operatorId: id, id: id === operator.id ? installed.id : 'PRIVATE_INSTALL' }],
    getManagementReleases: async (id: string) => [{ ...release, operatorId: id }],
    resolveManagementExecution: async (id: string) => id === installed.id && installed.enabled && release.approved
      ? { ok: true, value: { operator, installation: installed, release, manifestJson: manifests.value, controlsRevision: 1 } }
      : { ok: false, reason: 'disabled' },
    resolveManagementConfiguration: async (id: string) => id === installed.id && release.approved
      ? { ok: true, value: { operator, installation: installed, release, manifestJson: manifests.value, controlsRevision: 1 } }
      : { ok: false, reason: 'artifact-unapproved' },
  };
  const env = { ENTERPRISE_MODE: 'active', OPERATOR_REGISTRY: { getByName: () => registry },
    OPERATOR_ACTIVITY: { getByName: () => { throw new Error('Installed reads must not access Activities'); } } } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => error instanceof AppError ? c.json(error.toJSON(), error.statusCode as never)
    : c.json({ error: 'Internal error' }, 500));
  app.route('/api/operator-activities', routes);
  const request = (query = '', bindings = env, authenticated = true) => app.request(
    `https://enterprise.example.test/api/operator-activities/installations${query}`, {
      headers: authenticated ? { 'cf-access-authenticated-user-email': identity.email } : {},
    }, bindings);
  return { request, env, operator, hidden, installed, release, controls, catalog, manifests };
}
beforeEach(() => { identity.role = 'user'; identity.current = true; identity.email = 'invoker@example.test'; identity.groups = []; });

describe('REQ-OPERATOR-086 AC5/6: current-human installed operator projection', () => {
  it('lists invocation-only installations without requiring global management or exposing unrelated secrets', async () => {
    const f = fixture();
    const response = await f.request();
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value).toMatchObject({ items: [{ id: 'visible-install', operatorId: 'visible-operator',
      name: 'Renovate Dispatcher', installationName: 'Updates', version: 'v0.1.27', enabled: true, approved: true,
      canInvoke: true, canManage: false, guidedMode: 'repository', repository: 'acme/updates', automaticRuns: false }], cursor: null });
    const bytes = JSON.stringify(value);
    for (const secret of ['PRIVATE_CONFIGURATION', 'PRIVATE_ACCESS_JWT', 'PRIVATE_OPERATOR', 'PRIVATE_INSTALL']) expect(bytes).not.toContain(secret);
    expect(value).not.toHaveProperty('grants');
  });

  it('keeps eligible management visibility separate from invocation permission', async () => {
    const f = fixture(); f.operator.invokers = grant(); f.operator.managers = grant([identity.email]);
    f.controls.managers = grant([identity.email]);
    expect(await (await f.request()).json()).toMatchObject({ items: [{ id: 'visible-install', canManage: true, canInvoke: false }] });
  });

  it('does not expose installations to globally ineligible managers', async () => {
    const f = fixture(); f.operator.invokers = grant(); f.operator.managers = grant([identity.email]);
    expect(await (await f.request()).json()).toEqual({ items: [], cursor: null });
  });

  it('does not turn platform-admin management visibility into an invocation grant', async () => {
    const f = fixture(); identity.role = 'admin'; f.operator.invokers = grant();
    const response = await f.request(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [expect.objectContaining({ id: 'visible-install', canManage: true, canInvoke: false })] });
  });

  it('requires a current issuer-bound group claim, not a foreign group or stale identity', async () => {
    const f = fixture(); f.operator.invokers = { users: [], groups: [{ issuer: 'https://access.example.test', id: 'invokers' }] };
    expect(await (await f.request()).json()).toEqual({ items: [], cursor: null });
    identity.groups = ['invokers'];
    expect(await (await f.request()).json()).toMatchObject({ items: [{ id: 'visible-install', canInvoke: true }] });
    f.operator.invokers.groups[0].issuer = 'https://foreign.example.test';
    expect(await (await f.request()).json()).toEqual({ items: [], cursor: null });
    identity.current = false; expect((await f.request()).status).toBe(403);
  });

  it('does not claim disabled or unapproved installations are invocable, and never borrows another release pin', async () => {
    const f = fixture(); f.installed.enabled = false;
    expect(await (await f.request()).json()).toMatchObject({ items: [{ enabled: false, guidedMode: 'repository',
      repository: 'acme/updates', automaticRuns: false, repetitionIntervalSeconds: 3600 }] });
    expect((await f.request('/visible-install/preview')).status).toBe(404);
    f.installed.enabled = true; f.release.approved = false;
    expect(await (await f.request()).json()).toMatchObject({ items: [{ approved: false, guidedMode: null }] });
    f.installed.releaseId = 'missing-release';
    expect(await (await f.request()).json()).toMatchObject({ items: [{ approved: false, version: null }] });
  });

  it('preserves supported scheduling for a disabled manager-only installation without enabling invocation', async () => {
    const f = fixture(); f.installed.enabled = false;
    f.operator.invokers = grant(); f.operator.managers = grant([identity.email]); f.controls.managers = grant([identity.email]);
    const response = await f.request(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [{ id: f.installed.id, revision: 7, enabled: false,
      canInvoke: false, canManage: true, guidedMode: 'repository', automaticRuns: false, repetitionIntervalSeconds: 3600 }] });
    expect((await f.request('/visible-install/preview')).status).toBe(404);
  });

  it('rejects malformed, duplicate and foreign installation-list cursors without leaking hidden identities', async () => {
    const f = fixture();
    expect((await f.request('?cursor=invalid%2Fcursor')).status).toBe(400);
    expect((await f.request('?cursor=visible-operator&cursor=visible-operator')).status).toBe(400);
    const foreign = await f.request('?cursor=hidden-operator'); expect(foreign.status).toBe(404);
    expect(await foreign.text()).not.toContain('PRIVATE_OPERATOR');
    f.catalog.cursor = f.installed.id;
    expect(await (await f.request()).json()).toMatchObject({ cursor: 'visible-install' });
    expect((await f.request('?cursor=visible-install')).status).toBe(200);
    expect((await f.request('?cursor=PRIVATE_INSTALL')).status).toBe(404);
  });

  it('labels unsupported package scheduling instead of inventing a generic launcher', async () => {
    const f = fixture(); f.manifests.value = JSON.stringify({ name: 'Third-party package', inputSchema: { type: 'string' } });
    expect(await (await f.request()).json()).toMatchObject({ items: [{ guidedMode: null, automaticRuns: null }] });
  });

  it('retains enterprise and authenticated-human gates for installed reads', async () => {
    const f = fixture();
    expect((await f.request('', f.env, false)).status).toBe(401);
    expect((await f.request('', { ...f.env, ENTERPRISE_MODE: 'inactive' } as Env)).status).toBe(404);
  });
});
