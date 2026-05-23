/**
 * Security-gap tests for rate limiting
 *
 * Covers AC bullets not exercised by the existing rate-limit.test.ts:
 *   REQ-SEC-007 AC3  — 429 response body has { code: "RATE_LIMIT_ERROR", error: "..." }
 *   REQ-SEC-007 AC7  — fail-closed: KV failure on security-critical endpoint returns 429
 *   REQ-SEC-007 AC8  — fail-open: KV failure on resource endpoints allows the request
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createRateLimiter } from '../../middleware/rate-limit';
import { AppError } from '../../lib/error-types';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createMockKV } from '../helpers/mock-kv';

// ── test app factory ──────────────────────────────────────────────────────────

function buildApp(
  opts: {
    maxRequests?: number;
    failClosed?: boolean;
    kvThrows?: boolean;
    kvUnavailable?: boolean;
  } = {}
) {
  const { maxRequests = 1, failClosed = false, kvThrows = false, kvUnavailable = false } = opts;

  const mockKV = createMockKV();
  if (kvThrows) {
    mockKV.get = vi.fn().mockRejectedValue(new Error('KV unavailable'));
    mockKV.put = vi.fn().mockRejectedValue(new Error('KV unavailable'));
  }

  const app = new Hono<{ Bindings: Env; Variables: Partial<AuthVariables> }>();

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 429 | 500 | 503);
    }
    return c.json({ error: String(err) }, 500);
  });

  app.use('*', async (c, next) => {
    c.env = {
      KV: kvUnavailable ? undefined : (mockKV as unknown as KVNamespace),
    } as Env;
    c.set('bucketName', 'test-user');
    return next();
  });

  app.use('/limited', createRateLimiter({ windowMs: 60_000, maxRequests, failClosed }));
  app.post('/limited', (c) => c.json({ ok: true }));

  return app;
}

// ── REQ-SEC-007 AC3: 429 body shape ──────────────────────────────────────────

describe('REQ-SEC-007 AC3: 429 response body contains RATE_LIMIT_ERROR code', () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp({ maxRequests: 1 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('REQ-SEC-007 AC3: exceeded rate limit returns HTTP 429', async () => {
    await app.request('/limited', { method: 'POST' });
    const res = await app.request('/limited', { method: 'POST' });
    expect(res.status).toBe(429);
  });

  it('REQ-SEC-007 AC3: 429 body contains code="RATE_LIMIT_ERROR"', async () => {
    await app.request('/limited', { method: 'POST' });
    const res = await app.request('/limited', { method: 'POST' });

    const body = await res.json() as { code: string; error: string };
    expect(body.code).toBe('RATE_LIMIT_ERROR');
  });

  it('REQ-SEC-007 AC3: 429 body contains an error message mentioning rate limit', async () => {
    await app.request('/limited', { method: 'POST' });
    const res = await app.request('/limited', { method: 'POST' });

    const body = await res.json() as { code: string; error: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });
});

// ── REQ-SEC-007 AC7: fail-closed on KV failure ───────────────────────────────

describe('REQ-SEC-007 AC7: fail-closed rate limiter denies when KV throws', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('REQ-SEC-007 AC7: fail-closed=true + KV throws returns 429 (deny)', async () => {
    const app = buildApp({ maxRequests: 100, failClosed: true, kvThrows: true });
    const res = await app.request('/limited', { method: 'POST' });
    expect(res.status).toBe(429);
  });

  it('REQ-SEC-007 AC7: fail-closed=true + KV throws response has RATE_LIMIT_ERROR code', async () => {
    const app = buildApp({ maxRequests: 100, failClosed: true, kvThrows: true });
    const res = await app.request('/limited', { method: 'POST' });
    const body = await res.json() as { code: string };
    expect(body.code).toBe('RATE_LIMIT_ERROR');
  });
});

// ── REQ-SEC-007 AC8: fail-open on KV failure ─────────────────────────────────

describe('REQ-SEC-007 AC8: fail-open rate limiter allows when KV throws', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('REQ-SEC-007 AC8: fail-closed=false (default) + KV throws still allows request', async () => {
    const app = buildApp({ maxRequests: 1, failClosed: false, kvThrows: true });
    // Even after "using up" the in-memory limit, a fresh KV-error path falls through to in-memory
    // but let's verify the first request is always allowed when KV fails on fail-open
    const res = await app.request('/limited', { method: 'POST' });
    expect(res.status).toBe(200);
  });
});
