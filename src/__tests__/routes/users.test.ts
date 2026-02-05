import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';

// Track the current test user email
let currentTestUserEmail = 'admin@example.com';

// Mock the auth middleware to simply set user context without CF Access validation
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: currentTestUserEmail, authenticated: true, role: 'admin' });
    c.set('bucketName', `codeflare-test`);
    return next();
  }),
  requireAdmin: vi.fn(async (c: any, next: any) => {
    // In tests, simply pass through (user is always admin in test setup)
    return next();
  }),
}));

// Mock access-policy module
vi.mock('../../lib/access-policy', () => ({
  getAllUsers: vi.fn(),
  syncAccessPolicy: vi.fn(),
}));

// Mock access module for getBucketName
vi.mock('../../lib/access', () => ({
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

import usersRoutes from '../../routes/users';
import { getAllUsers, syncAccessPolicy } from '../../lib/access-policy';
import { authMiddleware, requireAdmin } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';

import { createMockKV } from '../helpers/mock-kv';

const mockGetAllUsers = getAllUsers as ReturnType<typeof vi.fn>;
const mockSyncAccessPolicy = syncAccessPolicy as ReturnType<typeof vi.fn>;
const mockAuthMiddleware = authMiddleware as ReturnType<typeof vi.fn>;
const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;

// Mock global fetch for CF API calls
const mockFetch = vi.fn();

describe('Users Routes', () => {
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
  });

  function createTestApp(userEmail = 'admin@example.com') {
    // Update the auth middleware mock to use this user
    currentTestUserEmail = userEmail;
    mockAuthMiddleware.mockImplementation(async (c: any, next: any) => {
      c.set('user', { email: userEmail, authenticated: true, role: 'admin' });
      c.set('bucketName', `codeflare-test`);
      return next();
    });

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

  describe('POST /users', () => {
    it('creates KV entry with addedBy and addedAt', async () => {
      const app = createTestApp('admin@example.com');

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'newuser@example.com' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; email: string; role: string };
      expect(body.success).toBe(true);
      expect(body.email).toBe('newuser@example.com');
      expect(body.role).toBe('user');

      // Verify KV put was called with correct key and data
      expect(mockKV.put).toHaveBeenCalledWith(
        'user:newuser@example.com',
        expect.stringContaining('"addedBy":"admin@example.com"'),
      );
      const putCall = mockKV.put.mock.calls.find(
        (call: string[]) => call[0] === 'user:newuser@example.com',
      );
      const stored = JSON.parse(putCall![1]);
      expect(stored.addedBy).toBe('admin@example.com');
      expect(stored.addedAt).toBe('2024-01-15T10:00:00.000Z');
      expect(stored.role).toBe('user');
    });

    it('returns 400 for missing email', async () => {
      const app = createTestApp();

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/email/i);
    });

    it('returns 400 for invalid email (no @)', async () => {
      const app = createTestApp();

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'notanemail' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/email/i);
    });

    it('returns 400 for email with double @@ (regex validation)', async () => {
      const app = createTestApp();

      for (const badEmail of ['@@', '@b', 'a@', 'a @b.com', ' @b.c']) {
        const res = await app.request('/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: badEmail }),
        });

        expect(res.status).toBe(400);
        const body = await res.json() as { error: string };
        expect(body.error).toMatch(/email/i);
      }
    });

    it('returns 400 for duplicate email', async () => {
      const app = createTestApp();

      // Pre-populate KV with existing user
      mockKV._set('user:existing@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'existing@example.com' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json() as { error: string };
      expect(body.error).toMatch(/already in allowlist/i);
    });

    it('returns 409 with USER_EXISTS code for duplicate user (AppError.toJSON contract)', async () => {
      const app = createTestApp();

      mockKV._set('user:dupe@example.com', { addedBy: 'admin@example.com', addedAt: '2024-01-01T00:00:00.000Z' });

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'dupe@example.com' }),
      });

      expect(res.status).toBe(409);
      const body = await res.json() as { error: string; code: string };
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code', 'USER_EXISTS');
    });

    it('attempts to sync CF Access policy after adding', async () => {
      const app = createTestApp();

      // Set up KV with account_id and domain for sync
      mockKV._store.set('setup:account_id', 'test-account-id');
      mockKV._store.set('setup:custom_domain', 'app.example.com');

      await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'newuser@example.com' }),
      });

      expect(mockSyncAccessPolicy).toHaveBeenCalledWith(
        'test-api-token',
        'test-account-id',
        'app.example.com',
        expect.anything(),
      );
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
      currentTestUserEmail = userEmail;
      mockAuthMiddleware.mockImplementation(async (c: any, next: any) => {
        c.set('user', { email: userEmail, authenticated: true, role });
        c.set('bucketName', `codeflare-test`);
        return next();
      });

      mockRequireAdmin.mockImplementation(async (c: any, next: any) => {
        const user = c.get('user');
        if (user?.role !== 'admin') {
          return c.json({ error: 'Access denied', code: 'FORBIDDEN' }, 403);
        }
        return next();
      });

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

    it('non-admin POST /users returns 403', async () => {
      const app = createTestAppWithRole('viewer@example.com', 'user');

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'new@example.com' }),
      });

      expect(res.status).toBe(403);
    });

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

    it('admin POST /users with role: admin stores admin role in KV', async () => {
      const app = createTestAppWithRole('admin@example.com', 'admin');

      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'newadmin@example.com', role: 'admin' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; email: string; role: string };
      expect(body.role).toBe('admin');

      const putCall = mockKV.put.mock.calls.find(
        (call: string[]) => call[0] === 'user:newadmin@example.com',
      );
      expect(putCall).toBeDefined();
      const stored = JSON.parse(putCall![1]);
      expect(stored.role).toBe('admin');
    });

    it('error responses follow AppError.toJSON() shape', async () => {
      const app = createTestAppWithRole('admin@example.com', 'admin');

      // Validation error (missing email)
      const res = await app.request('/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code', 'VALIDATION_ERROR');
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
});
