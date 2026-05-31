import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

import authRedirectRoutes from '../../routes/auth-redirects';

describe('Auth redirect routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env }>();

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        ...envOverrides,
      } as Env;
      return next();
    });

    app.route('/', authRedirectRoutes);

    app.onError((_err, c) => {
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  // ===========================================================================
  // GET /login/:provider
  // ===========================================================================
  describe('GET /login/:provider', () => {
    it('returns 503 when setup:custom_domain is not set in KV', async () => {
      const app = createApp();
      const res = await app.request('/login/google');

      expect(res.status).toBe(503);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('Auth not configured');
    });

    it('redirects to https://{customDomain}/app/ when custom_domain is set', async () => {
      mockKV._store.set('setup:custom_domain', 'myapp.example.com');

      const app = createApp();
      const res = await app.request('/login/google');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://myapp.example.com/app/');
    });

    it('redirects regardless of which provider is specified', async () => {
      mockKV._store.set('setup:custom_domain', 'myapp.example.com');

      const app = createApp();
      const res = await app.request('/login/github');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://myapp.example.com/app/');
    });
  });

  // ===========================================================================
  // GET /logout
  // ===========================================================================
  describe('GET /logout / REQ-AUTH-009 (logout dispatches by mode)', () => {
    it('redirects to CF Access logout URL when auth_domain is set', async () => {
      mockKV._store.set('setup:auth_domain', 'myteam.cloudflareaccess.com');
      mockKV._store.set('setup:custom_domain', 'myapp.example.com');

      const app = createApp();
      const res = await app.request('/logout');

      expect(res.status).toBe(302);
      const location = res.headers.get('Location')!;
      expect(location).toContain('https://myteam.cloudflareaccess.com/cdn-cgi/access/logout');
      expect(location).toContain('returnTo=');
    });

    it('encodes returnTo parameter correctly with custom_domain', async () => {
      mockKV._store.set('setup:auth_domain', 'myteam.cloudflareaccess.com');
      mockKV._store.set('setup:custom_domain', 'myapp.example.com');

      const app = createApp();
      const res = await app.request('/logout');

      const location = res.headers.get('Location')!;
      const expectedReturnTo = encodeURIComponent('https://myapp.example.com/');
      expect(location).toBe(
        `https://myteam.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=${expectedReturnTo}`
      );
    });

    it('redirects to request host origin when auth_domain is not set but custom_domain is set', async () => {
      mockKV._store.set('setup:custom_domain', 'myapp.example.com');

      const app = createApp();
      const res = await app.request('/logout');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://myapp.example.com/');
    });

    it('redirects to request host origin when neither auth_domain nor custom_domain is set', async () => {
      const app = createApp();
      const res = await app.request('http://localhost/logout');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('http://localhost/');
    });

    it('uses returnTo derived from request URL when custom_domain is not set', async () => {
      mockKV._store.set('setup:auth_domain', 'myteam.cloudflareaccess.com');

      const app = createApp();
      const res = await app.request('http://localhost:8787/logout');

      expect(res.status).toBe(302);
      const location = res.headers.get('Location')!;
      const expectedReturnTo = encodeURIComponent('http://localhost:8787/');
      expect(location).toBe(
        `https://myteam.cloudflareaccess.com/cdn-cgi/access/logout?returnTo=${expectedReturnTo}`
      );
    });
  });
});
