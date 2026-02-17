import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createMockKV } from '../helpers/mock-kv';
import { createMockR2Config } from '../helpers/mock-factories';
import { createTestApp } from '../helpers/test-app';

// Track mock state for assertions - vi.hoisted() ensures these are available when vi.mock() factory runs
const { mockFetch, mockCreateR2Client, mockGetR2Url } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return {
    mockFetch,
    mockCreateR2Client: vi.fn(() => ({ fetch: mockFetch })),
    mockGetR2Url: vi.fn((endpoint: string, bucket: string, key?: string) =>
      key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`
    ),
  };
});

// Mock r2-client module
vi.mock('../../lib/r2-client', () => ({
  createR2Client: mockCreateR2Client,
  getR2Url: mockGetR2Url,
}));

// Mock r2-config
vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue(createMockR2Config()),
}));

// Import after mocks are set up
import moveRoutes from '../../routes/storage/move';

describe('Storage Move Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();

    // Default: both copy and delete succeed
    mockFetch.mockResolvedValue(new Response('', { status: 200 }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createApp() {
    return createTestApp({
      routes: [{ path: '/move', handler: moveRoutes }],
      mockKV,
      envOverrides: {
        R2_ACCESS_KEY_ID: 'test-key',
        R2_SECRET_ACCESS_KEY: 'test-secret',
      },
    });
  }

  function postMove(app: Hono<{ Bindings: Env; Variables: AuthVariables }>, body: Record<string, unknown>) {
    return app.request('/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  describe('POST /move', () => {
    it('returns source and destination on successful move', async () => {
      const app = createApp();

      const res = await postMove(app, {
        source: 'workspace/old-name.ts',
        destination: 'workspace/new-name.ts',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { source: string; destination: string; warning?: string };
      expect(body.source).toBe('workspace/old-name.ts');
      expect(body.destination).toBe('workspace/new-name.ts');
      expect(body.warning).toBeUndefined();
    });

    it('calls CopyObject then DeleteObject in correct order', async () => {
      const app = createApp();

      await postMove(app, {
        source: 'workspace/old.ts',
        destination: 'workspace/new.ts',
      });

      // Two calls: copy (PUT) then delete (DELETE)
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // First call: CopyObject (PUT to destination)
      const [copyUrl, copyOpts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(copyUrl).toContain('workspace/new.ts');
      expect(copyOpts.method).toBe('PUT');
      expect((copyOpts.headers as Record<string, string>)['x-amz-copy-source']).toBe('/test-bucket/workspace/old.ts');

      // Second call: DeleteObject (DELETE source)
      const [deleteUrl, deleteOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(deleteUrl).toContain('workspace/old.ts');
      expect(deleteOpts.method).toBe('DELETE');
    });

    it('returns warning when copy succeeds but delete fails', async () => {
      // Copy succeeds, delete fails
      mockFetch
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(new Response('Error', { status: 500 }));

      const app = createApp();

      const res = await postMove(app, {
        source: 'workspace/old.ts',
        destination: 'workspace/new.ts',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { source: string; destination: string; warning?: string };
      expect(body.source).toBe('workspace/old.ts');
      expect(body.destination).toBe('workspace/new.ts');
      expect(body.warning).toContain('original could not be deleted');
    });

    it('returns warning when copy succeeds but delete throws', async () => {
      // Copy succeeds, delete throws network error
      mockFetch
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockRejectedValueOnce(new Error('network error'));

      const app = createApp();

      const res = await postMove(app, {
        source: 'workspace/old.ts',
        destination: 'workspace/new.ts',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { source: string; destination: string; warning?: string };
      expect(body.warning).toContain('original could not be deleted');
    });

    it('returns 500 when copy fails', async () => {
      mockFetch.mockResolvedValue(new Response('Error', { status: 403 }));

      const app = createApp();

      const res = await postMove(app, {
        source: 'workspace/old.ts',
        destination: 'workspace/new.ts',
      });

      expect(res.status).toBe(500);
    });

    it('rejects source with path traversal', async () => {
      const app = createApp();

      const res = await postMove(app, {
        source: '../etc/passwd',
        destination: 'workspace/new.ts',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('path traversal');
    });

    it('rejects destination with path traversal', async () => {
      const app = createApp();

      const res = await postMove(app, {
        source: 'workspace/old.ts',
        destination: 'workspace/../../../etc/passwd',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('path traversal');
    });

    it('rejects source in protected path', async () => {
      const app = createApp();

      const res = await postMove(app, {
        source: '.claude/settings.json',
        destination: 'workspace/settings.json',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('protected path');
    });

    it('rejects destination in protected path', async () => {
      const app = createApp();

      const res = await postMove(app, {
        source: 'workspace/file.ts',
        destination: '.ssh/authorized_keys',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('protected path');
    });

    it('rejects same source and destination', async () => {
      const app = createApp();

      const res = await postMove(app, {
        source: 'workspace/file.ts',
        destination: 'workspace/file.ts',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('must be different');
    });

    it('rejects missing source', async () => {
      const app = createApp();

      const res = await postMove(app, {
        destination: 'workspace/new.ts',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('source');
    });

    it('rejects missing destination', async () => {
      const app = createApp();

      const res = await postMove(app, {
        source: 'workspace/old.ts',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('destination');
    });

    it('rejects source starting with /', async () => {
      const app = createApp();

      const res = await postMove(app, {
        source: '/absolute/path.ts',
        destination: 'workspace/new.ts',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('must not start with /');
    });

    it('rejects source exceeding max key length', async () => {
      const app = createApp();

      const res = await postMove(app, {
        source: 'a'.repeat(1025),
        destination: 'workspace/new.ts',
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('at most');
    });

    it('does not call delete when copy fails', async () => {
      mockFetch.mockResolvedValue(new Response('Error', { status: 403 }));

      const app = createApp();

      await postMove(app, {
        source: 'workspace/old.ts',
        destination: 'workspace/new.ts',
      });

      // Only copy call, no delete
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('treats delete 204 as success (no warning)', async () => {
      // Copy succeeds with 200, delete returns 204 (No Content - standard for DELETE)
      mockFetch
        .mockResolvedValueOnce(new Response('', { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const app = createApp();

      const res = await postMove(app, {
        source: 'workspace/old.ts',
        destination: 'workspace/new.ts',
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { source: string; destination: string; warning?: string };
      expect(body.warning).toBeUndefined();
    });
  });
});
