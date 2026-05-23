/**
 * REQ-SUB-018 AC2: GET /api/usage polls real-time data from Timekeeper DO
 * with a KV fallback. This file exercises both branches against the real
 * production handler (no source-text matching).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, AccessUser, UsageRecord } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', {
      email: 'usage@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'standard',
      subscriptionTier: 'standard',
    } as AccessUser);
    c.set('bucketName', 'usage-bucket');
    return next();
  }),
}));

import usageRoutes from '../../routes/usage';

function createApp(envOverrides: Partial<Env> = {}) {
  const mockKV = createMockKV();
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      ...envOverrides,
    } as Env;
    return next();
  });
  app.route('/usage', usageRoutes);
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    }
    return c.json({ error: String(err) }, 500);
  });
  return { app, mockKV };
}

describe('GET /api/usage / REQ-SUB-018 AC2 (real-time Timekeeper DO with KV fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns Timekeeper live data when TIMEKEEPER binding is available and responds 200', async () => {
    const tkStub = {
      fetch: vi.fn(async () =>
        new Response(JSON.stringify({ dailySeconds: 1234, monthlySeconds: 5678 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      ),
    };
    const TIMEKEEPER = {
      idFromName: vi.fn(() => ({ toString: () => 'tk-id' })),
      get: vi.fn(() => tkStub),
    };
    const { app } = createApp({ TIMEKEEPER } as unknown as Partial<Env>);

    const res = await app.request('/usage', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      dailySeconds: number;
      monthlySeconds: number;
      monthlyQuotaSeconds: number;
      tier: string;
    };
    expect(body.dailySeconds).toBe(1234);
    expect(body.monthlySeconds).toBe(5678);
    expect(tkStub.fetch).toHaveBeenCalledTimes(1);
    // Tier monthlySeconds must come from tier config (not from live response)
    expect(body.monthlyQuotaSeconds).toBeGreaterThan(0);
  });

  it('falls back to KV record when Timekeeper DO returns non-200', async () => {
    const tkStub = {
      fetch: vi.fn(async () => new Response('boom', { status: 500 })),
    };
    const TIMEKEEPER = {
      idFromName: vi.fn(() => ({ toString: () => 'tk-id' })),
      get: vi.fn(() => tkStub),
    };
    const { app, mockKV } = createApp({ TIMEKEEPER } as unknown as Partial<Env>);

    // Seed KV record for current UTC month/date so the fallback returns
    // non-zero counts.
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const date = now.toISOString().slice(0, 10);
    const record: UsageRecord = {
      today: { date, seconds: 42 },
      thisWeek: { weekStart: date, seconds: 42 },
      thisMonth: { month, seconds: 999 },
      thisYear: { year: String(now.getUTCFullYear()), seconds: 999 },
      allTime: { seconds: 999 },
      lastUpdatedAt: now.toISOString(),
    };
    mockKV._set('timekeeper:usage-bucket', record);

    const res = await app.request('/usage', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json() as { dailySeconds: number; monthlySeconds: number };
    expect(body.dailySeconds).toBe(42);
    expect(body.monthlySeconds).toBe(999);
    expect(tkStub.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to KV when TIMEKEEPER binding is absent', async () => {
    const { app, mockKV } = createApp({});

    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const date = now.toISOString().slice(0, 10);
    mockKV._set('timekeeper:usage-bucket', {
      today: { date, seconds: 10 },
      thisWeek: { weekStart: date, seconds: 10 },
      thisMonth: { month, seconds: 200 },
      thisYear: { year: String(now.getUTCFullYear()), seconds: 200 },
      allTime: { seconds: 200 },
      lastUpdatedAt: now.toISOString(),
    } as UsageRecord);

    const res = await app.request('/usage', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json() as { dailySeconds: number; monthlySeconds: number };
    expect(body.dailySeconds).toBe(10);
    expect(body.monthlySeconds).toBe(200);
  });

  it('returns zero seconds when KV record is for a stale month (UTC month rollover)', async () => {
    const { app, mockKV } = createApp({});
    // Record from last year — month mismatch causes 0 counts per AC.
    mockKV._set('timekeeper:usage-bucket', {
      today: { date: '2020-01-01', seconds: 999 },
      thisWeek: { weekStart: '2020-01-01', seconds: 999 },
      thisMonth: { month: '2020-01', seconds: 999 },
      thisYear: { year: '2020', seconds: 999 },
      allTime: { seconds: 999 },
      lastUpdatedAt: '2020-01-01T00:00:00Z',
    } as UsageRecord);

    const res = await app.request('/usage', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json() as { dailySeconds: number; monthlySeconds: number };
    expect(body.dailySeconds).toBe(0);
    expect(body.monthlySeconds).toBe(0);
  });

  it('uses billing-aware effective tier for monthlyQuotaSeconds (canceled subscription downgrades to free)', async () => {
    // Override the auth mock for this single test to inject a canceled user.
    const { authMiddleware } = await import('../../middleware/auth');
    vi.mocked(authMiddleware).mockImplementationOnce(async (c: any, next: any) => {
      c.set('user', {
        email: 'canceled@example.com',
        authenticated: true,
        role: 'user',
        accessTier: 'standard',
        subscriptionTier: 'standard',
        billingStatus: 'canceled',
        billingPeriodEnd: new Date(Date.now() - 86400_000).toISOString(),
      } as AccessUser);
      c.set('bucketName', 'canceled-bucket');
      return next();
    });
    const { app } = createApp({});
    const res = await app.request('/usage', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json() as { tier: string };
    // Canceled standard user is downgraded to free tier per getEffectiveTier.
    expect(body.tier.toLowerCase()).toContain('free');
  });
});
