import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const { mockSendWelcomeEmail } = vi.hoisted(() => ({
  mockSendWelcomeEmail: vi.fn(async () => true),
}));
vi.mock('../../lib/email', () => ({
  sendWelcomeEmail: mockSendWelcomeEmail,
}));

import { resolveUserFromKV, getBucketName, authenticateRequest, getUserFromRequest, resetAuthConfigCache, resolveOrProvisionUser } from '../../lib/access';
import { AuthError, ForbiddenError } from '../../lib/error-types';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

describe('access.ts / REQ-AUTH-001 (two authentication modes) / REQ-AUTH-007 (JIT user provisioning in SaaS) / REQ-AUTH-012 (welcome email on provisioning)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
    resetAuthConfigCache();
  });

  describe('resolveUserFromKV', () => {
    it('returns null when user key does not exist in KV', async () => {
      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'nobody@example.com');
      expect(result).toBeNull();
    });

    it('returns null for malformed JSON string', async () => {
      mockKV._store.set('user:bad@example.com', 'not-valid-json{{{');

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'bad@example.com');
      expect(result).toBeNull();
    });

    it('returns null for truncated JSON object', async () => {
      mockKV._store.set('user:trunc@example.com', '{invalid');

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'trunc@example.com');
      expect(result).toBeNull();
    });

    it('returns null for plain text "not-json"', async () => {
      mockKV._store.set('user:text@example.com', 'not-json');

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'text@example.com');
      expect(result).toBeNull();
    });

    it('returns null when parsed value is not an object (e.g., number)', async () => {
      mockKV._store.set('user:num@example.com', '42');

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'num@example.com');
      expect(result).toBeNull();
    });

    it('returns null when parsed value is null', async () => {
      mockKV._store.set('user:null@example.com', 'null');

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'null@example.com');
      expect(result).toBeNull();
    });

    it('returns null when parsed value is a string', async () => {
      mockKV._store.set('user:str@example.com', '"just a string"');

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'str@example.com');
      expect(result).toBeNull();
    });

    it('returns null when parsed value is an array', async () => {
      mockKV._store.set('user:arr@example.com', '[1, 2, 3]');

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'arr@example.com');
      // CF-010: parseUserRecord rejects non-object values (arrays fail Zod z.object schema)
      expect(result).toBeNull();
    });

    it('defaults role to user when role field is missing', async () => {
      mockKV._store.set(
        'user:legacy@example.com',
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01' })
      );

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'legacy@example.com');
      expect(result).not.toBeNull();
      expect(result!.role).toBe('user');
      expect(result!.addedBy).toBe('setup');
      expect(result!.addedAt).toBe('2024-01-01');
    });

    it('returns admin when role is explicitly admin', async () => {
      mockKV._store.set(
        'user:admin@example.com',
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01', role: 'admin' })
      );

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'admin@example.com');
      expect(result).not.toBeNull();
      expect(result!.role).toBe('admin');
    });

    it('defaults role to user for unrecognized role value', async () => {
      mockKV._store.set(
        'user:custom@example.com',
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01', role: 'superadmin' })
      );

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'custom@example.com');
      expect(result).not.toBeNull();
      expect(result!.role).toBe('user');
    });

    it('defaults addedBy to unknown when missing', async () => {
      mockKV._store.set(
        'user:noauthor@example.com',
        JSON.stringify({ addedAt: '2024-01-01' })
      );

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'noauthor@example.com');
      expect(result).not.toBeNull();
      expect(result!.addedBy).toBe('unknown');
    });

    it('defaults addedAt to empty string when missing', async () => {
      mockKV._store.set(
        'user:nodate@example.com',
        JSON.stringify({ addedBy: 'test' })
      );

      const result = await resolveUserFromKV(mockKV as unknown as KVNamespace, 'nodate@example.com');
      expect(result).not.toBeNull();
      expect(result!.addedAt).toBe('');
    });

    it('normalizes email key lookup (trim + lowercase)', async () => {
      mockKV._store.set(
        'user:mixed@example.com',
        JSON.stringify({ addedBy: 'setup', addedAt: '2024-01-01', role: 'admin' })
      );

      const result = await resolveUserFromKV(
        mockKV as unknown as KVNamespace,
        '  MiXeD@Example.Com  '
      );
      expect(result).not.toBeNull();
      expect(result!.role).toBe('admin');
    });
  });

  describe('getBucketName / REQ-AUTH-006 AC3 (bucket name derivation max 63 chars, sanitized)', () => {
    it('generates bucket name with codeflare- prefix by default', () => {
      const name = getBucketName('user@example.com');
      expect(name).toMatch(/^codeflare-/);
    });

    it('replaces @ and . with hyphens', () => {
      const name = getBucketName('test@example.com');
      expect(name).toBe('codeflare-test-example-com');
    });

    it('truncates to 63 chars max', () => {
      const longEmail = 'a'.repeat(100) + '@example.com';
      const name = getBucketName(longEmail);
      expect(name.length).toBeLessThanOrEqual(63);
    });

    it('uses CLOUDFLARE_WORKER_NAME as prefix when provided', () => {
      const name = getBucketName('test@example.com', 'myapp');
      expect(name).toBe('myapp-test-example-com');
    });

    it('defaults to codeflare- when workerName is undefined', () => {
      const name = getBucketName('test@example.com', undefined);
      expect(name).toBe('codeflare-test-example-com');
    });
  });

  // ===========================================================================
  // authenticateRequest() tests (Q23)
  // ===========================================================================
  describe('authenticateRequest() / REQ-AUTH-006 AC1/AC2 (trim+lowercase email before KV lookup, role resolution, bucket derivation)', () => {
    function makeEnv(overrides: Partial<Env> = {}): Env {
      return {
        KV: mockKV as unknown as KVNamespace,
        ...overrides,
      } as Env;
    }

    it('throws AuthError when request has no auth headers', async () => {
      const request = new Request('http://localhost/test');

      await expect(
        authenticateRequest(request, makeEnv())
      ).rejects.toThrow(AuthError);
    });

    it('throws AuthError with 401 status code for unauthenticated requests', async () => {
      const request = new Request('http://localhost/test');

      try {
        await authenticateRequest(request, makeEnv());
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).statusCode).toBe(401);
      }
    });

    it('throws ForbiddenError when user is not in KV allowlist', async () => {
      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': 'unknown@example.com' },
      });

      await expect(
        authenticateRequest(request, makeEnv())
      ).rejects.toThrow(ForbiddenError);
    });

    it('throws ForbiddenError with 403 status code for unlisted users', async () => {
      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': 'stranger@example.com' },
      });

      try {
        await authenticateRequest(request, makeEnv());
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenError);
        expect((err as ForbiddenError).statusCode).toBe(403);
      }
    });

    it('uses CLOUDFLARE_WORKER_NAME for bucket name prefix', async () => {
      const testEmail = 'worker-test@example.com';
      mockKV._set(`user:${testEmail}`, { addedBy: 'setup', addedAt: '2024-01-01', role: 'user' });

      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      const result = await authenticateRequest(request, makeEnv({ CLOUDFLARE_WORKER_NAME: 'myapp' } as Partial<Env>));

      expect(result.bucketName).toBe('myapp-worker-test-example-com');
    });

    it('returns user object with email and bucketName for valid allowlisted user', async () => {
      const testEmail = 'valid@example.com';
      mockKV._set(`user:${testEmail}`, { addedBy: 'setup', addedAt: '2024-01-01', role: 'user' });

      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      const result = await authenticateRequest(request, makeEnv());

      expect(result.user.email).toBe(testEmail);
      expect(result.user.authenticated).toBe(true);
      expect(result.user.role).toBe('user');
      expect(result.bucketName).toBe(getBucketName(testEmail));
    });

    it('resolves admin role from KV entry', async () => {
      const testEmail = 'admin-auth@example.com';
      mockKV._set(`user:${testEmail}`, { addedBy: 'setup', addedAt: '2024-01-01', role: 'admin' });

      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': testEmail },
      });

      const result = await authenticateRequest(request, makeEnv());

      expect(result.user.role).toBe('admin');
    });

    it('normalizes authenticated email before allowlist lookup', async () => {
      const storedEmail = 'case-test@example.com';
      mockKV._set(`user:${storedEmail}`, { addedBy: 'setup', addedAt: '2024-01-01', role: 'user' });

      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': '  Case-Test@Example.Com  ' },
      });

      const result = await authenticateRequest(request, makeEnv());

      expect(result.user.email).toBe(storedEmail);
      expect(result.user.role).toBe('user');
      expect(result.bucketName).toBe(getBucketName(storedEmail));
    });
  });

  // ===========================================================================
  // CF-019: independent double-submit CSRF token gating in authenticateRequest
  // ===========================================================================
  describe('authenticateRequest() CSRF double-submit / CF-019 (cookie+header token, mismatch rejects, absence falls back to X-Requested-With)', () => {
    function makeEnv(overrides: Partial<Env> = {}): Env {
      return {
        KV: mockKV as unknown as KVNamespace,
        ...overrides,
      } as Env;
    }

    // Pre-setup header trust authenticates the email; the KV record makes the
    // allowlist lookup pass so we reach the end of authenticateRequest. The
    // CSRF gate runs FIRST, so rejection tests do not even need a KV record.
    const email = 'csrf-user@example.com';
    function seedUser(): void {
      mockKV._set(`user:${email}`, { addedBy: 'setup', addedAt: '2024-01-01', role: 'user' });
    }
    function makeRequest(headers: Record<string, string>): Request {
      return new Request('http://localhost/api/vault/abcdef12/x', {
        method: 'POST',
        headers: { 'cf-access-authenticated-user-email': email, ...headers },
      });
    }

    it('accepts when cookie and header tokens match', async () => {
      seedUser();
      const token = 'tok-abc-123';
      const req = makeRequest({
        Cookie: `codeflare_vault_csrf=${token}`,
        'X-Vault-Csrf': token,
      });
      // No X-Requested-With supplied: the matching double-submit token alone
      // must satisfy CSRF.
      const result = await authenticateRequest(req, makeEnv());
      expect(result.user.email).toBe(email);
    });

    it('rejects with ForbiddenError when cookie and header tokens differ', async () => {
      const req = makeRequest({
        Cookie: 'codeflare_vault_csrf=cookie-token',
        'X-Vault-Csrf': 'header-token',
      });
      await expect(authenticateRequest(req, makeEnv())).rejects.toThrow(ForbiddenError);
    });

    it('rejects mismatched tokens of equal length (constant-time path)', async () => {
      const req = makeRequest({
        Cookie: 'codeflare_vault_csrf=aaaaaa',
        'X-Vault-Csrf': 'bbbbbb',
      });
      await expect(authenticateRequest(req, makeEnv())).rejects.toThrow(ForbiddenError);
    });

    it('falls back to X-Requested-With when only the cookie is present (transition)', async () => {
      // Cookie present, header absent -> not a conclusive double-submit -> the
      // legacy X-Requested-With requirement still applies. Without it -> reject.
      const reqNoXrw = makeRequest({ Cookie: 'codeflare_vault_csrf=tok' });
      await expect(authenticateRequest(reqNoXrw, makeEnv())).rejects.toThrow(ForbiddenError);

      // With X-Requested-With -> the legacy gate passes.
      seedUser();
      const reqWithXrw = makeRequest({
        Cookie: 'codeflare_vault_csrf=tok',
        'X-Requested-With': 'XMLHttpRequest',
      });
      const result = await authenticateRequest(reqWithXrw, makeEnv());
      expect(result.user.email).toBe(email);
    });

    it('falls back to X-Requested-With when neither token is present (non-vault routes unaffected)', async () => {
      // Neither cookie nor header -> legacy behaviour: missing X-Requested-With rejects.
      const reqMissing = makeRequest({});
      await expect(authenticateRequest(reqMissing, makeEnv())).rejects.toThrow(ForbiddenError);

      // X-Requested-With present -> passes (existing contract preserved).
      seedUser();
      const reqXrw = makeRequest({ 'X-Requested-With': 'XMLHttpRequest' });
      const result = await authenticateRequest(reqXrw, makeEnv());
      expect(result.user.email).toBe(email);
    });

    it('does not gate safe methods (GET) on the CSRF token', async () => {
      seedUser();
      const req = new Request('http://localhost/api/vault/abcdef12/x', {
        method: 'GET',
        headers: { 'cf-access-authenticated-user-email': email },
      });
      const result = await authenticateRequest(req, makeEnv());
      expect(result.user.email).toBe(email);
    });
  });

  // ===========================================================================
  // getUserFromRequest() tests
  // ===========================================================================
  describe('getUserFromRequest() / REQ-AUTH-010 AC1/AC2/AC3/AC4 (authConfigFetched sentinel disables pre-setup header trust after first KV success) / REQ-AUTH-011 AC1/AC2 (resolution order: service token, cookie, JWT, pre-setup header)', () => {
    function makeEnv(overrides: Partial<Env> = {}): Env {
      return {
        KV: mockKV as unknown as KVNamespace,
        ...overrides,
      } as Env;
    }

    it('returns unauthenticated user when no headers present', async () => {
      const request = new Request('http://localhost/test');
      const user = await getUserFromRequest(request, makeEnv());
      expect(user.authenticated).toBe(false);
      expect(user.email).toBe('');
    });

    it('returns authenticated user from cf-access-authenticated-user-email header (pre-setup)', async () => {
      // No auth config in KV → pre-setup state → header trust allowed
      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': 'user@test.com' },
      });
      const user = await getUserFromRequest(request, makeEnv());
      expect(user.authenticated).toBe(true);
      expect(user.email).toBe('user@test.com');
    });

    it('normalizes cf-access-authenticated-user-email header', async () => {
      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': '  User@Test.Com  ' },
      });
      const user = await getUserFromRequest(request, makeEnv());
      expect(user.authenticated).toBe(true);
      expect(user.email).toBe('user@test.com');
    });

    it('rejects spoofed header when auth is configured but no JWT present (FIX-1)', async () => {
      // Simulate post-setup: auth_domain and access_aud are stored in KV
      mockKV._store.set('setup:auth_domain', 'myteam.cloudflareaccess.com');
      mockKV._store.set('setup:access_aud', 'aud-token-123');

      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': 'spoofed@attacker.com' },
      });
      const user = await getUserFromRequest(request, makeEnv());
      expect(user.authenticated).toBe(false);
      expect(user.email).toBe('');
    });

    it('trusts header when auth is NOT configured (pre-setup) (FIX-1)', async () => {
      // No auth config in KV → pre-setup → header trust for setup wizard
      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': 'setup@example.com' },
      });
      const user = await getUserFromRequest(request, makeEnv());
      expect(user.authenticated).toBe(true);
      expect(user.email).toBe('setup@example.com');
    });

    it('returns authenticated user from service token cf-access-client-id header', async () => {
      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-client-id': 'abc123.token' },
      });
      const user = await getUserFromRequest(request, makeEnv());
      expect(user.authenticated).toBe(true);
      expect(user.email).toContain('service-abc123');
    });

    it('uses SERVICE_TOKEN_EMAIL env for service token', async () => {
      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-client-id': 'abc123.token' },
      });
      const user = await getUserFromRequest(request, makeEnv({ SERVICE_TOKEN_EMAIL: 'svc@company.com' } as Partial<Env>));
      expect(user.email).toBe('svc@company.com');
    });

    it('logs logger.warn when access_aud_list JSON parse fails (FIX-3)', async () => {
      mockLoggerWarn.mockClear();
      resetAuthConfigCache();

      // Store invalid JSON in setup:access_aud_list
      mockKV._store.set('setup:access_aud_list', '{not-valid-json');

      const request = new Request('http://localhost/test', {
        headers: { 'cf-access-authenticated-user-email': 'user@test.com' },
      });
      await getUserFromRequest(request, makeEnv());

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Failed to parse access_aud_list',
        expect.objectContaining({ raw: '{not-valid-json' }),
      );
    });

  });

  describe('resolveOrProvisionUser — welcome email dedup', () => {
    beforeEach(() => {
      mockSendWelcomeEmail.mockClear();
    });

    it('sends welcome email on first-time SaaS user and sets flag', async () => {
      const env = { SAAS_MODE: 'active', KV: mockKV } as unknown as Env;
      await resolveOrProvisionUser(mockKV as unknown as KVNamespace, 'new@example.com', env);

      expect(mockSendWelcomeEmail).toHaveBeenCalledTimes(1);
      // Flag should be set in KV
      const flag = mockKV._store.get('welcome-sent:new@example.com');
      expect(flag).toBe('1');
    });

    it('does NOT send welcome email when flag already exists', async () => {
      mockKV._store.set('welcome-sent:existing@example.com', '1');
      const env = { SAAS_MODE: 'active', KV: mockKV } as unknown as Env;
      await resolveOrProvisionUser(mockKV as unknown as KVNamespace, 'existing@example.com', env);

      expect(mockSendWelcomeEmail).not.toHaveBeenCalled();
    });
  });
});
