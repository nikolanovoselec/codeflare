import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

vi.mock('../../lib/session-jwt', () => ({
  signSessionJWT: vi.fn(async () => 'mock-jwt-token'),
  SESSION_JWT_AUD: 'codeflare-session',
  cookieDomainAttr: vi.fn(() => ''),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  })),
}));

// Import mocked functions after vi.mock so overrides work per-test
import { signSessionJWT } from '../../lib/session-jwt';
import githubAuthRoutes from '../../routes/github-auth';
import { signOauthState } from '../../lib/oauth-state';

const TEST_SECRET = 'test-jwt-secret';

let mockKV: ReturnType<typeof createMockKV>;
let originalFetch: typeof globalThis.fetch;

function createApp(envOverrides: Partial<Env> = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      OAUTH_CLIENT_ID: 'test-client-id',
      OAUTH_CLIENT_SECRET: 'test-client-secret',
      OAUTH_JWT_SECRET: 'test-jwt-secret',
      SAAS_MODE: 'active',
      ...envOverrides,
    } as Env;
    return next();
  });
  app.route('/', githubAuthRoutes);
  return app;
}

describe('GitHub OAuth Routes / REQ-AUTH-002 (SaaS mode GitHub OAuth handshake)', () => {
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

    it('does not set oauth_state cookie (stateless HMAC-signed state in URL)', async () => {
      const app = createApp();
      const res = await app.request('/login');

      const setCookie = res.headers.get('Set-Cookie') ?? '';
      expect(setCookie).not.toContain('oauth_state=');
    });

    it('embeds an HMAC-signed state token (nonce.iat.sig) in the GitHub redirect URL', async () => {
      const app = createApp();
      const res = await app.request('/login');

      const location = res.headers.get('Location') ?? '';
      const stateMatch = location.match(/state=([^&]+)/);
      expect(stateMatch).not.toBeNull();
      const state = decodeURIComponent(stateMatch![1]);
      // nonce.iat.sig — three dot-separated segments
      expect(state.split('.')).toHaveLength(3);
    });

    it('returns 404 (looks unmounted) when OAUTH_CLIENT_ID missing', async () => {
      const app = createApp({ OAUTH_CLIENT_ID: undefined } as unknown as Partial<Env>);
      const res = await app.request('/login');
      expect(res.status).toBe(404);
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

    it('returns 404 (looks unmounted) when OAUTH_JWT_SECRET missing', async () => {
      const app = createApp({ OAUTH_JWT_SECRET: undefined } as unknown as Partial<Env>);
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(404);
    });

    it('redirects to /?error=access_denied when GitHub returns error', async () => {
      const app = createApp();
      const res = await app.request('/callback?error=access_denied');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('error=access_denied');
    });

    it('redirects to /?error=session-expired when state param missing', async () => {
      const app = createApp();
      const res = await app.request('/callback?code=test-code');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('error=session-expired');
    });

    it('redirects to /?error=session-expired when state signature is forged', async () => {
      const app = createApp();
      // Valid format, garbage signature — must fail HMAC verify
      const res = await app.request('/callback?code=test-code&state=nonce.1700000000.invalidsig');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('error=session-expired');
    });

    it('redirects to /?error=session-expired when state was signed with a different secret', async () => {
      const app = createApp();
      const wrongSecretState = await signOauthState('different-secret');
      const res = await app.request(`/callback?code=test-code&state=${encodeURIComponent(wrongSecretState)}`);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('error=session-expired');
    });

    it('sets codeflare_session cookie on success', async () => {
      mockGitHubSuccess();
      const app = createApp();
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);

      expect(res.status).toBe(302);
      const setCookie = res.headers.get('Set-Cookie') ?? '';
      expect(setCookie).toContain('codeflare_session=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
    });

    it('rejects replay of a previously-redeemed state token (single-use enforcement)', async () => {
      mockGitHubSuccess();
      const app = createApp();
      const state = await signOauthState(TEST_SECRET);

      // First redemption succeeds
      const first = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);
      expect(first.status).toBe(302);
      expect(first.headers.get('Location')).toContain('/app/');

      // Second redemption with the SAME state must be rejected as a replay,
      // even though the HMAC signature still verifies and the iat is fresh
      const second = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);
      expect(second.status).toBe(302);
      expect(second.headers.get('Location')).toContain('error=session-expired');
    });

    it('returns 404 (looks unmounted) when OAUTH_CLIENT_ID missing', async () => {
      const app = createApp({ OAUTH_CLIENT_ID: undefined } as unknown as Partial<Env>);
      const res = await app.request(`/callback?code=x&state=y`);
      expect(res.status).toBe(404);
    });

    it('returns 400 when code is missing but state is valid', async () => {
      const app = createApp();
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?state=${encodeURIComponent(state)}`);

      expect(res.status).toBe(400);
    });

    it('returns 502 when GitHub returns 200 with error body (no access_token)', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 }),
      ) as typeof globalThis.fetch;

      const app = createApp();
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=bad-code&state=${encodeURIComponent(state)}`);

      expect(res.status).toBe(502);
    });

    it('redirects to /app/subscribe for new user', async () => {
      mockGitHubSuccess();
      const app = createApp();
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/app/subscribe');
    });

    it('redirects to /app/ for active user', async () => {
      mockGitHubSuccess();
      mockKV._set('user:alice@example.com', {
        subscriptionTier: 'standard', subscribedAt: '2026-01-01',
      });

      const app = createApp();
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/app/');
      expect(res.headers.get('Location')).not.toContain('/subscribe');
    });

    it('redirects to /app/ for free tier user (no subscribedAt)', async () => {
      mockGitHubSuccess();
      mockKV._set('user:alice@example.com', {
        subscriptionTier: 'free',
      });

      const app = createApp();
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/app/');
      expect(res.headers.get('Location')).not.toContain('/subscribe');
    });

    it('redirects to /app/subscribe for pending user', async () => {
      mockGitHubSuccess();
      mockKV._set('user:alice@example.com', {
        subscriptionTier: 'pending',
      });

      const app = createApp();
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/app/subscribe');
    });

    it('returns 502 when GitHub token exchange fails', async () => {
      globalThis.fetch = vi.fn(async () =>
        new Response('Server Error', { status: 500 }),
      ) as typeof globalThis.fetch;

      const app = createApp();
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=bad-code&state=${encodeURIComponent(state)}`);

      expect(res.status).toBe(502);
    });

    it('returns 502 when GitHub profile API fails after successful token exchange', async () => {
      globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
        const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (u.includes('access_token')) {
          return new Response(JSON.stringify({ access_token: 'gho_test' }));
        }
        // Profile API returns 500
        return new Response('GitHub API Error', { status: 500 });
      }) as typeof globalThis.fetch;

      const app = createApp();
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);

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
      const state = await signOauthState(TEST_SECRET);
      const res = await app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);

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
