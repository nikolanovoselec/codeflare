import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

// ---------------------------------------------------------------------------
// Mocks shared across both halves of this file.
//
// session-jwt + logger are mocked so the real githubAuthRoutes callback can run
// without crypto/log side effects (mirrors github-auth.test.ts). The route
// modules pulled in by the worker module are mocked to Hono no-ops so importing
// `worker from '../../index'` has no import side effects (mirrors index.test.ts).
// ---------------------------------------------------------------------------
vi.mock('../../lib/session-jwt', () => ({
  signSessionJWT: vi.fn(async () => 'mock-jwt-token'),
  SESSION_JWT_AUD: 'codeflare-session',
  cookieDomainAttr: vi.fn(() => ''),
  verifySessionJWT: vi.fn(),
  shouldRefreshJWT: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(),
  })),
  setLogLevel: vi.fn(),
}));

// Worker module route-import side-effect guards (only needed for the /login
// rewrite half, which drives the real index.ts fetch handler).
vi.mock('../../routes/terminal', () => ({
  default: new Hono(),
  validateWebSocketRoute: vi.fn(() => ({ isWebSocketRoute: false })),
  handleWebSocketUpgrade: vi.fn(),
}));

import worker from '../../index';
import { resetSetupCache } from '../../lib/cache-reset';
import githubAuthRoutes from '../../routes/github-auth';
import { signOauthState } from '../../lib/oauth-state';
import { sendAccessRequestConfirmation } from '../../lib/email';
import { signSessionJWT } from '../../lib/session-jwt';

const TEST_SECRET = 'test-jwt-secret';

function createMockCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

describe('REQ-AUTH-020 / REQ-AUTH-021: onboarding login + access-request', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
    resetSetupCache();
    vi.mocked(signSessionJWT).mockResolvedValue('mock-jwt-token');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // =========================================================================
  // CHANGE 1 — /login rewrite in the worker fetch handler
  // =========================================================================
  describe('GET /login asset rewrite', () => {
    function createWorkerEnv(overrides: Partial<Env> = {}): {
      env: Env;
      mockAssets: { fetch: ReturnType<typeof vi.fn> };
    } {
      const mockAssets = {
        fetch: vi.fn(async () => new Response('login page', { status: 200 })),
      };
      // Setup is complete so the handler doesn't short-circuit to /setup.
      // _store.set stores the raw string (the worker reads it untyped and
      // compares `status === 'true'`, so JSON-encoding via _set would break it).
      mockKV._store.set('setup:complete', 'true');
      const env = {
        KV: mockKV as unknown as KVNamespace,
        ASSETS: mockAssets as unknown as Fetcher,
        ...overrides,
      } as Env;
      return { env, mockAssets };
    }

    it('onboarding active + SaaS unset → rewrites /login to /landing/login/', async () => {
      const { env, mockAssets } = createWorkerEnv({ ONBOARDING_LANDING_PAGE: 'active' });

      const res = await worker.fetch(new Request('https://example.com/login'), env, createMockCtx());

      expect(res.status).toBe(200);
      expect(mockAssets.fetch).toHaveBeenCalledTimes(1);
      const fetched = mockAssets.fetch.mock.calls[0][0] as Request;
      expect(new URL(fetched.url).pathname).toBe('/landing/login/');
    });

    it.each([
      { path: '/login/', available: true },
      { path: '/login', available: false },
      { path: '/login/', available: false },
    ])('REQ-AUTH-020 AC1: $path returns landing when available=$available and otherwise the Assets SPA fallback', async ({ path, available }) => {
      const { env, mockAssets } = createWorkerEnv({ ONBOARDING_LANDING_PAGE: 'active' });
      const assetRequests: string[] = [];
      const landingHtml = '<html><body>dedicated onboarding login fixture</body></html>';
      const spaHtml = '<html><body>SPA index fallback fixture</body></html>';
      // Model the existing Assets single-page-application policy at its I/O boundary.
      const files = new Map([['/index.html', spaHtml]]);
      if (available) files.set('/landing/login/', landingHtml);
      mockAssets.fetch.mockImplementation(async (...args: unknown[]) => {
        const request = args[0] as Request;
        const assetPath = new URL(request.url).pathname;
        assetRequests.push(assetPath);
        return new Response(files.get(assetPath) ?? files.get('/index.html'), {
          status: 200, headers: { 'Content-Type': 'text/html' },
        });
      });

      const response = await worker.fetch(new Request(`https://example.com${path}`), env, createMockCtx());
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html');
      expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
      expect(await response.text()).toBe(available ? landingHtml : spaHtml);
      expect(assetRequests).toEqual(['/landing/login/']);
    });

    it('SaaS active → /login is NOT rewritten to /landing/login/ (falls through to SPA)', async () => {
      const { env, mockAssets } = createWorkerEnv({
        ONBOARDING_LANDING_PAGE: 'active',
        SAAS_MODE: 'active',
      });

      const res = await worker.fetch(new Request('https://example.com/login'), env, createMockCtx());

      expect(res.status).toBe(200);
      expect(mockAssets.fetch).toHaveBeenCalledTimes(1);
      const fetched = mockAssets.fetch.mock.calls[0][0] as Request;
      // SaaS: served as-is (the SPA route), never the prerendered landing login.
      expect(new URL(fetched.url).pathname).toBe('/login');
    });
  });

  // =========================================================================
  // CHANGE 2 — mode-aware GitHub OAuth callback
  // =========================================================================
  describe('GET /callback redirect behaviour', () => {
    /**
     * Mocks GitHub OAuth (token + profile + emails) AND the Resend email API.
     * Records every Resend recipient address so tests can assert who got mailed.
     */
    function mockExternalCalls(opts: { email?: string; failRecipient?: string } = {}) {
      const email = opts.email ?? 'alice@example.com';
      const resendRecipients: string[] = [];
      const resendDeliveries: Array<{ to: string[]; status: number; requestedAt: unknown }> = [];
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (u.includes('github.com/login/oauth/access_token')) {
          return new Response(JSON.stringify({ access_token: 'gho_test_token' }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (u.includes('api.github.com/user/emails')) {
          return new Response(JSON.stringify([{ email, primary: true, verified: true }]));
        }
        if (u.includes('api.github.com/user')) {
          return new Response(JSON.stringify({ id: 12345, login: 'alice' }));
        }
        if (u.includes('api.resend.com/emails')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { to: string[] };
          for (const addr of body.to) resendRecipients.push(addr);
          const status = opts.failRecipient && body.to.includes(opts.failRecipient) ? 503 : 200;
          const record = await mockKV.get(`user:${email}`, 'json') as Record<string, unknown> | null;
          resendDeliveries.push({ to: body.to, status, requestedAt: record?.requestedAt });
          return new Response(JSON.stringify(status === 200 ? { id: 'email-id' } : { error: 'unavailable' }), { status });
        }
        return new Response('unexpected', { status: 500 });
      }) as typeof globalThis.fetch;
      return { resendRecipients, resendDeliveries };
    }

    function createApp(envOverrides: Partial<Env> = {}) {
      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          OAUTH_CLIENT_ID: 'test-client-id',
          OAUTH_CLIENT_SECRET: 'test-client-secret',
          OAUTH_JWT_SECRET: TEST_SECRET,
          RESEND_API_KEY: 'resend-key',
          ...envOverrides,
        } as Env;
        return next();
      });
      app.route('/', githubAuthRoutes);
      return app;
    }

    async function callback(app: ReturnType<typeof createApp>) {
      const state = await signOauthState(TEST_SECRET);
      return app.request(`/callback?code=test-code&state=${encodeURIComponent(state)}`);
    }

    it('onboarding + new non-active user → /login?status=requested, stamps requestedAt, mails admin + user', async () => {
      const { resendRecipients } = mockExternalCalls();
      // An admin exists so getAdminEmails resolves a recipient.
      mockKV._set('user:admin@example.com', { role: 'admin', addedBy: 'setup', addedAt: '2025-01-01' });

      const app = createApp({ ONBOARDING_LANDING_PAGE: 'active' });
      const res = await callback(app);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/login?status=requested');

      // Session cookie still issued exactly as before.
      expect(res.headers.get('Set-Cookie') ?? '').toContain('codeflare_session=');

      // requestedAt stamped on a now-provisioned pending user record.
      const record = await mockKV.get('user:alice@example.com', 'json') as Record<string, unknown>;
      expect(typeof record.requestedAt).toBe('string');
      expect(record.accessTier).toBe('pending');

      // Both the admin and the requesting user were emailed.
      expect(resendRecipients).toContain('admin@example.com');
      expect(resendRecipients).toContain('alice@example.com');
    });

    it('onboarding + already-requested user → does NOT re-send and does NOT change requestedAt', async () => {
      const { resendRecipients } = mockExternalCalls();
      mockKV._set('user:admin@example.com', { role: 'admin', addedBy: 'setup', addedAt: '2025-01-01' });
      // Pre-existing record that already carries requestedAt.
      mockKV._set('user:alice@example.com', {
        role: 'user', addedBy: 'github-oauth', addedAt: '2025-01-01',
        accessTier: 'pending', subscriptionTier: 'pending',
        requestedAt: '2025-01-02T00:00:00.000Z',
      });

      const app = createApp({ ONBOARDING_LANDING_PAGE: 'active' });
      const res = await callback(app);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/login?status=requested');

      // No emails sent on the repeat request.
      expect(resendRecipients).toHaveLength(0);
      // requestedAt preserved (not re-stamped).
      const record = await mockKV.get('user:alice@example.com', 'json') as Record<string, unknown>;
      expect(record.requestedAt).toBe('2025-01-02T00:00:00.000Z');
    });

    it.each([
      { failed: 'administrator notification', failRecipient: 'admin@example.com' },
      { failed: 'user confirmation', failRecipient: 'alice@example.com' },
    ])('REQ-AUTH-021 AC6: failed $failed preserves the request, independent email and redirect without retry delivery', async ({ failRecipient }) => {
      const { resendDeliveries } = mockExternalCalls({ failRecipient });
      mockKV._set('user:admin@example.com', { role: 'admin', addedBy: 'setup', addedAt: '2025-01-01' });
      const app = createApp({ ONBOARDING_LANDING_PAGE: 'active' });
      const startedAt = Date.now();
      const res = await callback(app);

      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('Location')!);
      expect(location.pathname + location.search).toBe('/login?status=requested');
      expect(res.headers.get('Set-Cookie')).toBe('codeflare_session=mock-jwt-token; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600');
      const record = await mockKV.get('user:alice@example.com', 'json') as Record<string, unknown>;
      expect(record).toMatchObject({
        role: 'user', accessTier: 'pending', subscriptionTier: 'pending', requestedAt: expect.any(String),
      });
      const requestedAt = record.requestedAt as string;
      expect(Date.parse(requestedAt)).toBeGreaterThanOrEqual(startedAt);
      expect(Date.parse(requestedAt)).toBeLessThanOrEqual(Date.now());
      // The real email helpers reach both provider requests after the durable stamp,
      // even when either individual request receives an unsuccessful response.
      const expectedDeliveries = ['admin@example.com', 'alice@example.com'].map(recipient => ({
        to: [recipient], status: recipient === failRecipient ? 503 : 200, requestedAt,
      }));
      expect(resendDeliveries).toEqual(expectedDeliveries);

      const retry = await callback(app); // New, genuinely signed state; not a nonce replay.
      expect(retry.status).toBe(302);
      expect(retry.headers.get('Location')).toBe(res.headers.get('Location'));
      expect(retry.headers.get('Set-Cookie')).toBe(res.headers.get('Set-Cookie'));
      expect(await mockKV.get('user:alice@example.com', 'json')).toEqual(record);
      expect(resendDeliveries).toEqual(expectedDeliveries);
    });

    it.each([
      { tier: 'legacy missing tier', subscriptionTier: undefined, destination: '/app/' },
      { tier: 'blocked', subscriptionTier: 'blocked', destination: '/login?status=requested' },
      { tier: 'pending', subscriptionTier: 'pending', destination: '/login?status=requested' },
      { tier: 'free', subscriptionTier: 'free', destination: '/app/' },
      { tier: 'trial', subscriptionTier: 'trial', destination: '/app/' },
      { tier: 'standard', subscriptionTier: 'standard', destination: '/app/' },
      { tier: 'advanced', subscriptionTier: 'advanced', destination: '/app/' },
      { tier: 'max', subscriptionTier: 'max', destination: '/app/' },
      { tier: 'unlimited', subscriptionTier: 'unlimited', destination: '/app/' },
    ])('REQ-AUTH-021 AC2: onboarding preserves $tier and redirects to $destination', async ({ subscriptionTier, destination }) => {
      const { resendRecipients } = mockExternalCalls();
      mockKV._set('user:admin@example.com', { role: 'admin', addedBy: 'setup', addedAt: '2025-01-01' });
      const stored = {
        role: 'user', addedBy: 'legacy-import', addedAt: '2025-01-01',
        accessTier: 'advanced', subscribedMode: 'advanced', onboardingComplete: true,
        ...(subscriptionTier === undefined ? {} : { subscriptionTier }),
      };
      mockKV._set('user:alice@example.com', stored);
      const app = createApp({ ONBOARDING_LANDING_PAGE: 'active' });
      const startedAt = Date.now();
      const response = await callback(app);

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('Location')!);
      expect(location.pathname + location.search).toBe(destination);
      expect(response.headers.get('Set-Cookie')).toBe('codeflare_session=mock-jwt-token; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600');
      const record = await mockKV.get('user:alice@example.com', 'json') as Record<string, unknown>;
      if (destination === '/login?status=requested') {
        expect(record).toEqual({ ...stored, requestedAt: expect.any(String) });
        expect(Date.parse(record.requestedAt as string)).toBeGreaterThanOrEqual(startedAt);
        expect(Date.parse(record.requestedAt as string)).toBeLessThanOrEqual(Date.now());
        expect(resendRecipients).toEqual(['admin@example.com', 'alice@example.com']);
      } else {
        expect(record).toEqual(stored);
        expect(resendRecipients).toEqual([]);
      }
    });

    it('SaaS + non-active user → /app/subscribe UNCHANGED, no onboarding emails', async () => {
      const { resendRecipients } = mockExternalCalls();
      mockKV._set('user:admin@example.com', { role: 'admin', addedBy: 'setup', addedAt: '2025-01-01' });

      // SaaS active (onboarding flag set too, to prove SaaS wins the gate).
      const app = createApp({ SAAS_MODE: 'active', ONBOARDING_LANDING_PAGE: 'active' });
      const res = await callback(app);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/app/subscribe');
      expect(res.headers.get('Location')).not.toContain('status=requested');

      // No access-request stamping, no onboarding emails.
      expect(resendRecipients).toHaveLength(0);
      const record = await mockKV.get('user:alice@example.com', 'json');
      expect(record).toBeNull();
    });

    it('active user → /app/ (onboarding mode does not divert active users)', async () => {
      const { resendRecipients } = mockExternalCalls();
      mockKV._set('user:alice@example.com', { subscriptionTier: 'standard', subscribedAt: '2026-01-01' });

      const app = createApp({ ONBOARDING_LANDING_PAGE: 'active' });
      const res = await callback(app);

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toContain('/app/');
      expect(res.headers.get('Location')).not.toContain('/subscribe');
      expect(res.headers.get('Location')).not.toContain('status=requested');
      expect(resendRecipients).toHaveLength(0);
    });
  });

  // =========================================================================
  // CHANGE 3 — user confirmation email helper
  // =========================================================================
  describe('sendAccessRequestConfirmation', () => {
    it('calls the Resend API with the user address in `to`', async () => {
      let sentTo: string[] | null = null;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (u.includes('api.resend.com/emails')) {
          sentTo = (JSON.parse(String(init?.body ?? '{}')) as { to: string[] }).to;
          return new Response(JSON.stringify({ id: 'x' }), { status: 200 });
        }
        return new Response('unexpected', { status: 500 });
      }) as typeof globalThis.fetch;

      const ok = await sendAccessRequestConfirmation({
        userEmail: 'requester@example.com',
        env: { RESEND_API_KEY: 'resend-key' },
      });

      expect(ok).toBe(true);
      expect(sentTo).toContain('requester@example.com');
    });
  });
});
