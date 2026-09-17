import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapOperatorSession } from '../../operators/session-bootstrap';
import type { Env } from '../../types';

const mocks = vi.hoisted(() => ({
  current: false,
  calls: [] as string[],
  authenticateRequest: vi.fn(),
  reconcile: vi.fn(),
  ensure: vi.fn(),
  credentials: vi.fn(),
  plan: vi.fn(),
  advance: vi.fn(),
}));

vi.mock('../../lib/agent-seed.generated', () => ({ PRESEED_CONTENT_HASH: 'current-seed' }));
vi.mock('../../lib/access', () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock('../../lib/kv-crypto', () => ({ getOrImportKey: vi.fn(async () => null) }));
vi.mock('../../lib/kv-keys', () => ({ getPreferencesKey: (bucket: string) => `prefs:${bucket}` }));
vi.mock('../../lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../lib/managed-release-active', () => ({
  getActiveManagedRelease: vi.fn(async () => null),
  hasPendingManagedReconciliation: vi.fn(() => false),
}));
vi.mock('../../lib/migration-containers', () => ({
  hasHealthyContainer: vi.fn(async () => false), drainContainers: vi.fn(async () => {}),
}));
vi.mock('../../lib/r2-migration', () => ({
  planRegimeReconcile: mocks.plan, advanceMigration: mocks.advance,
}));
vi.mock('../../lib/session-mode', () => ({ resolveEffectiveSessionMode: vi.fn(async () => 'advanced') }));
vi.mock('../../lib/subscription', () => ({
  getEffectiveTier: vi.fn(() => 'unlimited'), isEnterpriseMode: vi.fn(() => true),
}));
vi.mock('../../routes/container/lifecycle-init', () => ({
  ensureBucketAndSeed: mocks.ensure, setupR2Credentials: mocks.credentials,
}));
vi.mock('../../routes/storage/seed', () => ({ reconcileAgentConfigsForBootstrap: mocks.reconcile }));
vi.mock('../../../scripts/ci/coding-agent-selection-core.mjs', () => ({
  codingAgentProjectionIdentity: vi.fn(() => 'v1:pi'),
}));

const authority = { human: { subject: 'human', email: 'owner@example.test', issuer: 'https://access.example.test/',
  audiences: ['aud'], issuedAt: 1, expiresAt: Math.floor(Date.now() / 1000) + 300 }, accessJwt: 'jwt' };

function env() {
  return { CODING_AGENTS: 'pi', KV: { get: vi.fn(async () => mocks.current
    ? { lastPreseedHash: 'current-seed', lastPreseedProjectionIdentity: 'v1:pi', sessionMode: 'advanced' }
    : { lastPreseedHash: 'stale' }) } } as unknown as Env;
}

describe('REQ-OPERATOR-005: programmatic operator session bootstrap', () => {
  beforeEach(() => {
    mocks.current = false;
    mocks.calls.length = 0;
    vi.clearAllMocks();
    mocks.authenticateRequest.mockResolvedValue({ user: { email: 'owner@example.test', authenticated: true,
      subscriptionTier: 'unlimited' }, bucketName: 'owner-bucket' });
    mocks.reconcile.mockImplementation(async () => { mocks.calls.push('reconcile'); mocks.current = true; return {}; });
    mocks.plan.mockImplementation(async () => { mocks.calls.push('plan'); return {
      state: {}, migrating: false, pending: false,
    }; });
    mocks.advance.mockImplementation(async () => { mocks.calls.push('advance'); });
    mocks.ensure.mockImplementation(async () => { mocks.calls.push('ensure'); return {
      r2Config: { accountId: 'account', endpoint: 'https://account.r2.cloudflarestorage.com' }, r2SseDisabled: true,
    }; });
    mocks.credentials.mockImplementation(async () => { mocks.calls.push('credentials'); return {
      accessKeyId: 'scoped-key', secretAccessKey: 'scoped-secret', tokenId: 'token',
    }; });
  });

  it('reconciles stale bucket state before minting scoped credentials and returns complete restricted configuration', async () => {
    const result = await bootstrapOperatorSession({ env: env(), authority, ownerBucket: 'owner-bucket' });
    expect(mocks.calls).toEqual(['plan', 'reconcile', 'ensure', 'credentials']);
    expect(result.bootstrap).toEqual(expect.objectContaining({
      r2AccessKeyId: 'scoped-key', r2SecretAccessKey: 'scoped-secret', r2AccountId: 'account',
      r2Endpoint: 'https://account.r2.cloudflarestorage.com', r2SseDisabled: true,
      workspaceSyncEnabled: false, sessionMode: 'advanced', managedResourcePolicy: 'mutable',
    }));
  });

  it('advances a migrating encryption regime before reconciling stale managed state', async () => {
    let planned = 0;
    mocks.plan.mockImplementation(async () => {
      mocks.calls.push('plan');
      planned += 1;
      return { state: {}, migrating: planned === 1, pending: false };
    });

    await bootstrapOperatorSession({ env: env(), authority, ownerBucket: 'owner-bucket' });

    expect(mocks.calls).toEqual(['plan', 'advance', 'plan', 'reconcile', 'ensure', 'credentials']);
  });

  it('rejects a resolved identity or bucket mismatch before bucket mutation', async () => {
    mocks.authenticateRequest.mockResolvedValueOnce({ user: { email: 'other@example.test', authenticated: true },
      bucketName: 'owner-bucket' });
    await expect(bootstrapOperatorSession({ env: env(), authority, ownerBucket: 'owner-bucket' }))
      .rejects.toThrow(/identity mismatch/i);
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.credentials).not.toHaveBeenCalled();
  });
});
