import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import type { Env } from '../../types';

vi.mock('../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
}));
vi.mock('../../lib/r2-migration', () => ({
  planRegimeReconcile: vi.fn(async () => ({ state: {}, migrating: false, pending: false })),
  advanceMigration: vi.fn(),
}));
vi.mock('../../lib/managed-release-active', () => ({
  getActiveManagedRelease: vi.fn(async () => null),
  hasPendingManagedReconciliation: vi.fn(() => false),
}));

import lifecycleRoutes from '../../routes/session/lifecycle';

describe('REQ-SESSION-010 AC7: ancillary session polling owner', () => {
  let kv: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    kv = createMockKV();
    kv._set('storage-stats:test-bucket', {
      totalFiles: 4,
      totalFolders: 2,
      totalSizeBytes: 1024,
    });
  });

  function app() {
    return createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV: kv,
      envOverrides: { SAAS_MODE: 'false' } as Partial<Env>,
    });
  }

  it('returns cached storage and entitlement state outside the D1 hot path', async () => {
    const response = await app().request('/sessions/ancillary-status');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      maxSessions: expect.any(Number),
      storageStats: { totalFiles: 4, totalFolders: 2, totalSizeBytes: 1024 },
      bucketMigrating: false,
      bucketMigrationPending: false,
    });
    expect(kv.get).toHaveBeenCalledWith('storage-stats:test-bucket', 'json');
  });

  it('is explicitly non-cacheable', async () => {
    const response = await app().request('/sessions/ancillary-status');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });
});
