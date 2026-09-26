import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import routes from '../../routes/operator-activities';

const claims = {
  subject: 'owner-subject', email: 'owner@example.test', issuer: 'https://access.example.test',
  audiences: ['account-audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
  expiresAt: Math.floor(Date.now() / 1000) + 300,
};
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  requireOperatorHumanContext: async () => ({ human: claims, accessJwt: 'private.access.jwt' }),
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
    getBrowserDetail: vi.fn(async () => ({ ...summary, checkpoint: { step: 1 }, result: null })),
    inspectFailedDispatcherReason: vi.fn(async () => ({ reason: 'Synthetic fixture failure',
      operationCount: 1, denialCode: 'ROUTE_NOT_ELIGIBLE' })),
    collectBrowserResult: vi.fn(async () => ({ ok: true, detail: { ...summary, executionStatus: 'completed', result: { report: 'ready' } } })),
  };
  const registry = {
    listOwnedActivities: vi.fn(async () => [summary]),
    getOwnedActivity: vi.fn(async (_ownerId: string, activityId: string) => activityId === summary.activityId ? summary : null),
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
  const request = (path = '', method = 'GET', body?: unknown, csrf = true, bindings: Env = env) => app.request(
    `https://enterprise.example.test/api/operator-activities${path}`,
    { method, headers: {
      'content-type': 'application/json', 'cf-access-authenticated-user-email': claims.email,
      ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings,
    { waitUntil, passThroughOnException: vi.fn(), props: {}, exports: { OperatorRuntimeCapability: loopback } },
  );
  return { activity, registry, env, request, waitUntil, loopback };
}

beforeEach(() => vi.clearAllMocks());

describe('REQ-OPERATOR-027: authenticated owned activity browser surfaces', () => {
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

  it('limits temporary failed-submission inspection to the owner on Enterprise with a deliberate read header', async () => {
    const { request, registry, env } = fixture();
    const owned = await request('/activity-1/diagnostic');
    expect(owned.status).toBe(200);
    expect(owned.headers.get('cache-control')).toBe('no-store');
    expect(await owned.json()).toEqual({ reason: 'Synthetic fixture failure',
      operationCount: 1, denialCode: 'ROUTE_NOT_ELIGIBLE' });
    registry.getOwnedActivity.mockResolvedValueOnce(null);
    expect((await request('/activity-1/diagnostic')).status).toBe(404);
    expect((await request('/activity-1/diagnostic', 'GET', undefined, false)).status).toBe(403);
    expect((await request('/activity-1/diagnostic', 'GET', undefined, true,
      { ...env, ENTERPRISE_MODE: 'inactive' })).status).toBe(404);
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
