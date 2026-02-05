import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';

vi.mock('../../lib/jwt', () => ({
  verifyAccessJWT: vi.fn(async (token: string, _authDomain: string, expectedAud: string) => {
    if (token === 'cookie-token' && (expectedAud === 'aud-app' || expectedAud === 'aud-single')) {
      return 'cookie-user@example.com';
    }
    return null;
  }),
}));

import { getUserFromRequest, resetAuthConfigCache } from '../../lib/access';

describe('getUserFromRequest cookie JWT fallback', () => {
  beforeEach(() => {
    resetAuthConfigCache();
    vi.clearAllMocks();
  });

  function makeEnv(mockKV: ReturnType<typeof createMockKV>): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      DEV_MODE: 'false',
    } as Env;
  }

  it('authenticates from CF_Authorization cookie using access_aud_list', async () => {
    const mockKV = createMockKV();
    mockKV._store.set('setup:auth_domain', 'team.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud_list', JSON.stringify(['aud-app', 'aud-api']));

    const request = new Request('https://example.com/', {
      headers: { Cookie: 'foo=bar; CF_Authorization=cookie-token; baz=1' },
    });
    const user = await getUserFromRequest(request, makeEnv(mockKV));

    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('cookie-user@example.com');
  });

  it('falls back to single access_aud when access_aud_list is absent', async () => {
    const mockKV = createMockKV();
    mockKV._store.set('setup:auth_domain', 'team.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud', 'aud-single');

    const request = new Request('https://example.com/', {
      headers: { Cookie: 'CF_Authorization=cookie-token' },
    });
    const user = await getUserFromRequest(request, makeEnv(mockKV));

    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('cookie-user@example.com');
  });
});

