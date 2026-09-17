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
  run: vi.fn(async () => {}),
}));
vi.mock('../../operators/orchestrator', () => ({
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
    start: vi.fn(async () => ({ ok: true, phase: 'queued' })),
    cancelDrive: vi.fn(async () => ({ ok: true, state: { status: 'cancel-requested' } })),
    getBrowserDetail: vi.fn(async () => ({ ...summary, checkpoint: { step: 1 }, result: null })),
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
  const request = (path = '', method = 'GET', body?: unknown, csrf = true, bindings: Env = env) => app.request(
    `https://enterprise.example.test/api/operator-activities${path}`,
    { method, headers: {
      'content-type': 'application/json', 'cf-access-authenticated-user-email': claims.email,
      ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings,
    { waitUntil, passThroughOnException: vi.fn(), props: {} },
  );
  return { activity, registry, env, request, waitUntil };
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

  it('returns detail and result only after the durable index proves exact ownership', async () => {
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

  it('uses CSRF-protected POST start and cancellation while composing the existing activity methods', async () => {
    const { request, activity, waitUntil } = fixture();
    expect((await request('/activity-1/start', 'POST', { capability: 's'.repeat(43) }, false)).status).toBe(403);
    expect((await request('/activity-1/start', 'GET')).status).toBe(404);

    const started = await request('/activity-1/start', 'POST', { capability: 's'.repeat(43) });
    expect(started.status).toBe(200);
    expect(activity.start).toHaveBeenCalledWith('s'.repeat(43));
    expect(orchestration.run).toHaveBeenCalledWith('activity-1', expect.anything());
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
