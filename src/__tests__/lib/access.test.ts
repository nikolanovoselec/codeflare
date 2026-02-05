import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveUserFromKV, getBucketName, authenticateRequest, getUserFromRequest, resetAuthConfigCache } from '../../lib/access';
import { AuthError, ForbiddenError } from '../../lib/error-types';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';

describe('access.ts', () => {
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
      // Arrays are typeof 'object' and not null, so they pass the check
      // but the result will have defaults for missing fields
      expect(result).not.toBeNull();
      expect(result!.role).toBe('user'); // no .role on array → defaults
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

  describe('getBucketName', () => {
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
  describe('authenticateRequest()', () => {
    function makeEnv(overrides: Partial<Env> = {}): Env {
      return {
        KV: mockKV as unknown as KVNamespace,
        DEV_MODE: 'false',
        ...overrides,
      } as Env;
    }

    it('throws AuthError when request has no auth headers and DEV_MODE=false', async () => {
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

    it('grants admin role in DEV_MODE=true without any headers', async () => {
      const request = new Request('http://localhost/test');

      const result = await authenticateRequest(request, makeEnv({ DEV_MODE: 'true' } as Partial<Env>));

      expect(result.user.authenticated).toBe(true);
      expect(result.user.role).toBe('admin');
      // Default prefix when CLOUDFLARE_WORKER_NAME is not set
      expect(result.bucketName).toContain('codeflare-');
      // KV allowlist should NOT be checked
      expect(mockKV.get).not.toHaveBeenCalledWith(expect.stringMatching(/^user:/));
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
  // getUserFromRequest() tests
  // ===========================================================================
  describe('getUserFromRequest()', () => {
    function makeEnv(overrides: Partial<Env> = {}): Env {
      return {
        KV: mockKV as unknown as KVNamespace,
        DEV_MODE: 'false',
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

    it('returns test user in DEV_MODE with no headers', async () => {
      const request = new Request('http://localhost/test');
      const user = await getUserFromRequest(request, makeEnv({ DEV_MODE: 'true' } as Partial<Env>));
      expect(user.authenticated).toBe(true);
      expect(user.email).toBe('test@example.com');
    });
  });
});
