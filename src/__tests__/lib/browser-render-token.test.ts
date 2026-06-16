// REQ-BROWSER-007: in enterprise mode a session's Cloudflare Browser Rendering
// token + account come from the admin-global Setup value (the per-user Push & Deploy
// accordion is hidden), not from per-user deploy-keys. applyEnterpriseBrowserToken is
// the single override point at session start; these assertions catch a regression in
// the enterprise gate, the field override, the githubToken passthrough, or the
// fail-off-when-unconfigured behaviour.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetAndDecrypt = vi.hoisted(() => vi.fn());
vi.mock('../../lib/kv-crypto', () => ({
  getAndDecrypt: (...args: unknown[]) => mockGetAndDecrypt(...args),
}));

import { applyEnterpriseBrowserToken } from '../../lib/browser-render-token';
import { SETUP_KEYS } from '../../lib/kv-keys';
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

  it('enterprise + configured: overrides the Cloudflare fields with the admin token/account, preserves githubToken', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce({ token: 'admin-browser-token' });
    const deployKeys: DeployKeys = { githubToken: 'gh', cloudflareApiToken: 'stale', cloudflareAccountId: 'stale-acct' };
    const result = await applyEnterpriseBrowserToken(makeEnv(true, 'admin-acct'), deployKeys, null);
    expect(result?.cloudflareApiToken).toBe('admin-browser-token');
    expect(result?.cloudflareAccountId).toBe('admin-acct');
    expect(result?.githubToken).toBe('gh');
    // The token is read from the dedicated encrypted Setup key.
    expect(mockGetAndDecrypt).toHaveBeenCalledWith(expect.anything(), SETUP_KEYS.BROWSER_RENDER_TOKEN, null);
  });

  it('enterprise + no token configured: Cloudflare fields resolve to null so browser-run stays off', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce(null);
    const result = await applyEnterpriseBrowserToken(makeEnv(true, null), { githubToken: 'gh' }, null);
    expect(result?.cloudflareApiToken).toBeNull();
    expect(result?.cloudflareAccountId).toBeNull();
    expect(result?.githubToken).toBe('gh');
  });

  it('enterprise + no deploy-keys entry: returns an object carrying only the admin Cloudflare fields', async () => {
    mockGetAndDecrypt.mockResolvedValueOnce({ token: 'admin-browser-token' });
    const result = await applyEnterpriseBrowserToken(makeEnv(true, 'admin-acct'), undefined, null);
    expect(result?.cloudflareApiToken).toBe('admin-browser-token');
    expect(result?.cloudflareAccountId).toBe('admin-acct');
    expect(result?.githubToken).toBeUndefined();
  });
});
