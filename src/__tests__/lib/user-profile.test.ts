import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';

// Mock auth middleware to set user/bucketName without real Access JWT verification
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'test@example.com', authenticated: true, role: 'admin' });
    c.set('bucketName', 'test-bucket');
    await next();
  }),
  AuthVariables: {},
}));

vi.mock('../../lib/onboarding', () => ({
  isOnboardingLandingPageActive: vi.fn((val?: string) => val === 'active'),
}));

import userProfileRoutes from '../../routes/user-profile';

describe('GET /api/user', () => {
  function createTestApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        CLOUDFLARE_WORKER_NAME: 'codeflare',
        ONBOARDING_LANDING_PAGE: 'inactive',
        ...envOverrides,
      } as unknown as Env;
      return next();
    });

    app.route('/api/user', userProfileRoutes);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns user info with default worker name', async () => {
    const app = createTestApp();
    const res = await app.request('/api/user');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.email).toBe('test@example.com');
    expect(body.authenticated).toBe(true);
    expect(body.role).toBe('admin');
    expect(body.bucketName).toBe('test-bucket');
    expect(body.workerName).toBe('codeflare');
  });

  it('returns custom worker name from env', async () => {
    const app = createTestApp({ CLOUDFLARE_WORKER_NAME: 'my-fork' } as Partial<Env>);
    const res = await app.request('/api/user');
    const body = await res.json() as Record<string, unknown>;
    expect(body.workerName).toBe('my-fork');
  });

  it('returns onboardingActive based on env flag', async () => {
    const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active' } as Partial<Env>);
    const res = await app.request('/api/user');
    const body = await res.json() as Record<string, unknown>;
    expect(body.onboardingActive).toBe(true);
  });

  it('returns onboardingActive false when inactive', async () => {
    const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'inactive' } as Partial<Env>);
    const res = await app.request('/api/user');
    const body = await res.json() as Record<string, unknown>;
    expect(body.onboardingActive).toBe(false);
  });
});
