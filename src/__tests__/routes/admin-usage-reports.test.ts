import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';

let role = 'admin';
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => { c.set('user', { email: 'admin@example.com', authenticated: true, role }); return next(); }),
  requireAdmin: vi.fn(async (c: any, next: any) => role === 'admin' ? next() : c.json({ error: 'Forbidden' }, 403)),
}));
vi.mock('../../lib/usage-report-scheduler', async (original) => ({
  ...await original<any>(),
  createReportDispatch: vi.fn(async () => undefined),
  recoverReportDeliveries: vi.fn(async () => undefined),
}));

import reportRoutes from '../../routes/admin/usage-reports';
import { createReportDispatch, recoverReportDeliveries } from '../../lib/usage-report-scheduler';

function createApp() {
  const db = {
    prepare: vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [{
      id: 'd1', delivery_kind: 'test', dispatch_id: 'test:req-1', settings_revision: 2,
      report_month: '2027-07', recipient: 'admin@example.com', state: 'pending', attempt: 0,
      reason: null, created_at: '2027-08-01T00:00:00.000Z', updated_at: '2027-08-01T00:00:00.000Z',
    }] }) }) })),
  };
  const env = {
    USAGE_DB: db as unknown as D1Database,
    KV: { get: vi.fn(async () => ({ enabled: true, recipients: ['admin@example.com'], day: 1, hour: 9, timezone: 'UTC', settingsRevision: 2 })) },
  } as unknown as Env;
  const waitUntil = vi.fn();
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables & { requestId: string } }>();
  app.use('*', async (c, next) => { c.set('requestId', 'req-1'); return next(); });
  app.route('/admin', reportRoutes);
  const request = (path: string, init?: RequestInit) => app.fetch(
    new Request(`http://localhost${path}`, init), env, { waitUntil } as unknown as ExecutionContext,
  );
  return { request, waitUntil };
}

describe('admin usage report routes (REQ-SUB-027)', () => {
  beforeEach(() => { role = 'admin'; vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it('creates current-month test delivery rows and uses waitUntil only as fast path', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-08-15T12:00:00.000Z'));
    const { request, waitUntil } = createApp();
    const response = await request('/admin/usage-report-tests', { method: 'POST' });
    expect(response.status).toBe(202);
    expect(createReportDispatch).toHaveBeenCalledWith(expect.anything(), 'test', 'test:req-1', 2, '2027-08', ['admin@example.com'], new Date('2027-08-15T12:00:00.000Z'));
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(recoverReportDeliveries).toHaveBeenCalledOnce();
  });

  it('returns cursor-ready history with public delivery identity fields', async () => {
    const { request } = createApp();
    const response = await request('/admin/usage-report-deliveries?limit=25');
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.deliveries[0]).toMatchObject({ deliveryKind: 'test', dispatchId: 'test:req-1', state: 'pending' });
  });

  it('requires administrator role', async () => {
    role = 'user';
    expect((await createApp().request('/admin/usage-report-deliveries')).status).toBe(403);
  });
});
