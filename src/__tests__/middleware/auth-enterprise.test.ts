/**
 * REQ-ENTERPRISE-001: requireActiveUser under ENTERPRISE_MODE.
 *
 * When ENTERPRISE_MODE === 'active', the pending/blocked 403 gate is skipped so
 * any authenticated user passes through (every user is unlimited tier). When the
 * flag is unset, the SaaS pending/blocked gate is byte-identical to today.
 *
 * AC1. Enterprise: a pending user passes through (no 403) even with SAAS_MODE active.
 * AC2. Enterprise: a blocked user passes through (no 403).
 * AC3. flag-off regression: the pending/blocked 403 gate is intact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

const mockAuthResult = {
  user: { email: 'test@example.com', authenticated: true, role: 'user' } as AccessUser,
  bucketName: 'codeflare-test',
};

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => ({ ...mockAuthResult, user: { ...mockAuthResult.user } })),
  // auth.ts imports this for requireAdmin; requireActiveUser (under test) never calls it.
  resolveAdminAccessGroup: vi.fn(async () => []),
}));

import { requireActiveUser } from '../../middleware/auth';

describe('requireActiveUser under ENTERPRISE_MODE / REQ-ENTERPRISE-001', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    mockAuthResult.user = {
      email: 'pending@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'pending',
      subscriptionTier: 'pending',
    };
    mockAuthResult.bucketName = 'codeflare-test';
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.env = { KV: mockKV as unknown as KVNamespace, ...envOverrides } as Env;
      return next();
    });
    app.use('*', requireActiveUser);
    app.get('/test', (c) => c.json({ user: c.get('user'), bucketName: c.get('bucketName') }));
    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404);
      return c.json({ error: 'Unexpected error' }, 500);
    });
    return app;
  }

  // ── AC1: enterprise passthrough for pending user ──
  it('AC1: pending user passes through (200) when ENTERPRISE_MODE=active even with SAAS_MODE=active', async () => {
    const app = createApp({ SAAS_MODE: 'active', ENTERPRISE_MODE: 'active' });
    const res = await app.request('/test', {
      headers: { 'cf-access-authenticated-user-email': 'pending@example.com' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { user: AccessUser };
    expect(body.user.email).toBe('pending@example.com');
  });

  // ── AC2: enterprise passthrough for blocked user ──
  it('AC2: blocked user passes through (200) when ENTERPRISE_MODE=active', async () => {
    mockAuthResult.user = {
      email: 'blocked@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'blocked',
      subscriptionTier: 'blocked',
    };
    const app = createApp({ SAAS_MODE: 'active', ENTERPRISE_MODE: 'active' });
    const res = await app.request('/test', {
      headers: { 'cf-access-authenticated-user-email': 'blocked@example.com' },
    });
    expect(res.status).toBe(200);
  });

  // ── AC3: flag-off regression — gate intact ──
  it('flag-off: pending user is still 403 PENDING when SAAS_MODE=active and ENTERPRISE_MODE unset', async () => {
    const app = createApp({ SAAS_MODE: 'active' });
    const res = await app.request('/test', {
      headers: { 'cf-access-authenticated-user-email': 'pending@example.com' },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('PENDING');
  });

  it('flag-off: blocked user is still 403 BLOCKED when SAAS_MODE=active and ENTERPRISE_MODE unset', async () => {
    mockAuthResult.user = {
      email: 'blocked@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'blocked',
      subscriptionTier: 'blocked',
    };
    const app = createApp({ SAAS_MODE: 'active' });
    const res = await app.request('/test', {
      headers: { 'cf-access-authenticated-user-email': 'blocked@example.com' },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('BLOCKED');
  });
});
