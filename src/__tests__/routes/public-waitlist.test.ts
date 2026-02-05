import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import publicRoutes from '../../routes/public';
import { AppError, ValidationError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

describe('Public waitlist route', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function createTestApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env }>();

    app.onError((err, c) => {
      if (err instanceof AppError || err instanceof ValidationError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: err.message }, 500);
    });

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        DEV_MODE: 'false',
        ONBOARDING_LANDING_PAGE: 'inactive',
        ...envOverrides,
      } as Env;
      return next();
    });

    app.route('/public', publicRoutes);
    return app;
  }

  it('returns 404 when onboarding landing page is inactive', async () => {
    const app = createTestApp();

    const res = await app.request('/public/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@example.com',
        turnstileToken: 'token',
      }),
    });

    expect(res.status).toBe(404);
  });

  it('returns 400 when email is invalid', async () => {
    const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active' });

    const res = await app.request('/public/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'invalid-email',
        turnstileToken: 'token',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 503 when turnstile/resend secrets are missing in active mode', async () => {
    const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active' });

    const res = await app.request('/public/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        turnstileToken: 'token',
      }),
    });

    expect(res.status).toBe(503);
  });

  it('returns 400 when turnstile verification fails', async () => {
    const app = createTestApp({
      ONBOARDING_LANDING_PAGE: 'active',
      TURNSTILE_SECRET_KEY: 'turnstile-secret',
      RESEND_API_KEY: 're_123',
    });
    mockKV._set('user:admin@example.com', {
      addedBy: 'setup',
      addedAt: new Date().toISOString(),
      role: 'admin',
    });

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

    const res = await app.request('/public/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'user@example.com',
        turnstileToken: 'bad-token',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error.toLowerCase()).toContain('captcha');
  });

  // ===========================================================================
  // GET /public/onboarding-config
  // ===========================================================================

  it('returns onboarding config with active=true and turnstile site key', async () => {
    const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active' });
    // Use _store.set directly because turnstile_site_key is a raw string, not JSON
    mockKV._store.set('setup:turnstile_site_key', '0xABCDEF123456');

    const res = await app.request('/public/onboarding-config');

    expect(res.status).toBe(200);
    const body = await res.json() as { active: boolean; turnstileSiteKey: string | null };
    expect(body.active).toBe(true);
    expect(body.turnstileSiteKey).toBe('0xABCDEF123456');
  });

  it('returns null turnstileSiteKey when not configured', async () => {
    const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'active' });

    const res = await app.request('/public/onboarding-config');

    expect(res.status).toBe(200);
    const body = await res.json() as { active: boolean; turnstileSiteKey: string | null };
    expect(body.active).toBe(true);
    expect(body.turnstileSiteKey).toBeNull();
  });

  it('returns 404 for onboarding-config when onboarding is inactive', async () => {
    const app = createTestApp({ ONBOARDING_LANDING_PAGE: 'inactive' });

    const res = await app.request('/public/onboarding-config');

    expect(res.status).toBe(404);
  });

  it('sends waitlist notification email to admin users on successful submission', async () => {
    const app = createTestApp({
      ONBOARDING_LANDING_PAGE: 'active',
      TURNSTILE_SECRET_KEY: 'turnstile-secret',
      RESEND_API_KEY: 're_123',
      WAITLIST_FROM_EMAIL: 'Codeflare Waitlist <noreply@example.com>',
    });
    mockKV._set('user:admin@example.com', {
      addedBy: 'setup',
      addedAt: new Date().toISOString(),
      role: 'admin',
    });
    mockKV._set('user:viewer@example.com', {
      addedBy: 'setup',
      addedAt: new Date().toISOString(),
      role: 'user',
    });

    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (requestUrl.includes('/turnstile/v0/siteverify')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (requestUrl === 'https://api.resend.com/emails') {
        const body = JSON.parse(init?.body as string) as { to: string[] };
        expect(body.to).toEqual(['admin@example.com']);
        return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof globalThis.fetch;

    const res = await app.request('/public/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.12' },
      body: JSON.stringify({
        email: 'new-tester@example.com',
        turnstileToken: 'good-token',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });
});

