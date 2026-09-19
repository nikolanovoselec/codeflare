import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import lifecycleRoutes from '../../routes/session/lifecycle';

vi.mock('../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({ destroy: vi.fn(async () => undefined) })),
}));

describe('REQ-SESSION-006: D1 session lifecycle routes', () => {
  let kv: ReturnType<typeof createMockKV>;
  const id = 'aabbccdd11223344';

  beforeEach(() => {
    kv = createMockKV();
  });

  function app() {
    return createTestApp({ routes: [{ path: '/sessions', handler: lifecycleRoutes }], mockKV: kv });
  }

  function seed(status: 'stopped' | 'running' | 'unreachable' = 'running') {
    kv._set(`session:test-bucket:${id}`, {
      id, userId: 'test-bucket', name: 'Session', status,
      createdAt: '2027-01-01T00:00:00.000Z', lastAccessedAt: '2027-01-01T00:00:00.000Z',
      lifecycleGeneration: 2, responseRevision: 4,
    });
  }

  it('returns the authoritative D1 lifecycle without probing a container', async () => {
    seed('unreachable');
    const response = await app().request(`/sessions/${id}/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'unreachable', containerStatus: 'unreachable', ptyActive: false,
      session: { sessionId: id, lifecycleState: 'unreachable', lifecycleGeneration: 2, responseRevision: 4 },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns 404 for a valid owner-scoped ID absent from D1', async () => {
    const response = await app().request(`/sessions/${id}/status`);
    expect(response.status).toBe(404);
  });

  it('returns 400 for malformed IDs', async () => {
    const response = await app().request('/sessions/INVALID/status');
    expect(response.status).toBe(400);
  });
});
