/**
 * Rate limit coverage tests for all rate-limited routes.
 *
 * Verifies that rate limiters are wired to the correct routes by
 * exhausting the limit and asserting 429 on the next request.
 * Does NOT test the rate limiter middleware itself (see rate-limit.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createTestApp } from '../helpers/test-app';
import { createMockR2Config } from '../helpers/mock-factories';

// ── R2 mocks (storage routes need these) ─────────────────────────────

const mockR2Fetch = vi.fn();
const mockSign = vi.fn();

vi.mock('../../lib/r2-client', () => ({
  createR2Client: vi.fn(() => ({ fetch: mockR2Fetch, sign: mockSign })),
  getR2Url: vi.fn((endpoint: string, bucket: string, key?: string) =>
    key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`
  ),
  parseListObjectsXml: vi.fn(() => ({ objects: [], prefixes: [], isTruncated: false })),
  parseInitiateMultipartUploadXml: vi.fn(() => 'upload-id-123'),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireAdmin: vi.fn(async (_c: any, next: any) => next()),
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue(createMockR2Config({ accountId: 'test' })),
}));

vi.mock('../../lib/r2-admin', () => ({
  createBucketIfNotExists: vi.fn().mockResolvedValue({ success: true, created: false }),
  getOrCreateScopedR2Token: vi.fn().mockResolvedValue({ accessKeyId: 'k', secretAccessKey: 's' }),
}));

vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: vi.fn().mockResolvedValue({ written: [], skipped: [] }),
  seedAgentConfigs: vi.fn().mockResolvedValue({ written: [], skipped: [] }),
  reconcileAgentConfigs: vi.fn().mockResolvedValue({ written: [], skipped: [], deleted: [], warnings: [] }),
}));

// ── Container mocks (session stop/delete need these) ─────────────────

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn(() => ({
    getState: vi.fn().mockResolvedValue({ status: 'running' }),
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    destroy: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ── Route imports (after mocks) ──────────────────────────────────────

import uploadRoutes from '../../routes/storage/upload';
import deleteRoutes from '../../routes/storage/delete';
import moveRoutes from '../../routes/storage/move';
import seedRoutes from '../../routes/storage/seed';
import downloadRoutes from '../../routes/storage/download';
import previewRoutes from '../../routes/storage/preview';
import browseRoutes from '../../routes/storage/browse';
import statsRoutes from '../../routes/storage/stats';
import sessionCrudRoutes from '../../routes/session/crud';
import sessionLifecycleRoutes from '../../routes/session/lifecycle';
import userProfileRoutes from '../../routes/user-profile';

// ── Helpers ──────────────────────────────────────────────────────────

function storageEnv() {
  return {
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
  };
}

/**
 * Exhaust a rate limiter and assert the next request returns 429.
 *
 * @param limit - max requests allowed per window
 * @param makeRequest - function that fires one request and returns the Response
 * @param successStatuses - status codes that count as "not rate limited"
 */
async function assertRateLimited(
  limit: number,
  makeRequest: () => Response | Promise<Response>,
  successStatuses: number[] = [200, 201, 204],
) {
  for (let i = 0; i < limit; i++) {
    const res = await makeRequest();
    expect(successStatuses).toContain(res.status);
  }

  // Next request must be 429
  const blocked = await makeRequest();
  expect(blocked.status).toBe(429);
  const body = await blocked.json() as { code: string };
  expect(body.code).toBe('RATE_LIMIT_ERROR');
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Rate limit coverage', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00.000Z'));
    mockR2Fetch.mockReset();
    mockSign.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // ── Storage upload (shared limiter, 60/min) ──────────────────────

  describe('POST /upload - storage-upload (60/min)', () => {
    it('blocks after 60 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/upload', handler: uploadRoutes }],
        mockKV,
        envOverrides: storageEnv(),
      });
      mockR2Fetch.mockResolvedValue(new Response('', { status: 200 }));
      const content = btoa('x');

      await assertRateLimited(60, () =>
        app.request('/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'test.txt', content }),
        })
      );
    });
  });

  // ── Storage delete (20/min) ──────────────────────────────────────

  describe('POST /delete - storage-delete (20/min)', () => {
    it('blocks after 20 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/delete', handler: deleteRoutes }],
        mockKV,
        envOverrides: storageEnv(),
      });
      mockR2Fetch.mockResolvedValue(new Response(null, { status: 204 }));

      await assertRateLimited(20, () =>
        app.request('/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keys: ['file.txt'] }),
        })
      );
    });
  });

  // ── Storage move (20/min) ────────────────────────────────────────

  describe('POST /move - storage-move (20/min)', () => {
    it('blocks after 20 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/move', handler: moveRoutes }],
        mockKV,
        envOverrides: storageEnv(),
      });
      mockR2Fetch.mockResolvedValue(new Response('', { status: 200 }));

      await assertRateLimited(20, () =>
        app.request('/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'a.txt', destination: 'b.txt' }),
        })
      );
    });
  });

  // ── Storage seed (3/min, shared) ─────────────────────────────────

  describe('POST /seed/getting-started - storage-seed (3/min)', () => {
    it('blocks after 3 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/seed', handler: seedRoutes }],
        mockKV,
        envOverrides: { ...storageEnv(), CLOUDFLARE_API_TOKEN: 'tok' },
      });

      await assertRateLimited(3, () =>
        app.request('/seed/getting-started', { method: 'POST' })
      );
    });
  });

  // ── Storage download (120/min) ───────────────────────────────────

  describe('GET /download - storage-download (120/min)', () => {
    it('blocks after 120 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/download', handler: downloadRoutes }],
        mockKV,
        envOverrides: storageEnv(),
      });
      mockSign.mockResolvedValue(
        new Request('https://r2.test/test-bucket/file.txt', { method: 'GET' })
      );
      vi.stubGlobal('fetch', async () =>
        new Response('data', {
          status: 200,
          headers: { 'Content-Type': 'text/plain', 'Content-Length': '4' },
        })
      );

      await assertRateLimited(120, () =>
        app.request('/download?key=file.txt')
      );
    });
  });

  // ── Storage preview (120/min) ────────────────────────────────────

  describe('GET /preview - storage-preview (120/min)', () => {
    it('blocks after 120 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/preview', handler: previewRoutes }],
        mockKV,
        envOverrides: storageEnv(),
      });
      // HEAD returns text content type -use mockImplementation so each call gets a fresh Response
      mockR2Fetch.mockImplementation(() =>
        new Response('', {
          status: 200,
          headers: { 'Content-Type': 'text/plain', 'Content-Length': '5' },
        })
      );

      await assertRateLimited(120, () =>
        app.request('/preview?key=file.txt')
      );
    });
  });

  // ── Storage browse (30/min) ──────────────────────────────────────

  describe('GET /browse - storage-browse (30/min)', () => {
    it('blocks after 30 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/browse', handler: browseRoutes }],
        mockKV,
        envOverrides: storageEnv(),
      });
      mockR2Fetch.mockImplementation(() =>
        new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', {
          status: 200,
        })
      );

      await assertRateLimited(30, () => app.request('/browse'));
    });
  });

  // ── Storage stats (10/min) ───────────────────────────────────────

  describe('GET /stats - storage-stats (10/min)', () => {
    it('blocks after 10 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/stats', handler: statsRoutes }],
        mockKV,
        envOverrides: storageEnv(),
      });
      mockR2Fetch.mockImplementation(() =>
        new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', {
          status: 200,
        })
      );

      await assertRateLimited(10, () => app.request('/stats'));
    });
  });

  // ── Session delete (10/min) ──────────────────────────────────────

  describe('DELETE /sessions/:id - session-delete (10/min)', () => {
    it('blocks after 10 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/sessions', handler: sessionCrudRoutes }],
        mockKV,
      });

      // Seed sessions for deletion
      for (let i = 0; i < 11; i++) {
        const id = `session${String(i).padStart(8, '0')}`;
        mockKV._set(`session:test-bucket:${id}`, {
          id,
          name: `S${i}`,
          userId: 'test-bucket',
          createdAt: '2024-01-01T00:00:00Z',
          lastAccessedAt: '2024-01-01T00:00:00Z',
        });
      }

      await assertRateLimited(10, async () => {
        // Each request deletes a different session to avoid 404
        const idx = mockKV.delete.mock.calls.length;
        const id = `session${String(idx).padStart(8, '0')}`;
        return app.request(`/sessions/${id}`, { method: 'DELETE' });
      });
    });
  });

  // ── Session stop (10/min) ────────────────────────────────────────

  describe('POST /sessions/:id/stop - session-stop (10/min)', () => {
    it('blocks after 10 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/sessions', handler: sessionLifecycleRoutes }],
        mockKV,
      });

      const sessionId = 'abcdef12';
      mockKV._set(`session:test-bucket:${sessionId}`, {
        id: sessionId,
        name: 'Test',
        userId: 'test-bucket',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        lastAccessedAt: '2024-01-01T00:00:00Z',
      });

      await assertRateLimited(10, () =>
        app.request(`/sessions/${sessionId}/stop`, { method: 'POST' })
      );
    });
  });

  // ── Ensure R2 token (5/min) ──────────────────────────────────────

  describe('POST /user/ensure-r2-token - ensure-r2-token (5/min)', () => {
    it('blocks after 5 requests', async () => {
      const app = createTestApp({
        routes: [{ path: '/user', handler: userProfileRoutes }],
        mockKV,
        envOverrides: { CLOUDFLARE_API_TOKEN: 'tok' },
      });
      mockKV._set('setup:account_id', 'acc123');

      await assertRateLimited(5, () =>
        app.request('/user/ensure-r2-token', { method: 'POST' })
      );
    });
  });

  // ── Rate limit headers present ───────────────────────────────────

  describe('Rate limit headers', () => {
    it('storage upload includes X-RateLimit-Limit header', async () => {
      const app = createTestApp({
        routes: [{ path: '/upload', handler: uploadRoutes }],
        mockKV,
        envOverrides: storageEnv(),
      });
      mockR2Fetch.mockResolvedValue(new Response('', { status: 200 }));

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test.txt', content: btoa('x') }),
      });

      expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
      expect(res.headers.get('X-RateLimit-Remaining')).toBeDefined();
    });

    it('storage browse includes X-RateLimit-Limit header', async () => {
      const app = createTestApp({
        routes: [{ path: '/browse', handler: browseRoutes }],
        mockKV,
        envOverrides: storageEnv(),
      });
      mockR2Fetch.mockResolvedValue(
        new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 })
      );

      const res = await app.request('/browse');
      expect(res.headers.get('X-RateLimit-Limit')).toBe('30');
    });

    it('session stop includes X-RateLimit-Limit header', async () => {
      const app = createTestApp({
        routes: [{ path: '/sessions', handler: sessionLifecycleRoutes }],
        mockKV,
      });
      const id = 'abcdef12';
      mockKV._set(`session:test-bucket:${id}`, {
        id, name: 'T', userId: 'test-bucket', status: 'running',
        createdAt: '2024-01-01T00:00:00Z', lastAccessedAt: '2024-01-01T00:00:00Z',
      });

      const res = await app.request(`/sessions/${id}/stop`, { method: 'POST' });
      expect(res.headers.get('X-RateLimit-Limit')).toBe('10');
    });
  });
});
