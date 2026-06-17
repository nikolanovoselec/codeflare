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

    it('GET /prefill splits the stored CSV groups back into an array', async () => {
      mockKV._store.set('setup:enterprise_access_group', 'team_a,team_b');
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      expect(res.status).toBe(200);
      const body = await res.json() as { enterpriseAccessGroup?: string[] };
      expect(body.enterpriseAccessGroup).toEqual(['team_a', 'team_b']);
    });

    it('REQ-ENTERPRISE-014: GET /prefill splits the stored admin-group CSV back into an array', async () => {
      mockKV._store.set('setup:enterprise_admin_access_group', 'ops_admins,security_admins');
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      expect(res.status).toBe(200);
      const body = await res.json() as { adminAccessGroup?: string[] };
      expect(body.adminAccessGroup).toEqual(['ops_admins', 'security_admins']);
    });

    it('GET /prefill round-trips the stored dynamicRoutes', async () => {
      mockKV._store.set('setup:dynamic_routes', JSON.stringify(['development']));
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as { dynamicRoutes?: string[] };
      expect(body.dynamicRoutes).toEqual(['development']);
    });

    it('GET /prefill round-trips the stored defaultRoute', async () => {
      mockKV._store.set('setup:default_route', JSON.stringify({ route: 'development', reasoning: 'high' }));
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as { defaultRoute?: { route: string; reasoning: string } | null };
      expect(body.defaultRoute).toEqual({ route: 'development', reasoning: 'high' });
    });

    it('GET /prefill returns empty defaults when nothing is stored', async () => {
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as {
        enterpriseAccessGroup?: string[];
        adminAccessGroup?: string[];
        dynamicRoutes?: string[];
        defaultRoute?: unknown;
      };
      expect(body.enterpriseAccessGroup).toEqual([]);
      expect(body.adminAccessGroup).toEqual([]);
      expect(body.dynamicRoutes).toEqual([]);
      expect(body.defaultRoute).toBeNull();
    });

    it('GET /prefill degrades to empty defaults when stored route JSON is malformed', async () => {
      // Real Cloudflare KV.get(key, 'json') THROWS on malformed stored JSON. This
      // read runs before the handler's CF-API try block, so without a guard a bad
      // value would 500 the whole prefill. Simulate the boundary throwing.
      mockKV.get.mockImplementation(async (_key: string, type?: string) => {
        if (type === 'json') throw new SyntaxError('Unexpected token in JSON');
        return null;
      });
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      expect(res.status).toBe(200);
      const body = await res.json() as { dynamicRoutes?: string[]; defaultRoute?: unknown };
      expect(body.dynamicRoutes).toEqual([]);
      expect(body.defaultRoute).toBeNull();
    });

    it('GET /prefill omits the enterprise extras when ENTERPRISE_MODE is unset (regression)', async () => {
      // Even with values stored in KV, a non-enterprise prefill response must be
      // byte-identical to the pre-feature shape (no enterprise keys leak).
      mockKV._store.set('setup:enterprise_access_group', 'team_a');
      mockKV._store.set('setup:dynamic_routes', JSON.stringify(['development']));
      const app = createApp(); // ENTERPRISE_MODE unset
      const res = await app.request('/setup/prefill');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('enterpriseAccessGroup');
      expect(body).not.toHaveProperty('adminAccessGroup');
      expect(body).not.toHaveProperty('dynamicRoutes');
      expect(body).not.toHaveProperty('defaultRoute');
    });

    it('GET /prefill returns the extras on the no-token path (regression)', async () => {
      mockKV._store.set('setup:enterprise_access_group', 'team_a');
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as {
        enterpriseAccessGroup?: string[];
        dynamicRoutes?: string[];
        defaultRoute?: unknown;
      };
      expect(body.enterpriseAccessGroup).toEqual(['team_a']);
      expect(body.dynamicRoutes).toEqual([]);
      expect(body.defaultRoute).toBeNull();
    });
  });

  describe('REQ-BROWSER-007: admin Browser Rendering token prefill (masked)', () => {
    it('GET /prefill reports the token as set + returns the account id, never the token', async () => {
      mockKV._store.set('setup:browser_render_token', 'encrypted-blob-never-returned');
      mockKV._store.set('setup:browser_render_account_id', 'acct123');
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as Record<string, unknown>;
      expect(body.browserRenderTokenSet).toBe(true);
      expect(body.browserRenderAccountId).toBe('acct123');
      // The token value itself is never surfaced to the browser.
      expect(JSON.stringify(body)).not.toContain('encrypted-blob-never-returned');
    });

    it('GET /prefill reports the token unset + empty account when nothing is stored', async () => {
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as Record<string, unknown>;
      expect(body.browserRenderTokenSet).toBe(false);
      expect(body.browserRenderAccountId).toBe('');
    });

    it('GET /prefill omits the browser-token fields when ENTERPRISE_MODE is unset', async () => {
      mockKV._store.set('setup:browser_render_token', 'x');
      const app = createApp();
      const res = await app.request('/setup/prefill');
      const body = await res.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('browserRenderTokenSet');
      expect(body).not.toHaveProperty('browserRenderAccountId');
    });
  });

  describe('REQ-GITHUB-008: enterprise GitHub provider config prefill (masked)', () => {
    it('GET /prefill returns provider type + client ids + secret-set flags, never the secrets', async () => {
      mockKV._store.set('setup:github_provider_type', 'app');
      mockKV._store.set('setup:github_app_client_id', 'Iv1.appcid');
      mockKV._store.set('setup:github_app_client_secret', 'app-secret-blob');
      mockKV._store.set('setup:github_oauth_client_id', 'oauth-cid');
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubProviderType).toBe('app');
      expect(body.githubAppClientId).toBe('Iv1.appcid');
      expect(body.githubAppClientSecretSet).toBe(true);
      expect(body.githubOauthClientId).toBe('oauth-cid');
      expect(body.githubOauthClientSecretSet).toBe(false);
      // The secret value itself is never surfaced to the browser.
      expect(JSON.stringify(body)).not.toContain('app-secret-blob');
    });

    it('GET /prefill reports unset defaults when nothing is stored', async () => {
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubProviderType).toBeNull();
      expect(body.githubAppClientId).toBe('');
      expect(body.githubAppClientSecretSet).toBe(false);
    });

    it('GET /prefill surfaces the GitHub + Cloudflare provider fields in non-enterprise (admin, any mode)', async () => {
      // The Setup wizard is admin-gated in every mode, so the provider config must
      // round-trip in non-enterprise too — while enterprise-only fields stay absent.
      mockKV._store.set('setup:github_provider_type', 'oauth');
      mockKV._store.set('setup:github_oauth_client_id', 'oauth-cid');
      mockKV._store.set('setup:cloudflare_oauth_client_id', 'cf-cid');
      mockKV._store.set('setup:cloudflare_oauth_client_secret', 'cf-secret-blob');
      const app = createApp(); // ENTERPRISE_MODE unset
      const res = await app.request('/setup/prefill');
      const body = await res.json() as Record<string, unknown>;
      expect(body.githubProviderType).toBe('oauth');
      expect(body.githubOauthClientId).toBe('oauth-cid');
      expect(body.cloudflareOauthClientId).toBe('cf-cid');
      expect(body.cloudflareOauthClientSecretSet).toBe(true);
      // The secret value itself is never surfaced to the browser.
      expect(JSON.stringify(body)).not.toContain('cf-secret-blob');
      // Enterprise-only fields stay absent in non-enterprise.
      expect(body).not.toHaveProperty('enterpriseAccessGroup');
      expect(body).not.toHaveProperty('browserRenderTokenSet');
    });
  });

  describe('REQ-ENTERPRISE-013: per-group routing prefill', () => {
    it('GET /prefill round-trips the stored group routing map', async () => {
      const groupRouting = { developers: { routes: ['code_review'], defaultRoute: 'code_review', reasoning: 'high' } };
      mockKV._store.set('setup:group_routing', JSON.stringify(groupRouting));
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as Record<string, unknown>;
      expect(body.groupRouting).toEqual(groupRouting);
    });

    it('GET /prefill returns an empty map when none is stored', async () => {
      const app = createApp({ ENTERPRISE_MODE: 'active' } as Partial<Env>);
      const res = await app.request('/setup/prefill');
      const body = await res.json() as Record<string, unknown>;
      expect(body.groupRouting).toEqual({});
    });

    it('GET /prefill omits groupRouting when ENTERPRISE_MODE is unset', async () => {
      mockKV._store.set('setup:group_routing', JSON.stringify({ x: { routes: [], defaultRoute: '', reasoning: 'off' } }));
      const app = createApp();
      const res = await app.request('/setup/prefill');
      const body = await res.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('groupRouting');
    });
  });

});
