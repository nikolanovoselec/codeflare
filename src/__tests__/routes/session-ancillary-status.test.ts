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
vi.mock('../../lib/managed-release-active', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/managed-release-active')>(),
  getActiveManagedRelease: vi.fn(async () => null),
}));
vi.mock('../../lib/session-helpers', () => ({
  hasOwningSessionContainer: vi.fn(async () => false),
}));

import lifecycleRoutes from '../../routes/session/lifecycle';
import { hasOwningSessionContainer } from '../../lib/session-helpers';
import { getActiveManagedRelease } from '../../lib/managed-release-active';
import { getManagedEnvironmentStateKey, SETUP_KEYS } from '../../lib/kv-keys';

describe('REQ-SESSION-010 AC7: ancillary session polling owner', () => {
  let kv: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    vi.mocked(hasOwningSessionContainer).mockResolvedValue(false);
    vi.mocked(getActiveManagedRelease).mockResolvedValue(null);
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

  it.each([true, false])('REQ-STOR-023 AC4: journal-only reconciliation remains visible with bucket ownership %s', async (hasOwner) => {
    vi.mocked(hasOwningSessionContainer).mockResolvedValue(hasOwner);
    const preferences = {
      managedEnvironmentReconciliation: {
        targets: [{ digest: 'a'.repeat(64), sequence: 1, mode: 'default' }],
      },
    };
    kv._set('user-prefs:test-bucket', preferences);

    const response = await app().request('/sessions/ancillary-status');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      managedReleaseStatus: hasOwner ? 'update_pending' : 'upgrading',
      preseedNeedsUpgrade: !hasOwner,
    });
    // Observing an interrupted update must not publish an applied stamp or
    // discard the retry journal, regardless of current session ownership.
    expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
  });

  it('REQ-STOR-023 AC5: an incompatible published runtime is blocked, not upgrading, without scheduling reconciliation', async () => {
    vi.mocked(getActiveManagedRelease).mockRejectedValue(new Error('No compatible verified active release'));
    const config = {
      schemaVersion: 1, enabled: true, repository: 'acme/curation', repositoryId: 123456,
      publicKeyHex: 'ab'.repeat(32), publicKeyFingerprint: '1'.repeat(16),
      configFingerprint: 'f'.repeat(64), cacheBucketName: 'managed-cache', resourcePolicy: 'exclusive',
    };
    kv._set(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, config);
    kv._set(getManagedEnvironmentStateKey(config.configFingerprint), {
      schemaVersion: 1,
      active: {
        schemaVersion: 1, seedAbi: 1, sequence: 154, digest: 'd'.repeat(64),
        repositoryId: 123456, releaseId: 1540, releaseTag: 'seed-v154', sourceCommit: 'a'.repeat(40),
        runtimeDependencyHash: '0'.repeat(64), activatedAt: '2026-10-31T19:39:24.000Z',
      },
    });

    const response = await app().request('/sessions/ancillary-status');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      managedReleaseStatus: 'update_pending',
      managedReleaseBlockedReason: 'runtime_incompatible',
      preseedNeedsUpgrade: false,
    });
  });

  it('REQ-STOR-023 AC5: an unavailable descriptor does not invent a runtime incompatibility', async () => {
    vi.mocked(getActiveManagedRelease).mockRejectedValue(new Error('Snapshot unavailable'));
    const response = await app().request('/sessions/ancillary-status');
    const body = await response.json();
    expect(body).toMatchObject({ managedReleaseStatus: 'update_pending', preseedNeedsUpgrade: false });
    expect(body.managedReleaseBlockedReason).toBeUndefined();
  });

  it('is explicitly non-cacheable', async () => {
    const response = await app().request('/sessions/ancillary-status');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });
});
