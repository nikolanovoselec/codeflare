import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockR2Config } from '../helpers/mock-factories';
import { createTestApp } from '../helpers/test-app';

const testState = vi.hoisted(() => ({
  createBucketResult: { success: true, created: false } as { success: boolean; created?: boolean; error?: string },
  seedResult: { written: ['Getting-Started.md', 'Documentation/README.md'], skipped: [] as string[] },
}));

vi.mock('../../lib/r2-admin', () => ({
  createBucketIfNotExists: vi.fn(async () => testState.createBucketResult),
}));

vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: vi.fn(async () => testState.seedResult),
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn(async () => createMockR2Config()),
}));

import { createBucketIfNotExists } from '../../lib/r2-admin';
import { seedGettingStartedDocs } from '../../lib/r2-seed';
import seedRoutes from '../../routes/storage/seed';

describe('Storage Seed Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.createBucketResult = { success: true, created: false };
    testState.seedResult = { written: ['Getting-Started.md', 'Documentation/README.md'], skipped: [] };
  });

  function createApp(bucketName = 'test-bucket') {
    return createTestApp({
      routes: [{ path: '/seed', handler: seedRoutes }],
      mockKV: {} as KVNamespace,
      bucketName,
      envOverrides: {
        CLOUDFLARE_API_TOKEN: 'test-token',
        R2_ACCESS_KEY_ID: 'test-key',
        R2_SECRET_ACCESS_KEY: 'test-secret',
      },
    });
  }

  it('recreates getting-started docs with overwrite enabled', async () => {
    const app = createApp('my-bucket');

    const res = await app.request('/seed/getting-started', { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      success: boolean;
      bucketCreated: boolean;
      written: string[];
      skipped: string[];
    };

    expect(body.success).toBe(true);
    expect(body.bucketCreated).toBe(false);
    expect(body.written).toEqual(['Getting-Started.md', 'Documentation/README.md']);
    expect(createBucketIfNotExists).toHaveBeenCalledWith('test-account', 'test-token', 'my-bucket');
    expect(seedGettingStartedDocs).toHaveBeenCalledWith(
      expect.any(Object),
      'my-bucket',
      'https://test.r2.cloudflarestorage.com',
      { overwrite: true }
    );
  });

  it('returns container error when bucket creation fails', async () => {
    testState.createBucketResult = { success: false, error: 'denied' };
    const app = createApp('my-bucket');

    const res = await app.request('/seed/getting-started', { method: 'POST' });
    expect(res.status).toBe(500);

    const body = await res.json() as { code?: string };
    expect(body.code).toBe('CONTAINER_ERROR');
  });
});
