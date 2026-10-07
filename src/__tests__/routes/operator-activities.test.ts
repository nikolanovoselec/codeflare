import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import routes from '../../routes/operator-activities';
import { operatorOwnerKey } from '../../operators/browser-activity';

const claims = {
  subject: 'owner-subject', email: 'owner@example.test', issuer: 'https://access.example.test',
  audiences: ['account-audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};
const accessState = vi.hoisted(() => ({ active: true }));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireOperatorHumanContext: async () => {
    if (!accessState.active) throw new AppError('FORBIDDEN', 403, 'Human Access authentication required');
    return { human: claims, accessJwt: 'private.access.jwt' };
  },
  operatorAccessSessionCurrent: async () => accessState.active,
  authenticateRequest: async (_request: Request, bindings: Env) => {
    const record = JSON.parse((await bindings.KV.get(`user:${claims.email}`)) ?? '{}') as { role?: string };
    return { user: { email: claims.email, role: record.role }, bucketName: 'owner-bucket' };
  },
}));
const orchestration = vi.hoisted(() => ({
  prepare: vi.fn(async () => ({ activityId: 'prepared-activity', startCapability: 'p'.repeat(43), startExpiresAt: 1_900_000_000_000 })),
  run: vi.fn(async (_activityId: string, _env: Env, _bindCapability: unknown) => {}),
}));
vi.mock('../../operators/orchestrator', async importOriginal => ({
  ...await importOriginal<typeof import('../../operators/orchestrator')>(),
  prepareOperatorActivity: orchestration.prepare,
  runOperatorActivity: orchestration.run,
}));

const summary = {
  activityId: 'activity-1', operatorId: 'reviewer', executionStatus: 'running', cleanupStatus: 'pending',
  collectionStatus: 'unavailable', attention: false, sessionId: 'session-1', source: 'Repository dispatch',
  updatedAt: 1_800_000_000_000,
};

function fixture() {
  const activity = {
    ownsPrepared: vi.fn(async () => true),
    getPreparedInstallationId: vi.fn(async () => null),
    start: vi.fn(async () => ({ ok: true, phase: 'queued' })),
    cancelDrive: vi.fn(async () => ({ ok: true, state: { status: 'cancel-requested' } })),
    getBrowserDetail: vi.fn(async (): Promise<typeof summary & { checkpoint: unknown; result: unknown }> =>
      ({ ...summary, checkpoint: { step: 1 }, result: null })),
    getBrowserSummary: vi.fn(async (_ownerKey: string): Promise<(typeof summary & {
      operatorName?: string; context?: string }) | null> => null),
    collectBrowserResult: vi.fn(async () => ({ ok: true, detail: { ...summary, executionStatus: 'completed', result: { report: 'ready' } } })),
    publishRenovateAssessment: vi.fn(async () => ({ ok: true, phase: 'reserved' })),
  };
  const registry = {
    listOwnedActivities: vi.fn(async () => [summary]),
    listOwnedActivityPage: vi.fn(async (_owner: string, _cursor: string | null): Promise<{
      items: typeof summary[]; nextCursor: string | null; workingCount: number;
      unreadCount: number; latestSequence: number }> =>
      ({ items: [summary], nextCursor: null, workingCount: 1, unreadCount: 1, latestSequence: 1 })),
    acknowledgeOwnedActivities: vi.fn(async () => ({ unreadCount: 0 })),
    getOwnedActivity: vi.fn(async (_ownerId: string, activityId: string) => activityId === summary.activityId ? summary : null),
    resolveManagementExecution: vi.fn(async (_id: string): Promise<unknown> => ({ ok: false, reason: 'not-found' })),
  };
  const kv = createMockKV();
  kv._store.set('user:owner@example.test', JSON.stringify({ role: 'user', accessTier: 'advanced' }));
  const env = {
    ENTERPRISE_MODE: 'active', KV: kv,
    OPERATOR_REGISTRY: { getByName: () => registry },
    OPERATOR_ACTIVITY: { getByName: () => activity },
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) => error instanceof AppError
    ? c.json(error.toJSON(), error.statusCode as never)
    : c.json({ error: 'Internal error' }, 500));
  app.route('/api/operator-activities', routes);
  const waitUntil = vi.fn();
  const loopback = vi.fn(({ props }: { props: { activityId: string; generation: number } }) =>
    ({ fetch: vi.fn(), props }) as unknown as Fetcher);
  let githubTransport: (request: Request) => Promise<Response> = async () => Response.json({
    id: 424242, full_name: 'acme/updates', default_branch: 'trunk' });
  const setGithub = (handler: typeof githubTransport) => { githubTransport = handler; };
  const request = (path = '', method = 'GET', body?: unknown, csrf = true, bindings: Env = env) => app.request(
    `https://enterprise.example.test/api/operator-activities${path}`,
    { method, headers: {
      'content-type': 'application/json', 'cf-access-authenticated-user-email': claims.email,
      ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings,
    { waitUntil, passThroughOnException: vi.fn(), props: {}, exports: { OperatorRuntimeCapability: loopback, GitHubInterceptor: () => ({ fetch: (request: Request) => githubTransport(request) }) } },
  );
  return { activity, registry, env, kv, request, waitUntil, loopback, setGithub };
}

beforeEach(() => { vi.clearAllMocks(); accessState.active = true; });

describe('REQ-OPERATOR-027: authenticated owned activity browser surfaces', () => {
  it('REQ-OPERATOR-027: retired private failure inspection returns 404 for the approved owner', async () => {
    const f = fixture();
    const previousEmail = claims.email;
    try {
      claims.email = 'nikola.novoselec@gmail.com';
      f.env.CLOUDFLARE_WORKER_NAME = 'codeflare-enterprise-integration';
      f.registry.getOwnedActivity.mockResolvedValue({ ...summary, activityId: '9024a801-8bbd-426a-8330-59fdf5b8d688' });
      const response = await f.request('/9024a801-8bbd-426a-8330-59fdf5b8d688/failure-inspection');
      expect(response.status).toBe(404);
    } finally { claims.email = previousEmail; }
  });
  it('previews only an enabled, authorized pinned Renovate Dispatcher without creating an Activity or exposing credentials', async () => {
    const { request, registry, activity } = fixture();
    const selection = { operator: { id: 'operator-1', profile: 'dispatcher', repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher',
      invokers: { users: [claims.email], groups: [] } },
      release: { tagName: 'v0.1.2', githubReleaseId: 17 }, manifestJson: JSON.stringify({ name: 'Renovate Dispatcher', inputSchema: { type: 'object', additionalProperties: false,
        required: ['repository', 'pullRequest'], properties: { repository: { type: 'string' }, pullRequest: { type: 'integer', minimum: 1 } } } }),
      installation: { id: 'installation-1', releaseId: 'release-1' } };
    registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: selection });
    const preview = await request('/installations/installation-1/preview');
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ name: 'Renovate Dispatcher', version: 'v0.1.2', guidedAssessment: true, guidedMode: 'legacy-pull-request' });
    const schema = { type: 'object', additionalProperties: false, required: ['repository'],
      properties: { repository: { type: 'string', maxLength: 201, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' } } };
    const installed = (inputSchema: unknown) => ({ ...selection,
      manifestJson: JSON.stringify({ name: 'Renovate Dispatcher', inputSchema }) });
    registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: installed(schema) });
    expect(await (await request('/installations/installation-1/preview?guidedMode=legacy-pull-request')).json())
      .toMatchObject({ guidedAssessment: true, guidedMode: 'repository', version: 'v0.1.2' });
    for (const unsupportedSchema of [undefined, { ...schema, additionalProperties: true },
      { ...schema, required: [] }, { ...schema, properties: { ...schema.properties, surprise: { type: 'string' } } },
      { ...schema, properties: { repository: { ...schema.properties.repository, maxLength: 256 } } }]) {
      registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: installed(unsupportedSchema) });
      expect(await (await request('/installations/installation-1/preview')).json())
        .toMatchObject({ guidedAssessment: false, guidedMode: null });
    }
    expect(activity.start).not.toHaveBeenCalled();
    expect(orchestration.prepare).not.toHaveBeenCalled();
    registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: { ...selection, operator: { ...selection.operator, invokers: { users: [], groups: [] } } } });
    expect((await request('/installations/installation-1/preview')).status).toBe(404);
    registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: { ...selection, manifestJson: JSON.stringify({ name: 'Custom Dispatcher' }) } });
    const unsupported = await request('/installations/installation-1/preview');
    expect(unsupported.status).toBe(200);
    expect(await unsupported.json()).toMatchObject({ name: 'Custom Dispatcher', guidedAssessment: false });
    registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: { ...selection,
      operator: { ...selection.operator, repositoryUrl: 'https://github.com/elsewhere/dispatcher' } } });
    expect(await (await request('/installations/installation-1/preview')).json()).toMatchObject({ guidedAssessment: false });
  });
  it('returns a side-effect-free safe summary collection for the exact human account', async () => {
    const { request, registry, activity } = fixture();
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [summary] });
    expect(registry.listOwnedActivities).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(activity.getBrowserDetail).not.toHaveBeenCalled();
    expect(activity.start).not.toHaveBeenCalled();
    expect(activity.cancelDrive).not.toHaveBeenCalled();
    expect(activity.collectBrowserResult).not.toHaveBeenCalled();
    expect(JSON.stringify(await registry.listOwnedActivities.mock.results[0]?.value)).not.toContain('private.access.jwt');
  });

  it('REQ-OPERATOR-059: opening acknowledges only the authenticated owner through the observed sequence and requires CSRF', async () => {
    const { request, registry } = fixture();
    const page = await request('?limit=5');
    expect(await page.json()).toMatchObject({ unreadCount: 1, latestSequence: 1 });
    expect((await request('/read', 'POST', { through: 1 }, false)).status).toBe(403);
    expect((await request('/read', 'POST', { through: -1 })).status).toBe(400);
    const acknowledged = await request('/read', 'POST', { through: 1 });
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toEqual({ unreadCount: 0 });
    expect(registry.acknowledgeOwnedActivities).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), 1);
  });

  it('REQ-OPERATOR-061: only a current authorized admin session can activate an immutable server-timed Komodo scan', async () => {
    const { request, kv, registry, env } = fixture();
    const observed = { activatedAt: new Date().toISOString(), repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk' };
    (registry as unknown as { activateProspectiveRenovate: (input: unknown) => Promise<unknown> })
      .activateProspectiveRenovate = async () => ({ ok: true, ...observed, registrationId: 'registered-admin' });
    (env as unknown as { USAGE_DB: unknown }).USAGE_DB = { prepare: () => ({ bind: () => ({ first: async () => ({
      lifecycle_state: 'running', lifecycle_generation: 3, owner_key: 'owner-bucket', session_id: 'session0001',
      created_at: new Date().toISOString(), last_accessed_at: new Date().toISOString(), response_revision: 0,
      observation_sequence: 0, workspace: 'default', terminal_mode: 'terminal', editor_ready: 1, editor_ready_error: 0,
    }) }) }) };
    kv._store.set('user:owner@example.test', JSON.stringify({ role: 'admin' }));
    (env as unknown as { CONTAINER: unknown }).CONTAINER = { idFromName: (value: string) => value,
      get: () => ({ armRenovateScan: async () => ({ ok: true, activatedAt: observed.activatedAt }) }) };
    registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: { installation: { id: 'dispatcher-install',
      revision: 1, enabled: true, configurationJson: JSON.stringify({ renovate: { repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 900 } }) }, operator: { profile: 'dispatcher', invokers: { users: [claims.email], groups: [] } },
      release: { bundleDigest: 'a'.repeat(64) }, controlsRevision: 1 } });
    const command = { installationId: 'dispatcher-install', sessionId: 'session0001', sessionGeneration: 3 };
    const response = await request('/renovate/activation', 'POST', command);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ activatedAt: expect.any(String), repositoryId: 424242 });
    expect((await request('/renovate/activation', 'POST', { ...command, activatedAt: '2000-01-01T00:00:00Z' })).status)
      .toBe(400);
    expect((await request('/renovate/activation', 'POST', command, false)).status).toBe(403);
    registry.resolveManagementExecution.mockResolvedValue({ ok: false, reason: 'disabled' });
    expect((await request('/renovate/activation', 'POST', command)).status).toBe(403);
    kv._store.set('user:owner@example.test', JSON.stringify({ role: 'user' }));
    expect((await request('/renovate/activation', 'POST', command)).status).toBe(403);
    accessState.active = false;
    expect((await request('/renovate/activation', 'POST', command)).status).toBe(403);
  });

  it('REQ-OPERATOR-041: reads detail and result only after the durable index proves exact ownership without mutation', async () => {
    const { request, registry, activity, waitUntil } = fixture();
    const detail = await request('/activity-1');
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ activityId: 'activity-1', checkpoint: { step: 1 }, result: null });
    const result = await request('/activity-1/result');
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ activityId: 'activity-1', checkpoint: { step: 1 }, result: null });

    registry.getOwnedActivity.mockResolvedValueOnce(null);
    expect((await request('/another-owner/result')).status).toBe(404);
    expect(activity.start).not.toHaveBeenCalled();
    expect(activity.cancelDrive).not.toHaveBeenCalled();
    expect(activity.collectBrowserResult).not.toHaveBeenCalled();
    expect(orchestration.prepare).not.toHaveBeenCalled();
    expect(orchestration.run).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('REQ-OPERATOR-041: browser result stays owner-scoped even when another account knows the ID', async () => {
    const { request, registry, activity } = fixture();
    registry.getOwnedActivity.mockResolvedValue(null);
    const denied = await request('/activity-1/result');
    expect(denied.status).toBe(404);
    expect(activity.getBrowserDetail).not.toHaveBeenCalled();
    expect(activity.collectBrowserResult).not.toHaveBeenCalled();
  });

  it('REQ-OPERATOR-027: recovers missing historical display metadata on the owner page without exposing result bytes', async () => {
    const { request, activity } = fixture();
    const ownerKey = await operatorOwnerKey(claims);
    activity.getBrowserSummary.mockImplementation(async key => key === ownerKey
      ? { ...summary, operatorName: 'Renovate Dispatcher', context: 'owner/repo · PR #42',
          executionStatus: 'completed', updatedAt: summary.updatedAt + 1000 } : null);
    const response = await request('?limit=5');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ items: [{ activityId: 'activity-1',
      operatorName: 'Renovate Dispatcher', context: 'owner/repo · PR #42', executionStatus: 'running',
      updatedAt: summary.updatedAt }], nextCursor: null, workingCount: 1, unreadCount: 1, latestSequence: 1 });
    expect(JSON.stringify(payload)).not.toContain('checkpoint');
    expect(JSON.stringify(payload)).not.toContain('result');
    expect(await (await request()).json()).toEqual({ items: [summary] });
  });

  it('REQ-OPERATOR-027: preserves indexed status and existing metadata; ignores unavailable or mismatched Activity projections', async () => {
    const { request, registry, activity } = fixture();
    const indexed = { ...summary, operatorName: 'Pinned name', context: 'existing/repo · PR #7' };
    registry.listOwnedActivityPage.mockResolvedValue({ items: [indexed], nextCursor: 'activity-1',
      workingCount: 3, unreadCount: 2, latestSequence: 5 });
    activity.getBrowserSummary.mockResolvedValue({ ...summary, operatorName: 'Different name',
      context: 'other/repo · PR #8', executionStatus: 'completed' });
    expect(await (await request('?limit=5')).json()).toMatchObject({ items: [{ operatorName: 'Pinned name',
      context: 'existing/repo · PR #7', executionStatus: 'running' }], nextCursor: 'activity-1',
      workingCount: 3, unreadCount: 2, latestSequence: 5 });
    const firstItem = async () => {
      const page = await (await request('?limit=5')).json() as { items: Array<Record<string, unknown>> };
      return page.items[0];
    };
    registry.listOwnedActivityPage.mockResolvedValue({ items: [summary], nextCursor: null,
      workingCount: 3, unreadCount: 2, latestSequence: 5 });
    activity.getBrowserSummary.mockResolvedValue({ ...summary, activityId: 'another-activity', operatorName: 'Foreign name' });
    expect(await firstItem()).not.toHaveProperty('operatorName');
    activity.getBrowserSummary.mockResolvedValue({ ...summary, operatorId: 'foreign-operator', operatorName: 'Foreign name' });
    expect(await firstItem()).not.toHaveProperty('operatorName');
    activity.getBrowserSummary.mockResolvedValue(null);
    expect(await firstItem()).toEqual(summary);
    activity.getBrowserSummary.mockRejectedValueOnce(new Error('Read unavailable'));
    expect(await firstItem()).toEqual(summary);
    const nameOnly = { ...summary, operatorName: 'Pinned name' };
    registry.listOwnedActivityPage.mockResolvedValue({ items: [nameOnly], nextCursor: null,
      workingCount: 3, unreadCount: 2, latestSequence: 5 });
    activity.getBrowserSummary.mockResolvedValue({ ...summary, operatorName: 'Other name',
      context: 'owner/repo · PR #42' });
    expect(await firstItem()).toEqual(nameOnly);
    activity.getBrowserSummary.mockResolvedValue({ ...summary, operatorName: 'Pinned name',
      context: 'owner/repo · PR #42' });
    expect(await firstItem()).toMatchObject({ operatorName: 'Pinned name', context: 'owner/repo · PR #42' });
    const contextOnly = { ...summary, context: 'pinned/repo · PR #7' };
    registry.listOwnedActivityPage.mockResolvedValue({ items: [contextOnly], nextCursor: null,
      workingCount: 3, unreadCount: 2, latestSequence: 5 });
    activity.getBrowserSummary.mockResolvedValue({ ...summary, operatorName: 'Other name',
      context: 'owner/repo · PR #42' });
    expect(await firstItem()).toEqual(contextOnly);
    activity.getBrowserSummary.mockResolvedValue({ ...summary, operatorName: 'Other name',
      context: 'pinned/repo · PR #7' });
    expect(await firstItem()).toMatchObject({ operatorName: 'Other name', context: 'pinned/repo · PR #7' });
  });

  it('REQ-OPERATOR-027: exposes five owner-scoped entries and all-working count using a validated stable cursor', async () => {
    const { request, registry } = fixture();
    registry.listOwnedActivityPage.mockImplementation(async (_owner: string, cursor: string | null) => ({
      items: cursor ? [{ ...summary, activityId: 'activity-6' }] : Array.from({ length: 5 }, (_, i) =>
        ({ ...summary, activityId: `activity-${i + 1}` })), nextCursor: cursor ? null : 'activity-5', workingCount: 92,
      unreadCount: 3, latestSequence: 5 }));
    const first = await request('?limit=5');
    expect(first.status).toBe(200);
    const firstPage = await first.json() as { nextCursor: string | null; workingCount: number;
      items: Array<{ activityId: string }> };
    expect(firstPage).toMatchObject({ nextCursor: 'activity-5', workingCount: 92 });
    expect(firstPage.items.map(item => item.activityId))
      .toEqual(['activity-1', 'activity-2', 'activity-3', 'activity-4', 'activity-5']);
    const next = await request('?limit=5&after=activity-5');
    expect(await next.json()).toMatchObject({ items: [{ activityId: 'activity-6' }], workingCount: 92 });
    expect(registry.listOwnedActivityPage).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/), 'activity-5');
    expect((await request('?limit=5&after=invalid%20cursor')).status).toBe(400);
    registry.listOwnedActivityPage.mockRejectedValueOnce(new Error('Activity history changed'));
    const stale = await request('?limit=5&after=activity-5');
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'HISTORY_CHANGED' });
    expect((await request('?limit=6')).status).toBe(400);
  });

  it('REQ-OPERATOR-041: browser GET preserves original Review reports and settled Dispatcher assessment without collection', async () => {
    const { request, activity } = fixture();
    const review = { schemaVersion: 1, activityId: 'activity-1', activityGeneration: 1, generation: 1,
      repositoryId: 138, pullRequest: 34, status: 'incomplete', cleanup: 'stopped',
      originalReports: [{ lane: 'code-reviewer', findings: [{ id: 'unresolved', message: 'Still open' }] }],
      history: { clear: false }, presentation: { check: { conclusion: 'failure', summary: 'Review findings' } } };
    activity.getBrowserDetail.mockResolvedValueOnce({ ...summary, executionStatus: 'completed',
      checkpoint: null, result: review });
    const first = await request('/activity-1/result');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ result: { originalReports: review.originalReports,
      presentation: { check: { conclusion: 'failure' } } } });
    const assessment = { repository: 'owner/repo', pullRequest: 17, readOnly: true,
      evidence: { complete: false, stale: false, truncated: false, bot: 'renovate[bot]' } };
    activity.getBrowserDetail.mockResolvedValueOnce({ ...summary, executionStatus: 'completed',
      checkpoint: null, result: assessment });
    const second = await request('/activity-1/result');
    expect(await second.json()).toMatchObject({ result: assessment });
    expect(activity.collectBrowserResult).not.toHaveBeenCalled();
  });

  it('does not expose the retired failed-submission diagnostic', async () => {
    const { request } = fixture();
    expect((await request('/activity-1/diagnostic')).status).toBe(404);
  });

  it('returns detail and collects a result only after the durable index proves exact ownership', async () => {
    const { request, registry, activity } = fixture();
    const detail = await request('/activity-1');
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({ activityId: 'activity-1', checkpoint: { step: 1 }, result: null });
    expect(JSON.stringify(detailBody)).not.toContain('private.access.jwt');
    const result = await request('/activity-1/result', 'POST', {});
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ activityId: 'activity-1', executionStatus: 'completed', result: { report: 'ready' } });

    registry.getOwnedActivity.mockResolvedValueOnce(null);
    expect((await request('/another-owner')).status).toBe(404);
    expect(activity.getBrowserDetail).toHaveBeenCalledTimes(1);
    expect(activity.collectBrowserResult).toHaveBeenCalledTimes(1);
  });

  it('prepares a bounded activity through the verified human request boundary', async () => {
    const { request } = fixture();
    const response = await request('', 'POST', { operatorId: 'reviewer', invocation: { repository: 'owner/repo' } });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ activityId: 'prepared-activity', startCapability: 'p'.repeat(43) });
    expect(orchestration.prepare).toHaveBeenCalledWith({ operatorId: 'reviewer', invocation: { repository: 'owner/repo' } },
      { human: claims, accessJwt: 'private.access.jwt' }, expect.anything());
  });

  it('starts a just-prepared activity only through its exact durable owner binding', async () => {
    const { request, activity, waitUntil } = fixture();
    const prepared = await request('', 'POST', { operatorId: 'reviewer', invocation: { repository: 'owner/repo' } });
    expect(prepared.status).toBe(201);
    const body = await prepared.json() as { activityId: string; startCapability: string };

    const started = await request(`/${body.activityId}/start`, 'POST', { capability: body.startCapability });
    expect(started.status).toBe(200);
    expect(activity.ownsPrepared).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(activity.start).toHaveBeenCalledWith(body.startCapability);
    expect(orchestration.run).toHaveBeenCalledWith(body.activityId, expect.anything(), expect.any(Function));
    const bindLoopback = orchestration.run.mock.calls[0]?.[2] as (activityId: string, generation: number) => Fetcher;
    const capability = bindLoopback(body.activityId, 3);
    expect(capability).toMatchObject({ props: { activityId: body.activityId, generation: 3 } });
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it('continues only durable waiting work through an explicit owner-authenticated POST', async () => {
    const { request, activity, waitUntil } = fixture();
    activity.getBrowserDetail.mockResolvedValueOnce({ ...summary, executionStatus: 'waiting',
      checkpoint: { step: 2 }, result: null });

    const continued = await request('/activity-1/continue', 'POST', {});

    expect(continued.status).toBe(202);
    expect(await continued.json()).toEqual({ ok: true, phase: 'queued' });
    expect(orchestration.run).toHaveBeenCalledWith('activity-1', expect.anything(), expect.any(Function));
    expect(waitUntil).toHaveBeenCalledOnce();

    activity.getBrowserDetail.mockResolvedValueOnce({ ...summary, checkpoint: { step: 1 }, result: null });
    expect((await request('/activity-1/continue', 'POST', {})).status).toBe(409);
    expect((await request('/activity-1/continue', 'POST', {}, false)).status).toBe(403);
    expect(orchestration.run).toHaveBeenCalledTimes(1);
  });

  it('uses CSRF-protected POST start and cancellation while composing the existing activity methods', async () => {
    const { request, activity, waitUntil } = fixture();
    expect((await request('/activity-1/start', 'POST', { capability: 's'.repeat(43) }, false)).status).toBe(403);
    expect((await request('/activity-1/start', 'GET')).status).toBe(404);

    const started = await request('/activity-1/start', 'POST', { capability: 's'.repeat(43) });
    expect(started.status).toBe(200);
    expect(activity.start).toHaveBeenCalledWith('s'.repeat(43));
    expect(orchestration.run).toHaveBeenCalledWith('activity-1', expect.anything(), expect.any(Function));
    expect(waitUntil).toHaveBeenCalledOnce();
    const cancelled = await request('/activity-1/cancel', 'POST', {});
    expect(cancelled.status).toBe(200);
    expect(activity.cancelDrive).toHaveBeenCalledOnce();
  });

  it('is unavailable outside enterprise without reading the activity index', async () => {
    const { request, registry, env } = fixture();
    expect((await request('', 'GET', undefined, true, { ...env, ENTERPRISE_MODE: 'inactive' })).status).toBe(404);
    expect(registry.listOwnedActivities).not.toHaveBeenCalled();
  });
});

describe('REQ-OPERATOR-060: explicit authenticated publisher admission', () => {
  const command = { sessionId: 'session-1', sessionGeneration: 3 };

  it('admits only a current admin and exact owned Activity with a CSRF-protected session command', async () => {
    const f = fixture();
    expect((await f.request('/activity-1/publish', 'POST', command)).status).toBe(403);
    expect((await f.request('/activity-1/publish', 'POST', command, false)).status).toBe(403);
    f.kv._store.set('user:owner@example.test', JSON.stringify({ role: 'admin', accessTier: 'advanced' }));
    accessState.active = false;
    expect((await f.request('/activity-1/publish', 'POST', command)).status).toBe(403);
    accessState.active = true;
    f.registry.getOwnedActivity.mockResolvedValueOnce(null);
    expect((await f.request('/activity-1/publish', 'POST', command)).status).toBe(404);
    expect((await f.request('/activity-1/publish', 'POST', { ...command, repository: 'foreign/repo' })).status).toBe(400);
    const response = await f.request('/activity-1/publish', 'POST', command);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect((await f.request('/activity-1/result')).status).toBe(200);
  });
});


describe('REQ-OPERATOR-061: configured Renovate run settings', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['repository'], properties: {
    repository: { type: 'string', maxLength: 201, pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' } } };
  it('projects only the configured repository through authorized guided preview and ignores URL overrides', async () => {
    const f = fixture();
    const selected = { operator: { id: 'dispatcher', profile: 'dispatcher',
      repositoryUrl: 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher',
      invokers: { users: [claims.email], groups: [] } }, installation: { id: 'install', enabled: true,
      configurationJson: JSON.stringify({ renovate: { repository: 'acme/updates', automaticRuns: false,
        repetitionIntervalSeconds: 900 }, privateSetting: 'DO_NOT_PROJECT' }) },
      release: { tagName: 'v1', githubReleaseId: 17 }, manifestJson: JSON.stringify({ id: 'renovate-dispatcher',
        profile: 'dispatcher', intentVersion: '3', name: 'Renovate Dispatcher', inputSchema: schema }) };
    f.registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: selected });
    const preview = await f.request('/installations/install/preview?repository=other/repo');
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ name: 'Renovate Dispatcher', version: 'v1', guidedAssessment: true,
      guidedMode: 'repository', configuredRepository: 'acme/updates' });
    f.registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: { ...selected,
      installation: { ...selected.installation, configurationJson: '{}' } } });
    expect(await (await f.request('/installations/install/preview')).json()).toEqual({
      name: 'Renovate Dispatcher', version: 'v1', guidedAssessment: true, guidedMode: 'repository' });
    f.registry.resolveManagementExecution.mockResolvedValue({ ok: true, value: { ...selected,
      operator: { ...selected.operator, invokers: { users: [], groups: [] } } } });
    expect((await f.request('/installations/install/preview')).status).toBe(404);
  });
});


describe('REQ-OPERATOR-061: configured Renovate run settings', () => {
  function activationFixture() {
    const f = fixture();
    const selected = { installation: { id: 'dispatcher-install', revision: 2, enabled: true,
      policy: { resourceProfileId: null }, configurationJson: JSON.stringify({ renovate: {
        repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 900 } }) },
      operator: { operatorId: 'dispatcher', revision: 1, profile: 'dispatcher', invokers: { users: [claims.email], groups: [] } },
      release: { id: 'release', bundleDigest: 'a'.repeat(64) }, controlsRevision: 1,
      manifestJson: JSON.stringify({ id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '3' }) };
    f.registry.resolveManagementExecution.mockImplementation(async () => ({ ok: true, value: selected }));
    const admitted: unknown[] = [], armed: unknown[] = [], reads: Request[] = [];
    Object.assign(f.registry, { activateProspectiveRenovate: async (input: unknown) => {
      admitted.push(input); return { ok: true, registrationId: 'scan-configured', activatedAt: '2026-09-28T00:00:00.000Z',
        repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk' }; } });
    Object.assign(f.env, { USAGE_DB: { prepare: () => ({ bind: () => ({ first: async () => ({
      lifecycle_state: 'running', lifecycle_generation: 3, owner_key: 'owner-bucket', session_id: 'session0001',
      created_at: new Date().toISOString(), last_accessed_at: new Date().toISOString(), response_revision: 0,
      observation_sequence: 0, workspace: 'default', terminal_mode: 'terminal', editor_ready: 1, editor_ready_error: 0,
    }) }) }) }, CONTAINER: { idFromName: (name: string) => name, get: () => ({
      armRenovateScan: async (input: unknown) => { armed.push(input); return { ok: true }; } }) } });
    f.kv._store.set('user:owner@example.test', JSON.stringify({ role: 'admin' }));
    f.setGithub(async request => { reads.push(request); return Response.json({
      id: 424242, full_name: 'acme/updates', default_branch: 'trunk' }); });
    return { ...f, selected, admitted, armed, reads, command: {
      installationId: 'dispatcher-install', sessionId: 'session0001', sessionGeneration: 3 } };
  }
  it('authenticates configured repository metadata with one fixed parent GET before activation', async () => {
    const f = activationFixture();
    const response = await f.request('/renovate/activation', 'POST', f.command);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ repositoryId: 424242 });
    expect(f.reads.map(request => ({ url: request.url, method: request.method, redirect: request.redirect })))
      .toEqual([{ url: 'https://api.github.com/repos/acme/updates', method: 'GET', redirect: 'manual' }]);
    expect(f.admitted).toHaveLength(1);
    expect(f.armed).toHaveLength(1);
  });
  it.each(['unset', 'off', 'redirect', 'foreign-name', 'unsafe-id', 'no-branch', 'changed-selection', 'revoked-session'])
    ('denies %s before persisting or arming a registration', async fault => {
      const f = activationFixture();
      if (fault === 'unset') f.selected.installation.configurationJson = '{}';
      if (fault === 'off') f.selected.installation.configurationJson = JSON.stringify({ renovate: { repository: 'acme/updates', automaticRuns: false } });
      f.setGithub(async () => {
        if (fault === 'changed-selection') f.selected.installation.revision++;
        if (fault === 'revoked-session') accessState.active = false;
        if (fault === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://api.github.com/repos/other/repo' } });
        return Response.json({ id: fault === 'unsafe-id' ? Number.MAX_SAFE_INTEGER + 1 : 424242,
          full_name: fault === 'foreign-name' ? 'other/repo' : 'acme/updates', default_branch: fault === 'no-branch' ? '' : 'trunk' });
      });
      expect((await f.request('/renovate/activation', 'POST', f.command)).status).not.toBe(202);
      expect(f.admitted).toEqual([]);
      expect(f.armed).toEqual([]);
    });
  it('cannot report activation success when schedule acknowledgement fails', async () => {
    const f = activationFixture();
    Object.assign(f.env, { CONTAINER: { idFromName: (name: string) => name,
      get: () => ({ armRenovateScan: async () => { throw Error('lost schedule acknowledgement'); } }) } });
    expect((await f.request('/renovate/activation', 'POST', f.command)).status).not.toBe(202);
  });
});
