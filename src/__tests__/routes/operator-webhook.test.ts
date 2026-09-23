/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * REQ-OPERATOR-029: the managed edge route still authenticates fixed
 * methods and activity-scoped capabilities in Worker code. These fixtures are
 * Worker boundary evidence, not deployed public-host Access acceptance.
 */
import { describe, expect, it, vi } from 'vitest';
import webhookRoutes from '../../routes/operator-webhook';

const orchestration = vi.hoisted(() => ({ run: vi.fn(async () => {}) }));
vi.mock('../../operators/orchestrator', async importOriginal => ({
  ...await importOriginal<typeof import('../../operators/orchestrator')>(),
  runOperatorActivity: orchestration.run,
}));

const activityId = 'activity-1';
const capability = 's'.repeat(43);
function environment(overrides: Record<string, unknown> = {}) {
  const activity = {
    startWebhook: vi.fn(async () => ({ ok: true, phase: 'queued', readCapability: 'r'.repeat(43) })),
    getWebhookStatus: vi.fn(async () => ({ ok: true, terminal: false, status: 'queued' })),
    redeemWebhookResult: vi.fn(async () => ({ ok: false, reason: 'not-ready' })),
  };
  return { activity, env: { ENTERPRISE_MODE: 'active', OPERATOR_ACTIVITY: {
    getByName: vi.fn(() => activity),
  }, ...overrides } };
}
function request(path: string, method: string, token = capability, body?: unknown) {
  return new Request(`https://enterprise.example.test${path}`, {
    method, headers: { authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('REQ-OPERATOR-029: capability-authenticated webhook edge', () => {
  it('routes fixed operations with exact response shapes, no-store and no token reflection', async () => {
    const { env, activity } = environment();
    const cases = [
      ['POST', 'start', 200, { ok: true, phase: 'queued', readCapability: 'r'.repeat(43) }],
      ['GET', 'status', 200, { ok: true, terminal: false, status: 'queued' }],
      ['POST', 'result', 202, { error: 'Webhook capability operation rejected', code: 'WEBHOOK_NOT_READY' }],
    ] as const;
    for (const [method, action, status, expectedBody] of cases) {
      const response = await webhookRoutes.fetch(request(`/operator-webhook/v1/activities/${activityId}/${action}`, method), env as never,
        { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {}, exports: {
          OperatorRuntimeCapability: vi.fn(({ props }: { props: { activityId: string; generation: number } }) =>
            ({ fetch: vi.fn(), props })),
        } });
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await response.text();
      expect(JSON.parse(body)).toEqual(expectedBody);
      expect(body).not.toContain(capability);
    }
    expect(activity.startWebhook).toHaveBeenCalledWith(capability);
    expect(orchestration.run).toHaveBeenCalledTimes(1);
    expect(orchestration.run).toHaveBeenCalledWith(activityId, env, expect.any(Function));
    expect(activity.getWebhookStatus).toHaveBeenCalledWith(capability);
    expect(activity.redeemWebhookResult).toHaveBeenCalledWith(capability);
  });

  it('REQ-OPERATOR-029: continuation wire response acknowledges work without echoing capability or issuing new authority', async () => {
    const { env, activity } = environment();
    const continuing = activity as typeof activity & { continueWebhook?: ReturnType<typeof vi.fn> };
    continuing.continueWebhook = vi.fn(async (_token: string, generation: number) => generation === 1
      ? { ok: true, phase: 'queued' } : { ok: false, reason: 'stale-generation' });
    const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {}, exports: {
      OperatorRuntimeCapability: vi.fn(() => ({ fetch: vi.fn() })),
    } };
    const response = await webhookRoutes.fetch(request(`/operator-webhook/v1/activities/${activityId}/continue`, 'POST', capability,
      { generation: 1 }), env as never, context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ ok: true, phase: 'queued' });
    for (const body of [undefined, { generation: 0 }, { generation: '1' }, { generation: 1, actorId: 'other' }]) {
      const denied = await webhookRoutes.fetch(request(`/operator-webhook/v1/activities/${activityId}/continue`, 'POST', capability, body), env as never);
      expect(denied.status).toBe(400);
      expect(await denied.text()).not.toContain(capability);
    }
    const stale = await webhookRoutes.fetch(request(`/operator-webhook/v1/activities/${activityId}/continue`, 'POST', capability,
      { generation: 2 }), env as never, context);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: 'WEBHOOK_STALE_GENERATION' });
  });

  it('REQ-OPERATOR-053: a stalled continuation body is cancelled and rejected within the read deadline', async () => {
    const { env } = environment();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"generation":')); },
      cancel() { cancelled = true; },
    });
    const response = await webhookRoutes.fetch(new Request(
      `https://enterprise.example.test/operator-webhook/v1/activities/${activityId}/continue`, {
        method: 'POST', headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
        body, duplex: 'half',
      } as RequestInit), env as never);
    expect(response.status).toBe(400);
    expect(cancelled).toBe(true);
  }, 4_000);

  it('REQ-OPERATOR-029: terminal status wire response is metadata-only even when the internal projection includes report bytes', async () => {
    const { env, activity } = environment();
    const terminal = activity as unknown as { getWebhookStatus: () => Promise<unknown> };
    terminal.getWebhookStatus = async () => ({ ok: true, terminal: true, status: 'completed', generation: 2,
      result: { report: 'private-review-report-canary' } });
    const response = await webhookRoutes.fetch(request(`/operator-webhook/v1/activities/${activityId}/status`, 'GET'), env as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ ok: true, terminal: true, status: 'completed', generation: 2 });
  });

  it('rejects non-enterprise, missing capability, unknown paths, wrong methods and request bodies before activity RPC', async () => {
    const { env, activity } = environment();
    const attempts: Array<[Request, Record<string, unknown>, number]> = [
      [request(`/operator-webhook/v1/activities/${activityId}/start`, 'POST'), { ...env, ENTERPRISE_MODE: undefined }, 404],
      [new Request(`https://enterprise.example.test/operator-webhook/v1/activities/${activityId}/start`, { method: 'POST' }), env, 401],
      [request(`/operator-webhook/v1/activities/${activityId}/unknown`, 'POST'), env, 404],
      [request(`/operator-webhook/v1/activities/${activityId}/start`, 'GET'), env, 405],
      [new Request(`https://enterprise.example.test/operator-webhook/v1/activities/${activityId}/start`, {
        method: 'POST', headers: { authorization: `Bearer ${capability}` }, body: '{}',
      }), env, 400],
    ];
    for (const [input, bindings, status] of attempts) {
      expect((await webhookRoutes.fetch(input, bindings as never)).status).toBe(status);
    }
    expect(activity.startWebhook).not.toHaveBeenCalled();
  });

  it('throttles repeated webhook requests before activity RPC', async () => {
    const { env, activity } = environment();
    const path = '/operator-webhook/v1/activities/throttled-activity/status';
    const input = () => new Request(`https://enterprise.example.test${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${capability}`, 'cf-connecting-ip': '203.0.113.29' },
    });

    for (let count = 0; count < 30; count += 1) {
      expect((await webhookRoutes.fetch(input(), env as never)).status).toBe(200);
    }
    const throttled = await webhookRoutes.fetch(input(), env as never);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('cache-control')).toBe('no-store');
    await expect(throttled.json()).resolves.toEqual({ error: 'Too many requests', code: 'WEBHOOK_THROTTLED' });
    expect(activity.getWebhookStatus).toHaveBeenCalledTimes(30);
  });
});
