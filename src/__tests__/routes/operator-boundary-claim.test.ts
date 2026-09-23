/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import webhookRoutes from '../../routes/operator-webhook';

const claim = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../../operators/review-boundary-claim', () => ({ claimVerifiedBoundaryAction: claim.execute }));

const path = 'https://enterprise.example.test/operator-webhook/v1/activities/claims/boundary';
const token = 'header.payload.signature';
const bindings = { repositoryId: 123, pullRequest: 45, head: 'a'.repeat(40), base: 'b'.repeat(40),
  mergeBase: 'c'.repeat(40), runId: 678, runAttempt: 2 };
const env = { ENTERPRISE_MODE: 'active' };
function request(body: unknown = bindings, authorization: string | null = `Bearer ${token}`, method = 'POST') {
  return new Request(path, { method, headers: {
    ...(authorization === null ? {} : { authorization }), 'content-type': 'application/json',
  }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}

beforeEach(() => {
  claim.execute.mockReset();
  claim.execute.mockResolvedValue({ activityId: 'review-activity', origin: 'https://enterprise.example.test',
    startCapability: 's'.repeat(43), ...bindings, workflowId: 531, generation: 1 });
});

describe('operator boundary claim route (task #30; proposed contract)', () => {
  it('accepts a strictly bound OIDC claim and returns start authority without browser Access JWT', async () => {
    const response = await webhookRoutes.fetch(request(), env as never);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const result = await response.json() as Record<string, unknown>;
    expect(result).toMatchObject({ activityId: 'review-activity', origin: 'https://enterprise.example.test',
      startCapability: 's'.repeat(43), ...bindings, workflowId: 531, generation: 1 });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result).toLowerCase()).not.toContain('accessjwt');
  });

  it('rejects non-enterprise, GET and absent or malformed bearer authorization before claiming', async () => {
    const cases = [
      [request(), { ENTERPRISE_MODE: undefined }, 404],
      [request(bindings, `Bearer ${token}`, 'GET'), env, 405],
      [request(bindings, null), env, 401],
      [request(bindings, 'Basic abc'), env, 401],
      [request(bindings, 'Bearer '), env, 401],
    ] as const;
    for (const [input, environment, status] of cases) {
      const response = await webhookRoutes.fetch(input, environment as never);
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('rejects every caller-owned authority field and incomplete or invalid bindings before claiming', async () => {
    const invalid = [
      ...['principal', 'installation', 'startCapability', 'jwt', 'publisherToken'].map(key => ({ ...bindings, [key]: 'forged' })),
      ...Object.keys(bindings).map(key => Object.fromEntries(Object.entries(bindings).filter(([name]) => name !== key))),
      { ...bindings, repositoryId: '123' }, { ...bindings, pullRequest: 0 },
      { ...bindings, runId: -1 }, { ...bindings, runAttempt: 0 }, { ...bindings, head: '' },
      { ...bindings, base: null }, { ...bindings, mergeBase: 4 },
    ];
    for (const body of invalid) {
      const response = await webhookRoutes.fetch(request(body), env as never);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('rejects bodies exceeding 4 KiB without invoking the claim helper', async () => {
    const response = await webhookRoutes.fetch(request({ ...bindings, head: 'x'.repeat(4096) }), env as never);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('cancels a stalled claim body at a short read deadline before claiming', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('{"repositoryId":')); },
        cancel() { cancelled = true; },
      });
      const pending = Promise.resolve(webhookRoutes.fetch(new Request(path, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body, duplex: 'half',
      } as RequestInit), env as never));
      await vi.advanceTimersByTimeAsync(2_000);
      const response = await pending;
      expect(response.status).toBe(400);
      expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  }, 4_000);
});
