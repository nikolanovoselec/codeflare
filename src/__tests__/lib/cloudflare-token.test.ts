import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env, DeployKeys } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import {
  storeCloudflareConnection,
  clearCloudflareConnection,
  getCloudflareConnectionStatus,
  getValidCloudflareToken,
  applyCloudflareOAuthToken,
  getCloudflareProvider,
  fetchCloudflareAccounts,
  connectCloudflare,
  setCloudflareAccount,
  disconnectCloudflare,
} from '../../lib/cloudflare-token';
import { SETUP_KEYS } from '../../lib/kv-keys';

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const BUCKET = 'test-bucket';
const KEY = `deploy-keys:${BUCKET}`;

let mockKV: ReturnType<typeof createMockKV>;

function env(over: Partial<Env> = {}): Env {
  return { KV: mockKV, ...over } as Env;
}
function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json };
}
/** Register the admin Cloudflare OAuth client (id plain, secret "encrypted" JSON). */
function configureClient() {
  mockKV.put(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID, 'cf-cid');
  mockKV.put(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_SECRET, JSON.stringify({ secret: 'cf-sec' }));
}
function form(body: unknown): URLSearchParams {
  return new URLSearchParams(body as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockKV = createMockKV();
});
afterEach(() => {
  vi.useRealTimers();
});

// ─── Storage & status ───────────────────────────────────────────────────────

describe('cloudflare-token storage & status', () => {
  it('persists an oauth connection and reads it back via status + a fresh token (no network)', async () => {
    await storeCloudflareConnection(env(), BUCKET, {
      accessToken: 'cf_a',
      source: 'oauth',
      refreshToken: 'cfr_a',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'acct-1',
    });

    expect(await getCloudflareConnectionStatus(env(), BUCKET)).toEqual({
      connected: true,
      accountId: 'acct-1',
      source: 'oauth',
    });
    expect(await getValidCloudflareToken(env(), BUCKET)).toBe('cf_a');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('preserves the GitHub deploy fields when storing a cloudflare connection', async () => {
    mockKV._set(KEY, { githubToken: 'gho', githubTokenSource: 'oauth' } satisfies DeployKeys);

    await storeCloudflareConnection(env(), BUCKET, { accessToken: 'cf_b', source: 'oauth' });

    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.cloudflareApiToken).toBe('cf_b');
    expect(raw.cloudflareTokenSource).toBe('oauth');
    expect(raw.githubToken).toBe('gho');
    expect(raw.githubTokenSource).toBe('oauth');
  });

  it('clearing removes the cloudflare fields but keeps the GitHub fields', async () => {
    mockKV._set(KEY, {
      cloudflareApiToken: 'cf',
      cloudflareTokenSource: 'oauth',
      cloudflareRefreshToken: 'r',
      cloudflareAccountId: 'acct',
      githubToken: 'gho',
    } satisfies DeployKeys);

    await clearCloudflareConnection(env(), BUCKET);

    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.cloudflareApiToken).toBeUndefined();
    expect(raw.cloudflareTokenSource).toBeUndefined();
    expect(raw.cloudflareRefreshToken).toBeUndefined();
    expect(raw.cloudflareAccountId).toBeUndefined();
    expect(raw.githubToken).toBe('gho');
  });

  it('clearing deletes the entry entirely when no github fields remain', async () => {
    mockKV._set(KEY, { cloudflareApiToken: 'cf', cloudflareTokenSource: 'oauth' } satisfies DeployKeys);
    await clearCloudflareConnection(env(), BUCKET);
    expect(await mockKV.get(KEY)).toBeNull();
  });
});

// ─── getValidCloudflareToken: expiry / refresh / fail-closed ─────────────────

describe('getValidCloudflareToken', () => {
  it('returns a manually-pasted PAT verbatim, no network', async () => {
    mockKV._set(KEY, { cloudflareApiToken: 'cf_pat', cloudflareTokenSource: 'pat' } satisfies DeployKeys);
    expect(await getValidCloudflareToken(env(), BUCKET)).toBe('cf_pat');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns an oauth token without an expiry verbatim, no network', async () => {
    mockKV._set(KEY, { cloudflareApiToken: 'cf_o', cloudflareTokenSource: 'oauth' } satisfies DeployKeys);
    expect(await getValidCloudflareToken(env(), BUCKET)).toBe('cf_o');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns a fresh oauth token without refreshing', async () => {
    mockKV._set(KEY, {
      cloudflareApiToken: 'cf_fresh',
      cloudflareTokenSource: 'oauth',
      cloudflareRefreshToken: 'r',
      cloudflareTokenExpiresAt: Date.now() + 3_600_000,
    } satisfies DeployKeys);
    expect(await getValidCloudflareToken(env(), BUCKET)).toBe('cf_fresh');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes a near-expiry oauth token, persists the rotated token+expiry, preserves accountId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));
    const now = Date.now();
    configureClient();
    mockKV._set(KEY, {
      cloudflareApiToken: 'cf_old',
      cloudflareTokenSource: 'oauth',
      cloudflareRefreshToken: 'cfr_old',
      cloudflareTokenExpiresAt: now + 60_000, // inside the 5-min refresh skew
      cloudflareAccountId: 'acct-keep',
    } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(ok({ access_token: 'cf_new', refresh_token: 'cfr_new', expires_in: 3_600 }));

    const tok = await getValidCloudflareToken(env(), BUCKET);

    expect(tok).toBe('cf_new');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://dash.cloudflare.com/oauth2/token');
    const body = form((opts as RequestInit).body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('cfr_old');
    expect(body.get('client_secret')).toBe('cf-sec');

    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.cloudflareApiToken).toBe('cf_new');
    expect(raw.cloudflareRefreshToken).toBe('cfr_new');
    expect(raw.cloudflareTokenExpiresAt).toBe(now + 3_600 * 1000);
    expect(raw.cloudflareAccountId).toBe('acct-keep');
  });

  it('fails closed (null) when an expired oauth token has no refresh token', async () => {
    mockKV._set(KEY, {
      cloudflareApiToken: 'cf_dead',
      cloudflareTokenSource: 'oauth',
      cloudflareTokenExpiresAt: Date.now() - 1000,
    } satisfies DeployKeys);
    expect(await getValidCloudflareToken(env(), BUCKET)).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails closed (null) when the refresh call fails — never returns the stale token', async () => {
    configureClient();
    mockKV._set(KEY, {
      cloudflareApiToken: 'cf_old',
      cloudflareTokenSource: 'oauth',
      cloudflareRefreshToken: 'r',
      cloudflareTokenExpiresAt: Date.now() - 1000,
    } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'bad' }) });
    expect(await getValidCloudflareToken(env(), BUCKET)).toBeNull();
  });

  it('returns null when not connected', async () => {
    expect(await getValidCloudflareToken(env(), BUCKET)).toBeNull();
  });
});

// ─── applyCloudflareOAuthToken: container-injection refresh wiring ────────────

describe('applyCloudflareOAuthToken', () => {
  it('passes a PAT source through untouched (no refresh, no network)', async () => {
    const dk: DeployKeys = { cloudflareApiToken: 'cf_pat', cloudflareTokenSource: 'pat', githubToken: 'gh' };
    const out = await applyCloudflareOAuthToken(env(), dk, BUCKET);
    expect(out).toBe(dk); // same reference: not rewritten
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('passes through when there is no cloudflare token source (e.g. enterprise browser token)', async () => {
    const dk: DeployKeys = { cloudflareApiToken: 'cf_admin', githubToken: 'gh' };
    const out = await applyCloudflareOAuthToken(env(), dk, BUCKET);
    expect(out).toBe(dk);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('injects a still-valid oauth token and preserves the other deploy fields', async () => {
    const dk: DeployKeys = {
      cloudflareApiToken: 'cf_fresh',
      cloudflareTokenSource: 'oauth',
      cloudflareRefreshToken: 'r',
      cloudflareTokenExpiresAt: Date.now() + 3_600_000,
      githubToken: 'gh',
    };
    mockKV._set(KEY, dk);
    const out = await applyCloudflareOAuthToken(env(), dk, BUCKET);
    expect(out?.cloudflareApiToken).toBe('cf_fresh');
    expect(out?.githubToken).toBe('gh');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes a near-expiry oauth token before injection', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));
    configureClient();
    const dk: DeployKeys = {
      cloudflareApiToken: 'cf_old',
      cloudflareTokenSource: 'oauth',
      cloudflareRefreshToken: 'cfr_old',
      cloudflareTokenExpiresAt: Date.now() + 60_000, // inside the refresh skew
      githubToken: 'gh',
    };
    mockKV._set(KEY, dk);
    mockFetch.mockResolvedValueOnce(ok({ access_token: 'cf_new', refresh_token: 'cfr_new', expires_in: 3_600 }));
    const out = await applyCloudflareOAuthToken(env(), dk, BUCKET);
    expect(out?.cloudflareApiToken).toBe('cf_new');
    expect(out?.githubToken).toBe('gh');
  });

  it('fails closed (null token) when an expiring oauth token cannot be refreshed — never injects a stale token', async () => {
    const dk: DeployKeys = {
      cloudflareApiToken: 'cf_stale',
      cloudflareTokenSource: 'oauth',
      cloudflareTokenExpiresAt: Date.now() - 1000, // expired, no refresh token
      githubToken: 'gh',
    };
    mockKV._set(KEY, dk);
    const out = await applyCloudflareOAuthToken(env(), dk, BUCKET);
    expect(out?.cloudflareApiToken).toBeNull();
    expect(out?.githubToken).toBe('gh');
  });
});

// ─── Provider selection (Setup→KV, non-enterprise only) ──────────────────────

describe('getCloudflareProvider', () => {
  it('returns null when unconfigured', async () => {
    expect(await getCloudflareProvider(env())).toBeNull();
  });

  it('resolves the OAuth client from KV (id plain, secret encrypted)', async () => {
    configureClient();
    const p = await getCloudflareProvider(env());
    expect(p?.source).toBe('oauth');
    const url = new URL(p!.authorizeUrl({ state: 's', redirectUri: 'https://x/cb', scope: 'offline_access' }));
    expect(url.searchParams.get('client_id')).toBe('cf-cid');
  });

  it('fails closed (null) when the client id is set but the secret is missing', async () => {
    mockKV.put(SETUP_KEYS.CLOUDFLARE_OAUTH_CLIENT_ID, 'cf-cid');
    expect(await getCloudflareProvider(env())).toBeNull();
  });

  it('returns null in enterprise mode even when the KV client is configured', async () => {
    configureClient();
    expect(await getCloudflareProvider(env({ ENTERPRISE_MODE: 'active' }))).toBeNull();
  });
});

// ─── authorizeUrl / exchangeCode / refresh / revoke ──────────────────────────

describe('CloudflareOAuthProvider', () => {
  it('builds an authorize URL to the Cloudflare consent endpoint with the standard params', async () => {
    configureClient();
    const p = await getCloudflareProvider(env());
    const url = new URL(p!.authorizeUrl({ state: 'st8', redirectUri: 'https://app/cb', scope: 'offline_access' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://dash.cloudflare.com/oauth2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cf-cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app/cb');
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('exchanges a code at the token endpoint and returns token+refresh+expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));
    const now = Date.now();
    configureClient();
    const p = await getCloudflareProvider(env());
    mockFetch.mockResolvedValueOnce(ok({ access_token: 'cf_x', refresh_token: 'cfr_x', expires_in: 3_600 }));

    const conn = await p!.exchangeCode('the-code', 'https://app/cb');

    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://dash.cloudflare.com/oauth2/token');
    const body = form((opts as RequestInit).body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('redirect_uri')).toBe('https://app/cb');
    expect(body.get('client_secret')).toBe('cf-sec');
    expect(conn).toMatchObject({ accessToken: 'cf_x', source: 'oauth', refreshToken: 'cfr_x', expiresAt: now + 3_600 * 1000 });
  });

  it('throws when the token endpoint returns an OAuth error', async () => {
    configureClient();
    const p = await getCloudflareProvider(env());
    mockFetch.mockResolvedValueOnce(ok({ error: 'invalid_grant' }));
    await expect(p!.exchangeCode('bad', 'https://app/cb')).rejects.toThrow();
  });
});

// ─── accounts + connect orchestration ────────────────────────────────────────

describe('fetchCloudflareAccounts', () => {
  it('returns the account list on success', async () => {
    mockFetch.mockResolvedValueOnce(ok({ success: true, result: [{ id: 'a1', name: 'One' }] }));
    expect(await fetchCloudflareAccounts('tok')).toEqual([{ id: 'a1', name: 'One' }]);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://api.cloudflare.com/client/v4/accounts');
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });
  it('throws on an API error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    await expect(fetchCloudflareAccounts('tok')).rejects.toThrow();
  });
});

describe('connectCloudflare', () => {
  it('auto-selects the single account, persists token+refresh+expiry+accountId', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));
    const now = Date.now();
    configureClient();
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'cf_t', refresh_token: 'cf_r', expires_in: 3_600 }))
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: 'only-acct', name: 'Only' }] }));

    const res = await connectCloudflare(env(), BUCKET, 'code', 'https://app/cb');

    expect(res.accountId).toBe('only-acct');
    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.cloudflareApiToken).toBe('cf_t');
    expect(raw.cloudflareRefreshToken).toBe('cf_r');
    expect(raw.cloudflareTokenExpiresAt).toBe(now + 3_600 * 1000);
    expect(raw.cloudflareTokenSource).toBe('oauth');
    expect(raw.cloudflareAccountId).toBe('only-acct');
  });

  it('leaves accountId unset (for user selection) when several accounts exist', async () => {
    configureClient();
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'cf_t', refresh_token: 'cf_r', expires_in: 3_600 }))
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] }));

    const res = await connectCloudflare(env(), BUCKET, 'code', 'https://app/cb');

    expect(res.accountId).toBeUndefined();
    expect(res.accounts).toHaveLength(2);
    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.cloudflareApiToken).toBe('cf_t');
    expect(raw.cloudflareAccountId ?? null).toBeNull();
  });

  it('throws when no provider is configured', async () => {
    await expect(connectCloudflare(env(), BUCKET, 'code', 'https://app/cb')).rejects.toThrow();
  });
});

describe('setCloudflareAccount', () => {
  it('persists a valid account id and rejects an inaccessible one', async () => {
    mockKV._set(KEY, { cloudflareApiToken: 'cf', cloudflareTokenSource: 'oauth' } satisfies DeployKeys);
    mockFetch.mockResolvedValue(ok({ success: true, result: [{ id: 'a', name: 'A' }] }));

    expect(await setCloudflareAccount(env(), BUCKET, 'a')).toBe(true);
    expect(((await mockKV.get(KEY, 'json')) as DeployKeys).cloudflareAccountId).toBe('a');

    expect(await setCloudflareAccount(env(), BUCKET, 'nope')).toBe(false);
  });

  it('refreshes an expiring token before listing accounts and preserves the rotated token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T00:00:00Z'));
    configureClient();
    mockKV._set(KEY, {
      cloudflareApiToken: 'cf_old',
      cloudflareTokenSource: 'oauth',
      cloudflareRefreshToken: 'cfr_old',
      cloudflareTokenExpiresAt: Date.now() - 1000, // expired -> must refresh before the accounts call
    } satisfies DeployKeys);
    mockFetch
      .mockResolvedValueOnce(ok({ access_token: 'cf_new', refresh_token: 'cfr_new', expires_in: 3_600 })) // refresh
      .mockResolvedValueOnce(ok({ success: true, result: [{ id: 'a', name: 'A' }] })); // accounts

    expect(await setCloudflareAccount(env(), BUCKET, 'a')).toBe(true);

    // accounts fetched with the refreshed token, not the stale one (the bug this fixes)
    expect((mockFetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer cf_new' });
    const raw = (await mockKV.get(KEY, 'json')) as DeployKeys;
    expect(raw.cloudflareAccountId).toBe('a');
    expect(raw.cloudflareApiToken).toBe('cf_new'); // rotated token not clobbered by the account write
  });
});

describe('disconnectCloudflare', () => {
  it('revokes an oauth token at Cloudflare and clears the stored fields', async () => {
    configureClient();
    mockKV._set(KEY, { cloudflareApiToken: 'cf', cloudflareTokenSource: 'oauth' } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(ok({}));

    await disconnectCloudflare(env(), BUCKET);

    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toBe('https://dash.cloudflare.com/oauth2/revoke');
    expect(await mockKV.get(KEY)).toBeNull();
  });

  it('revokes the refresh token (whole grant family) when one is stored', async () => {
    configureClient();
    mockKV._set(KEY, {
      cloudflareApiToken: 'cf_a',
      cloudflareTokenSource: 'oauth',
      cloudflareRefreshToken: 'cfr_a',
    } satisfies DeployKeys);
    mockFetch.mockResolvedValueOnce(ok({}));

    await disconnectCloudflare(env(), BUCKET);

    const body = form((mockFetch.mock.calls[0][1] as RequestInit).body);
    expect(body.get('token')).toBe('cfr_a'); // the refresh token, not the access token
    expect(await mockKV.get(KEY)).toBeNull();
  });
});
