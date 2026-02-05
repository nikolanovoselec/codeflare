import { describe, it, expect, vi, beforeEach } from 'vitest';
import handlers from '../../../routes/setup/handlers';
import type { Env } from '../../../types';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AuthError, AppError } from '../../../lib/error-types';
import { createMockKV } from '../../helpers/mock-kv';

vi.mock('../../../lib/circuit-breakers', () => ({
  cfApiCB: { execute: (fn: () => Promise<unknown>) => fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Setup Handlers', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env }>();

    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: err.message }, 500);
    });

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        ...envOverrides,
      } as unknown as Env;
      return next();
    });

    app.route('/setup', handlers);
    return app;
  }

  describe('GET /status', () => {
    it('returns configured: false when setup not complete', async () => {
      const app = createApp();

      const res = await app.request('/setup/status');

      expect(res.status).toBe(200);
      const body = await res.json() as { configured: boolean };
      expect(body.configured).toBe(false);
    });

    it('returns configured: true with custom domain when setup is complete', async () => {
      mockKV._set('setup:complete', true);
      // Store raw string for simple KV get
      mockKV._store.set('setup:complete', 'true');
      mockKV._store.set('setup:custom_domain', 'app.example.com');
      const app = createApp();

      const res = await app.request('/setup/status');

      expect(res.status).toBe(200);
      const body = await res.json() as { configured: boolean; customDomain?: string };
      expect(body.configured).toBe(true);
      expect(body.customDomain).toBe('app.example.com');
    });
  });

  describe('GET /detect-token', () => {
    it('returns detected: false when no token in env', async () => {
      const app = createApp();

      const res = await app.request('/setup/detect-token');

      expect(res.status).toBe(200);
      const body = await res.json() as { detected: boolean };
      expect(body.detected).toBe(false);
    });

    it('returns valid token info when CLOUDFLARE_API_TOKEN is set', async () => {
      const app = createApp({ CLOUDFLARE_API_TOKEN: 'test-token' } as Partial<Env>);

      // Mock verify and accounts API calls
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            success: true,
            result: { id: 'tok-123', status: 'active' },
            errors: [],
            messages: [],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({
            success: true,
            result: [{ id: 'acc-123', name: 'My Account' }],
            errors: [],
            messages: [],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        );

      const res = await app.request('/setup/detect-token');

      expect(res.status).toBe(200);
      const body = await res.json() as { detected: boolean; valid: boolean; account: { id: string; name: string } };
      expect(body.detected).toBe(true);
      expect(body.valid).toBe(true);
      expect(body.account.id).toBe('acc-123');
      expect(body.account.name).toBe('My Account');
    });

    it('returns valid: false when token verification fails', async () => {
      const app = createApp({ CLOUDFLARE_API_TOKEN: 'bad-token' } as Partial<Env>);

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({
          success: false,
          result: null,
          errors: [{ code: 1000, message: 'Invalid token' }],
          messages: [],
        }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      );

      const res = await app.request('/setup/detect-token');

      expect(res.status).toBe(200);
      const body = await res.json() as { detected: boolean; valid: boolean };
      expect(body.detected).toBe(true);
      expect(body.valid).toBe(false);
    });
  });

  describe('POST /reset-for-tests', () => {
    it('resets setup state in DEV_MODE', async () => {
      mockKV._store.set('setup:complete', 'true');
      const app = createApp({ DEV_MODE: 'true' } as Partial<Env>);

      const res = await app.request('/setup/reset-for-tests', { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
      expect(mockKV.delete).toHaveBeenCalledWith('setup:complete');
    });

    it('throws AuthError in production mode', async () => {
      const app = createApp({ DEV_MODE: 'false' } as Partial<Env>);

      const res = await app.request('/setup/reset-for-tests', { method: 'POST' });

      expect(res.status).toBe(401);
    });
  });

  describe('POST /restore-for-tests', () => {
    it('restores setup state in DEV_MODE', async () => {
      const app = createApp({ DEV_MODE: 'true' } as Partial<Env>);

      const res = await app.request('/setup/restore-for-tests', { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
      expect(mockKV.put).toHaveBeenCalledWith('setup:complete', 'true');
    });

    it('throws AuthError in production mode', async () => {
      const app = createApp({ DEV_MODE: 'false' } as Partial<Env>);

      const res = await app.request('/setup/restore-for-tests', { method: 'POST' });

      expect(res.status).toBe(401);
    });
  });
});
