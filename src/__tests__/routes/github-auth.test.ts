import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// Configurable mock auth result
const mockSignSessionJWT = vi.fn(async () => 'mock-jwt-token');

vi.mock('../../lib/session-jwt', () => ({
  signSessionJWT: mockSignSessionJWT,
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  })),
}));

// Import mocked functions after vi.mock so overrides work per-test
import { signSessionJWT } from '../../lib/session-jwt';
import githubAuthRoutes from '../../routes/github-auth';

let mockKV: ReturnType<typeof createMockKV>;
let originalFetch: typeof globalThis.fetch;

function createApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      GITHUB_CLIENT_ID: 'test-client-id',
      GITHUB_CLIENT_SECRET: 'test-client-secret',
      JWT_SECRET: 'test-jwt-secret',
      SAAS_MODE: 'active',
      ...envOverrides,
    } as Env;
    return next();
  });
  app.route('/', githubAuthRoutes);
  return app;
}

describe('GitHub OAuth Routes', () => {
  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
    // Restore default mock behaviour
    vi.mocked(signSessionJWT).mockResolvedValue('mock-jwt-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ─── Login ─────────────────────────────────────────────────────

  describe('GET /login', () => {
    it('redirects to github.com with correct params', async () => {
      mockKV._set('setup:custom_domain', 'codeflare.example.com');
      const app = createApp();
      const res = await app.request('/login');

      expect(res.status).toBe(302);
      const location = res.headers.get('Location')!;
      expect(location).toContain('github.com/login/oauth/authorize');
      expect(location).toContain('client_id=test-client-id');
      expect(location).toContain('scope=user%3Aemail');
      expect(location).toContain('state=');
      expect(location).toContain('redirect_uri=');
    });

    it('sets oauth_state cookie', async () => {
      const app = createApp();
      const res = await app.request('/login');

      const setCookie = res.headers.get('Set-Cookie') ?? '';
      expect(setCookie).toContain('oauth_state=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
    });

    it('returns 500 when GITHUB_CLIENT_ID missing', async () => {
      const app = createApp({ GITHUB_CLIENT_ID: undefined } as unknown as Partial<Env>);
      const res = await app.request('/login');
      expect(res.status).toBe(500);
    });
  });

  // ─── Callback ──────────────────────────────────────────────────

  describe('GET /callback', () => {
    function mockGitHubSuccess() {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (u.includes('github.com/login/oauth/access_token')) {
          return new Response(JSON.stringify({ access_token: 'gho_test_token' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (u.includes('api.github.com/user/emails')) {
          return new Response(JSON.stringify([
            { email: 'alice@example.com', primary: true, verified: true },
          ]));
        }
        if (u.includes('api.github.com/user')) {
          return new Response(JSON.stringify({ id: 12345, login: 'alice' }));
        }
        return new Response('unexpected', { status: 500 });
      }) as typeof globalThis.fetch;
    }

    it('redirects to /?error=access_denied when GitHub returns error', async () => {
      const app = createApp();
      const res = await app.request('/callback?error=access_denied');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('error=access_denied');
    });

    it('returns 403 when state cookie missing', async () => {
      const app = createApp();
      const res = await app.request('/callback?code=test-code&state=abc');

      expect(res.status).toBe(403);
    });

    it('returns 403 when state mismatch', async () => {
      const app = createApp();
      const res = await app.request('/callback?code=test-code&state=wrong', {
        headers: { Cookie: 'oauth_state=correct' },
      });

      expect(res.status).toBe(403);
    });

    it('sets codeflare_session cookie on success', async () => {
      mockGitHubSuccess();
      const app = createApp();
      const res = await app.request('/callback?code=test-code&state=test-state', {
        headers: { Cookie: 'oauth_state=test-state' },
      });

      expect(res.status).toBe(302);
      const setCookie = res.headers.get('Set-Cookie') ?? '';
      expect(setCookie).toContain('codeflare_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
    });

    it('redirects to /app/subscribe for new user', async () => {
      mockGitHubSuccess();
      const app = createApp();
      const res = await app.request('/callback?code=test-code&state=test-state', {
        headers: { Cookie: 'oauth_state=test-state' },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/app/subscribe');
    });

    it('redirects to /app/ for active user', async () => {
      mockGitHubSuccess();
      mockKV._set('user:alice@example.com', {
        subscriptionTier: 'standard', subscribedAt: '2026-01-01',
      });

      const app = createApp();
      const res = await app.request('/callback?code=test-code&state=test-state', {
        headers: { Cookie: 'oauth_state=test-state' },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/app/');
      expect(res.headers.get('Location')).not.toContain('/subscribe');
    });

    it('returns 502 when GitHub token exchange fails', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response('Server Error', { status: 500 }),
      ) as typeof globalThis.fetch;

      const app = createApp();
      const res = await app.request('/callback?code=bad-code&state=test-state', {
        headers: { Cookie: 'oauth_state=test-state' },
      });

      expect(res.status).toBe(502);
    });

    it('redirects to /?error=no-verified-email when no verified email', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (u.includes('access_token')) {
          return new Response(JSON.stringify({ access_token: 'gho_test' }));
        }
        if (u.includes('/user/emails')) {
          return new Response(JSON.stringify([
            { email: 'unverified@example.com', primary: true, verified: false },
          ]));
        }
        if (u.includes('/user')) {
          return new Response(JSON.stringify({ id: 99, login: 'nomail' }));
        }
        return new Response('unexpected', { status: 500 });
      }) as typeof globalThis.fetch;

      const app = createApp();
      const res = await app.request('/callback?code=test-code&state=test-state', {
        headers: { Cookie: 'oauth_state=test-state' },
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('error=no-verified-email');
    });
  });

  // ─── Logout ────────────────────────────────────────────────────

  describe('GET /logout', () => {
    it('clears codeflare_session cookie', async () => {
      const app = createApp();
      const res = await app.request('/logout');

      expect(res.status).toBe(302);
      const setCookie = res.headers.get('Set-Cookie') ?? '';
      expect(setCookie).toContain('codeflare_session=');
      expect(setCookie).toContain('Max-Age=0');
    });

    it('redirects to /', async () => {
      const app = createApp();
      const res = await app.request('/logout');

      expect(res.status).toBe(302);
      const location = res.headers.get('Location') ?? '';
      expect(location).toMatch(/\/$/);
    });
  });
});
