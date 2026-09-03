import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';

let role = 'admin';
let unauthenticated = false;
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (unauthenticated) throw new AppError('AUTH_ERROR', 401, 'Not authenticated');
    c.set('user', { email: 'admin@example.com', authenticated: true, role });
    c.set('bucketName', 'codeflare-admin');
    return next();
  }),
  requireAdmin: vi.fn(async (c: any, next: any) => role === 'admin' ? next() : c.json({ error: 'Forbidden' }, 403)),
}));

import adminUsageRoutes from '../../routes/admin/usage';

const rows = [
  {
    user_key: 'a'.repeat(64), email: 'alice@example.com', account_status: 'active', data_since: '2026-08-01T00:00:00.000Z',
    deleted_at: null, runtime_seconds: 120, session_count: 2, updated_at: '2026-08-30T12:00:00.000Z',
  },
  {
    user_key: 'b'.repeat(64), email: 'bob@example.com', account_status: 'deleted', data_since: '2026-08-02T00:00:00.000Z',
    deleted_at: '2026-08-29T00:00:00.000Z', runtime_seconds: 0, session_count: 0, updated_at: '2026-08-30T11:00:00.000Z',
  },
  {
    user_key: 'c'.repeat(64), email: '=2+2@example.com', account_status: 'active', data_since: '2026-08-03T00:00:00.000Z',
    deleted_at: null, runtime_seconds: 1, session_count: 1, updated_at: '2026-08-30T10:00:00.000Z',
  },
];

function createApp() {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({ bind: (...values: unknown[]) => {
      statements.push({ sql, values });
      return {
        all: vi.fn(async () => ({ success: true, results: sql.includes('COUNT(')
          ? [{ runtime_seconds: 120, session_count: 2, active_users: 1, data_since: '2026-08-01T00:00:00.000Z', history_updated_at: '2026-08-30T12:00:00.000Z' }]
          : sql.includes('GROUP BY p.period_start')
            ? [
              { period_start: '2026-08-30', runtime_seconds: 120, session_count: 2, history_updated_at: '2026-08-30T12:00:00.000Z' },
              { period_start: '2026-08-29', runtime_seconds: 60, session_count: 1, history_updated_at: '2026-08-29T12:00:00.000Z' },
            ]
            : rows })),
      };
    } })),
  };
  const env = { USAGE_DB: db as unknown as D1Database } as Env;
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
  app.use('*', async (c, next) => { c.env = env; return next(); });
  app.route('/admin/usage', adminUsageRoutes);
  app.onError((error, c) => error instanceof AppError
    ? c.json(error.toJSON(), error.statusCode as any)
    : c.json({ error: String(error) }, 500));
  return { app, statements };
}

describe('admin organization usage routes (REQ-SUB-026)', () => {
  beforeEach(() => {
    role = 'admin';
    unauthenticated = false;
    vi.clearAllMocks();
  });

  it('rejects unauthenticated and non-admin requests in every mode', async () => {
    const { app } = createApp();
    unauthenticated = true;
    expect((await app.request('/admin/usage?period=day&start=2026-08-30')).status).toBe(401);
    unauthenticated = false;
    role = 'user';
    expect((await app.request('/admin/usage?period=day&start=2026-08-30')).status).toBe(403);
  });

  it('returns chronological existing history aggregates and deterministic user rows', async () => {
    const { app, statements } = createApp();
    const response = await app.request('/admin/usage?period=day&start=2026-08-30&sort=runtimeSeconds&direction=desc&limit=2');
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      period: 'day', start: '2026-08-30', timezone: 'UTC',
      summary: { runtimeSeconds: 120, sessionCount: 2, activeUsers: 1 },
      dataSince: '2026-08-01T00:00:00.000Z',
      historyUpdatedAt: '2026-08-30T12:00:00.000Z',
      series: [
        { start: '2026-08-29', runtimeSeconds: 60, sessionCount: 1, historyUpdatedAt: '2026-08-29T12:00:00.000Z' },
        { start: '2026-08-30', runtimeSeconds: 120, sessionCount: 2, historyUpdatedAt: '2026-08-30T12:00:00.000Z' },
      ],
    });
    expect(body.users).toHaveLength(2);
    expect(body.users[1]).toMatchObject({ email: 'bob@example.com', accountStatus: 'deleted' });
    expect(statements.some((statement) => /ORDER BY p\.runtime_seconds DESC, u\.user_key ASC/.test(statement.sql))).toBe(true);
    expect(statements.some((statement) => /GROUP BY p\.period_start[\s\S]*ORDER BY p\.period_start DESC/.test(statement.sql))).toBe(true);
  });

  it('bounds every history series to its configured period limit', async () => {
    for (const [period, start, limit] of [
      ['day', '2026-08-30', 14],
      ['week', '2026-08-24', 12],
      ['month', '2026-08', 12],
      ['year', '2026', 5],
    ] as const) {
      const { app, statements } = createApp();

      expect((await app.request(`/admin/usage?period=${period}&start=${start}`)).status).toBe(200);

      const series = statements.find((statement) => /GROUP BY p\.period_start/.test(statement.sql));
      expect(series?.values).toEqual([period, start, limit]);
    }
  });

  it('rejects malformed calendar starts before SQL', async () => {
    for (const query of [
      'period=day&start=2026-02-30',
      'period=month&start=2026-13',
      'period=week&start=2026-08-25',
    ]) {
      const { app, statements } = createApp();
      expect((await app.request(`/admin/usage?${query}`)).status).toBe(400);
      expect(statements).toHaveLength(0);
    }
  });

  it('rejects malformed, mismatched, and timezone-bearing cursor requests before SQL', async () => {
    const { app, statements } = createApp();
    expect((await app.request('/admin/usage?period=day&start=2026-08-30&cursor=bad')).status).toBe(400);
    const cursor = Buffer.from(JSON.stringify({
      v: 1, period: 'month', start: '2026-08', sort: 'runtimeSeconds', direction: 'desc', lastValue: 10, userKey: 'a'.repeat(64),
    })).toString('base64url');
    expect((await app.request(`/admin/usage?period=day&start=2026-08-30&cursor=${cursor}`)).status).toBe(400);
    expect((await app.request('/admin/usage?period=day&start=2026-08-30&timezone=Europe%2FBerlin')).status).toBe(400);
    expect(statements).toHaveLength(0);
  });

  it('uses the same row mapping and order for JSON and unpaginated CSV', async () => {
    const jsonApp = createApp().app;
    const json = await (await jsonApp.request('/admin/usage?period=day&start=2026-08-30&sort=email&direction=asc')).json() as any;
    const csvApp = createApp().app;
    const response = await csvApp.request('/admin/usage?period=day&start=2026-08-30&sort=email&direction=asc&format=csv');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const csv = await response.text();
    expect(csv).toContain('alice@example.com');
    expect(csv).toContain('bob@example.com');
    expect(csv).toContain("'=2+2@example.com");
    expect(csv.indexOf(json.users[0].email)).toBeLessThan(csv.indexOf(json.users[1].email));
  });

  it('returns user detail by opaque user key and never places email in the path', async () => {
    const { app } = createApp();
    const response = await app.request(`/admin/usage/users/${'a'.repeat(64)}?period=day&start=2026-08-30`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      userKey: 'a'.repeat(64), email: 'alice@example.com', runtimeSeconds: 120, sessionCount: 2,
    });
    expect((await app.request('/admin/usage/users/alice@example.com?period=day&start=2026-08-30')).status).toBe(400);
  });
});
