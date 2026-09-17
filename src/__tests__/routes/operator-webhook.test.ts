/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * REQ-OPERATOR-026: the only edge-Access bypass route still authenticates fixed
 * methods and activity-scoped capabilities in Worker code. These fixtures are
 * Worker boundary evidence, not deployed public-host Access acceptance.
 */
import { describe, expect, it, vi } from 'vitest';
import webhookRoutes from '../../routes/operator-webhook';

const orchestration = vi.hoisted(() => ({ run: vi.fn(async () => {}) }));
vi.mock('../../operators/orchestrator', () => ({ runOperatorActivity: orchestration.run }));

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
function request(path: string, method: string, token = capability) {
  return new Request(`https://enterprise.example.test${path}`, {
    method, headers: { authorization: `Bearer ${token}` },
  });
}

describe('REQ-OPERATOR-026: capability-authenticated webhook edge', () => {
  it('routes fixed start/status/result operations with no-store responses and no token reflection', async () => {
    const { env, activity } = environment();
    const cases = [
      ['POST', 'start', 200], ['GET', 'status', 200], ['POST', 'result', 202],
    ] as const;
    for (const [method, action, status] of cases) {
      const response = await webhookRoutes.fetch(request(`/operator-webhook/v1/activities/${activityId}/${action}`, method), env as never,
        { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} });
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).not.toContain(capability);
    }
    expect(activity.startWebhook).toHaveBeenCalledWith(capability);
    expect(orchestration.run).toHaveBeenCalledTimes(1);
    expect(orchestration.run).toHaveBeenCalledWith(activityId, env);
    expect(activity.getWebhookStatus).toHaveBeenCalledWith(capability);
    expect(activity.redeemWebhookResult).toHaveBeenCalledWith(capability);
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
});
