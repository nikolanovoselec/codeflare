import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

// Configurable mock auth result
const mockAuthResult = {
  user: { email: 'pending@example.com', authenticated: true, role: 'user', accessTier: 'pending' } as AccessUser,
  bucketName: 'codeflare-pending',
};
let mockAuthShouldReject = false;

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => {
    if (mockAuthShouldReject) {
      throw new AppError('AUTH_ERROR', 401, 'Not authenticated');
    }
    return { ...mockAuthResult, user: { ...mockAuthResult.user } };
  }),
}));

// Import after mock
import authRoutes from '../../routes/auth';

describe('POST /auth/request-access', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
    mockAuthShouldReject = false;
    mockAuthResult.user = {
      email: 'pending@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'pending',
    };
    mockAuthResult.bucketName = 'codeflare-pending';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        TURNSTILE_SECRET_KEY: 'turnstile-secret',
        ...envOverrides,
      } as Env;
      return next();
    });

    app.route('/auth', authRoutes);

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  it('returns 200 with valid Turnstile token', async () => {
    // Mock successful Turnstile verification
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (requestUrl.includes('/turnstile/v0/siteverify')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;

    // Add user entry in KV
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
    });

    const app = createApp();
    const res = await app.request('/auth/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    // Verify requestedAt was saved to KV
    const userData = await mockKV.get('user:pending@example.com', 'json') as Record<string, unknown>;
    expect(userData.requestedAt).toBeDefined();
    expect(typeof userData.requestedAt).toBe('string');
  });

  it('returns 200 idempotently when requestedAt already set (no re-notification)', async () => {
    // User already submitted — requestedAt is set
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
      requestedAt: '2025-01-02T12:00:00Z',
    });

    // fetch should NOT be called (no Turnstile verify, no email)
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const app = createApp();
    const res = await app.request('/auth/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
    // No external calls made (idempotent)
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 without Turnstile token', async () => {
    const app = createApp();
    const res = await app.request('/auth/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('returns 403 with invalid Turnstile token', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (requestUrl.includes('/turnstile/v0/siteverify')) {
        return new Response(
          JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
          { status: 200 }
        );
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;

    const app = createApp();
    const res = await app.request('/auth/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'bad-token' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('returns 400 for already-active user', async () => {
    mockAuthResult.user = {
      email: 'active@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'standard',
    };

    const app = createApp();
    const res = await app.request('/auth/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('already active');
  });

  it('returns 403 for blocked user', async () => {
    mockAuthResult.user = {
      email: 'blocked@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'blocked',
    };

    const app = createApp();
    const res = await app.request('/auth/request-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('FORBIDDEN');
  });

  it('includes turnstileSiteKey and requestedAt in GET /auth/status for pending users', async () => {
    mockKV._store.set('setup:turnstile_site_key', '0xSITEKEY123');
    mockKV._set('user:pending@example.com', {
      addedBy: 'jit',
      addedAt: '2025-01-01T00:00:00Z',
      role: 'user',
      accessTier: 'pending',
      requestedAt: '2025-01-02T12:00:00Z',
    });

    const app = createApp();
    const res = await app.request('/auth/status');

    expect(res.status).toBe(200);
    const body = await res.json() as { turnstileSiteKey: string; requestedAt: string };
    expect(body.turnstileSiteKey).toBe('0xSITEKEY123');
    expect(body.requestedAt).toBe('2025-01-02T12:00:00Z');
  });

  it('returns null turnstileSiteKey and requestedAt for non-pending users', async () => {
    mockAuthResult.user = {
      email: 'active@example.com',
      authenticated: true,
      role: 'user',
      accessTier: 'standard',
    };

    const app = createApp();
    const res = await app.request('/auth/status');

    expect(res.status).toBe(200);
    const body = await res.json() as { turnstileSiteKey: string | null; requestedAt: string | null };
    expect(body.turnstileSiteKey).toBeNull();
    expect(body.requestedAt).toBeNull();
  });
});
