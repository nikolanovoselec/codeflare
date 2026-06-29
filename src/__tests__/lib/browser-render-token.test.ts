// REQ-BROWSER-007 / REQ-BROWSER-008: in enterprise mode a session's Cloudflare Browser
// Rendering token + account come from the admin-global Setup value (the per-user Push &
// Deploy accordion is hidden), not from per-user deploy-keys. applyEnterpriseBrowserToken is
// the single container-env override point at session start — and per REQ-BROWSER-008 it puts
// only the NON-SECRET PLACEHOLDER (not the real token) into the container; the real token is
// read worker-side by getEnterpriseBrowserCreds for the CloudflareBrowserInterceptor. These
// assertions catch a regression in the enterprise gate, the placeholder substitution, the
// githubToken passthrough, the fail-off-when-unconfigured behaviour, or a real-token leak.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAndDecrypt = vi.hoisted(() => vi.fn());
vi.mock('../../lib/kv-crypto', () => ({
  getAndDecrypt: (...args: unknown[]) => mockGetAndDecrypt(...args),
}));

import { applyEnterpriseBrowserToken, getEnterpriseBrowserCreds } from '../../lib/browser-render-token';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER } from '../../lib/constants';
import type { Env, DeployKeys } from '../../types';

function makeEnv(enterprise: boolean, accountId: string | null): Env {
  return {
    ENTERPRISE_MODE: enterprise ? 'active' : undefined,
    KV: {
      get: vi.fn(async (key: string) =>
        key === SETUP_KEYS.BROWSER_RENDER_ACCOUNT_ID ? accountId : null,
      ),
    },
  } as unknown as Env;
}

describe('applyEnterpriseBrowserToken (REQ-BROWSER-007)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('non-enterprise: returns deployKeys unchanged and reads nothing', async () => {
    const deployKeys: DeployKeys = { githubToken: 'gh', cloudflareApiToken: 'user-cf', cloudflareAccountId: 'user-acct' };
    const result = await applyEnterpriseBrowserToken(makeEnv(false, 'admin-acct'), deployKeys, null);
    // Same object back — the per-user Cloudflare token is preserved untouched.
    expect(result).toBe(deployKeys);
    expect(mockGetAndDecrypt).not.toHaveBeenCalled();
  });

  it('REQ-BROWSER-008: enterprise + configured sets the PLACEHOLDER (never the real token) + admin account, preserves githubToken', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce({ token: 'admin-browser-token' });
    const deployKeys: DeployKeys = { githubToken: 'gh', cloudflareApiToken: 'stale', cloudflareAccountId: 'stale-acct' };
    const result = await applyEnterpriseBrowserToken(makeEnv(true, 'admin-acct'), deployKeys, null);
    // The container gets the non-secret placeholder, NEVER the real token (REQ-BROWSER-008).
    expect(result?.cloudflareApiToken).toBe(ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER);
    expect(result?.cloudflareApiToken).not.toBe('admin-browser-token');
    expect(result?.cloudflareAccountId).toBe('admin-acct');
    expect(result?.githubToken).toBe('gh');
    // The (real) token is still READ from the dedicated encrypted Setup key (to decide the placeholder).
    expect(mockGetAndDecrypt).toHaveBeenCalledWith(expect.anything(), SETUP_KEYS.BROWSER_RENDER_TOKEN, null);
  });

  it('enterprise + no token configured: Cloudflare fields resolve to null so browser-run stays off (no placeholder)', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce(null);
    const result = await applyEnterpriseBrowserToken(makeEnv(true, null), { githubToken: 'gh' }, null);
    expect(result?.cloudflareApiToken).toBeNull();
    expect(result?.cloudflareAccountId).toBeNull();
    expect(result?.githubToken).toBe('gh');
  });

  it('REQ-BROWSER-008: enterprise + no deploy-keys entry: returns an object carrying only the placeholder + admin account', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce({ token: 'admin-browser-token' });
    const result = await applyEnterpriseBrowserToken(makeEnv(true, 'admin-acct'), undefined, null);
    expect(result?.cloudflareApiToken).toBe(ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER);
    expect(result?.cloudflareAccountId).toBe('admin-acct');
    expect(result?.githubToken).toBeUndefined();
  });
});

describe('getEnterpriseBrowserCreds (REQ-BROWSER-008) — worker-side real token resolver', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the REAL token + account id in enterprise (for the interceptor, never the container)', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce({ token: 'admin-browser-token' });
    const creds = await getEnterpriseBrowserCreds(makeEnv(true, 'admin-acct'), null);
    expect(creds.token).toBe('admin-browser-token');
    expect(creds.accountId).toBe('admin-acct');
    expect(mockGetAndDecrypt).toHaveBeenCalledWith(expect.anything(), SETUP_KEYS.BROWSER_RENDER_TOKEN, null);
  });

  it('non-enterprise: returns nulls and reads nothing', async () => {
    const creds = await getEnterpriseBrowserCreds(makeEnv(false, 'admin-acct'), null);
    expect(creds).toEqual({ token: null, accountId: null });
    expect(mockGetAndDecrypt).not.toHaveBeenCalled();
  });

  it('enterprise + unconfigured: returns nulls', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce(null);
    const creds = await getEnterpriseBrowserCreds(makeEnv(true, null), null);
    expect(creds).toEqual({ token: null, accountId: null });
  });
});
