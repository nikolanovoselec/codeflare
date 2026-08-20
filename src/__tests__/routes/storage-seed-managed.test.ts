import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessUser, Env } from '../../types';
import { gzipBytes, parseManagedReleaseStream, type ManagedRelease } from '../../lib/remote-curation';
import {
  getActiveVerifiedManagedRelease,
  type ActiveVerifiedManagedRelease,
  type VerifiedManagedReleaseContent,
} from '../../lib/managed-release-active';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import { getManagedEnvironmentPatKey, SETUP_KEYS } from '../../lib/kv-keys';
import { managedExtensionsDocumentContent } from '../../lib/r2-seed';

const state = vi.hoisted(() => ({
  active: null as ActiveVerifiedManagedRelease | null,
  activeError: null as Error | null,
  cached: null as VerifiedManagedReleaseContent | null,
}));
const reconcile = vi.hoisted(() => vi.fn(async () => ({ written: ['.claude/company.md'], skipped: [], deleted: [], warnings: [] })));
const reseedContext = vi.hoisted(() => vi.fn(async () => ({ written: [], skipped: [] })));
const createBucket = vi.hoisted(() => vi.fn(async () => ({ success: true, created: false })));
const fetchR2 = vi.hoisted(() => vi.fn(async () => new Response('', { status: 200 })));

vi.mock('../../lib/managed-release-active', () => ({
  getActiveVerifiedManagedRelease: vi.fn(async () => {
    if (state.activeError) throw state.activeError;
    return state.active;
  }),
  getCachedManagedReleaseByDigest: vi.fn(async () => state.cached),
}));
vi.mock('../../lib/r2-seed', async () => {
  const actual = await vi.importActual<typeof import('../../lib/r2-seed')>('../../lib/r2-seed');
  return {
    ...actual,
    seedGettingStartedDocs: vi.fn(),
    reconcileAgentConfigs: reconcile,
    reseedContextModePlugin: reseedContext,
  };
});
vi.mock('../../lib/r2-admin', () => ({ createBucketIfNotExists: createBucket }));
vi.mock('../../lib/r2-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/r2-client')>()),
  createR2Client: () => ({ fetch: fetchR2 }),
  getR2Url: (endpoint: string, bucket: string, key?: string) => key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`,
}));
vi.mock('../../lib/tutorial-seed.generated', () => ({ SEEDED_DOCUMENTS: [] }));
vi.mock('../../lib/r2-config', () => ({ getR2Config: vi.fn(async () => ({ accountId: 'account', endpoint: 'https://r2.example.com' })) }));
vi.mock('../../lib/r2-migration', () => ({
  isBucketMigrating: vi.fn(async () => false),
  resolveBucketSseOnEnsure: vi.fn(async () => false),
}));
vi.mock('../../lib/agent-seed.generated', () => ({
  AGENTS_SEEDED_CONFIGS: [],
  PRESEED_CONTENT_HASH: 'baked-hash',
  RETIRED_PRESEED_KEYS: [],
}));

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

function appFor(
  mockKV: ReturnType<typeof createMockKV>,
  user: AccessUser = { email: 'user@example.com', authenticated: true, accessTier: 'unlimited' as never },
  envOverrides: Partial<Env> = {},
) {
  return createTestApp({
    routes: [{ path: '/seed', handler: routes }],
    mockKV,
    bucketName: 'user-bucket',
    user,
    envOverrides: { R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret', CLOUDFLARE_API_TOKEN: 'token', ...envOverrides },
  });
}

describe('managed storage reconcile', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const compressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(release)));
    state.active = {
      digest: 'd'.repeat(64),
      compressed,
      pointer: {
        schemaVersion: 1,
        seedAbi: 1,
        sequence: release.sequence,
        digest: 'd'.repeat(64),
        repositoryId: release.source.repositoryId,
        releaseId: 9,
        releaseTag: release.source.releaseTag,
        sourceCommit: release.source.commitSha,
        runtimeDependencyHash: release.runtimeDependencyHash,
        activatedAt: '2026-08-19T00:00:00.000Z',
      },
      release: await parseManagedReleaseStream(compressed),
    };
    state.activeError = null;
    state.cached = null;
    fetchR2.mockClear();
  });

  it('REQ-SETUP-014 AC6: configured repository credentials never enter user-bucket writes', async () => {
    const credential = 'github_pat_user_bucket_forbidden';
    const configFingerprint = 'f'.repeat(64);
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });
    kv._set(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, {
      enabled: true,
      configFingerprint,
      repository: 'acme/curation',
    });
    kv._store.set(getManagedEnvironmentPatKey(configFingerprint), credential);

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledTimes(1);

    const actual = await vi.importActual<typeof import('../../lib/r2-seed')>('../../lib/r2-seed');
    const call = reconcile.mock.calls[0] as unknown as Parameters<typeof actual.reconcileAgentConfigs>;
    await actual.reconcileAgentConfigs(...call);

    const r2Calls = fetchR2.mock.calls as unknown as Array<[string, RequestInit?]>;
    const writes = r2Calls.filter(([, init]) => init?.method === 'PUT');
    expect(writes.length).toBeGreaterThan(0);
    const serializedWrites = writes.map(([url, init]) => JSON.stringify({ url, headers: init?.headers, body: init?.body })).join('\n');
    expect(serializedWrites).not.toContain(credential);
  });

  it('REQ-STOR-024 AC1+AC4: successful managed reconcile loads cached content and stamps applied state last', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced', workspaceSyncEnabled: true });
    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(getActiveVerifiedManagedRelease).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced', expect.objectContaining({
      managedRelease: expect.objectContaining({
        digest: 'd'.repeat(64),
        compressed: expect.any(Uint8Array),
        release: expect.objectContaining({ sequence: 9 }),
      }),
    }));
    expect(reseedContext).toHaveBeenCalled();
    const applied = await kv.get('user-prefs:user-bucket', 'json') as any;
    const expectedManifestBytes = managedExtensionsDocumentContent({
      digest: state.active!.digest,
      compressed: state.active!.compressed,
      release: state.active!.release,
    });
    expect(applied.managedEnvironmentApplied).toMatchObject({
      digest: 'd'.repeat(64),
      managedExtensionsDigest: createHash('sha256').update(expectedManifestBytes).digest('hex'),
      sequence: 9,
      mode: 'advanced',
    });
    expect(Date.parse(applied.managedEnvironmentApplied.appliedAt)).not.toBeNaN();
    const finalPut = kv.put.mock.calls.at(-1)!;
    expect(finalPut[0]).toBe('user-prefs:user-bucket');
  });

  it('reconciles and stamps the entitlement-clamped mode for a downgraded SaaS user', async () => {
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', { sessionMode: 'advanced' });

    const response = await appFor(kv, {
      email: 'user@example.com',
      authenticated: true,
      subscriptionTier: 'advanced',
      billingStatus: 'canceled',
    }, { SAAS_MODE: 'active' }).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(
      expect.anything(),
      'user-bucket',
      'https://r2.example.com',
      'default',
      expect.anything(),
    );
    const applied = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(applied.managedEnvironmentApplied.mode).toBe('default');
  });

  it('REQ-STOR-024 AC4: does not stamp applied state when context-mode reconciliation fails', async () => {
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
      managedEnvironmentApplied: { digest: '1'.repeat(64), managedExtensionsDigest: '2'.repeat(64), sequence: 8, mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z' },
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(reconcile).not.toHaveBeenCalled();
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied?.digest).toBe('1'.repeat(64));
    expect(preferences.lastPreseedHash).toBeUndefined();
  });

  it('REQ-STOR-024 AC5: reconciles from current release when disposable cache history is absent', async () => {
    state.cached = null;
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: '1'.repeat(64),
        managedExtensionsDigest: '2'.repeat(64),
        sequence: 8,
        mode: 'advanced',
        appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(expect.anything(), 'user-bucket', 'https://r2.example.com', 'advanced', expect.objectContaining({
      managedRelease: expect.objectContaining({ digest: 'd'.repeat(64) }),
    }));
    const reconcileOptions = reconcile.mock.calls.at(-1)?.[4] as Record<string, unknown>;
    expect(reconcileOptions).not.toHaveProperty('priorManagedRelease');
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied.digest).toBe('d'.repeat(64));
  });

  it('REQ-STOR-022 AC4 + REQ-STOR-024 AC5: cacheless disable fails closed with applied state intact', async () => {
    state.active = null;
    state.cached = null;
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      managedEnvironmentApplied: {
        digest: '1'.repeat(64),
        managedExtensionsDigest: '2'.repeat(64),
        sequence: 8,
        mode: 'advanced',
        appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });

    const response = await appFor(kv).request('/seed/agent-configs', { method: 'POST' });

    expect(response.status).toBe(500);
    expect(reconcile).not.toHaveBeenCalled();
    const preferences = await kv.get('user-prefs:user-bucket', 'json') as any;
    expect(preferences.managedEnvironmentApplied?.digest).toBe('1'.repeat(64));
  });

  it('REQ-STOR-022 AC4+AC5+AC6: disable restores baked state and preserves personal intent', async () => {
    state.active = null;
    const prior = { ...release, sequence: 8 };
    const compressed = await gzipBytes(new TextEncoder().encode(JSON.stringify(prior)));
    state.cached = { compressed, release: await parseManagedReleaseStream(compressed) };
    const kv = createMockKV();
    kv._set('user-prefs:user-bucket', {
      sessionMode: 'advanced',
      workspaceSyncEnabled: true,
      managedEnvironmentApplied: { digest: '1'.repeat(64), managedExtensionsDigest: '2'.repeat(64), sequence: 8, mode: 'advanced', appliedAt: '2026-01-01T00:00:00.000Z' },
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
