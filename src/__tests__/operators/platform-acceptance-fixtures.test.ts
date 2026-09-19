/// <reference types="@cloudflare/vitest-pool-workers/types" />
/** REQ-OPERATOR-009/010 acceptance scaffolding; no private operator or deployed acceptance. */
import { describe, expect, it, vi } from 'vitest';
import { runDirectFixture, runSessionFixture, runWebhookCallerFixture } from './fixtures/platform-acceptance';
import { consumerContractFixtures } from './fixtures/consumer-contracts';

describe('REQ-OPERATOR-009: platform acceptance fixtures', () => {
  it('runs a direct-only invocation without creating a session', async () => {
    const execute = vi.fn(async () => ({ status: 'completed' as const, result: { ok: true } }));
    expect(await runDirectFixture(consumerContractFixtures[0], { execute })).toEqual({
      execution: 'completed', cleanup: 'not-required', persistence: 'not-required', result: { ok: true },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('orders real Pi/file/explicit-sync/stop seams and reports incomplete persistence independently', async () => {
    const calls: string[] = [];
    const runtime = {
      ensure: vi.fn(async () => { calls.push('ensure'); return { sessionId: 'session-1' }; }),
      send: vi.fn(async () => { calls.push('send'); return { taskId: 'task-1' }; }),
      observe: vi.fn(async () => { calls.push('observe'); return { status: 'completed' as const, result: { report: 'ready' } }; }),
      sync: vi.fn(async () => { calls.push('sync'); return { status: 'unknown' as const }; }),
      stop: vi.fn(async () => { calls.push('stop'); return { status: 'stopped' as const }; }),
    };
    expect(await runSessionFixture(consumerContractFixtures[1], runtime)).toMatchObject({
      execution: 'completed', persistence: 'unknown', cleanup: 'stopped', result: { report: 'ready' },
    });
    expect(calls).toEqual(['ensure', 'send', 'observe', 'sync', 'stop']);
  });

  it('uses fixed webhook methods and preserves a non-consuming not-ready result', async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (request: Request) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return request.url.endsWith('/start') ? Response.json({ readCapability: 'r'.repeat(43) })
        : request.url.endsWith('/status') ? Response.json({ terminal: false, status: 'running' })
          : Response.json({ code: 'WEBHOOK_NOT_READY' }, { status: 202 });
    });
    expect(await runWebhookCallerFixture('https://enterprise.example.test', 'activity-1', 's'.repeat(43), fetch))
      .toMatchObject({ status: 'running', result: 'not-ready' });
    expect(calls).toEqual([
      'POST /operator-webhook/v1/activities/activity-1/start',
      'GET /operator-webhook/v1/activities/activity-1/status',
      'POST /operator-webhook/v1/activities/activity-1/result',
    ]);
  });
});
