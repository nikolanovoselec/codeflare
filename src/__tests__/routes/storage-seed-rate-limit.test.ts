/**
 * REQ-AGENT-032 AC2: the storage-seed routes are protected by a per-window
 * rate limiter (3 requests / 60s) so a user cannot hammer
 * `POST /api/storage/seed/getting-started`.
 *
 * @impl src/routes/storage/seed.ts::storageSeedRateLimiter
 *   (createRateLimiter({ maxRequests: 3, windowMs: 60_000 }) applied via
 *    app.use('*', storageSeedRateLimiter))
 *
 * Drives the real seed router through the shared Workers test harness and
 * asserts the contract: the first 3 requests in a window are allowed, the 4th
 * is rejected with HTTP 429 / RATE_LIMIT_ERROR, and the advisory
 * X-RateLimit-Limit header reflects the configured maxRequests (3).
 *
 * Gut-check: if `app.use('*', storageSeedRateLimiter)` is removed, the 4th
 * request returns 200 and the 429 assertion fails. If `maxRequests` is changed
 * (e.g. to 4) the 4th request succeeds and likewise fails. If maxRequests is
 * lowered (e.g. to 2) the 3rd success assertion fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import { createMockR2Config } from '../helpers/mock-factories';

// ── R2 dependency mocks (the seed handler calls these before responding) ──────
// Placed at module level before the route import so the Workers-pool hoisting
// resolves them (see vitest.config.ts mock-hoisting note).
vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue(createMockR2Config({ accountId: 'test' })),
}));

vi.mock('../../lib/r2-admin', () => ({
  createBucketIfNotExists: vi.fn().mockResolvedValue({ success: true, created: false }),
}));

vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: vi.fn().mockResolvedValue({ written: ['README.md'], skipped: [] }),
  reconcileAgentConfigs: vi.fn().mockResolvedValue({ written: [], skipped: [] }),
}));

// Route import AFTER mocks.
import seedRoutes from '../../routes/storage/seed';

function seedEnv() {
  return {
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    CLOUDFLARE_API_TOKEN: 'tok',
  };
}

describe('REQ-AGENT-032 AC2: storage-seed rate limiter (3/min)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    // Pin the clock so all four requests fall inside one 60s window — the
    // KV-backed limiter keys counts by window, so a real-time boundary crossing
    // must not flake the test.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function createApp() {
    return createTestApp({
      routes: [{ path: '/seed', handler: seedRoutes }],
      mockKV,
      envOverrides: seedEnv(),
    });
  }

  function post() {
    return createApp().request('/seed/getting-started', { method: 'POST' });
  }

  it('allows the first 3 requests in a window and 429s the 4th', async () => {
    // First 3 requests: allowed (handler runs, returns 200 success).
    for (let i = 1; i <= 3; i++) {
      const res = await post();
      expect(res.status, `request ${i} should be allowed`).toBe(200);
      const body = (await res.json()) as { success: boolean };
      expect(body.success).toBe(true);
    }

    // 4th request: over the limit -> 429 with the rate-limit error contract.
    const blocked = await post();
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { code: string };
    expect(body.code).toBe('RATE_LIMIT_ERROR');
  });

  it('reports the configured maxRequests (3) via X-RateLimit-Limit on an allowed request', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    // Contract value: the advisory limit header equals the configured maxRequests.
    expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
  });

  it('attaches Retry-After to the 429 once the limit is exhausted', async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await post();
      expect(res.status).toBe(200);
    }
    const blocked = await post();
    expect(blocked.status).toBe(429);
    // CF-012: the 429 carries advisory retry headers.
    expect(blocked.headers.get('Retry-After')).not.toBeNull();
    expect(blocked.headers.get('X-RateLimit-Remaining')).toBe('0');
  });
});
