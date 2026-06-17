import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env, DeployKeys } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import {
  storeGithubConnection,
  clearGithubConnection,
  getValidGithubToken,
  getGithubConnectionStatus,
  getGithubProvider,
  connectGithub,
  disconnectGithub,
} from '../../lib/github-token';
import { SETUP_KEYS } from '../../lib/kv-keys';

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BUCKET = 'test-bucket';
const KEY = `deploy-keys:${BUCKET}`;
const APP_ENV = { GITHUB_APP_CLIENT_ID: 'app-cid', GITHUB_APP_CLIENT_SECRET: 'app-sec' };
const OAUTH_ENV = { OAUTH_CLIENT_ID: 'oauth-cid', OAUTH_CLIENT_SECRET: 'oauth-sec' };

let mockKV: ReturnType<typeof createMockKV>;

function env(over: Partial<Env> = {}): Env {
  return { KV: mockKV, ...over } as Env;
}
function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockKV = createMockKV();
});
afterEach(() => {
  vi.useRealTimers();
});

// ─── Storage & status (REQ-GITHUB-001) ─────────────────────────────────────

describe('github-token storage & status', () => {
  it('persists an app connection and reads it back via status + a fresh token (no network)', async () => {
    await storeGithubConnection(env(), BUCKET, {
      accessToken: 'gho_a',
      source: 'app',
      refreshToken: 'ghr_a',
      expiresAt: Date.now() + 3_600_000,
      login: 'octo',
    });

    expect(await getGithubConnectionStatus(env(), BUCKET)).toEqual({
      connected: true,
      login: 'octo',
      source: 'app',
    });
    expect(await getValidGithubToken(env(), BUCKET)).toBe('gho_a');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('preserves the Cloudflare deploy fields when storing a github connection', async () => {
    mockKV._set(KEY, { cloudflareApiToken: 'cf', cloudflareAccountId: 'acct' } satisfies DeployKeys);

    await storeGithubConnection(env(), BUCKET, { accessToken: 'gho_b', source: 'oauth' });

    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.githubToken).toBe('gho_b');
    expect(raw.githubTokenSource).toBe('oauth');
    expect(raw.cloudflareApiToken).toBe('cf');
    expect(raw.cloudflareAccountId).toBe('acct');
  });

  it('clearing removes the github fields but keeps the Cloudflare fields', async () => {
    mockKV._set(KEY, {
      githubToken: 'x',
      githubTokenSource: 'app',
      githubRefreshToken: 'r',
      cloudflareApiToken: 'cf',
    } satisfies DeployKeys);

    await clearGithubConnection(env(), BUCKET);

    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.githubToken).toBeUndefined();
    expect(raw.githubTokenSource).toBeUndefined();
    expect(raw.githubRefreshToken).toBeUndefined();
    expect(raw.cloudflareApiToken).toBe('cf');
  });

  it('clearing deletes the entry entirely when nothing else remains', async () => {
    mockKV._set(KEY, { githubToken: 'x', githubTokenSource: 'pat' } satisfies DeployKeys);

    await clearGithubConnection(env(), BUCKET);

    expect(mockKV.delete).toHaveBeenCalledWith(KEY);
    expect(await mockKV.get(KEY)).toBeNull();
  });

  it('encrypts the token at rest when ENCRYPTION_KEY is set, and round-trips on read', async () => {
    const rawKey = crypto.getRandomValues(new Uint8Array(32));
    const ENCRYPTION_KEY = btoa(String.fromCharCode(...rawKey));

    await storeGithubConnection(env({ ENCRYPTION_KEY }), BUCKET, {
      accessToken: 'gho_secret_xyz',
      source: 'oauth',
    });

    const blob = mockKV._store.get(KEY)!;
    expect(blob.startsWith('v1:')).toBe(true);
    expect(blob).not.toContain('gho_secret_xyz');
    expect(await getValidGithubToken(env({ ENCRYPTION_KEY }), BUCKET)).toBe('gho_secret_xyz');
  });
});

// ─── getValidGithubToken: expiry / refresh / fail-closed (REQ-GITHUB-001) ───

describe('getValidGithubToken', () => {
  it('returns a manually-pasted PAT verbatim, no network', async () => {
    mockKV._set(KEY, { githubToken: 'ghp_pat', githubTokenSource: 'pat' } satisfies DeployKeys);
    expect(await getValidGithubToken(env(), BUCKET)).toBe('ghp_pat');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns a long-lived OAuth token without refreshing', async () => {
    mockKV._set(KEY, { githubToken: 'gho_oauth', githubTokenSource: 'oauth' } satisfies DeployKeys);
    expect(await getValidGithubToken(env(OAUTH_ENV), BUCKET)).toBe('gho_oauth');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns a fresh App token without refreshing', async () => {
    mockKV._set(KEY, {
      githubToken: 'gho_fresh',
      githubTokenSource: 'app',
      githubRefreshToken: 'ghr',
      githubTokenExpiresAt: Date.now() + 3_600_000,
    } satisfies DeployKeys);
    expect(await getValidGithubToken(env(APP_ENV), BUCKET)).toBe('gho_fresh');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes a near-expiry App token, persists the rotated token+expiry, preserves login', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));
    const now = Date.now();
    mockKV._set(KEY, {
      githubToken: 'gho_old',
      githubTokenSource: 'app',
      githubRefreshToken: 'ghr_old',
      githubTokenExpiresAt: now + 60_000, // inside the 5-min refresh skew
      githubLogin: 'octo',
    } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(ok({ access_token: 'gho_new', refresh_token: 'ghr_new', expires_in: 28_800 }));

    const tok = await getValidGithubToken(env(APP_ENV), BUCKET);

    expect(tok).toBe('gho_new');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/login/oauth/access_token');
    expect(JSON.parse((opts as RequestInit).body as string)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ghr_old',
    });
    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.githubToken).toBe('gho_new');
    expect(raw.githubRefreshToken).toBe('ghr_new');
    expect(raw.githubTokenExpiresAt).toBe(now + 28_800 * 1000);
    expect(raw.githubLogin).toBe('octo');
  });

  it('fails closed (null) when an expired App token has no refresh token', async () => {
    mockKV._set(KEY, {
      githubToken: 'gho_dead',
      githubTokenSource: 'app',
      githubTokenExpiresAt: Date.now() - 1000,
    } satisfies DeployKeys);
    expect(await getValidGithubToken(env(APP_ENV), BUCKET)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails closed (null) when the refresh call fails — never returns the stale token', async () => {
    mockKV._set(KEY, {
      githubToken: 'gho_old',
      githubTokenSource: 'app',
      githubRefreshToken: 'ghr',
      githubTokenExpiresAt: Date.now() - 1000,
    } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'bad_refresh' }) });
    expect(await getValidGithubToken(env(APP_ENV), BUCKET)).toBeNull();
  });

  it('returns null when not connected', async () => {
    expect(await getValidGithubToken(env(), BUCKET)).toBeNull();
  });
});

// ─── Provider selection (REQ-GITHUB-001) ───────────────────────────────────

describe('getGithubProvider', () => {
  it('selects the GitHub App provider when app env config is present', async () => {
    expect((await getGithubProvider(env(APP_ENV)))?.source).toBe('app');
  });
  it('selects the OAuth App provider when only oauth env config is present', async () => {
    expect((await getGithubProvider(env(OAUTH_ENV)))?.source).toBe('oauth');
  });
  it('prefers the GitHub App when both env configs are present', async () => {
    expect((await getGithubProvider(env({ ...APP_ENV, ...OAUTH_ENV })))?.source).toBe('app');
  });
  it('returns null when neither is configured (non-enterprise)', async () => {
    expect(await getGithubProvider(env())).toBeNull();
  });

  // REQ-GITHUB-008: enterprise resolves the provider + credentials from Setup→KV.
  it('enterprise resolves the GitHub App provider + credentials from KV by type', async () => {
    mockKV.put(SETUP_KEYS.GITHUB_PROVIDER_TYPE, 'app');
    mockKV.put(SETUP_KEYS.GITHUB_APP_CLIENT_ID, 'kv-app-cid');
    mockKV.put(SETUP_KEYS.GITHUB_APP_CLIENT_SECRET, JSON.stringify({ secret: 'kv-app-sec' }));
    const p = await getGithubProvider(env({ ENTERPRISE_MODE: 'active' }));
    expect(p?.source).toBe('app');
    // The KV client id is the one actually used (it rides the authorize URL).
    const url = new URL(p!.authorizeUrl({ state: 's', redirectUri: 'r' }));
    expect(url.searchParams.get('client_id')).toBe('kv-app-cid');
  });
  it('enterprise resolves the OAuth App provider from KV when type is oauth', async () => {
    mockKV.put(SETUP_KEYS.GITHUB_PROVIDER_TYPE, 'oauth');
    mockKV.put(SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID, 'kv-oauth-cid');
    mockKV.put(SETUP_KEYS.GITHUB_OAUTH_CLIENT_SECRET, JSON.stringify({ secret: 'kv-oauth-sec' }));
    expect((await getGithubProvider(env({ ENTERPRISE_MODE: 'active' })))?.source).toBe('oauth');
  });
  it('enterprise KV config wins over deploy env vars', async () => {
    mockKV.put(SETUP_KEYS.GITHUB_PROVIDER_TYPE, 'oauth');
    mockKV.put(SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID, 'kv-oauth-cid');
    mockKV.put(SETUP_KEYS.GITHUB_OAUTH_CLIENT_SECRET, JSON.stringify({ secret: 'kv-oauth-sec' }));
    expect((await getGithubProvider(env({ ENTERPRISE_MODE: 'active', ...APP_ENV })))?.source).toBe('oauth');
  });
  it('enterprise falls back to env when the KV config is incomplete (missing secret)', async () => {
    mockKV.put(SETUP_KEYS.GITHUB_PROVIDER_TYPE, 'app');
    mockKV.put(SETUP_KEYS.GITHUB_APP_CLIENT_ID, 'kv-app-cid');
    // No secret stored ⇒ KV resolution fails closed ⇒ env fallback.
    expect((await getGithubProvider(env({ ENTERPRISE_MODE: 'active', ...OAUTH_ENV })))?.source).toBe('oauth');
  });
  it('enterprise returns null when neither KV nor env is configured', async () => {
    expect(await getGithubProvider(env({ ENTERPRISE_MODE: 'active' }))).toBeNull();
  });

  // The admin Setup wizard is admin-gated in every mode, so a KV-configured
  // provider must also resolve in non-enterprise deployments (REQ-GITHUB-008).
  it('non-enterprise resolves the provider from the admin Setup KV', async () => {
    mockKV.put(SETUP_KEYS.GITHUB_PROVIDER_TYPE, 'oauth');
    mockKV.put(SETUP_KEYS.GITHUB_OAUTH_CLIENT_ID, 'kv-oauth-cid');
    mockKV.put(SETUP_KEYS.GITHUB_OAUTH_CLIENT_SECRET, JSON.stringify({ secret: 'kv-oauth-sec' }));
    const p = await getGithubProvider(env()); // no ENTERPRISE_MODE
    expect(p?.source).toBe('oauth');
    const url = new URL(p!.authorizeUrl({ state: 's', redirectUri: 'r' }));
    expect(url.searchParams.get('client_id')).toBe('kv-oauth-cid');
  });
  it('non-enterprise Setup KV config wins over the login OAuth env vars', async () => {
    mockKV.put(SETUP_KEYS.GITHUB_PROVIDER_TYPE, 'app');
    mockKV.put(SETUP_KEYS.GITHUB_APP_CLIENT_ID, 'kv-app-cid');
    mockKV.put(SETUP_KEYS.GITHUB_APP_CLIENT_SECRET, JSON.stringify({ secret: 'kv-app-sec' }));
    expect((await getGithubProvider(env(OAUTH_ENV)))?.source).toBe('app');
  });
});

// ─── Authorize URL (REQ-GITHUB-001) ────────────────────────────────────────

describe('authorizeUrl', () => {
  it('App URL carries client_id/state/redirect_uri and no scope param', async () => {
    const url = new URL(
      (await getGithubProvider(env(APP_ENV)))!.authorizeUrl({ state: 's1', redirectUri: 'https://cf/cb' }),
    );
    expect(url.host).toBe('github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('app-cid');
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cf/cb');
    expect(url.searchParams.get('scope')).toBeNull();
  });

  it('OAuth URL requests the repo/read:org/workflow scope', async () => {
    const url = new URL(
      (await getGithubProvider(env(OAUTH_ENV)))!.authorizeUrl({ state: 's', redirectUri: 'https://cf/cb' }),
    );
    expect(url.searchParams.get('scope')).toBe('repo read:org workflow');
  });

  it('honours the GITHUB_HOST override for data-residency tenants', async () => {
    const url = new URL(
      (await getGithubProvider(env({ ...APP_ENV, GITHUB_HOST: 'ghe.example.com' })))!.authorizeUrl({
        state: 's',
        redirectUri: 'r',
      }),
    );
    expect(url.host).toBe('ghe.example.com');
  });
});

// ─── Code exchange (REQ-GITHUB-001) ────────────────────────────────────────

describe('connectGithub (code exchange)', () => {
  it('App exchange stores token + refresh + expiry + login', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'gho_app', refresh_token: 'ghr_app', expires_in: 28_800 }))
      .mockResolvedValueOnce(ok({ login: 'octo' }));

    const conn = await connectGithub(env(APP_ENV), BUCKET, 'code123', 'https://cf/cb');

    expect(conn).toMatchObject({
      source: 'app',
      accessToken: 'gho_app',
      refreshToken: 'ghr_app',
      expiresAt: Date.now() + 28_800 * 1000,
      login: 'octo',
    });
    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.githubToken).toBe('gho_app');
    expect(raw.githubTokenSource).toBe('app');
    expect(JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({
      code: 'code123',
      redirect_uri: 'https://cf/cb',
      client_id: 'app-cid',
    });
  });

  it('OAuth exchange stores a long-lived token with no refresh/expiry', async () => {
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'gho_oauth_x' }))
      .mockResolvedValueOnce(ok({ login: 'octo' }));

    const conn = await connectGithub(env(OAUTH_ENV), BUCKET, 'c', 'https://cf/cb');

    expect(conn.source).toBe('oauth');
    expect(conn.refreshToken).toBeUndefined();
    expect(conn.expiresAt).toBeUndefined();
    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.githubToken).toBe('gho_oauth_x');
    expect(raw.githubRefreshToken).toBeNull();
  });

  it('throws when the code exchange returns an error', async () => {
    mockFetch.mockResolvedValueOnce(ok({ error: 'bad_verification_code' }));
    await expect(connectGithub(env(APP_ENV), BUCKET, 'bad', 'r')).rejects.toThrow();
  });
});

// ─── Disconnect / revoke (REQ-GITHUB-005) ──────────────────────────────────

describe('disconnectGithub', () => {
  it('revokes at GitHub and clears the field for an app/oauth token', async () => {
    mockKV._set(KEY, { githubToken: 'gho_x', githubTokenSource: 'app' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}) });

    await disconnectGithub(env(APP_ENV), BUCKET);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toContain('/applications/app-cid/token');
    expect((opts as RequestInit).method).toBe('DELETE');
    expect(await mockKV.get(KEY)).toBeNull();
  });

  it('does NOT call GitHub revoke for a manually-pasted PAT but still clears it', async () => {
    mockKV._set(KEY, { githubToken: 'ghp_pat', githubTokenSource: 'pat' } satisfies DeployKeys);

    await disconnectGithub(env(APP_ENV), BUCKET);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(await mockKV.get(KEY)).toBeNull();
  });
});
