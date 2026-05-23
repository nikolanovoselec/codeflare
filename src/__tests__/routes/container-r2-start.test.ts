/**
 * REQ-SESSION-003: R2 bucket mounted and synced on start
 * AC coverage in THIS file: AC1 (createBucketIfNotExists called on start),
 *                           AC2 (scoped R2 token obtained and injected),
 *                           AC5 (new buckets seeded with getting-started docs)
 *
 * AC3 (entrypoint initial rclone sync) and AC4 (bisync daemon + SIGUSR1)
 * are entrypoint.sh runtime behaviors. Worker (vitest-pool-workers) runtime
 * has no filesystem so the previous source-presence audits were broken.
 * Backstop: host/__tests__/entrypoint-bisync-behavior.test.js (real bash
 * harness; same code path as REQ-STOR-003 / REQ-STOR-004).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';

// Hoisted shared test state
const testState = vi.hoisted(() => ({
  container: null as {
    fetch: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    getState: ReturnType<typeof vi.fn>;
    startAndWaitForPorts: ReturnType<typeof vi.fn>;
  } | null,
  createBucketResult: { success: true, created: false } as { success: boolean; error?: string; created?: boolean },
  seedResult: { written: [], skipped: [] } as { written: string[]; skipped: string[] },
}));

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => testState.container),
}));

vi.mock('../../lib/r2-admin', () => ({
  createBucketIfNotExists: vi.fn(async () => testState.createBucketResult),
  getOrCreateScopedR2Token: vi.fn(async () => ({
    accessKeyId: 'scoped-ak',
    secretAccessKey: 'scoped-sk',
    tokenId: 'scoped-tok',
  })),
}));

vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: vi.fn(async () => testState.seedResult),
  reconcileAgentConfigs: vi.fn(async () => ({ written: [], skipped: [], deleted: [], warnings: [] })),
  reseedContextModePlugin: vi.fn(async () => ({ written: [], skipped: [] })),
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn(async () => ({ accountId: 'test-account', endpoint: 'https://test.r2.cloudflarestorage.com' })),
}));

const passThroughCB = { execute: (fn: () => Promise<unknown>) => fn(), reset: vi.fn() };
vi.mock('../../lib/circuit-breakers', () => ({
  getContainerHealthCB: () => passThroughCB,
  getContainerInternalCB: () => passThroughCB,
  getContainerSessionsCB: () => passThroughCB,
}));

vi.mock('../../lib/onboarding', () => ({ isSaasModeActive: vi.fn(() => false) }));
vi.mock('../../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: any, next: any) => next()),
}));

import lifecycleRoutes from '../../routes/container/lifecycle';
import { createBucketIfNotExists, getOrCreateScopedR2Token } from '../../lib/r2-admin';
import { seedGettingStartedDocs } from '../../lib/r2-seed';

describe('REQ-SESSION-003: R2 bucket mounted and synced on start', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  const mockExecutionCtx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };

  function makeContainer() {
    return {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ bucketName: null }), { status: 200 })
      ),
      destroy: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue({ status: 'stopped' }),
      startAndWaitForPorts: vi.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(() => {
    mockKV = createMockKV();
    testState.container = makeContainer();
    testState.createBucketResult = { success: true, created: false };
    testState.seedResult = { written: [], skipped: [] };
    mockKV._set('session:test-bucket:abcdef1234567890abcdef12', {
      id: 'abcdef1234567890abcdef12',
      name: 'Test Session',
      userId: 'test-bucket',
      status: 'stopped',
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    });
  });

  function createApp() {
    const app = createTestApp({
      routes: [{ path: '/container', handler: lifecycleRoutes }],
      mockKV,
      envOverrides: { CLOUDFLARE_API_TOKEN: 'test-token' } as Partial<Env>,
    });
    return (path: string, init?: RequestInit) => {
      const req = new Request(`http://localhost${path}`, init);
      return app.fetch(req, {} as Env, mockExecutionCtx as unknown as ExecutionContext);
    };
  }

  // AC1: POST /api/container/start creates the user's R2 bucket if it does not exist
  describe('REQ-SESSION-003 AC1: createBucketIfNotExists called on start', () => {
    it('calls createBucketIfNotExists for the user bucket', async () => {
      const fetch = createApp();
      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(createBucketIfNotExists).toHaveBeenCalledWith(
        'test-account',
        'test-token',
        'test-bucket'
      );
    });

    it('returns 500 when bucket creation fails', async () => {
      testState.createBucketResult = { success: false, error: 'Bucket creation failed' };
      const fetch = createApp();
      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });
      expect(res.status).toBe(500);
    });
  });

  // AC2: Scoped R2 API token obtained/created and injected as container env vars
  describe('REQ-SESSION-003 AC2: scoped R2 token obtained and injected', () => {
    it('calls getOrCreateScopedR2Token with bucket name and user email', async () => {
      const fetch = createApp();
      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });
      expect(getOrCreateScopedR2Token).toHaveBeenCalledWith(
        'test@example.com',
        'test-account',
        'test-token',
        'test-bucket',
        expect.anything(), // KV namespace
        // cryptoKey: null when ENCRYPTION_KEY env var is absent (test env);
        // expect.anything() rejects null, so be explicit.
        null,
      );
    });

    it('passes scoped credentials in the setBucketName body to the DO', async () => {
      const fetch = createApp();
      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });
      // The DO's fetch was called with /_internal/setBucketName containing r2 creds
      const containerFetchCalls = testState.container!.fetch.mock.calls;
      const setBucketNameCall = containerFetchCalls.find(
        (call) => (call[0] as Request).url.includes('setBucketName')
      );
      expect(setBucketNameCall).toBeDefined();
      const body = JSON.parse(await (setBucketNameCall![0] as Request).clone().text());
      expect(body.r2AccessKeyId).toBe('scoped-ak');
      expect(body.r2SecretAccessKey).toBe('scoped-sk');
    });
  });

  // AC3 (entrypoint initial rclone sync) and AC4 (bisync daemon + SIGUSR1) are
  // covered by host/__tests__/entrypoint-bisync-behavior.test.js, which spawns
  // bash with the real entrypoint code. Worker runtime cannot readFileSync
  // arbitrary repo files, so those structural audits live in host/.

  // AC5: New buckets are seeded with getting-started docs and agent configs
  describe('REQ-SESSION-003 AC5: new buckets seeded with getting-started docs', () => {
    it('calls seedGettingStartedDocs when bucket is newly created', async () => {
      testState.createBucketResult = { success: true, created: true };
      testState.seedResult = { written: ['Getting-Started.md'], skipped: [] };
      const fetch = createApp();
      await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });
      expect(seedGettingStartedDocs).toHaveBeenCalled();
    });

    it('does not fail when seed is skipped for existing bucket', async () => {
      testState.createBucketResult = { success: true, created: false };
      testState.seedResult = { written: [], skipped: ['Getting-Started.md'] };
      const fetch = createApp();
      const res = await fetch('/container/start?sessionId=abcdef1234567890abcdef12', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
    });
  });
});
