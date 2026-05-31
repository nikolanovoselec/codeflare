import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, AccessUser } from '../../types';
import type { AuthVariables } from '../../middleware/auth';

// CF-005: The auth middleware is NO LONGER mocked into a pass-through. The
// REAL requireActiveUser/requireAdmin from src/middleware/auth run. We mock
// only the request-identity input (authenticateRequest) so the middleware's
// tier gate and role check are exercised end-to-end against controlled
// fixtures. getBucketName is also mocked here because it lives in the same
// module (../../lib/access) and the route imports it.
let mockAuthUser: AccessUser = { email: 'admin@example.com', authenticated: true, role: 'admin' } as AccessUser;

vi.mock('../../lib/access', () => ({
  authenticateRequest: vi.fn(async () => ({
    user: { ...mockAuthUser },
    bucketName: 'codeflare-test',
  })),
  getBucketName: vi.fn((email: string, workerName?: string) => {
    const sanitized = email
      .toLowerCase()
      .trim()
      .replace(/@/g, '-')
      .replace(/\./g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const prefix = workerName || 'codeflare';
    return `${prefix}-${sanitized.substring(0, 63 - prefix.length - 1)}`;
  }),
}));

// Mock access-policy module
vi.mock('../../lib/access-policy', () => ({
  getAllUsers: vi.fn(),
  syncAccessPolicy: vi.fn(),
  getAdminEmails: vi.fn(async () => []),
}));

// Mock r2-admin scoped token functions
const mockDeleteScopedR2Token = vi.hoisted(() => vi.fn());
vi.mock('../../lib/r2-admin', () => ({
  deleteScopedR2Token: mockDeleteScopedR2Token,
}));

import usersRoutes from '../../routes/users';
import { getAllUsers, syncAccessPolicy } from '../../lib/access-policy';
import { AppError } from '../../lib/error-types';

import { createMockKV } from '../helpers/mock-kv';

const mockGetAllUsers = getAllUsers as ReturnType<typeof vi.fn>;
const mockSyncAccessPolicy = syncAccessPolicy as ReturnType<typeof vi.fn>;

/**
 * Set the identity the real middleware will see for the next request.
 * Defaults to an active tier so the acting user clears the SaaS tier gate;
 * tests that exercise the gate itself pass an explicit pending/blocked tier.
 */
function setAuthUser(user: Partial<AccessUser> & { email: string }) {
  mockAuthUser = { authenticated: true, role: 'user', accessTier: 'standard', subscriptionTier: 'standard', ...user } as AccessUser;
}

// Mock global fetch for CF API calls
const mockFetch = vi.fn();

describe('Users Routes / REQ-AUTH-018 (user management admin panel)', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
    globalThis.fetch = mockFetch;
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    mockGetAllUsers.mockResolvedValue([]);
    mockSyncAccessPolicy.mockResolvedValue(undefined);
    // Default acting identity: active admin (clears the SaaS tier gate and
    // requireAdmin). Tests that exercise the guards override via the factories.
    setAuthUser({ email: 'admin@example.com', role: 'admin' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
  });

  function createTestApp(userEmail = 'admin@example.com') {
    // Drive the real middleware via the mocked authenticateRequest identity.
    setAuthUser({ email: userEmail, role: 'admin' });

    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    // Set up mock env
    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        CLOUDFLARE_API_TOKEN: 'test-api-token',
      } as unknown as Env;
      return next();
    });

    app.route('/users', usersRoutes);

    // Error handler to match the global one in index.ts
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  describe('GET /users', () => {
    it('returns list of users from KV', async () => {
      const mockUsers = [
        { email: 'alice@example.com', addedBy: 'admin@example.com', addedAt: '2024-01-10T00:00:00.000Z' },
        { email: 'bob@example.com', addedBy: 'admin@example.com', addedAt: '2024-01-11T00:00:00.000Z' },
      ];
      mockGetAllUsers.mockResolvedValue(mockUsers);

      const app = createTestApp();
      const res = await app.request('/users');

      expect(res.status).toBe(200);
      const body = await res.json() as { users: typeof mockUsers };
      expect(body.users).toHaveLength(2);
      expect(body.users[0].email).toBe('alice@example.com');
      expect(body.users[0].addedBy).toBe('admin@example.com');
      expect(body.users[0].addedAt).toBe('2024-01-10T00:00:00.000Z');
      expect(body.users[1].email).toBe('bob@example.com');
    });

    it('returns empty array when no user: keys exist', async () => {
      mockGetAllUsers.mockResolvedValue([]);

      const app = createTestApp();
      const res = await app.request('/users');

      expect(res.status).toBe(200);
      const body = await res.json() as { users: unknown[] };
      expect(body.users).toEqual([]);
    });
  });

  describe('DELETE /users/:email', () => {
    it('removes KV entry for user', async () => {
      const app = createTestApp('admin@example.com');

      // Pre-populate user
      mockKV._set('user:target@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });

      const res = await app.request('/users/target%40example.com', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; email: string };
      expect(body.success).toBe(true);
      expect(body.email).toBe('target@example.com');
      expect(mockKV.delete).toHaveBeenCalledWith('user:target@example.com');
    });

    it('returns 400 when trying to remove self', async () => {
      const app = createTestApp('admin@example.com');

      // Pre-populate own user entry
      mockKV._set('user:admin@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });

      const res = await app.request('/users/admin%40example.com', {
        method: 'DELETE',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/yourself/i);
    });

    it('returns 404 when user does not exist', async () => {
      const app = createTestApp();

      const res = await app.request('/users/nonexistent%40example.com', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/not found/i);
    });

    it('attempts R2 bucket deletion via Cloudflare API', async () => {
      const app = createTestApp('admin@example.com');

      // Set up KV with account_id
      mockKV._store.set('setup:account_id', 'test-account-id');
      mockKV._set('user:target@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });

      await app.request('/users/target%40example.com', {
        method: 'DELETE',
      });

      // Verify fetch was called with DELETE to R2 bucket endpoint
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/r2/buckets/codeflare-'),
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-token',
          }),
        }),
      );
    });

    // =======================================================================
    // Scoped R2 Token cleanup on user deletion
    // =======================================================================
    it('should read r2token:{email} and call deleteScopedR2Token on user deletion', async () => {
      const app = createTestApp('admin@example.com');

      mockKV._store.set('setup:account_id', 'test-account-id');
      mockKV._set('user:target@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });
      mockKV._set('r2token:target@example.com', {
        accessKeyId: 'ak-123',
        secretAccessKey: 'sk-456',
        tokenId: 'token-id-789',
        bucketName: 'codeflare-target-example-com',
        createdAt: '2024-01-01T00:00:00Z',
      });

      mockDeleteScopedR2Token.mockResolvedValue(undefined);

      await app.request('/users/target%40example.com', { method: 'DELETE' });

      // Should have called deleteScopedR2Token with the stored tokenId
      expect(mockDeleteScopedR2Token).toHaveBeenCalledWith(
        'test-account-id',
        'test-api-token',
        'token-id-789',
      );
    });

    it('should empty bucket via S3 list+delete before bucket deletion', async () => {
      const app = createTestApp('admin@example.com');

      mockKV._store.set('setup:account_id', 'test-account-id');
      mockKV._set('user:target@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });
      mockKV._set('r2token:target@example.com', {
        accessKeyId: 'ak-123',
        secretAccessKey: 'sk-456',
        tokenId: 'token-id-789',
        bucketName: 'codeflare-target-example-com',
        createdAt: '2024-01-01T00:00:00Z',
      });

      mockDeleteScopedR2Token.mockResolvedValue(undefined);

      // Mock S3 list objects returning some objects, then delete
      // The implementation should use S3-compatible API to empty the bucket
      // before calling the bucket deletion API
      mockFetch
        // S3 ListObjectsV2 response (empty for simplicity in TDD)
        .mockResolvedValueOnce(new Response('<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 }))
        // DELETE bucket
        .mockResolvedValueOnce(new Response('{}', { status: 200 }));

      const res = await app.request('/users/target%40example.com', { method: 'DELETE' });
      expect(res.status).toBe(200);
    });

    it('should continue deletion even if token deletion fails (graceful)', async () => {
      const app = createTestApp('admin@example.com');

      mockKV._store.set('setup:account_id', 'test-account-id');
      mockKV._set('user:target@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });
      mockKV._set('r2token:target@example.com', {
        accessKeyId: 'ak-123',
        secretAccessKey: 'sk-456',
        tokenId: 'token-id-789',
        bucketName: 'codeflare-target-example-com',
        createdAt: '2024-01-01T00:00:00Z',
      });

      // Token deletion fails
      mockDeleteScopedR2Token.mockRejectedValue(new Error('CF API down'));

      const res = await app.request('/users/target%40example.com', { method: 'DELETE' });

      // User deletion should still succeed despite token deletion failure
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('should delete r2token:{email} KV entry after token deletion', async () => {
      const app = createTestApp('admin@example.com');

      mockKV._store.set('setup:account_id', 'test-account-id');
      mockKV._set('user:target@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });
      mockKV._set('r2token:target@example.com', {
        accessKeyId: 'ak-123',
        secretAccessKey: 'sk-456',
        tokenId: 'token-id-789',
        bucketName: 'codeflare-target-example-com',
        createdAt: '2024-01-01T00:00:00Z',
      });

      mockDeleteScopedR2Token.mockResolvedValue(undefined);

      await app.request('/users/target%40example.com', { method: 'DELETE' });

      // Should have deleted the r2token KV entry
      expect(mockKV.delete).toHaveBeenCalledWith('r2token:target@example.com');
    });

    it('attempts to sync CF Access policy after removal', async () => {
      const app = createTestApp('admin@example.com');

      // Set up KV with account_id and domain
      mockKV._store.set('setup:account_id', 'test-account-id');
      mockKV._store.set('setup:custom_domain', 'app.example.com');
      mockKV._set('user:target@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });

      await app.request('/users/target%40example.com', {
        method: 'DELETE',
      });

      expect(mockSyncAccessPolicy).toHaveBeenCalledWith(
        'test-api-token',
        'test-account-id',
        'app.example.com',
        expect.anything(),
      );
    });
  });

  // =========================================================================
  // Admin-only gating tests
  // =========================================================================
  describe('Admin-only access control', () => {
    function createTestAppWithRole(userEmail: string, role: 'admin' | 'user') {
      // Real authMiddleware + requireAdmin run; only identity is mocked.
      setAuthUser({ email: userEmail, role });

      const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      app.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          CLOUDFLARE_API_TOKEN: 'test-api-token',
        } as unknown as Env;
        return next();
      });
      app.route('/users', usersRoutes);

      // Error handler to match the global one in index.ts
      app.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });

      return app;
    }

    it('non-admin GET /users returns 403', async () => {
      const app = createTestAppWithRole('viewer@example.com', 'user');

      const res = await app.request('/users');

      expect(res.status).toBe(403);
    });

    it('non-admin DELETE /users/:email returns 403', async () => {
      const app = createTestAppWithRole('viewer@example.com', 'user');
      mockKV._set('user:target@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01' });

      const res = await app.request('/users/target%40example.com', {
        method: 'DELETE',
      });

      expect(res.status).toBe(403);
    });

    it('not-found error follows AppError.toJSON() shape', async () => {
      const app = createTestAppWithRole('admin@example.com', 'admin');

      const res = await app.request('/users/ghost%40example.com', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
      const body = await res.json() as { error: string; code: string };
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code', 'NOT_FOUND');
    });

    it('DELETE admin user returns 400 - admins cannot be deleted via user management', async () => {
      const app = createTestAppWithRole('admin@example.com', 'admin');
      mockKV._set('user:other-admin@example.com', {
        addedBy: 'setup',
        addedAt: '2024-01-01T00:00:00.000Z',
        role: 'admin',
      });

      const res = await app.request('/users/other-admin%40example.com', {
        method: 'DELETE',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/admin/i);
    });

    it('DELETE non-admin user succeeds normally', async () => {
      const app = createTestAppWithRole('admin@example.com', 'admin');
      mockKV._set('user:regular@example.com', {
        addedBy: 'admin@example.com',
        addedAt: '2024-01-01T00:00:00.000Z',
        role: 'user',
      });

      const res = await app.request('/users/regular%40example.com', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('PATCH admin user tier returns 400 - cannot change admin access tier', async () => {
      const app = createTestAppWithRole('admin@example.com', 'admin');
      // Need SAAS_MODE for PATCH to work
      (app as any)._useMW = true;
      // Re-create with SAAS_MODE
      const saasApp = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      saasApp.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          CLOUDFLARE_API_TOKEN: 'test-api-token',
          SAAS_MODE: 'active',
        } as unknown as Env;
        return next();
      });
      saasApp.route('/users', usersRoutes);
      saasApp.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });

      mockKV._set('user:target-admin@example.com', {
        addedBy: 'setup',
        addedAt: '2024-01-01T00:00:00.000Z',
        role: 'admin',
        accessTier: 'advanced',
      });

      const res = await saasApp.request('/users/target-admin%40example.com', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionTier: 'standard' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/admin/i);
    });

    it('PATCH non-admin user tier succeeds in SaaS mode', async () => {
      const saasApp = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      saasApp.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          CLOUDFLARE_API_TOKEN: 'test-api-token',
          SAAS_MODE: 'active',
        } as unknown as Env;
        return next();
      });
      saasApp.route('/users', usersRoutes);
      saasApp.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });

      mockKV._set('user:regular@example.com', {
        addedBy: 'admin@example.com',
        addedAt: '2024-01-01T00:00:00.000Z',
        role: 'user',
        accessTier: 'pending',
      });

      const res = await saasApp.request('/users/regular%40example.com', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionTier: 'standard' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; subscriptionTier: string };
      expect(body.success).toBe(true);
      expect(body.subscriptionTier).toBe('standard');
    });

    it('PATCH user to advanced tier auto-sets sessionMode preference', async () => {
      const saasApp = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      saasApp.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          CLOUDFLARE_API_TOKEN: 'test-api-token',
          SAAS_MODE: 'active',
          CLOUDFLARE_WORKER_NAME: 'codeflare',
        } as unknown as Env;
        return next();
      });
      saasApp.route('/users', usersRoutes);
      saasApp.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });

      mockKV._set('user:newuser@example.com', {
        addedBy: 'jit',
        addedAt: '2024-01-01T00:00:00.000Z',
        role: 'user',
        accessTier: 'pending',
      });

      const res = await saasApp.request('/users/newuser%40example.com', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionTier: 'advanced' }),
      });

      expect(res.status).toBe(200);
      // Check that preferences were written with sessionMode: 'advanced'
      const prefsKey = 'user-prefs:codeflare-newuser-example-com';
      const prefs = mockKV._store.get(prefsKey);
      expect(prefs).toBeDefined();
      const parsed = typeof prefs === 'string' ? JSON.parse(prefs) : prefs;
      expect(parsed.sessionMode).toBe('advanced');
    });

    it('PATCH user to advanced does not override existing sessionMode preference', async () => {
      const saasApp = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      saasApp.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          CLOUDFLARE_API_TOKEN: 'test-api-token',
          SAAS_MODE: 'active',
          CLOUDFLARE_WORKER_NAME: 'codeflare',
        } as unknown as Env;
        return next();
      });
      saasApp.route('/users', usersRoutes);
      saasApp.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });

      mockKV._set('user:existing@example.com', {
        addedBy: 'jit',
        addedAt: '2024-01-01T00:00:00.000Z',
        role: 'user',
        accessTier: 'standard',
      });
      // User already has preferences with default mode
      mockKV._set('user-prefs:codeflare-existing-example-com', {
        sessionMode: 'default',
        lastAgentType: 'codex',
      });

      const res = await saasApp.request('/users/existing%40example.com', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionTier: 'advanced' }),
      });

      expect(res.status).toBe(200);
      // Existing sessionMode should be preserved
      const prefsKey = 'user-prefs:codeflare-existing-example-com';
      const prefs = mockKV._store.get(prefsKey);
      const parsed = typeof prefs === 'string' ? JSON.parse(prefs) : prefs;
      expect(parsed.sessionMode).toBe('default');
      expect(parsed.lastAgentType).toBe('codex');
    });

    it('PATCH succeeds when user has accessTier: free (written by subscribe endpoint)', async () => {
      const saasApp = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      saasApp.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          CLOUDFLARE_API_TOKEN: 'test-api-token',
          SAAS_MODE: 'active',
          CLOUDFLARE_WORKER_NAME: 'codeflare',
        } as unknown as Env;
        return next();
      });
      saasApp.route('/users', usersRoutes);
      saasApp.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });

      // Subscribe endpoint writes accessTier: 'free' which is not in AccessTierSchema
      mockKV._set('user:subscriber@example.com', {
        addedBy: 'jit',
        addedAt: '2024-01-01T00:00:00.000Z',
        role: 'user',
        accessTier: 'free',
        subscriptionTier: 'free',
        subscribedAt: '2024-01-02T00:00:00.000Z',
      });

      const res = await saasApp.request('/users/subscriber%40example.com', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionTier: 'advanced' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; subscriptionTier: string };
      expect(body.success).toBe(true);
      expect(body.subscriptionTier).toBe('advanced');
    });

    it('PATCH user to standard tier does not write preferences', async () => {
      const saasApp = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      saasApp.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          CLOUDFLARE_API_TOKEN: 'test-api-token',
          SAAS_MODE: 'active',
          CLOUDFLARE_WORKER_NAME: 'codeflare',
        } as unknown as Env;
        return next();
      });
      saasApp.route('/users', usersRoutes);
      saasApp.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });

      mockKV._set('user:stduser@example.com', {
        addedBy: 'jit',
        addedAt: '2024-01-01T00:00:00.000Z',
        role: 'user',
        accessTier: 'pending',
      });

      await saasApp.request('/users/stduser%40example.com', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionTier: 'standard' }),
      });

      // No preferences should be written
      const prefsKey = 'user-prefs:codeflare-stduser-example-com';
      expect(mockKV._store.get(prefsKey)).toBeUndefined();
    });

    it('GET /users returns role field for each user', async () => {
      const mockUsers = [
        { email: 'admin@example.com', addedBy: 'setup', addedAt: '2024-01-01', role: 'admin' as const },
        { email: 'viewer@example.com', addedBy: 'admin@example.com', addedAt: '2024-01-02', role: 'user' as const },
      ];
      mockGetAllUsers.mockResolvedValue(mockUsers);

      const app = createTestAppWithRole('admin@example.com', 'admin');
      const res = await app.request('/users');

      expect(res.status).toBe(200);
      const body = await res.json() as { users: Array<{ email: string; role: string }> };
      expect(body.users).toHaveLength(2);
      expect(body.users[0].role).toBe('admin');
      expect(body.users[1].role).toBe('user');
    });
  });

  // =========================================================================
  // CF-005: Real authMiddleware (requireActiveUser) + requireAdmin gating.
  // No pass-through mock - only the identity (authenticateRequest) is mocked,
  // so the middleware's tier gate and role check run for real.
  // =========================================================================
  describe('Real auth/admin guards - CF-005', () => {
    function createGuardApp(envOverrides: Partial<Env> = {}) {
      const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      app.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          CLOUDFLARE_API_TOKEN: 'test-api-token',
          ...envOverrides,
        } as unknown as Env;
        return next();
      });
      app.route('/users', usersRoutes);
      app.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
        }
        return c.json({ error: 'Unexpected error' }, 500);
      });
      return app;
    }

    it('admin reaches the route (200) through the real guards', async () => {
      setAuthUser({ email: 'admin@example.com', role: 'admin' });
      mockGetAllUsers.mockResolvedValue([]);

      const res = await createGuardApp().request('/users');

      expect(res.status).toBe(200);
    });

    it('non-admin is rejected by the real requireAdmin (403)', async () => {
      setAuthUser({ email: 'viewer@example.com', role: 'user' });

      const res = await createGuardApp().request('/users');

      expect(res.status).toBe(403);
    });

    it('SaaS-mode pending user is rejected by the tier gate before requireAdmin (403)', async () => {
      // pending is not an active tier → requireActiveUser returns 403 { code: 'PENDING' }
      setAuthUser({ email: 'pending@example.com', role: 'admin', accessTier: 'pending', subscriptionTier: 'pending' });

      const res = await createGuardApp({ SAAS_MODE: 'active' } as Partial<Env>).request('/users');

      expect(res.status).toBe(403);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('PENDING');
    });

    it('SaaS-mode blocked user is rejected by the tier gate (403 BLOCKED)', async () => {
      setAuthUser({ email: 'blocked@example.com', role: 'admin', accessTier: 'blocked', subscriptionTier: 'blocked' });

      const res = await createGuardApp({ SAAS_MODE: 'active' } as Partial<Env>).request('/users');

      expect(res.status).toBe(403);
      const body = await res.json() as { code?: string };
      expect(body.code).toBe('BLOCKED');
    });

    it('non-SaaS pending admin passes the tier gate (200) - gate is SaaS-only', async () => {
      // When SAAS_MODE is unset, requireActiveUser behaves like requireIdentity:
      // no tier gate, so a pending admin reaches the route.
      setAuthUser({ email: 'admin@example.com', role: 'admin', accessTier: 'pending', subscriptionTier: 'pending' });
      mockGetAllUsers.mockResolvedValue([]);

      const res = await createGuardApp().request('/users');

      expect(res.status).toBe(200);
    });
  });
});
