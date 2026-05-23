import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createRateLimiter, RateLimitConfig } from '../../middleware/rate-limit';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { RateLimitError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

describe('createRateLimiter / REQ-SEC-007 AC1 (factory keyed by bucketName with CF-Connecting-IP fallback) / REQ-SEC-007 AC2 (KV primary + in-memory fallback with TTL) / REQ-SEC-007 AC3 (429 with RATE_LIMIT_ERROR) / REQ-SEC-007 AC4 (X-RateLimit headers) / REQ-SEC-019 AC5 (STRESS_TEST_MODE bypass)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createTestApp(config: RateLimitConfig, kvAvailable = true) {
    const app = new Hono<{ Bindings: Env; Variables: Partial<AuthVariables> }>();

    // Error handler to convert thrown errors to HTTP responses
    app.onError((err, c) => {
      if (err instanceof RateLimitError) {
        return c.json({ error: err.message }, 429);
      }
      return c.json({ error: err.message }, 500);
    });

    // Set up mock env
    app.use('*', async (c, next) => {
      c.env = {
        KV: kvAvailable ? (mockKV as unknown as KVNamespace) : undefined,
      } as Env;
      // Simulate bucketName being set by auth middleware
      c.set('bucketName', 'test-user');
      return next();
    });

    app.use('/test', createRateLimiter(config));
    app.get('/test', (c) => c.json({ success: true }));

    return app;
  }

  describe('basic rate limiting', () => {
    it('allows requests under the limit', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 10,
      });

      for (let i = 0; i < 10; i++) {
        const res = await app.request('/test');
        expect(res.status).toBe(200);
      }
    });

    it('blocks requests over the limit', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 3,
      });

      // First 3 requests succeed
      for (let i = 0; i < 3; i++) {
        const res = await app.request('/test');
        expect(res.status).toBe(200);
      }

      // 4th request should be blocked
      const res = await app.request('/test');
      expect(res.status).toBe(429);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('Rate limit exceeded');
    });

    it('resets after window expires', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 2,
      });

      // Use up the limit
      await app.request('/test');
      await app.request('/test');

      // Should be blocked
      let res = await app.request('/test');
      expect(res.status).toBe(429);

      // Advance time past window
      vi.advanceTimersByTime(61000);

      // Should be allowed again
      res = await app.request('/test');
      expect(res.status).toBe(200);
    });
  });

  describe('rate limit headers', () => {
    it('sets X-RateLimit-Limit header', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 10,
      });

      const res = await app.request('/test');
      expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    });

    it('sets X-RateLimit-Remaining header', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 10,
      });

      let res = await app.request('/test');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('9');

      res = await app.request('/test');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('8');
    });

    it('shows 0 remaining when at limit', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 2,
      });

      await app.request('/test');
      const res = await app.request('/test');
      expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    });
  });

  describe('key prefix', () => {
    it('uses custom key prefix', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 10,
        keyPrefix: 'custom-prefix',
      });

      await app.request('/test');

      // Check that the correct key was used
      expect(mockKV.get).toHaveBeenCalledWith('custom-prefix:test-user', 'json');
    });

    it('uses default prefix when not specified', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 10,
      });

      await app.request('/test');

      expect(mockKV.get).toHaveBeenCalledWith('ratelimit:test-user', 'json');
    });
  });

  describe('KV not available', () => {
    it('skips rate limiting when KV is not available', async () => {
      const app = createTestApp(
        {
          windowMs: 60000,
          maxRequests: 1,
        },
        false // KV not available
      );

      // All requests should pass through
      for (let i = 0; i < 5; i++) {
        const res = await app.request('/test');
        expect(res.status).toBe(200);
      }
    });
  });

  describe('IP-based rate limiting', () => {
    it('uses CF-Connecting-IP when bucketName not available', async () => {
      const app = new Hono<{ Bindings: Env; Variables: Partial<AuthVariables> }>();

      app.use('*', async (c, next) => {
        c.env = { KV: mockKV as unknown as KVNamespace } as Env;
        // Don't set bucketName
        return next();
      });

      app.use('/test', createRateLimiter({
        windowMs: 60000,
        maxRequests: 10,
      }));
      app.get('/test', (c) => c.json({ success: true }));

      await app.request('/test', {
        headers: { 'CF-Connecting-IP': '192.168.1.1' },
      });

      expect(mockKV.get).toHaveBeenCalledWith('ratelimit:192.168.1.1', 'json');
    });

    it('uses anonymous when neither bucketName nor IP available', async () => {
      const app = new Hono<{ Bindings: Env; Variables: Partial<AuthVariables> }>();

      app.use('*', async (c, next) => {
        c.env = { KV: mockKV as unknown as KVNamespace } as Env;
        return next();
      });

      app.use('/test', createRateLimiter({
        windowMs: 60000,
        maxRequests: 10,
      }));
      app.get('/test', (c) => c.json({ success: true }));

      await app.request('/test');

      expect(mockKV.get).toHaveBeenCalledWith('ratelimit:anonymous', 'json');
    });
  });

  describe('KV expiration', () => {
    it('sets appropriate TTL on KV entries', async () => {
      const app = createTestApp({
        windowMs: 60000, // 1 minute
        maxRequests: 10,
      });

      await app.request('/test');

      // TTL should be window (60s) + 60s buffer = 120s
      expect(mockKV.put).toHaveBeenCalledWith(
        'ratelimit:test-user',
        expect.any(String),
        { expirationTtl: 120 }
      );
    });
  });

  describe('window tracking', () => {
    it('increments count within same window', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 10,
      });

      await app.request('/test');
      await app.request('/test');

      // Verify count is being incremented
      const lastPutCall = mockKV.put.mock.calls[mockKV.put.mock.calls.length - 1];
      const storedData = JSON.parse(lastPutCall[1]);
      expect(storedData.count).toBe(2);
    });

    it('starts new window when previous window expired', async () => {
      const app = createTestApp({
        windowMs: 60000,
        maxRequests: 10,
      });

      // First request
      await app.request('/test');

      // Advance past window
      vi.advanceTimersByTime(61000);

      // Second request should start new window
      await app.request('/test');

      const lastPutCall = mockKV.put.mock.calls[mockKV.put.mock.calls.length - 1];
      const storedData = JSON.parse(lastPutCall[1]);
      expect(storedData.count).toBe(1);
    });
  });

  describe('stress test mode bypass', () => {
    function createStressTestApp(config: RateLimitConfig, stressTestMode?: string) {
      const app = new Hono<{ Bindings: Env; Variables: Partial<AuthVariables> }>();

      app.onError((err, c) => {
        if (err instanceof RateLimitError) {
          return c.json({ error: err.message }, 429);
        }
        return c.json({ error: err.message }, 500);
      });

      app.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          ...(stressTestMode !== undefined && { STRESS_TEST_MODE: stressTestMode }),
        } as Env;
        c.set('bucketName', 'test-user');
        return next();
      });

      app.use('/test', createRateLimiter(config));
      app.get('/test', (c) => c.json({ success: true }));

      return app;
    }

    it('bypasses rate limit when STRESS_TEST_MODE === "active"', async () => {
      const app = createStressTestApp(
        { windowMs: 60000, maxRequests: 1 },
        'active'
      );

      for (let i = 0; i < 10; i++) {
        const res = await app.request('/test');
        expect(res.status).toBe(200);
      }
    });

    it('does NOT set X-RateLimit-* headers when bypassed', async () => {
      const app = createStressTestApp(
        { windowMs: 60000, maxRequests: 10 },
        'active'
      );

      const res = await app.request('/test');
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
      expect(res.headers.get('X-RateLimit-Remaining')).toBeNull();
    });

    it('does NOT access KV when bypassed', async () => {
      const app = createStressTestApp(
        { windowMs: 60000, maxRequests: 10 },
        'active'
      );

      await app.request('/test');

      expect(mockKV.get).not.toHaveBeenCalled();
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('still enforces limits when STRESS_TEST_MODE is unset', async () => {
      const app = createStressTestApp(
        { windowMs: 60000, maxRequests: 1 },
        undefined
      );

      const first = await app.request('/test');
      expect(first.status).toBe(200);

      const second = await app.request('/test');
      expect(second.status).toBe(429);
    });

    it('still enforces limits when STRESS_TEST_MODE is any value other than "active"', async () => {
      const app = createStressTestApp(
        { windowMs: 60000, maxRequests: 1 },
        'true'
      );

      const first = await app.request('/test');
      expect(first.status).toBe(200);

      const second = await app.request('/test');
      expect(second.status).toBe(429);
    });

    // REQ-OPS-008 AC5: the bypass logs ONE warning per isolate (worker) the
    // first time STRESS_TEST_MODE is observed active. The module-scoped
    // `stressTestWarningLogged` flag is the sole gate. We use vi.resetModules
    // + a freshly-mocked logger to observe the side-effect cleanly without
    // contaminating other tests that already tripped the flag.
    //
    // Cleanup lives in beforeEach/afterEach (not inline at the tail of each
    // it()) so a failed expect() can't leak the mocked logger or the cached
    // module-scope `stressTestWarningLogged=true` into subsequent tests.
    describe('REQ-OPS-008 AC5: one-time warning per isolate', () => {
      let warnSpy: ReturnType<typeof vi.fn>;
      let freshCreateRateLimiter: typeof createRateLimiter;

      beforeEach(async () => {
        vi.resetModules();
        warnSpy = vi.fn();
        vi.doMock('../../lib/logger', () => ({
          createLogger: () => ({
            info: vi.fn(),
            warn: warnSpy,
            error: vi.fn(),
            debug: vi.fn(),
          }),
        }));
        // Re-import AFTER the doMock so the factory binds to the spy.
        ({ createRateLimiter: freshCreateRateLimiter } = await import('../../middleware/rate-limit'));
      });

      afterEach(() => {
        vi.doUnmock('../../lib/logger');
        vi.resetModules();
      });

      it('logs exactly one warning across many bypassed requests', async () => {
        const app = new Hono<{ Bindings: Env; Variables: Partial<AuthVariables> }>();
        app.use('*', async (c, next) => {
          c.env = {
            KV: mockKV as unknown as KVNamespace,
            STRESS_TEST_MODE: 'active',
          } as Env;
          c.set('bucketName', 'stress-user');
          return next();
        });
        app.use('/test', freshCreateRateLimiter({ windowMs: 60000, maxRequests: 1 }));
        app.get('/test', (c) => c.json({ ok: true }));

        for (let i = 0; i < 7; i++) {
          const res = await app.request('/test');
          expect(res.status).toBe(200);
        }

        // AC5: exactly one warning across all 7 requests.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const [msg] = warnSpy.mock.calls[0] as [string];
        expect(msg).toMatch(/STRESS_TEST_MODE/);
        expect(msg).toMatch(/bypass/i);
      });

      it('does NOT log a warning when STRESS_TEST_MODE is unset (no false-positive on normal traffic)', async () => {
        const app = new Hono<{ Bindings: Env; Variables: Partial<AuthVariables> }>();
        app.use('*', async (c, next) => {
          c.env = { KV: mockKV as unknown as KVNamespace } as Env;
          c.set('bucketName', 'normal-user');
          return next();
        });
        app.use('/test', freshCreateRateLimiter({ windowMs: 60000, maxRequests: 5 }));
        app.get('/test', (c) => c.json({ ok: true }));

        for (let i = 0; i < 3; i++) {
          await app.request('/test');
        }

        // No STRESS_TEST_MODE bypass message should ever be logged.
        const stressCalls = warnSpy.mock.calls.filter(
          ([msg]: unknown[]) => typeof msg === 'string' && msg.includes('STRESS_TEST_MODE')
        );
        expect(stressCalls).toHaveLength(0);
      });
    });
  });
});
