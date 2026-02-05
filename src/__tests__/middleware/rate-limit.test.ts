import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createRateLimiter, RateLimitConfig } from '../../middleware/rate-limit';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { RateLimitError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

describe('createRateLimiter', () => {
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
});
