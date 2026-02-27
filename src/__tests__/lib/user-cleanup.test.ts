import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';

// Mock dependencies before imports
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

const mockDeleteScopedR2Token = vi.hoisted(() => vi.fn());
vi.mock('../../lib/r2-admin', () => ({
  deleteScopedR2Token: mockDeleteScopedR2Token,
}));

const containerState = vi.hoisted(() => ({
  destroy: vi.fn(),
}));
vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => containerState),
}));

import { cleanupUserData } from '../../lib/user-cleanup';
import type { Env } from '../../types';
import { getContainer } from '@cloudflare/containers';

const mockGetContainer = vi.mocked(getContainer);
const mockContainerDestroy = containerState.destroy;
const mockFetch = vi.fn();

describe('cleanupUserData', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  const originalFetch = globalThis.fetch;

  const email = 'target@example.com';
  const bucketName = 'codeflare-target-example-com';

  function createEnv(overrides?: Partial<Env>): Env {
    return {
      KV: mockKV as unknown as KVNamespace,
      CONTAINER: {} as unknown as Env['CONTAINER'],
      CLOUDFLARE_API_TOKEN: 'test-api-token',
      CLOUDFLARE_WORKER_NAME: undefined,
      ...overrides,
    } as unknown as Env;
  }

  beforeEach(() => {
    mockKV = createMockKV();
    globalThis.fetch = mockFetch;
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    mockDeleteScopedR2Token.mockResolvedValue(undefined);
    mockContainerDestroy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.clearAllMocks();
  });

  it('destroys active sessions and their containers', async () => {
    // Set up two sessions in KV
    mockKV._set(`session:${bucketName}:abcdef0123456789`, { id: 'abcdef0123456789', name: 'Session 1', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._set(`session:${bucketName}:fedcba9876543210`, { id: 'fedcba9876543210', name: 'Session 2', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._store.set('setup:account_id', 'test-account-id');

    const result = await cleanupUserData(email, createEnv());

    expect(result.deletedSessions).toBe(2);
    // Should have called getContainer + destroy for each session
    expect(mockGetContainer).toHaveBeenCalledTimes(2);
    expect(mockContainerDestroy).toHaveBeenCalledTimes(2);
    // Session KV entries should be deleted
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:abcdef0123456789`);
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:fedcba9876543210`);
  });

  it('deletes user:{email} from KV', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    await cleanupUserData(email, createEnv());

    expect(mockKV.delete).toHaveBeenCalledWith(`user:${email}`);
  });

  it('reads r2token, calls deleteScopedR2Token, deletes r2token KV entry', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`r2token:${email}`, {
      accessKeyId: 'ak-123',
      secretAccessKey: 'sk-456',
      tokenId: 'token-id-789',
      bucketName,
      createdAt: '2024-01-01T00:00:00Z',
    });

    const result = await cleanupUserData(email, createEnv());

    expect(mockDeleteScopedR2Token).toHaveBeenCalledWith(
      'test-account-id',
      'test-api-token',
      'token-id-789',
    );
    expect(result.tokenDeleted).toBe(true);
    expect(mockKV.delete).toHaveBeenCalledWith(`r2token:${email}`);
  });

  it('empties R2 bucket via fetch and deletes bucket via CF API', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`r2token:${email}`, {
      accessKeyId: 'ak-123',
      secretAccessKey: 'sk-456',
      tokenId: 'token-id-789',
      bucketName,
      createdAt: '2024-01-01T00:00:00Z',
    });

    // Mock S3 list + bucket delete
    mockFetch
      .mockResolvedValueOnce(new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await cleanupUserData(email, createEnv());

    expect(result.bucketDeleted).toBe(true);
    // Should have called fetch for bucket deletion (CF API DELETE)
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/r2/buckets/${bucketName}`),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns CleanupResult with correct counts', async () => {
    mockKV._set(`session:${bucketName}:abcdef0123456789`, { id: 'abcdef0123456789', name: 'S1', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._store.set('setup:account_id', 'test-account-id');
    mockKV._set(`r2token:${email}`, {
      tokenId: 'tok-1',
      bucketName,
      createdAt: '2024-01-01T00:00:00Z',
    });

    mockFetch
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const result = await cleanupUserData(email, createEnv());

    expect(result).toEqual({
      deletedSessions: 1,
      bucketDeleted: true,
      tokenDeleted: true,
    });
  });

  it('gracefully handles missing sessions (no sessions to clean)', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    const result = await cleanupUserData(email, createEnv());

    expect(result.deletedSessions).toBe(0);
    expect(mockGetContainer).not.toHaveBeenCalled();
  });

  it('gracefully handles missing R2 token (no token stored)', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    const result = await cleanupUserData(email, createEnv());

    expect(result.tokenDeleted).toBe(false);
    expect(mockDeleteScopedR2Token).not.toHaveBeenCalled();
    // r2token KV entry should still be deleted (cleanup)
    expect(mockKV.delete).toHaveBeenCalledWith(`r2token:${email}`);
  });

  it('gracefully handles R2 bucket deletion failure (logged, not thrown)', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    // Bucket delete returns error
    mockFetch.mockResolvedValueOnce(new Response('BucketNotEmpty', { status: 409 }));

    const result = await cleanupUserData(email, createEnv());

    expect(result.bucketDeleted).toBe(false);
    // Should NOT throw
  });

  it('gracefully handles container destroy failure (continues with other sessions)', async () => {
    mockKV._set(`session:${bucketName}:abcdef0123456789`, { id: 'abcdef0123456789', name: 'S1', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._set(`session:${bucketName}:fedcba9876543210`, { id: 'fedcba9876543210', name: 'S2', userId: email, createdAt: '', lastAccessedAt: '' });
    mockKV._store.set('setup:account_id', 'test-account-id');

    // First container destroy fails, second succeeds
    mockContainerDestroy
      .mockRejectedValueOnce(new Error('Container not found'))
      .mockResolvedValueOnce(undefined);

    const result = await cleanupUserData(email, createEnv());

    // Both sessions should still be cleaned from KV
    expect(result.deletedSessions).toBe(2);
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:abcdef0123456789`);
    expect(mockKV.delete).toHaveBeenCalledWith(`session:${bucketName}:fedcba9876543210`);
  });

  it('skips R2 bucket deletion when accountId is missing', async () => {
    // No setup:account_id in KV

    const result = await cleanupUserData(email, createEnv());

    expect(result.bucketDeleted).toBe(false);
    // No fetch calls for bucket deletion
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips R2 bucket deletion when CLOUDFLARE_API_TOKEN is missing', async () => {
    mockKV._store.set('setup:account_id', 'test-account-id');

    const result = await cleanupUserData(email, createEnv({ CLOUDFLARE_API_TOKEN: '' } as Partial<Env>));

    expect(result.bucketDeleted).toBe(false);
  });
});
