/**
 * CF-040
 * REQ-STOR-015: user-driven Sync-now fan-out (POST /api/sessions/sync).
 *
 * Route-level coverage for the thin wrapper over fanOutBisyncTrigger:
 *   AC1 - happy path: each running session is forwarded the bisync trigger
 *         and reported as 'triggered'.
 *   AC3 - per-session failure isolation: one session erroring does not abort
 *         the fan-out; the surviving session is still 'triggered' and the
 *         failing one is reported 'failed'.
 *
 * The fan-out talks to Container DOs via getContainer().fetch(); the mock
 * dispatches per containerId (`${bucketName}-${sessionId}`) so each session's
 * outcome is controlled independently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import { buildSessionMetadata } from '../../lib/kv-keys';

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));
vi.mock('../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../../lib/onboarding', () => ({ isSaasModeActive: vi.fn(() => false) }));
vi.mock('../../lib/agent-seed.generated', () => ({ PRESEED_CONTENT_HASH: 'abc1234567890def' }));

// Per-containerId fetch dispatch. Tests register a Response (or throw) per
// containerId; the getContainer mock routes container.fetch() accordingly.
const containerBehavior = vi.hoisted(() => ({
  map: new Map<string, { status?: number; throws?: boolean }>(),
}));

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn((_ns: unknown, containerId: string) => ({
    fetch: vi.fn(async () => {
      const behavior = containerBehavior.map.get(containerId);
      if (behavior?.throws) {
        throw new Error('container fetch boom');
      }
      return new Response(null, { status: behavior?.status ?? 202 });
    }),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));

import lifecycleRoutes from '../../routes/session/lifecycle';

describe('CF-040 / REQ-STOR-015: POST /api/sessions/sync fan-out', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    containerBehavior.map.clear();
  });

  function createApp() {
    return createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV,
    });
  }

  function makeSession(id: string, status: 'running' | 'stopped'): Session {
    return {
      id,
      name: `Session ${id}`,
      userId: 'test-bucket',
      status,
      createdAt: '2024-01-01T00:00:00.000Z',
      lastAccessedAt: '2024-01-01T00:00:00.000Z',
    };
  }

  function seedRunning(id: string) {
    const session = makeSession(id, 'running');
    mockKV._set(`session:test-bucket:${id}`, session, buildSessionMetadata(session));
  }

  // AC1: every running session is triggered (host returns 202).
  it('fans the bisync trigger out to each running session (happy path)', async () => {
    seedRunning('aabbccdd11223344');
    seedRunning('eeff001122334455');
    // Both containers accept the trigger.
    containerBehavior.map.set('test-bucket-aabbccdd11223344', { status: 202 });
    containerBehavior.map.set('test-bucket-eeff001122334455', { status: 202 });

    const app = createApp();
    const res = await app.request('/sessions/sync', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      count: number;
      sessions: Array<{ sessionId: string; status: string }>;
    };
    expect(body.count).toBe(2);
    const byId = Object.fromEntries(body.sessions.map((s) => [s.sessionId, s.status]));
    expect(byId['aabbccdd11223344']).toBe('triggered');
    expect(byId['eeff001122334455']).toBe('triggered');
  });

  // AC3: one session erroring does not abort the fan-out; the surviving
  // session is still triggered and the failing one is reported failed.
  it('isolates a per-session failure (one container errors, the other still triggers)', async () => {
    seedRunning('aabbccdd11223344');
    seedRunning('eeff001122334455');
    containerBehavior.map.set('test-bucket-aabbccdd11223344', { status: 202 });
    containerBehavior.map.set('test-bucket-eeff001122334455', { throws: true });

    const app = createApp();
    const res = await app.request('/sessions/sync', { method: 'POST' });

    expect(res.status).toBe(200);
    const body = await res.json() as {
      count: number;
      sessions: Array<{ sessionId: string; status: string; error?: string }>;
    };
    expect(body.count).toBe(2);
    const byId = Object.fromEntries(body.sessions.map((s) => [s.sessionId, s.status]));
    expect(byId['aabbccdd11223344']).toBe('triggered');
    expect(byId['eeff001122334455']).toBe('failed');
    const failed = body.sessions.find((s) => s.sessionId === 'eeff001122334455');
    expect(failed!.error).toContain('boom');
  });

  // Stopped sessions are not part of the fan-out (only running sessions sync).
  it('skips stopped sessions (only running sessions are fanned out)', async () => {
    seedRunning('aabbccdd11223344');
    const stopped = makeSession('eeff001122334455', 'stopped');
    mockKV._set('session:test-bucket:eeff001122334455', stopped, buildSessionMetadata(stopped));
    containerBehavior.map.set('test-bucket-aabbccdd11223344', { status: 202 });

    const app = createApp();
    const res = await app.request('/sessions/sync', { method: 'POST' });

    const body = await res.json() as {
      count: number;
      sessions: Array<{ sessionId: string }>;
    };
    expect(body.count).toBe(1);
    expect(body.sessions[0].sessionId).toBe('aabbccdd11223344');
  });
});
