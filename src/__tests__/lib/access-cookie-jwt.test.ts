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
import { signSessionJWT, verifySessionJWT, SESSION_JWT_AUD } from '../../lib/session-jwt';

describe('getUserFromRequest cookie JWT fallback', () => {
  beforeEach(() => {
    resetAuthConfigCache();
    vi.clearAllMocks();
  });

  function makeEnv(mockKV: ReturnType<typeof createMockKV>): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
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

  it.each([
    { mode: 'SaaS', flags: { SAAS_MODE: 'active' } },
    { mode: 'onboarding', flags: { ONBOARDING_LANDING_PAGE: 'active' } },
  ])('REQ-AUTH-001 AC1: $mode without OAuth configuration resolves the Access identity', async ({ flags }) => {
    const mockKV = createMockKV();
    mockKV._store.set('setup:auth_domain', 'team.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud', 'aud-single');
    const request = new Request('https://example.com/', {
      headers: {
        Cookie: 'CF_Authorization=cookie-token; codeflare_session=unconfigured-session',
        'cf-access-authenticated-user-email': 'untrusted@example.com',
      },
    });

    expect(await getUserFromRequest(request, { ...makeEnv(mockKV), ...flags })).toEqual({
      email: 'cookie-user@example.com', authenticated: true,
    });
  });

  it.each(['SaaS', 'onboarding'] as const)(
    'REQ-AUTH-011 AC1/AC2/AC3: %s resolves competing credentials without falling through failed branches', async mode => {
      const mockKV = createMockKV();
      mockKV._store.set('setup:auth_domain', 'team.cloudflareaccess.com');
      mockKV._store.set('setup:access_aud', 'aud-single');
      const secret = 'synthetic-session-secret-32-chars!!';
      const session = await signSessionJWT({
        email: 'session@example.com', sub: 'fixture-user', ghLogin: 'fixture', aud: SESSION_JWT_AUD,
      }, secret);
      const env = {
        ...makeEnv(mockKV),
        ...(mode === 'SaaS' ? { SAAS_MODE: 'active' } : { ONBOARDING_LANDING_PAGE: 'active' }),
        OAUTH_CLIENT_ID: 'fixture-client', OAUTH_JWT_SECRET: secret,
        SERVICE_AUTH_SECRET: 'service-secret', SERVICE_TOKEN_EMAIL: 'service@example.com',
      } as Env;
      const request = (token: string | null, service?: string) => new Request('https://example.com/', {
        headers: {
          // The same Access fixture is accepted by the default-mode tests above.
          'cf-access-jwt-assertion': 'cookie-token',
          'cf-access-authenticated-user-email': 'untrusted@example.com',
          ...(token ? { Cookie: `codeflare_session=${token}` } : {}),
          ...(service ? { 'X-Service-Auth': service } : {}),
        },
      });

      expect(await getUserFromRequest(request(session, 'service-secret'), env)).toMatchObject({
        email: 'service@example.com', authenticated: true, role: 'admin',
      });
      expect(await getUserFromRequest(request(session), env)).toEqual({
        email: 'session@example.com', authenticated: true,
      });
      // Wrong service secret may not degrade to either otherwise valid identity.
      expect(await getUserFromRequest(request(session, 'wrong-secret!!'), env)).toEqual({
        email: '', authenticated: false,
      });
      for (const token of ['invalid.jwt.token', null]) {
        expect(await getUserFromRequest(request(token), env)).toEqual({ email: '', authenticated: false });
      }
    },
  );

  it('REQ-AUTH-021 AC4: a valid app cookie cannot authenticate outside session-OIDC mode', async () => {
    const mockKV = createMockKV();
    mockKV._store.set('setup:auth_domain', 'team.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud', 'aud-single');
    const secret = 'synthetic-session-secret-32-chars!!';
    const session = await signSessionJWT({
      email: 'session@example.com', sub: 'fixture-user', ghLogin: 'fixture', aud: SESSION_JWT_AUD,
    }, secret);
    expect(await verifySessionJWT(session, secret, SESSION_JWT_AUD)).toMatchObject({
      email: 'session@example.com', aud: SESSION_JWT_AUD,
    });
    // Keep OAuth configured: only the deployment mode prevents app-cookie trust.
    const env = { ...makeEnv(mockKV), OAUTH_CLIENT_ID: 'fixture-client', OAUTH_JWT_SECRET: secret } as Env;
    const request = (accessToken?: string) => new Request('https://example.com/', {
      headers: {
        Cookie: `codeflare_session=${session}`,
        'cf-access-authenticated-user-email': 'untrusted@example.com',
        ...(accessToken ? { 'cf-access-jwt-assertion': accessToken } : {}),
      },
    });

    expect(await getUserFromRequest(request(), env)).toEqual({ email: '', authenticated: false });
    expect(await getUserFromRequest(request('invalid-access'), env)).toEqual({ email: '', authenticated: false });
    expect(await getUserFromRequest(request('cookie-token'), env)).toEqual({
      email: 'cookie-user@example.com', authenticated: true,
    });
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

