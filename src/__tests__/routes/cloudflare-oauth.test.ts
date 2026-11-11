import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, DeployKeys } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { AppError } from '../../lib/error-types';

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

// authMiddleware (api routes) + the callback both re-derive identity via this.
vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => ({
    user: { email: 'u@example.com', authenticated: true, role: 'user' },
    bucketName: 'test-bucket',
  })),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import cloudflareRoutes from '../../routes/cloudflare';
import cloudflareAuthRoutes from '../../routes/cloudflare-auth';
import { authenticateRequest } from '../../lib/access';
import { signOauthState } from '../../lib/oauth-state';
import { SETUP_KEYS } from '../../lib/kv-keys';

const KEY = 'deploy-keys:test-bucket';
const STATE_SECRET = 'state-secret';
/** Plain non-enterprise, non-advanced env (the decoupled-gate case). */
const DEFAULT_ENV: Partial<Env> = { OAUTH_JWT_SECRET: STATE_SECRET };

let mockKV: ReturnType<typeof createMockKV>;

function createTestApp(env: Partial<Env>) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    return c.json({ error: 'Unexpected error' }, 500);
  });
  app.use('*', async (c, next) => {
    (c.env as unknown) = { KV: mockKV, ...env };
    return next();
  });
  app.route('/api/cloudflare', cloudflareRoutes);
  app.route('/auth/cloudflare', cloudflareAuthRoutes);
  return app;
}
function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}
function configureClient() {
  mockKV.put(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID, 'cf-cid');
  mockKV.put(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET, JSON.stringify({ secret: 'cf-sec' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockKV = createMockKV();
  vi.mocked(authenticateRequest).mockResolvedValue({
    user: { email: 'u@example.com', authenticated: true, role: 'user' },
    bucketName: 'test-bucket',
  });
});

describe.each([
  ['default', {}], ['enterprise', { ENTERPRISE_MODE: 'active' }],
] as const)('REQ-AGENT-064: %s owner OAuth lifecycle', (_mode, overrides) => {
  const BASE_ENV: Partial<Env> = { ...DEFAULT_ENV, ...overrides };

// ─── GET /connect (NOT tier-gated — the decoupling invariant) ────────────────

// REQ-AGENT-064: Connect to Cloudflare via OAuth
describe('GET /api/cloudflare/connect', () => {
  it('redirects to the Cloudflare consent endpoint with a state param for a plain authed user', async () => {
    configureClient();
    const res = await createTestApp(BASE_ENV).request('/api/cloudflare/connect');
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('client_id')).toBe('cf-cid');
    expect(loc.searchParams.get('scope')).toContain('offline_access');
  });

  it('503s when no OAuth client is configured', async () => {
    const res = await createTestApp(BASE_ENV).request('/api/cloudflare/connect');
    expect(res.status).toBe(503);
    expect((await res.json() as Record<string, unknown>).code).toBe('CLOUDFLARE_NOT_CONFIGURED');
  });

  it('feeds every scope tier into OAuth with Analytics read and offline access', async () => {
    configureClient();
    const locations = await Promise.all(
      ['minimal', 'recommended', 'advanced'].map(async (tier) => new URL(
        (await createTestApp(BASE_ENV).request(`/api/cloudflare/connect?tier=${tier}`)).headers.get('location')!,
      )),
    );

    for (const location of locations) {
      const scopes = location.searchParams.get('scope')!.split(' ');
      expect(scopes).toContain('analytics.read');
      expect(scopes).toContain('offline_access');
    }
    expect(locations[2].searchParams.get('scope')).toContain('ai.write');
    expect(locations[0].searchParams.get('scope')).not.toContain('ai.write');
  });
});

// ─── GET /status ─────────────────────────────────────────────────────────────

describe('GET /api/cloudflare/status', () => {
  it('reports configured=false + not connected when unconfigured', async () => {
    const body = await (await createTestApp(BASE_ENV).request('/api/cloudflare/status')).json() as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.connected).toBe(false);
  });

  it('reports configured but not connected until this owner grants access', async () => {
    configureClient();
    mockKV._set('deploy-keys:foreign-bucket', { cloudflareApiToken: 'foreign-token', cloudflareAccountId: 'foreign-account' });
    const response = await createTestApp(BASE_ENV).request('/api/cloudflare/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true, connected: false });
  });

  it('reports connected + accountId + source when a token with an account exists', async () => {
    configureClient();
    mockKV._set(KEY, { cloudflareApiToken: 'cf', cloudflareTokenSource: 'oauth', cloudflareAccountId: 'a1' } satisfies DeployKeys);
    const body = await (await createTestApp(BASE_ENV).request('/api/cloudflare/status')).json() as Record<string, unknown>;
    expect(body.configured).toBe(true);
    expect(body.connected).toBe(true);
    expect(body.accountId).toBe('a1');
    expect(body.source).toBe('oauth');
  });

  it('surfaces the accessible accounts when connected without a selected account', async () => {
    configureClient();
    mockKV._set(KEY, { cloudflareApiToken: 'cf', cloudflareTokenSource: 'oauth' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(ok({ success: true, result: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }));
    const body = await (await createTestApp(BASE_ENV).request('/api/cloudflare/status')).json() as Record<string, unknown>;
    expect(body.connected).toBe(true);
    expect(body.accountId ?? null).toBeNull();
    expect(body.accounts).toHaveLength(2);
  });
});

// ─── POST /account ───────────────────────────────────────────────────────────

describe('POST /api/cloudflare/account', () => {
  it('persists a valid account selection', async () => {
    mockKV._set(KEY, { cloudflareApiToken: 'cf', cloudflareTokenSource: 'oauth' } satisfies DeployKeys);
    mockFetch.mockResolvedValue(ok({ success: true, result: [{ id: 'a', name: 'A' }] }));
    const res = await createTestApp(BASE_ENV).request('/api/cloudflare/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'a' }),
    });
    expect(res.status).toBe(200);
    expect(((await mockKV.get(KEY, 'json')) as DeployKeys).cloudflareAccountId).toBe('a');
  });

  it('400s for an account the token cannot access', async () => {
    mockKV._set(KEY, { cloudflareApiToken: 'cf', cloudflareTokenSource: 'oauth' } satisfies DeployKeys);
    mockFetch.mockResolvedValue(ok({ success: true, result: [{ id: 'a', name: 'A' }] }));
    const res = await createTestApp(BASE_ENV).request('/api/cloudflare/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'nope' }),
    });
    expect(res.status).toBe(400);
  });
});

// ─── POST /disconnect ────────────────────────────────────────────────────────

describe('POST /api/cloudflare/disconnect', () => {
  it('clears the stored cloudflare fields', async () => {
    configureClient();
    mockKV._set(KEY, { cloudflareApiToken: 'cf', cloudflareTokenSource: 'oauth' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(ok({}));
    const res = await createTestApp(BASE_ENV).request('/api/cloudflare/disconnect', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await mockKV.get(KEY)).toBeNull();
  });
});

// ─── GET /auth/cloudflare/connect/callback ───────────────────────────────────

describe('GET /auth/cloudflare/connect/callback', () => {
  async function validState() {
    return signOauthState(STATE_SECRET, 'test-bucket');
  }

  it('exchanges the code, stores an oauth token + auto-selected account, redirects connected', async () => {
    configureClient();
    const state = await validState();
    mockKV._set('deploy-keys:foreign-bucket', { cloudflareApiToken: 'foreign-existing' });
    const foreign = await mockKV.get('deploy-keys:foreign-bucket');
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'cf_t', refresh_token: 'cf_r', expires_in: 3_600 }))
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: 'only', name: 'Only' }] }));

    const res = await createTestApp(BASE_ENV).request(
      `/auth/cloudflare/connect/callback?code=abc&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('cloudflare=connected');
    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.cloudflareApiToken).toBe('cf_t');
    expect(raw.cloudflareTokenSource).toBe('oauth');
    expect(raw.cloudflareAccountId).toBe('only');
    expect(raw.cloudflareRefreshToken).toBe('cf_r');
    expect(await mockKV.get('deploy-keys:foreign-bucket')).toBe(foreign);
  });

  it('redirects to account selection when several accounts are accessible', async () => {
    configureClient();
    const state = await validState();
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'cf_t', refresh_token: 'cf_r', expires_in: 3_600 }))
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }));

    const res = await createTestApp(BASE_ENV).request(
      `/auth/cloudflare/connect/callback?code=abc&state=${encodeURIComponent(state)}`,
    );

    expect(res.headers.get('location')).toContain('cloudflare=select-account');
  });

  it('redirects expired on an invalid state and never exchanges a code', async () => {
    configureClient();
    const res = await createTestApp(BASE_ENV).request(
      '/auth/cloudflare/connect/callback?code=abc&state=forged.0.bad',
    );
    expect(res.headers.get('location')).toContain('cloudflare=expired');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('redirects denied when the user declines at Cloudflare', async () => {
    configureClient();
    const res = await createTestApp(BASE_ENV).request('/auth/cloudflare/connect/callback?error=access_denied');
    expect(res.headers.get('location')).toContain('cloudflare=denied');
  });

  it('redirects unavailable when no OAuth client is configured', async () => {
    const state = await validState();
    const res = await createTestApp(BASE_ENV).request(
      `/auth/cloudflare/connect/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.headers.get('location')).toContain('cloudflare=unavailable');
  });

  it.each(['foreign-owner', 'unbound', 'expired', 'missing-session'] as const)(
    'rejects %s callback without exchanging or changing either owner grant', async rejection => {
      configureClient();
      mockKV._set(KEY, { cloudflareApiToken: 'owner-existing', cloudflareAccountId: 'owner-account' });
      mockKV._set('deploy-keys:foreign-bucket', { cloudflareApiToken: 'foreign-existing' });
      let state: string;
      if (rejection === 'expired') {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 1_801_000);
        try { state = await validState(); } finally { clock.mockRestore(); }
      } else {
        state = await signOauthState(STATE_SECRET, rejection === 'unbound' ? undefined
          : rejection === 'foreign-owner' ? 'foreign-bucket' : 'test-bucket');
      }
      if (rejection === 'missing-session') vi.mocked(authenticateRequest).mockRejectedValueOnce(new Error('session expired'));
      const before = [await mockKV.get(KEY), await mockKV.get('deploy-keys:foreign-bucket')];
      const res = await createTestApp(BASE_ENV).request(
        `/auth/cloudflare/connect/callback?code=abc&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain(rejection === 'missing-session' ? 'error=session-expired' : 'cloudflare=expired');
      expect(mockFetch).not.toHaveBeenCalled();
      expect([await mockKV.get(KEY), await mockKV.get('deploy-keys:foreign-bucket')]).toEqual(before);
    },
  );

  it('rejects a replayed state (single-use nonce) on the second redemption', async () => {
    configureClient();
    const state = await validState();
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'cf_t', expires_in: 3_600 }))
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: 'only', name: 'Only' }] }));

    const app = createTestApp(BASE_ENV);
    const first = await app.request(`/auth/cloudflare/connect/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(first.headers.get('location')).toContain('cloudflare=connected');

    const grant = await mockKV.get(KEY);
    mockFetch.mockClear();
    const second = await app.request(`/auth/cloudflare/connect/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(second.headers.get('location')).toContain('cloudflare=expired');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(await mockKV.get(KEY)).toBe(grant);
  });
});

  it('keeps status, account selection and disconnect confined to the authenticated owner', async () => {
    configureClient();
    mockKV._set(KEY, { cloudflareApiToken: 'owner-token', cloudflareTokenSource: 'oauth', cloudflareRefreshToken: 'owner-refresh' });
    mockKV._set('deploy-keys:foreign-bucket', { cloudflareApiToken: 'foreign-token', cloudflareAccountId: 'foreign-account' });
    mockKV._set(SETUP_KEYS.BROWSER_RENDER_TOKEN, { token: 'admin-browser-secret' });
    const foreign = await mockKV.get('deploy-keys:foreign-bucket');
    const browser = await mockKV.get(SETUP_KEYS.BROWSER_RENDER_TOKEN);
    const app = createTestApp(BASE_ENV);
    mockFetch.mockResolvedValue(ok({ success: true, result: [{ id: 'owner-account', name: 'Owner' }] }));
    const status = await app.request('/api/cloudflare/status');
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(JSON.parse(statusText)).toMatchObject({ configured: true, connected: true, accounts: [{ id: 'owner-account', name: 'Owner' }] });
    for (const secret of ['owner-token', 'owner-refresh', 'foreign-token', 'admin-browser-secret', 'cf-sec']) expect(statusText).not.toContain(secret);
    const select = (accountId: string) => app.request('/api/cloudflare/account', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId }) });
    expect((await select('foreign-account')).status).toBe(400);
    expect(((await mockKV.get(KEY, 'json')) as DeployKeys).cloudflareAccountId).toBeUndefined();
    expect((await select('owner-account')).status).toBe(200);
    expect(((await mockKV.get(KEY, 'json')) as DeployKeys).cloudflareAccountId).toBe('owner-account');
    expect((mockFetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer owner-token' });
    mockFetch.mockResolvedValueOnce(ok({}));
    expect((await app.request('/api/cloudflare/disconnect', { method: 'POST' })).status).toBe(200);
    const revoke = mockFetch.mock.calls.find(([url]) => String(url).endsWith('/oauth2/revoke'))!;
    expect(new URLSearchParams((revoke[1] as RequestInit).body as string).get('token')).toBe('owner-refresh');
    expect(await mockKV.get(KEY)).toBeNull();
    expect(await mockKV.get('deploy-keys:foreign-bucket')).toBe(foreign);
    expect(await mockKV.get(SETUP_KEYS.BROWSER_RENDER_TOKEN)).toBe(browser);
  });

});
