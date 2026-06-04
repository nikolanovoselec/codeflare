/**
 * REQ-ENTERPRISE-002: GET /api/user exposes the enterpriseMode flag.
 *
 * The response carries an additive boolean `enterpriseMode` derived from
 * isEnterpriseMode(env). It is true only when ENTERPRISE_MODE=active and false
 * otherwise; when false the rest of the payload is byte-identical to today.
 *
 * AC1. enterpriseMode === true when ENTERPRISE_MODE=active.
 * AC2. flag-off regression: enterpriseMode === false when ENTERPRISE_MODE unset,
 *      and the rest of the payload is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userProfileRoutes from '../../routes/user-profile';
import type { Env } from '../../types';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError } from '../../lib/error-types';
import { AuthVariables } from '../../middleware/auth';
import { createMockKV } from '../helpers/mock-kv';

const mockAuthenticateRequest = vi.hoisted(() => vi.fn());
const mockGetOrCreateScopedR2Token = vi.hoisted(() => vi.fn());

vi.mock('../../lib/access', () => ({ authenticateRequest: mockAuthenticateRequest }));
vi.mock('../../lib/r2-admin', () => ({ getOrCreateScopedR2Token: mockGetOrCreateScopedR2Token }));

describe('GET /api/user enterpriseMode flag / REQ-ENTERPRISE-002', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    mockAuthenticateRequest.mockResolvedValue({
      user: { email: 'test@example.com', authenticated: true, role: 'user' },
      bucketName: 'codeflare-abc123',
    });
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
    app.onError((err, c) => {
      if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      return c.json({ error: err.message }, 500);
    });
    app.use('*', async (c, next) => {
      c.env = { KV: mockKV as unknown as KVNamespace, ...envOverrides } as unknown as Env;
      return next();
    });
    app.route('/user', userProfileRoutes);
    return app;
  }

  // ── AC1: flag on ──
  it('AC1: enterpriseMode is true when ENTERPRISE_MODE=active', async () => {
    const app = createApp({ ENTERPRISE_MODE: 'active' });
    const res = await app.request('/user');
    expect(res.status).toBe(200);
    const body = await res.json() as { enterpriseMode: boolean };
    expect(body.enterpriseMode).toBe(true);
  });

  // ── AC2: flag-off regression ──
  it('flag-off: enterpriseMode is false when ENTERPRISE_MODE is unset', async () => {
    const app = createApp();
    const res = await app.request('/user');
    expect(res.status).toBe(200);
    const body = await res.json() as { enterpriseMode: boolean };
    expect(body.enterpriseMode).toBe(false);
  });

  it("flag-off: enterpriseMode is false for non-'active' values", async () => {
    const app = createApp({ ENTERPRISE_MODE: 'true' });
    const res = await app.request('/user');
    expect(res.status).toBe(200);
    const body = await res.json() as { enterpriseMode: boolean };
    expect(body.enterpriseMode).toBe(false);
  });

  it('flag-off: the rest of the payload is unchanged (additive field only)', async () => {
    mockKV._set('user:test@example.com', { onboardingComplete: true, subscribedMode: 'default' });
    const app = createApp();
    const res = await app.request('/user');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // Every pre-existing field is present and unchanged; enterpriseMode is the
    // only addition and is false on the off path.
    // c.json strips undefined fields, so accessTier/subscriptionTier (both
    // undefined for this user) do not appear as keys.
    expect(body).toEqual({
      email: 'test@example.com',
      authenticated: true,
      role: 'user',
      bucketName: 'codeflare-abc123',
      workerName: 'codeflare',
      onboardingActive: false,
      saasMode: false,
      onboardingComplete: true,
      // subscriptionTier is undefined ⇒ not 'pending'/'blocked' ⇒ hasSubscribed true
      hasSubscribed: true,
      subscribedMode: 'default',
      enterpriseMode: false,
    });
  });
});
