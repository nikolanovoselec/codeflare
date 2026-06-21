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
import { signOauthState } from '../../lib/oauth-state';
import { SETUP_KEYS } from '../../lib/kv-keys';

const KEY = 'deploy-keys:test-bucket';
const STATE_SECRET = 'state-secret';
/** Plain non-enterprise, non-advanced env (the decoupled-gate case). */
const BASE_ENV: Partial<Env> = { OAUTH_JWT_SECRET: STATE_SECRET };

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
});

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

  it('feeds the scope tier into the OAuth authorize scope param (always incl. offline_access)', async () => {
    configureClient();
    const advanced = new URL(
      (await createTestApp(BASE_ENV).request('/api/cloudflare/connect?tier=advanced')).headers.get('location')!,
    );
    expect(advanced.searchParams.get('scope')).toContain('ai.write');
    expect(advanced.searchParams.get('scope')!.split(' ')).toContain('offline_access');
    const minimal = new URL(
      (await createTestApp(BASE_ENV).request('/api/cloudflare/connect?tier=minimal')).headers.get('location')!,
    );
    expect(minimal.searchParams.get('scope')).not.toContain('ai.write');
  });
});

// ─── GET /status ─────────────────────────────────────────────────────────────

describe('GET /api/cloudflare/status', () => {
  it('reports configured=false + not connected when unconfigured', async () => {
    const body = await (await createTestApp(BASE_ENV).request('/api/cloudflare/status')).json() as Record<string, unknown>;
    expect(body.configured).toBe(false);
    expect(body.connected).toBe(false);
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

  it('rejects a replayed state (single-use nonce) on the second redemption', async () => {
    configureClient();
    const state = await validState();
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'cf_t', expires_in: 3_600 }))
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: 'only', name: 'Only' }] }));

    const app = createTestApp(BASE_ENV);
    const first = await app.request(`/auth/cloudflare/connect/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(first.headers.get('location')).toContain('cloudflare=connected');

    const second = await app.request(`/auth/cloudflare/connect/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(second.headers.get('location')).toContain('cloudflare=expired');
  });
});
