/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, vi } from 'vitest';
import { createWebhookHandoff, openWebhookHandoff } from '../../operators/webhook-handoff';
import webhookRoutes from '../../routes/operator-webhook';

const orchestration = vi.hoisted(() => ({ run: vi.fn(async () => {}) }));
vi.mock('../../operators/orchestrator', async importOriginal => ({
  ...await importOriginal<typeof import('../../operators/orchestrator')>(),
  runOperatorActivity: orchestration.run,
}));

const startCapability = 's'.repeat(43);
const readCapability = 'r'.repeat(43);
const activityId = 'review-activity-1';
const handoffKey = btoa('a'.repeat(32)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const context = { deployment: 'enterprise', operatorId: 'review-conductor', activityId,
  workflow: 'review.yml', revision: 4, expiresAt: Date.now() + 60_000 };

function request(action: string, method: string, capability: string) {
  return new Request(`https://enterprise.example.test/operator-webhook/v1/activities/${activityId}/${action}`, {
    method, headers: { authorization: `Bearer ${capability}` },
  });
}

function environment(continueResult: unknown = { ok: true, phase: 'queued', generation: 9 }) {
  let started = false;
  let resultConsumed = false;
  const activity = {
    startWebhook: async () => {
      if (started) return { ok: false as const, reason: 'already-started' as const };
      started = true;
      return { ok: true as const, phase: 'queued' as const, readCapability };
    },
    continueWebhook: async () => continueResult,
    getWebhookStatus: async () => ({ ok: true, terminal: false, status: 'waiting',
      progress: { generation: 9, completedLanes: ['security'], requiredLanes: ['security', 'specification'] } }),
    redeemWebhookResult: async () => {
      if (resultConsumed) return { ok: false as const, reason: 'consumed' as const };
      resultConsumed = true;
      return { ok: true as const, terminal: true, status: 'incomplete', result: {
        publication: { source: 'github', generation: 9, revision: 'c'.repeat(40) },
        missingLanes: ['specification'], localFallback: false,
      } };
    },
  };
  return { env: { ENTERPRISE_MODE: 'active', OPERATOR_ACTIVITY: { getByName: () => activity } }, activity };
}

async function fetchWebhook(input: Request, env: Record<string, unknown>) {
  return webhookRoutes.fetch(input, env as never, { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {}, exports: {} });
}

describe('REQ-OPERATOR-050: Review Conductor continuation', () => {
  it('continues an encrypted handoff while status stays metadata-only and result remains single-use', async () => {
    const handoff = await createWebhookHandoff({ startCapability, webhookKey: handoffKey, context });
    if (handoff.mode !== 'encrypted') throw new Error('expected encrypted handoff');
    const capability = await openWebhookHandoff(handoff.envelope, handoffKey, context);
    const { env } = environment();

    expect(await (await fetchWebhook(request('start', 'POST', capability), env)).json()).toEqual({
      ok: true, phase: 'queued', readCapability,
    });
    expect(await (await fetchWebhook(request('status', 'GET', readCapability), env)).json()).toEqual({
      ok: true, terminal: false, status: 'waiting',
      progress: { generation: 9, completedLanes: ['security'], requiredLanes: ['security', 'specification'] },
    });
    const continued = await fetchWebhook(request('continue', 'POST', readCapability), env);
    expect(continued.status).toBe(200);
    await expect(continued.json()).resolves.toEqual({ ok: true, phase: 'queued', generation: 9 });

    expect(await (await fetchWebhook(request('result', 'POST', readCapability), env)).json()).toEqual({
      ok: true, terminal: true, status: 'incomplete', result: {
        publication: { source: 'github', generation: 9, revision: 'c'.repeat(40) },
        missingLanes: ['specification'], localFallback: false,
      },
    });
    const reused = await fetchWebhook(request('result', 'POST', readCapability), env);
    expect(reused.status).toBe(409);
    await expect(reused.json()).resolves.toEqual({ error: 'Webhook capability operation rejected', code: 'WEBHOOK_CONSUMED' });
  });

  it('fences stale GitHub publication without replacing it with a local review', async () => {
    const { env } = environment({ ok: false, reason: 'stale-publication' });

    const response = await fetchWebhook(request('continue', 'POST', readCapability), env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Webhook capability operation rejected', code: 'WEBHOOK_STALE_PUBLICATION',
    });
  });

  it('keeps a partial GitHub lane set incomplete instead of publishing a local fallback', async () => {
    const { env } = environment({ ok: true, terminal: true, status: 'incomplete', result: {
      publication: { source: 'github', generation: 9, revision: 'c'.repeat(40) },
      missingLanes: ['specification'], localFallback: false,
    } });

    const response = await fetchWebhook(request('continue', 'POST', readCapability), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, terminal: true, status: 'incomplete', result: {
      publication: { source: 'github', generation: 9, revision: 'c'.repeat(40) },
      missingLanes: ['specification'], localFallback: false,
    } });
  });
});
