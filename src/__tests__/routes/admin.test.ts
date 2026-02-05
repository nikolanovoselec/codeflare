import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';

// Mock auth middleware
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('user', { email: 'admin@example.com', authenticated: true, role: 'admin' });
    c.set('bucketName', 'codeflare-test');
    return next();
  }),
  requireAdmin: vi.fn(async (c: any, next: any) => {
    const user = c.get('user');
    if (user?.role !== 'admin') {
      return c.json({ error: 'Access denied', code: 'FORBIDDEN' }, 403);
    }
    return next();
  }),
}));

// Mock rate limiter to pass through
vi.mock('../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: any, next: any) => next()),
}));

import adminRoutes from '../../routes/admin';
import { authMiddleware, requireAdmin } from '../../middleware/auth';

const mockAuthMiddleware = authMiddleware as ReturnType<typeof vi.fn>;
const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;

describe('Admin Routes', () => {
  let mockDestroy: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;
  let mockIdFromString: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockDestroy = vi.fn().mockResolvedValue(undefined);
    mockGet = vi.fn().mockReturnValue({ destroy: mockDestroy });
    mockIdFromString = vi.fn().mockReturnValue({ toString: () => 'mock-do-id' });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createTestApp(role: 'admin' | 'user' = 'admin') {
    mockAuthMiddleware.mockImplementation(async (c: any, next: any) => {
      c.set('user', { email: 'admin@example.com', authenticated: true, role });
      c.set('bucketName', 'codeflare-test');
      return next();
    });

    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    // Inject mock env
    app.use('*', async (c, next) => {
      c.env = {
        CONTAINER: {
          idFromString: mockIdFromString,
          get: mockGet,
        },
      } as unknown as Env;
      return next();
    });

    app.route('/admin', adminRoutes);

    // Global error handler matching index.ts
    app.onError((err, c) => {
      if (err instanceof AppError) {
        return c.json(err.toJSON(), err.statusCode as 400 | 401 | 403 | 404 | 500);
      }
      return c.json({ error: 'Unexpected error' }, 500);
    });

    return app;
  }

  describe('POST /admin/destroy-by-id', () => {
    it('destroys container with valid 64-char hex DO ID', async () => {
      const validDoId = 'a'.repeat(64);
      const app = createTestApp();

      const res = await app.request('/admin/destroy-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doId: validDoId }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; doId: string };
      expect(body.success).toBe(true);
      expect(body.doId).toBe(validDoId);
      expect(mockIdFromString).toHaveBeenCalledWith(validDoId);
      expect(mockGet).toHaveBeenCalled();
      expect(mockDestroy).toHaveBeenCalled();
    });

    it('returns 400 for invalid DO ID format (too short)', async () => {
      const app = createTestApp();

      const res = await app.request('/admin/destroy-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doId: 'tooshort' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 for invalid DO ID format (non-hex chars)', async () => {
      const app = createTestApp();

      const res = await app.request('/admin/destroy-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doId: 'g'.repeat(64) }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for missing doId', async () => {
      const app = createTestApp();

      const res = await app.request('/admin/destroy-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('uses idFromString (not idFromName) for safe DO reference', async () => {
      const validDoId = 'b'.repeat(64);
      const app = createTestApp();

      await app.request('/admin/destroy-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doId: validDoId }),
      });

      // Verify idFromString was used (safe: references existing DO)
      expect(mockIdFromString).toHaveBeenCalledWith(validDoId);
    });

    it('accepts uppercase hex in DO ID', async () => {
      const validDoId = 'A'.repeat(32) + 'f'.repeat(32);
      const app = createTestApp();

      const res = await app.request('/admin/destroy-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doId: validDoId }),
      });

      expect(res.status).toBe(200);
    });

    it('returns 500 when container.destroy() throws', async () => {
      mockDestroy.mockRejectedValue(new Error('DO not found'));
      const app = createTestApp();

      const res = await app.request('/admin/destroy-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doId: 'c'.repeat(64) }),
      });

      expect(res.status).toBe(500);
    });
  });

  describe('Admin role gating', () => {
    it('non-admin user gets 403', async () => {
      const app = createTestApp('user');

      const res = await app.request('/admin/destroy-by-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doId: 'd'.repeat(64) }),
      });

      expect(res.status).toBe(403);
    });
  });
});
