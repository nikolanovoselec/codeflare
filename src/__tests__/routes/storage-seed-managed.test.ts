import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedRelease } from '../../lib/remote-curation';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';

const state = vi.hoisted(() => ({
  active: null as null | { digest: string; release: ManagedRelease },
  activeError: null as Error | null,
  cached: null as null | ManagedRelease,
}));
const reconcile = vi.hoisted(() => vi.fn(async () => ({ written: ['.claude/company.md'], skipped: [], deleted: [], warnings: [] })));
const reseedContext = vi.hoisted(() => vi.fn(async () => ({ written: [], skipped: [] })));
const createBucket = vi.hoisted(() => vi.fn(async () => ({ success: true, created: false })));

vi.mock('../../lib/managed-release-active', () => ({
  getActiveVerifiedManagedRelease: vi.fn(async () => {
    if (state.activeError) throw state.activeError;
    return state.active;
  }),
  getVerifiedManagedReleaseByDigest: vi.fn(async () => state.cached),
}));
vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: vi.fn(),
  reconcileAgentConfigs: reconcile,
  reseedContextModePlugin: reseedContext,
}));
vi.mock('../../lib/r2-admin', () => ({ createBucketIfNotExists: createBucket }));
vi.mock('../../lib/r2-config', () => ({ getR2Config: vi.fn(async () => ({ accountId: 'account', endpoint: 'https://r2.example.com' })) }));
vi.mock('../../lib/r2-migration', () => ({
  isBucketMigrating: vi.fn(async () => false),
  resolveBucketSseOnEnsure: vi.fn(async () => false),
}));
vi.mock('../../lib/agent-seed.generated', () => ({ PRESEED_CONTENT_HASH: 'baked-hash' }));

import routes from '../../routes/storage/seed';

const release: ManagedRelease = {
  seedAbi: 1,
  sequence: 9,
  source: { repositoryId: 7, commitSha: 'a'.repeat(40), releaseTag: 'v9', compilerCommit: 'b'.repeat(40) },
  runtimeDependencyHash: 'c'.repeat(64),
  documents: [{ key: '.claude/company.md', contentType: 'text/markdown; charset=utf-8', content: '# Company', modes: ['advanced'] }],
  retiredPaths: [],
  managedExtensions: [],
};

function appFor(mockKV: ReturnType<typeof createMockKV>) {
  return createTestApp({
    routes: [{ path: '/seed', handler: routes }],
    mockKV,
    bucketName: 'user-bucket',
    user: { email: 'user@example.com', authenticated: true, accessTier: 'unlimited' as never },
    envOverrides: { R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', CLOUDFLARE_API_TOKEN: 'token' },
  });
}

describe('managed storage reconcile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.active = { digest: 'd'.repeat(64), release };
    state.activeError = null;
    state.cached = null;
  });

  it('REQ-STOR-020 AC3: successful managed reconcile stamps applied state last', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced', workspaceSyncEnabled: true });
    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced', expect.objectContaining({
      managedRelease: { digest: 'd'.repeat(64), release },
    }));
    expect(reseedContext).toHaveBeenCalled();
    const applied = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(applied.managedEnvironmentApplied).toMatchObject({ digest: 'd'.repeat(64), sequence: 9, mode: 'advanced' });
    expect(Date.parse(applied.managedEnvironmentApplied.appliedAt)).not.toBeNaN();
    const finalPut = kv.put.mock.calls.at(-1)!;
    expect(finalPut[0]).toBe('user-prefs:user-bucket');
  });

  it('does not stamp applied state when context-mode reconciliation fails', async () => {
    reseedContext.mockRejectedValueOnce(new Error('context failed'));
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(500);
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toBeUndefined();
  });

  it('returns a typed 409 before bucket creation or R2 writes when any session is running', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    kv._set('session:user-bucket:running123456789', { id: 'running123456789', status: 'running' }, { s: 'r' });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });
    const body = await response.json() as { code: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe('MANAGED_ENVIRONMENT_UPDATE_PENDING');
    expect(createBucket).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('does not substitute baked content when enabled curation has no verified active release', async () => {
    state.active = null;
    state.activeError = new Error('verified active release unavailable');
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: { digest: '1'.repeat(64), sequence: 8, mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z' },
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(reconcile).not.toHaveBeenCalled();
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied?.digest).toBe('1'.repeat(64));
    expect(preferences.lastPreseedHash).toBeUndefined();
  });

  it('REQ-STOR-020 AC6: disable converges to baked state without deleting personal intent', async () => {
    state.active = null;
    state.cached = { ...release, sequence: 8 };
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      workspaceSyncEnabled: true,
      managedEnvironmentApplied: { digest: '1'.repeat(64), sequence: 8, mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z' },
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced', expect.objectContaining({
      managedRelease: null,
      priorManagedRelease: expect.objectContaining({ digest: '1'.repeat(64), mode: 'advanced' }),
    }));
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied).toBeUndefined();
    expect(preferences.workspaceSyncEnabled).toBe(true);
    expect(preferences.lastPreseedHash).toBe('baked-hash');
  });
});
