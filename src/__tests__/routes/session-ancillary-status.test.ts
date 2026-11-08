import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import type { AccessUser, Env, UserPreferences } from '../../types';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { resetTierConfigCache } from '../../lib/subscription';
import { PRESEED_RUNTIME_DEPENDENCY_HASH } from '../../lib/agent-seed.generated';
import { PRESEED_CONTENT_HASH } from '../../lib/agent-seed.generated';

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

  function app(envOverrides: Partial<Env> = {}, user?: AccessUser) {
    return createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV: kv,
      envOverrides: { SAAS_MODE: 'false', ...envOverrides },
      ...(user && { user }),
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
    expect(body).not.toHaveProperty('managedReleaseBlockedReason');
  });

  it.each([
    ['default', true],
    [undefined, true],
    ['advanced', false],
  ] as const)('REQ-ENTERPRISE-001 AC6: ancillary polling requires enterprise Pro reconciliation for stored mode %s with current baked inputs', async (sessionMode, needsUpgrade) => {
    const preferences = {
      lastPreseedHash: PRESEED_CONTENT_HASH,
      lastPreseedProjectionIdentity: 'v1:pi',
      ...(sessionMode === undefined ? {} : { sessionMode }),
    };
    kv._set('user-prefs:test-bucket', preferences);
    const enterpriseApp = createTestApp({
      routes: [{ path: '/sessions', handler: lifecycleRoutes }],
      mockKV: kv,
      envOverrides: { SAAS_MODE: 'false', ENTERPRISE_MODE: 'active', CODING_AGENTS: 'pi' },
    });

    const response = await enterpriseApp.request('/sessions/ancillary-status');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      preseedNeedsUpgrade: needsUpgrade,
      preseedUpgradeTarget: JSON.stringify(['baked', PRESEED_CONTENT_HASH, null, 'advanced', 'v1:pi', 'mutable']),
    });
    expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
  });

  // Retained historical titles now exercise the actual ancillary owner.
  describe('managed ancillary regression coverage', () => {
    const projection = 'v1:claude-code,codex,copilot,antigravity,opencode,pi';
    const descriptor: NonNullable<Awaited<ReturnType<typeof getActiveManagedRelease>>> = {
      digest: 'd'.repeat(64), resourcePolicy: 'mutable',
      pointer: {
        schemaVersion: 1, seedAbi: 1, sequence: 4, digest: 'd'.repeat(64),
        repositoryId: 123456, releaseId: 40, releaseTag: 'seed-v4', sourceCommit: 'a'.repeat(40),
        runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH, activatedAt: '2026-10-31T19:39:24.000Z',
      },
    };
    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('../../lib/session-helpers')>('../../lib/session-helpers');
      vi.mocked(hasOwningSessionContainer).mockImplementation(actual.hasOwningSessionContainer);
      vi.mocked(getActiveManagedRelease).mockResolvedValue(descriptor);
    });
    function matchingPreferences(applied: Partial<NonNullable<UserPreferences['managedEnvironmentApplied']>> = {}): UserPreferences {
      return { sessionMode: 'default', managedEnvironmentApplied: {
        digest: 'd'.repeat(64), sequence: 4, mode: 'default', projectionIdentity: projection,
        managedExtensionsDigest: 'e'.repeat(64), appliedAt: '2026-01-01T00:00:00.000Z', ...applied,
      } };
    }
    async function observe(envOverrides: Partial<Env> = {}, user?: AccessUser) {
      const response = await app(envOverrides, user).request('/sessions/ancillary-status');
      expect(response.status).toBe(200);
      return await response.json();
    }
    function session(status: 'starting' | 'running' | 'unreachable' | 'stopping' | 'stopped') {
      return { id: 'aabbccdd11223344', name: 'Session', userId: 'test-bucket', status,
        createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z' };
    }

    it('returns preseedNeedsUpgrade true when hash missing from preferences', async () => {
      vi.mocked(getActiveManagedRelease).mockResolvedValue(null);
      kv._set('user-prefs:test-bucket', { lastPreseedHash: PRESEED_CONTENT_HASH, lastPreseedProjectionIdentity: projection });
      expect(await observe()).toMatchObject({ preseedNeedsUpgrade: false });
      const preferences = { lastPreseedProjectionIdentity: projection };
      kv._set('user-prefs:test-bucket', preferences);
      expect(await observe()).toMatchObject({ preseedNeedsUpgrade: true });
      expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
    });
    it('REQ-STOR-023 AC1+AC2: initial status compares descriptor and mode without payload bytes', async () => {
      const preferences = { sessionMode: 'default' };
      kv._set('user-prefs:test-bucket', preferences);
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true,
        preseedUpgradeTarget: JSON.stringify(['managed', 'd'.repeat(64), 4, 'default', projection, 'mutable']) });
      expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
      // Mocked discovery does not independently prove payload-I/O absence.
    });
    it('REQ-STOR-022 AC1+AC2: a running session defers mutation and reports pending status', async () => {
      const preferences = { sessionMode: 'default' };
      kv._set('user-prefs:test-bucket', preferences);
      const authority = createMockKV();
      const env = { USAGE_DB: createMockSessionD1(authority) };
      for (const status of ['starting', 'running', 'unreachable', 'stopping'] as const) {
        authority._set('session:test-bucket:aabbccdd11223344', session(status));
        expect(await observe(env)).toMatchObject({ managedReleaseStatus: 'update_pending', preseedNeedsUpgrade: false });
        expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
        expect(await authority.get('session:test-bucket:aabbccdd11223344', 'json')).toEqual(session(status));
      }
    });
    it('REQ-STOR-022: stale running metadata does not strand reconciliation after persisted stop', async () => {
      const key = 'session:test-bucket:aabbccdd11223344';
      const stale = session('running');
      kv._set(key, stale, { s: 'r' });
      const authority = createMockKV();
      authority._set(key, session('running'));
      const env = { USAGE_DB: createMockSessionD1(authority) };
      expect(await observe(env)).toMatchObject({ managedReleaseStatus: 'update_pending', preseedNeedsUpgrade: false });
      authority._set(key, session('stopped'));
      expect(await observe(env)).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true });
      expect(await kv.get(key, 'json')).toEqual(stale);
      expect(await authority.get(key, 'json')).toEqual(session('stopped'));
    });
    it('reports upgrading when a downgraded SaaS user has advanced managed content applied', async () => {
      resetTierConfigCache();
      try {
        const preferences = { ...matchingPreferences({ mode: 'advanced' }), sessionMode: 'advanced' };
        kv._set('user-prefs:test-bucket', preferences);
        expect(await observe()).toMatchObject({ managedReleaseStatus: 'current', preseedNeedsUpgrade: false });
        expect(await observe({ SAAS_MODE: 'active' }, {
          email: 'test@example.com', authenticated: true, subscriptionTier: 'advanced', billingStatus: 'canceled',
        })).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true,
          preseedUpgradeTarget: JSON.stringify(['managed', 'd'.repeat(64), 4, 'default', projection, 'mutable']) });
        expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
      } finally { resetTierConfigCache(); }
    });
    it('reports current only when release, mode, policy, and projection identity match applied state', async () => {
      vi.mocked(getActiveManagedRelease).mockResolvedValue({ ...descriptor, resourcePolicy: 'immutable' });
      kv._set('user-prefs:test-bucket', matchingPreferences({ resourcePolicy: 'immutable', managedPathsDigest: 'f'.repeat(64) }));
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'current', preseedNeedsUpgrade: false });
    });
    it.each([
      ['missing', undefined], ['selection mismatch', 'v1:pi'],
      ['schema mismatch', 'v0:claude-code,codex,copilot,antigravity,opencode,pi'],
    ])('REQ-STOR-023 AC1: matching managed release with %s projection is not current', async (_case, projectionIdentity) => {
      kv._set('user-prefs:test-bucket', matchingPreferences());
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'current', preseedNeedsUpgrade: false });
      kv._set('user-prefs:test-bucket', matchingPreferences({ projectionIdentity }));
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true });
    });
    it('REQ-STOR-023 AC1: a pre-upgrade applied stamp without a manifest digest requires reconciliation', async () => {
      kv._set('user-prefs:test-bucket', matchingPreferences());
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'current', preseedNeedsUpgrade: false });
      kv._set('user-prefs:test-bucket', matchingPreferences({ managedExtensionsDigest: undefined }));
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true });
    });
    it.each([
      ['policy changed', 'immutable', 'exclusive', 'f'.repeat(64)],
      ['protected path identity missing', 'exclusive', 'exclusive', undefined],
    ] as const)('REQ-STOR-023 AC1: reports upgrading when managed resource %s', async (_case, desiredPolicy, appliedPolicy, pathsDigest) => {
      vi.mocked(getActiveManagedRelease).mockResolvedValue({ ...descriptor, resourcePolicy: desiredPolicy });
      kv._set('user-prefs:test-bucket', matchingPreferences({ resourcePolicy: desiredPolicy, managedPathsDigest: 'f'.repeat(64) }));
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'current', preseedNeedsUpgrade: false });
      kv._set('user-prefs:test-bucket', matchingPreferences({ resourcePolicy: appliedPolicy, managedPathsDigest: pathsDigest }));
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true });
    });
    it('REQ-STOR-023 AC3: an outage rejects last-known-good state for another mode', async () => {
      const preferences = matchingPreferences();
      kv._set('user-prefs:test-bucket', preferences);
      vi.mocked(getActiveManagedRelease).mockRejectedValue(new Error('verified cache unavailable'));
      expect(await observe({ ENTERPRISE_MODE: 'active' })).toMatchObject({ managedReleaseStatus: 'update_pending', preseedNeedsUpgrade: false });
      expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
    });
    it('REQ-STOR-023 AC5: reports update pending when no compatible verified active release is available', async () => {
      const preferences = matchingPreferences();
      kv._set('user-prefs:test-bucket', preferences);
      vi.mocked(getActiveManagedRelease).mockRejectedValue(new Error('verified cache unavailable'));
      const body = await observe();
      expect(body).toMatchObject({ managedReleaseStatus: 'update_pending', preseedNeedsUpgrade: false });
      expect(body).not.toHaveProperty('managedReleaseBlockedReason');
      expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
    });
    it('REQ-STOR-023 AC4: pending target state retries even when applied identity matches active', async () => {
      kv._set('user-prefs:test-bucket', matchingPreferences());
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'current', preseedNeedsUpgrade: false });
      const preferences = { ...matchingPreferences(),
        managedEnvironmentReconciliation: { targets: [{ digest: 'c'.repeat(64), sequence: 3, mode: 'default' }] } };
      kv._set('user-prefs:test-bucket', preferences);
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true });
      expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
    });
    it('REQ-STOR-023: exposes a stable desired target for retry suppression without confusing progress with identity', async () => {
      kv._set('user-prefs:test-bucket', { sessionMode: 'default' });
      const first = await observe();
      expect(first).toMatchObject({ preseedNeedsUpgrade: true,
        preseedUpgradeTarget: JSON.stringify(['managed', 'd'.repeat(64), 4, 'default', projection, 'mutable']) });
      kv._set('managed-reconcile-progress:test-bucket', {
        schemaVersion: 1, targetDigest: 'd'.repeat(64), phase: 'finalizing', completed: 61, total: 61,
        updatedAt: '2026-08-31T12:00:00.000Z',
      });
      expect((await observe()).preseedUpgradeTarget).toBe(first.preseedUpgradeTarget);
      for (const changed of [
        { ...descriptor, digest: 'a'.repeat(64), pointer: { ...descriptor.pointer, digest: 'a'.repeat(64) } },
        { ...descriptor, pointer: { ...descriptor.pointer, sequence: 5 } },
        { ...descriptor, resourcePolicy: 'immutable' as const },
      ]) {
        vi.mocked(getActiveManagedRelease).mockResolvedValue(changed);
        expect((await observe()).preseedUpgradeTarget).not.toBe(first.preseedUpgradeTarget);
      }
      vi.mocked(getActiveManagedRelease).mockResolvedValue(descriptor);
      kv._set('user-prefs:test-bucket', { sessionMode: 'advanced' });
      expect((await observe()).preseedUpgradeTarget).not.toBe(first.preseedUpgradeTarget);
      kv._set('user-prefs:test-bucket', { sessionMode: 'default' });
      expect((await observe({ CODING_AGENTS: 'pi' })).preseedUpgradeTarget).not.toBe(first.preseedUpgradeTarget);
      vi.mocked(getActiveManagedRelease).mockResolvedValue(null);
      const baked = await observe();
      expect(baked.preseedUpgradeTarget).toBe(JSON.stringify(['baked', PRESEED_CONTENT_HASH, null, 'default', projection, 'mutable']));
      expect(baked.preseedUpgradeTarget).not.toBe(first.preseedUpgradeTarget);
      expect((await observe()).preseedUpgradeTarget).toBe(baked.preseedUpgradeTarget);
      const lifecycleOnly = await app().request('/sessions/batch-status');
      expect(lifecycleOnly.status).toBe(200);
      expect(await lifecycleOnly.json()).not.toHaveProperty('preseedUpgradeTarget');
    });
    it('REQ-STOR-036 AC2: batch status exposes only matching pending progress', async () => {
      kv._set('user-prefs:test-bucket', { sessionMode: 'default' });
      const progress = { schemaVersion: 1, targetDigest: 'c'.repeat(64), phase: 'writing', completed: 25, total: 61,
        updatedAt: '2026-08-31T12:00:00.000Z' };
      kv._set('managed-reconcile-progress:test-bucket', progress);
      const unrelated = await observe();
      expect(unrelated).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true });
      expect(unrelated).not.toHaveProperty('managedReleaseProgress');
      expect(await kv.get('managed-reconcile-progress:test-bucket', 'json')).toEqual(progress);
      kv._set('managed-reconcile-progress:test-bucket', { ...progress, targetDigest: 'd'.repeat(64) });
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true,
        managedReleaseProgress: { phase: 'writing', completed: 25, total: 61 } });
    });
    it('REQ-STOR-036 AC1: malformed progress is omitted', async () => {
      kv._set('user-prefs:test-bucket', { sessionMode: 'default' });
      kv._set('managed-reconcile-progress:test-bucket', {
        schemaVersion: 1, targetDigest: 'd'.repeat(64), phase: 'writing', completed: 62, total: 61,
        updatedAt: '2026-08-31T12:00:00.000Z',
      });
      const body = await observe();
      expect(body).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true });
      expect(body).not.toHaveProperty('managedReleaseProgress');
    });
    it('REQ-STOR-036 AC2: update-pending state omits progress', async () => {
      const authority = createMockKV();
      authority._set('session:test-bucket:aabbccdd11223344', session('running'));
      kv._set('managed-reconcile-progress:test-bucket', {
        schemaVersion: 1, targetDigest: 'd'.repeat(64), phase: 'writing', completed: 25, total: 61,
        updatedAt: '2026-08-31T12:00:00.000Z',
      });
      const body = await observe({ USAGE_DB: createMockSessionD1(authority) });
      expect(body).toMatchObject({ managedReleaseStatus: 'update_pending', preseedNeedsUpgrade: false });
      expect(body).not.toHaveProperty('managedReleaseProgress');
    });
    it('REQ-STOR-036 AC3: progress read failure cannot replace authoritative upgrading status', async () => {
      kv._set('user-prefs:test-bucket', { sessionMode: 'default' });
      const read = kv.get.getMockImplementation()!;
      kv.get.mockImplementation((key, type) => key === 'managed-reconcile-progress:test-bucket'
        ? Promise.reject(new Error('progress unavailable')) : read(key, type));
      const body = await observe();
      expect(body).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: true });
      expect(body).not.toHaveProperty('managedReleaseProgress');
    });
    it('REQ-STOR-036 AC4: applied target exposes finalizing once and clears it', async () => {
      const preferences = matchingPreferences();
      kv._set('user-prefs:test-bucket', preferences);
      kv._set('managed-reconcile-progress:test-bucket', {
        schemaVersion: 1, targetDigest: 'd'.repeat(64), phase: 'finalizing', completed: 61, total: 61,
        updatedAt: '2026-08-31T12:00:00.000Z',
      });
      expect(await observe()).toMatchObject({ managedReleaseStatus: 'upgrading', preseedNeedsUpgrade: false,
        managedReleaseProgress: { phase: 'finalizing', completed: 61, total: 61 } });
      expect(await kv.get('managed-reconcile-progress:test-bucket', 'json')).toBeNull();
      const next = await observe();
      expect(next).toMatchObject({ managedReleaseStatus: 'current', preseedNeedsUpgrade: false });
      expect(next).not.toHaveProperty('managedReleaseProgress');
      expect(await kv.get('user-prefs:test-bucket', 'json')).toEqual(preferences);
    });
  });

  it('is explicitly non-cacheable', async () => {
    const response = await app().request('/sessions/ancillary-status');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  });
});
