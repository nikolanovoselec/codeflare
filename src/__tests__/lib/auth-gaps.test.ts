/**
 * Coverage for authentication REQ gaps.
 *
 * Targets Implemented REQs that had Automated/Integration test verification
 * but no @test anchor and no dedicated test coverage for specific ACs.
 *
 * REQ-AUTH-001 AC2, AC3 (SaaS mode mutual exclusivity)
 * REQ-AUTH-004 AC1, AC2, AC3, AC5 (X-Service-Auth constant-time comparison)
 * REQ-AUTH-008 AC1, AC2, AC4 (session cookie refresh threshold)
 * REQ-AUTH-010 AC1, AC2, AC3 (authConfigFetched sentinel permanence)
 * REQ-AUTH-011 AC1, AC2, AC3 (auth resolution order)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must hoist logger mock before any import that calls createLogger.
const { mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: mockLoggerWarn,
  })),
}));

// Mock sendWelcomeEmail so JIT provisioning tests don't require Resend.
const { mockSendWelcomeEmail } = vi.hoisted(() => ({
  mockSendWelcomeEmail: vi.fn(async () => true),
}));
vi.mock('../../lib/email', () => ({
  sendWelcomeEmail: mockSendWelcomeEmail,
}));

import {
  getUserFromRequest,
  resetAuthConfigCache,
} from '../../lib/access';
import { AuthError } from '../../lib/error-types';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import {
  signSessionJWT,
  shouldRefreshJWT,
  verifySessionJWT,
  SESSION_JWT_AUD,
} from '../../lib/session-jwt';

const TEST_JWT_SECRET = 'test-hmac-secret-32-chars-minimum!!';

describe('REQ-AUTH-004: Service token authentication (X-Service-Auth)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    resetAuthConfigCache();
  });

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      ...overrides,
    } as Env;
  }

  // REQ-AUTH-004 AC1: X-Service-Auth header is checked FIRST in getUserFromRequest()
  it('REQ-AUTH-004 AC1: X-Service-Auth header is checked before any other auth mechanism', async () => {
    // Even with SaaS mode active (which would normally require OAUTH_JWT_SECRET),
    // a valid X-Service-Auth header succeeds before the SaaS branch throws.
    const env = makeEnv({
      SERVICE_AUTH_SECRET: 'my-e2e-secret',
      SERVICE_TOKEN_EMAIL: 'e2e@example.com',
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client-id',
      OAUTH_JWT_SECRET: TEST_JWT_SECRET,
    });

    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'my-e2e-secret' },
    });

    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('e2e@example.com');
    expect(user.role).toBe('admin');
  });

  // REQ-AUTH-004 AC2: Constant-time comparison - wrong secret is rejected
  it('REQ-AUTH-004 AC2: rejects X-Service-Auth header with wrong secret (constant-time)', async () => {
    const env = makeEnv({
      SERVICE_AUTH_SECRET: 'correct-secret-value',
    });

    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'wrong-secret-value' },
    });

    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(false);
    expect(user.email).toBe('');
  });

  // REQ-AUTH-004 AC2: length mismatch is rejected immediately (constant-time path)
  it('REQ-AUTH-004 AC2: rejects X-Service-Auth when header value has wrong length', async () => {
    const env = makeEnv({
      SERVICE_AUTH_SECRET: 'correct-secret',
    });

    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'short' },
    });

    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(false);
    expect(user.email).toBe('');
  });

  // REQ-AUTH-004 AC3: Successful service token returns admin role + SERVICE_TOKEN_EMAIL
  it('REQ-AUTH-004 AC3: successful X-Service-Auth returns admin role and SERVICE_TOKEN_EMAIL', async () => {
    const env = makeEnv({
      SERVICE_AUTH_SECRET: 'shared-e2e-token-abc',
      SERVICE_TOKEN_EMAIL: 'svc-account@corp.example.com',
    });

    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'shared-e2e-token-abc' },
    });

    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(true);
    expect(user.role).toBe('admin');
    expect(user.email).toBe('svc-account@corp.example.com');
  });

  // REQ-AUTH-004 AC3: Falls back to default e2e email when SERVICE_TOKEN_EMAIL not set
  it('REQ-AUTH-004 AC3: falls back to e2e-service@codeflare.local when SERVICE_TOKEN_EMAIL absent', async () => {
    const env = makeEnv({
      SERVICE_AUTH_SECRET: 'shared-e2e-token-xyz',
      // SERVICE_TOKEN_EMAIL intentionally omitted
    });

    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'shared-e2e-token-xyz' },
    });

    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(true);
    expect(user.role).toBe('admin');
    expect(user.email).toBe('e2e-service@codeflare.local');
  });

  // REQ-AUTH-004 AC5: When SERVICE_AUTH_SECRET not set, X-Service-Auth header is ignored
  it('REQ-AUTH-004 AC5: X-Service-Auth header is ignored when SERVICE_AUTH_SECRET not configured', async () => {
    // No SERVICE_AUTH_SECRET in env — the header must be silently ignored
    // and fall through to other auth mechanisms (which will fail here).
    const env = makeEnv({
      // SERVICE_AUTH_SECRET intentionally absent
    });

    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'any-value' },
    });

    const user = await getUserFromRequest(request, env);

    // Must NOT authenticate via the service token path
    expect(user.authenticated).toBe(false);
  });

  // REQ-AUTH-004 AC3: EMAIL normalization applied to SERVICE_TOKEN_EMAIL
  it('REQ-AUTH-004 AC3: SERVICE_TOKEN_EMAIL is normalized (trimmed + lowercased)', async () => {
    const env = makeEnv({
      SERVICE_AUTH_SECRET: 'token-abc',
      SERVICE_TOKEN_EMAIL: '  SVC@Corp.COM  ',
    });

    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'token-abc' },
    });

    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('svc@corp.com');
  });
});

// ===========================================================================
// REQ-AUTH-001: Two authentication modes
// ===========================================================================
describe('REQ-AUTH-001: SaaS mode mutual exclusivity', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    resetAuthConfigCache();
  });

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      ...overrides,
    } as Env;
  }

  // REQ-AUTH-001 AC2 (constraint): Missing OAUTH_JWT_SECRET in SaaS mode throws AuthError
  it('REQ-AUTH-001 AC2: throws AuthError when SAAS_MODE=active and OAUTH_JWT_SECRET missing', async () => {
    const env = makeEnv({
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client-id',
      // OAUTH_JWT_SECRET intentionally absent
    });

    const request = new Request('http://localhost/test', {
      headers: { Cookie: 'codeflare_session=some-token' },
    });

    await expect(getUserFromRequest(request, env)).rejects.toBeInstanceOf(AuthError);
  });

  // REQ-AUTH-001 AC3: SaaS branch entered means CF Access is never checked (no fallthrough)
  it('REQ-AUTH-001 AC3: SaaS OIDC branch does not fall through to CF Access on invalid session', async () => {
    // With SaaS mode active: invalid session cookie returns unauthenticated immediately.
    // If CF Access were checked, the cf-access-jwt-assertion header (which is absent) would
    // fall through to pre-setup fallback (which would succeed on the email header).
    // The correct behavior is unauthenticated — no fallthrough.
    const env = makeEnv({
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client-id',
      OAUTH_JWT_SECRET: TEST_JWT_SECRET,
    });

    const request = new Request('http://localhost/test', {
      headers: {
        // Invalid session cookie — should fail and NOT fall through to CF Access
        Cookie: 'codeflare_session=invalid.jwt.token',
        // CF Access fallback email header — must be ignored in SaaS mode
        'cf-access-authenticated-user-email': 'attacker@evil.com',
      },
    });

    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(false);
    // If CF Access fell through, this would be 'attacker@evil.com'
    expect(user.email).toBe('');
  });

  // REQ-AUTH-001 AC3: When no session cookie is present in SaaS mode, returns unauthenticated
  it('REQ-AUTH-001 AC3: returns unauthenticated immediately when no codeflare_session cookie in SaaS mode', async () => {
    const env = makeEnv({
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client-id',
      OAUTH_JWT_SECRET: TEST_JWT_SECRET,
    });

    const request = new Request('http://localhost/test', {
      headers: {
        // No codeflare_session cookie — SaaS mode returns false immediately
        // CF Access email header must NOT be trusted
        'cf-access-authenticated-user-email': 'user@example.com',
      },
    });

    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(false);
    expect(user.email).toBe('');
  });

  // REQ-AUTH-001 AC2: Valid SaaS session cookie produces authenticated user
  it('REQ-AUTH-001 AC2: valid codeflare_session cookie in SaaS mode authenticates user', async () => {
    const env = makeEnv({
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client-id',
      OAUTH_JWT_SECRET: TEST_JWT_SECRET,
    });

    const token = await signSessionJWT(
      { email: 'alice@example.com', sub: 'gh-12345', ghLogin: 'alice', aud: SESSION_JWT_AUD },
      TEST_JWT_SECRET,
    );

    const request = new Request('http://localhost/test', {
      headers: { Cookie: `codeflare_session=${token}` },
    });

    const user = await getUserFromRequest(request, env);

    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('alice@example.com');
    // SaaS path does NOT set role here (role comes from KV via authenticateRequest)
    expect(user.role).toBeUndefined();
  });
});

// ===========================================================================
// REQ-AUTH-008: Session cookie auto-refresh (shouldRefreshJWT threshold)
// ===========================================================================
describe('REQ-AUTH-008: Session cookie auto-refresh', () => {
  // REQ-AUTH-008 AC2: shouldRefreshJWT returns true when < 15 min remaining
  it('REQ-AUTH-008 AC2: shouldRefreshJWT returns true when less than 15 minutes remain on JWT', async () => {
    // Sign a token expiring in 14 minutes (below 15-min refresh threshold)
    const token = await signSessionJWT(
      { email: 'user@example.com', sub: 'gh-001', ghLogin: 'userhandle' },
      TEST_JWT_SECRET,
      14 * 60, // 14 minutes TTL
    );

    const payload = await verifySessionJWT(token, TEST_JWT_SECRET);
    expect(payload).not.toBeNull();

    const result = shouldRefreshJWT(payload!);

    expect(result).toBe(true);
  });

  // REQ-AUTH-008 AC2: shouldRefreshJWT returns false when >= 15 min remaining
  it('REQ-AUTH-008 AC2: shouldRefreshJWT returns false when 15+ minutes remain on JWT', async () => {
    // Sign a token expiring in 16 minutes (above threshold)
    const token = await signSessionJWT(
      { email: 'user@example.com', sub: 'gh-001', ghLogin: 'userhandle' },
      TEST_JWT_SECRET,
      16 * 60, // 16 minutes TTL
    );

    const payload = await verifySessionJWT(token, TEST_JWT_SECRET);
    expect(payload).not.toBeNull();

    const result = shouldRefreshJWT(payload!);

    expect(result).toBe(false);
  });

  // REQ-AUTH-008 AC2: boundary — exactly 15 minutes remaining is NOT refreshed
  it('REQ-AUTH-008 AC2: shouldRefreshJWT returns false at exactly 15 minutes boundary', async () => {
    // 15 * 60 = 900 seconds exactly — threshold is STRICTLY less-than 900
    const token = await signSessionJWT(
      { email: 'user@example.com', sub: 'gh-001', ghLogin: 'userhandle' },
      TEST_JWT_SECRET,
      15 * 60,
    );

    const payload = await verifySessionJWT(token, TEST_JWT_SECRET);
    expect(payload).not.toBeNull();

    // At the moment of signing, exp - now >= 15*60 (could equal 900), so not refreshed
    const result = shouldRefreshJWT(payload!);

    // Expect false because the threshold is strictly < 900
    expect(result).toBe(false);
  });

  // REQ-AUTH-008 AC2: refresh produces a new token with 1-hour TTL
  it('REQ-AUTH-008 AC2: refreshed JWT has 3600-second (1-hour) TTL', async () => {
    const before = Math.floor(Date.now() / 1000);
    const refreshed = await signSessionJWT(
      { email: 'user@example.com', sub: 'gh-001', ghLogin: 'userhandle' },
      TEST_JWT_SECRET,
      // Default TTL = 3600 (mirrors what index.ts does on refresh)
    );
    const after = Math.floor(Date.now() / 1000);

    const payload = await verifySessionJWT(refreshed, TEST_JWT_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.exp - payload!.iat).toBe(3600);
    expect(payload!.iat).toBeGreaterThanOrEqual(before);
    expect(payload!.iat).toBeLessThanOrEqual(after);
  });

  // REQ-AUTH-008 AC1: shouldRefreshJWT returns false for expired tokens
  it('REQ-AUTH-008 AC1: shouldRefreshJWT returns false for an already-expired token', async () => {
    // Sign with negative TTL — already expired
    const token = await signSessionJWT(
      { email: 'user@example.com', sub: 'gh-001', ghLogin: 'userhandle' },
      TEST_JWT_SECRET,
      -60, // expired 60 seconds ago
    );

    // verifySessionJWT returns null for expired tokens so we must decode manually.
    // shouldRefreshJWT checks payload.exp > now, which is false for expired tokens.
    const parts = token.split('.');
    const decoded = JSON.parse(new TextDecoder().decode(
      (() => {
        let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = base64.length % 4;
        if (pad === 2) base64 += '==';
        else if (pad === 3) base64 += '=';
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      })()
    ));

    const result = shouldRefreshJWT(decoded);

    // payload.exp <= now, so shouldRefreshJWT must return false
    expect(result).toBe(false);
  });
});

// ===========================================================================
// REQ-AUTH-010: Auth bypass prevention (authConfigFetched sentinel)
// ===========================================================================
describe('REQ-AUTH-010: Auth bypass prevention sentinel', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    resetAuthConfigCache();
  });

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      ...overrides,
    } as Env;
  }

  // REQ-AUTH-010 AC1: Sentinel is set once KV auth config has real data
  it('REQ-AUTH-010 AC1: pre-setup header trust is allowed before auth config fetched', async () => {
    // Fresh cache, no auth config in KV — pre-setup state
    const env = makeEnv();

    const request = new Request('http://localhost/test', {
      headers: { 'cf-access-authenticated-user-email': 'setup-admin@company.com' },
    });

    const user = await getUserFromRequest(request, env);

    // Pre-setup: header is trusted
    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('setup-admin@company.com');
  });

  // REQ-AUTH-010 AC2: Once sentinel is set, pre-setup fallback is permanently disabled
  it('REQ-AUTH-010 AC2: header trust disabled permanently once auth config fetched from KV', async () => {
    // First request: populate KV with real auth config so sentinel is set
    mockKV._store.set('setup:auth_domain', 'myteam.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud', 'aud-abc-123');

    const env = makeEnv();

    // First request fetches config and sets the sentinel
    const firstRequest = new Request('http://localhost/first', {
      headers: { 'cf-access-authenticated-user-email': 'user@company.com' },
    });
    const firstUser = await getUserFromRequest(firstRequest, env);
    // No JWT present, auth configured → unauthenticated (FIX-1)
    expect(firstUser.authenticated).toBe(false);

    // Now simulate KV failure by removing auth config
    // (sentinel must NOT revert even if KV would return null on next read)
    // The sentinel is module-level — resetting cache clears it, but we don't reset here.
    // Remove KV entries to simulate transient failure
    mockKV._store.delete('setup:auth_domain');
    mockKV._store.delete('setup:access_aud');

    // Cache TTL: re-use cached values (don't clear cache — this mirrors real isolate behavior)
    const secondRequest = new Request('http://localhost/second', {
      headers: { 'cf-access-authenticated-user-email': 'attacker@evil.com' },
    });
    const secondUser = await getUserFromRequest(secondRequest, env);

    // Even with KV gone and email header present, the sentinel keeps fallback disabled
    // (cached auth config keeps authConfigured=true, so header is rejected)
    expect(secondUser.authenticated).toBe(false);
  });

  // REQ-AUTH-010 AC4: resetAuthConfigCache() clears the sentinel (for tests)
  it('REQ-AUTH-010 AC4: resetAuthConfigCache clears the sentinel allowing re-fetch', async () => {
    // Set up auth config and populate sentinel via first request
    mockKV._store.set('setup:auth_domain', 'myteam.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud', 'aud-abc-123');

    const env = makeEnv();
    const req1 = new Request('http://localhost/a', {
      headers: { 'cf-access-authenticated-user-email': 'x@x.com' },
    });
    await getUserFromRequest(req1, env);

    // Now reset — removes cache AND sentinel
    resetAuthConfigCache();

    // After reset, with no KV config, pre-setup header trust is restored.
    // makeEnv() reuses the outer mockKV reference; we need an actually-empty
    // KV to assert pre-setup fallback re-engages.
    const freshKV = createMockKV();
    const env2 = { KV: freshKV as unknown as KVNamespace } as Env;
    const req2 = new Request('http://localhost/b', {
      headers: { 'cf-access-authenticated-user-email': 'fresh@example.com' },
    });
    const user = await getUserFromRequest(req2, env2);

    // Sentinel cleared — pre-setup fallback is active again
    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('fresh@example.com');
  });
});

// ===========================================================================
// REQ-AUTH-011: Auth resolution order
// ===========================================================================
describe('REQ-AUTH-011: Auth resolution order', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    resetAuthConfigCache();
  });

  function makeEnv(overrides: Partial<Env> = {}): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      ...overrides,
    } as Env;
  }

  // REQ-AUTH-011 AC1(a): Service token is checked first — beats SaaS OIDC
  it('REQ-AUTH-011 AC1: service token (X-Service-Auth) takes priority over SaaS OIDC session cookie', async () => {
    const serviceSecret = 'service-auth-secret-value';
    const env = makeEnv({
      SERVICE_AUTH_SECRET: serviceSecret,
      SERVICE_TOKEN_EMAIL: 'service@system.local',
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client',
      OAUTH_JWT_SECRET: TEST_JWT_SECRET,
    });

    // Also provide a valid SaaS session cookie — it must NOT win
    const saasToken = await signSessionJWT(
      { email: 'saas-user@example.com', sub: 'gh-99', ghLogin: 'saasuser' },
      TEST_JWT_SECRET,
    );

    const request = new Request('http://localhost/test', {
      headers: {
        'X-Service-Auth': serviceSecret,
        Cookie: `codeflare_session=${saasToken}`,
      },
    });

    const user = await getUserFromRequest(request, env);

    // Service token wins — email is SERVICE_TOKEN_EMAIL, not the SaaS cookie email
    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('service@system.local');
    expect(user.role).toBe('admin');
  });

  // REQ-AUTH-011 AC1(b): SaaS OIDC is checked before CF Access (step b before c)
  it('REQ-AUTH-011 AC1: SaaS OIDC cookie is checked before CF Access JWT', async () => {
    const env = makeEnv({
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client',
      OAUTH_JWT_SECRET: TEST_JWT_SECRET,
    });

    const saasToken = await signSessionJWT(
      { email: 'saas-primary@example.com', sub: 'gh-88', ghLogin: 'saasprimary', aud: SESSION_JWT_AUD },
      TEST_JWT_SECRET,
    );

    const request = new Request('http://localhost/test', {
      headers: {
        Cookie: `codeflare_session=${saasToken}`,
        // CF Access header present — must be ignored in SaaS mode
        'cf-access-jwt-assertion': 'some-cf-access-jwt',
      },
    });

    const user = await getUserFromRequest(request, env);

    // SaaS OIDC wins — email from the session cookie
    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('saas-primary@example.com');
  });

  // REQ-AUTH-011 AC2: Once a method succeeds, subsequent methods are not checked
  it('REQ-AUTH-011 AC2: once service token succeeds, SaaS OIDC and CF Access are not evaluated', async () => {
    // The service token succeeds — it returns before reaching SaaS or CF Access code.
    // If SaaS branch were evaluated, it would require OAUTH_JWT_SECRET (which is absent
    // here) and throw AuthError. The fact that NO error is thrown proves the service-token
    // path returned early.
    const env = makeEnv({
      SERVICE_AUTH_SECRET: 'valid-secret',
      SERVICE_TOKEN_EMAIL: 'svc@test.com',
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client',
      // OAUTH_JWT_SECRET intentionally absent — SaaS branch would throw if reached
    });

    const request = new Request('http://localhost/test', {
      headers: { 'X-Service-Auth': 'valid-secret' },
    });

    // Must not throw — service token returns before the SaaS branch with missing OAUTH_JWT_SECRET
    await expect(getUserFromRequest(request, env)).resolves.toMatchObject({
      authenticated: true,
      email: 'svc@test.com',
      role: 'admin',
    });
  });

  // REQ-AUTH-011 AC1(d): Pre-setup fallback is the last resort (only before setup)
  it('REQ-AUTH-011 AC1: pre-setup email header is only trusted when no other auth is configured', async () => {
    // No auth config in KV, no SaaS mode, no service token
    const env = makeEnv();

    const request = new Request('http://localhost/test', {
      headers: { 'cf-access-authenticated-user-email': 'presetup@company.com' },
    });

    const user = await getUserFromRequest(request, env);

    // Pre-setup fallback (method d) is the last resort and works here
    expect(user.authenticated).toBe(true);
    expect(user.email).toBe('presetup@company.com');
  });

  // REQ-AUTH-011 AC3: SaaS branch does not fall through on failure
  it('REQ-AUTH-011 AC3: SaaS branch entered does not fall through to CF Access on bad cookie', async () => {
    // Setup: CF Access configured in KV (would succeed if reached via fallthrough)
    mockKV._store.set('setup:auth_domain', 'team.cloudflareaccess.com');
    mockKV._store.set('setup:access_aud', 'valid-aud');

    const env = makeEnv({
      SAAS_MODE: 'active',
      OAUTH_CLIENT_ID: 'gh-client',
      OAUTH_JWT_SECRET: TEST_JWT_SECRET,
    });

    const request = new Request('http://localhost/test', {
      headers: {
        // Bad session cookie — SaaS branch fails
        Cookie: 'codeflare_session=bad.jwt.token',
        // CF Access email header — must NOT be reached
        'cf-access-authenticated-user-email': 'bypass@evil.com',
      },
    });

    const user = await getUserFromRequest(request, env);

    // SaaS branch entered and failed — return unauthenticated, no fallthrough
    expect(user.authenticated).toBe(false);
    expect(user.email).toBe('');
  });
});
