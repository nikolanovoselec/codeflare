/**
 * Admin tier management route tests — REQ-SUB-009.
 *
 * Covers:
 *   AC1: PUT /api/admin/tiers accepts a tier array and writes to tiers:config KV
 *   AC5: Schema includes maxStorageBytes so it persists on save
 *   AC6: requireAdmin middleware protects tier management endpoints
 *
 * AC3+4 (getTierConfig KV-first/merge) are covered in
 * src/__tests__/lib/subscription-req-sub-gaps.test.ts.
 *
 * Deleting routes/admin/tiers.ts or removing its PUT handler will break these tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';
import { getDefaultTiers, resetTierConfigCache } from '../../lib/subscription';

// ---------------------------------------------------------------------------
// Auth middleware mock — admin by default; toggle for non-admin tests
// ---------------------------------------------------------------------------
let mockUserRole = 'admin';
let mockAuthShouldReject = false;

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    if (mockAuthShouldReject) {
      throw new AppError('AUTH_ERROR', 401, 'Not authenticated');
    }
    c.set('user', {
      email: 'admin@example.com',
      authenticated: true,
      role: mockUserRole,
      subscriptionTier: 'unlimited',
    });
    c.set('bucketName', 'codeflare-admin');
    return next();
  }),
  requireAdmin: vi.fn(async (c: any, next: any) => {
    const user = c.get('user');
    if (!user || user.role !== 'admin') {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return next();
  }),
}));

import adminTiersRoute from '../../routes/admin/tiers';

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------
function createApp(envOverrides: Partial<Env> = {}) {
  resetTierConfigCache();
  const mockKV = createMockKV();
  const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

  app.use('*', async (c, next) => {
    c.env = {
      KV: mockKV as unknown as KVNamespace,
      ...envOverrides,
    } as Env;
    return next();
  });

  app.route('/admin/tiers', adminTiersRoute);

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
    }
    return c.json({ error: String(err) }, 500);
  });

  return { app, mockKV };
}

/** Build a valid 8-tier array (all required fields) for PUT requests. */
function buildValidTiers() {
  return getDefaultTiers();
}

// ---------------------------------------------------------------------------
// GET /admin/tiers
// ---------------------------------------------------------------------------
describe('GET /admin/tiers — REQ-SUB-009', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserRole = 'admin';
    mockAuthShouldReject = false;
  });

  it('REQ-SUB-009 AC3: returns current tier config (defaults when KV is empty)', async () => {
    const { app } = createApp();
    const res = await app.request('/admin/tiers');
    expect(res.status).toBe(200);
    const body = await res.json() as { tiers: unknown[] };
    expect(body.tiers).toHaveLength(8);
  });

  it('REQ-SUB-009 AC6: returns 403 when user is not admin', async () => {
    mockUserRole = 'user';
    const { app } = createApp();
    const res = await app.request('/admin/tiers');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// PUT /admin/tiers
// ---------------------------------------------------------------------------
describe('PUT /admin/tiers — REQ-SUB-009', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserRole = 'admin';
    mockAuthShouldReject = false;
  });

  it('REQ-SUB-009 AC1: writes accepted tier array to tiers:config KV key', async () => {
    const { app, mockKV } = createApp();
    const tiers = buildValidTiers();

    const res = await app.request('/admin/tiers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiers),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    // KV must have been written with the correct key
    const stored = await mockKV.get('tiers:config', 'json') as unknown[];
    expect(stored).toHaveLength(8);
  });

  it('REQ-SUB-009 AC1: stored tier config contains the submitted values', async () => {
    const { app, mockKV } = createApp();
    const tiers = buildValidTiers().map((t) =>
      t.id === 'free' ? { ...t, monthlySeconds: 7200 } : t
    );

    await app.request('/admin/tiers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiers),
    });

    const stored = await mockKV.get('tiers:config', 'json') as Array<{ id: string; monthlySeconds: number }>;
    expect(stored.find((t) => t.id === 'free')!.monthlySeconds).toBe(7200);
  });

  it('REQ-SUB-009 AC5: maxStorageBytes field is accepted and persisted by the schema', async () => {
    const { app, mockKV } = createApp();
    const tiers = buildValidTiers().map((t) =>
      t.id === 'advanced' ? { ...t, maxStorageBytes: 2_000_000_000 } : t
    );

    const res = await app.request('/admin/tiers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiers),
    });

    expect(res.status).toBe(200);

    const stored = await mockKV.get('tiers:config', 'json') as Array<{ id: string; maxStorageBytes: number }>;
    expect(stored.find((t) => t.id === 'advanced')!.maxStorageBytes).toBe(2_000_000_000);
  });

  it('REQ-SUB-009 AC5: null maxStorageBytes (unlimited) is accepted and persisted', async () => {
    const { app, mockKV } = createApp();
    const tiers = buildValidTiers().map((t) =>
      t.id === 'unlimited' ? { ...t, maxStorageBytes: null } : t
    );

    const res = await app.request('/admin/tiers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiers),
    });

    expect(res.status).toBe(200);

    const stored = await mockKV.get('tiers:config', 'json') as Array<{ id: string; maxStorageBytes: null }>;
    expect(stored.find((t) => t.id === 'unlimited')!.maxStorageBytes).toBeNull();
  });

  it('REQ-SUB-009 AC6: returns 403 when user is not admin', async () => {
    mockUserRole = 'user';
    const { app } = createApp();
    const tiers = buildValidTiers();

    const res = await app.request('/admin/tiers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiers),
    });

    expect(res.status).toBe(403);
  });

  it('REQ-SUB-009 AC1: rejects array with wrong number of tiers', async () => {
    const { app } = createApp();
    const tiers = buildValidTiers().slice(0, 7); // only 7

    const res = await app.request('/admin/tiers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiers),
    });

    expect(res.status).toBe(400);
  });

  it('REQ-SUB-009 AC1: rejects payload with invalid tier IDs', async () => {
    const { app } = createApp();
    const tiers = buildValidTiers().map((t, i) =>
      i === 0 ? { ...t, id: 'super-tier' } : t
    );

    const res = await app.request('/admin/tiers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiers),
    });

    expect(res.status).toBe(400);
  });

  it('REQ-SUB-009 AC1: rejects non-array body', async () => {
    const { app } = createApp();

    const res = await app.request('/admin/tiers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'standard' }),
    });

    expect(res.status).toBe(400);
  });

  it('REQ-SUB-009 AC1: rejects tier with negative monthlySeconds', async () => {
    const { app } = createApp();
    const tiers = buildValidTiers().map((t) =>
      t.id === 'free' ? { ...t, monthlySeconds: -1 } : t
    );

    const res = await app.request('/admin/tiers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tiers),
    });

    expect(res.status).toBe(400);
  });
});
