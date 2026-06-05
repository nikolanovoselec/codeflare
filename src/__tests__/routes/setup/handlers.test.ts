import { describe, it, expect, vi, beforeEach } from 'vitest';
import handlers from '../../../routes/setup/handlers';
import type { Env } from '../../../types';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { AppError, ForbiddenError } from '../../../lib/error-types';
import { resetAuthConfigCache } from '../../../lib/access';
import { createMockKV } from '../../helpers/mock-kv';

vi.mock('../../../lib/circuit-breakers', () => ({
  cfApiCB: { execute: (fn: () => Promise<unknown>) => fn() },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Setup Handlers / REQ-SETUP-005 (admin-only auth gate on POST setup endpoints) / REQ-SETUP-006 (setup config persistence + reload) / REQ-SETUP-008 (setup wizard step state machine and validation) / REQ-SETUP-011 (allowlist persisted as KV user records via setup endpoint)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  const _TEST_EMAIL = 'test@example.com';

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    resetAuthConfigCache();
  });

  function createApp(envOverrides: Partial<Env> = {}) {
    const app = new Hono<{ Bindings: Env }>();

    app.onError((err, c) => {
      if (err instanceof ForbiddenError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
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

  describe('REQ-ENTERPRISE-010: setup exposes the enterprise access group', () => {
    it('GET /status returns enterpriseMode:true when ENTERPRISE_MODE=active', async () => {
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/status');
      expect(res.status).toBe(200);
      const body = await res.json() as { enterpriseMode?: boolean };
      expect(body.enterpriseMode).toBe(true);
    });

    it('GET /status returns enterpriseMode:false when the flag is unset (regression)', async () => {
      const app = createApp();
      const res = await app.request('/setup/status');
      const body = await res.json() as { enterpriseMode?: boolean };
      expect(body.enterpriseMode).toBe(false);
    });

    it('GET /prefill round-trips the stored ENTERPRISE_ACCESS_GROUP', async () => {
      mockKV._store.set('setup:enterprise_access_group', 'Codeflare-Users');
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      expect(res.status).toBe(200);
      const body = await res.json() as { enterpriseAccessGroup?: string };
      expect(body.enterpriseAccessGroup).toBe('Codeflare-Users');
    });

    it('GET /prefill returns an empty group string when none is stored', async () => {
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as { enterpriseAccessGroup?: string };
      expect(body.enterpriseAccessGroup).toBe('');
    });
  });

});
