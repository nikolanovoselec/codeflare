import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { ValidationError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

// Track mock state for assertions - vi.hoisted() ensures these are available when vi.mock() factory runs
const { mockSign, mockCreateR2Client, mockGetR2Url, mockFetch } = vi.hoisted(() => {
  const mockSign = vi.fn();
  const mockFetch = vi.fn();
  return {
    mockSign,
    mockFetch,
    mockCreateR2Client: vi.fn(() => ({ sign: mockSign })),
    mockGetR2Url: vi.fn((endpoint: string, bucket: string, key?: string) => {
      if (key) return `${endpoint}/${bucket}/${key}`;
      return `${endpoint}/${bucket}`;
    }),
  };
});

// Mock r2-client module — download uses AwsClient.sign(), not .fetch()
vi.mock('../../lib/r2-client', () => ({
  createR2Client: mockCreateR2Client,
  getR2Url: mockGetR2Url,
}));

// Mock r2-config
vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue({
    accountId: 'test-account',
    endpoint: 'https://test.r2.cloudflarestorage.com',
  }),
}));

// Import after mocks are set up
import downloadRoutes from '../../routes/storage/download';

describe('Storage Download Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();

    // Default: sign() returns a signed Request object
    mockSign.mockResolvedValue(
      new Request('https://test.r2.cloudflarestorage.com/test-bucket/path/to/file.txt?X-Amz-Signature=abc123', {
        method: 'GET',
      })
    );

    // Default: global fetch returns a successful R2 response (streaming proxy)
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : '';
      if (url.includes('test.r2.cloudflarestorage.com')) {
        return new Response('file-content', {
          status: 200,
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': '12',
          },
        });
      }
      return originalFetch(input);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function createTestApp() {
    const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    app.onError((err, c) => {
      if (err instanceof ValidationError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: err.message }, 500);
    });

    app.use('*', async (c, next) => {
      c.env = {
        KV: mockKV as unknown as KVNamespace,
        R2_ACCESS_KEY_ID: 'test-key',
        R2_SECRET_ACCESS_KEY: 'test-secret',
      } as unknown as Env;
      c.set('user', { email: 'test@example.com', authenticated: true });
      c.set('bucketName', 'test-bucket');
      return next();
    });

    app.route('/download', downloadRoutes);
    return app;
  }

  describe('GET /download', () => {
    it('returns 200 with streamed content and correct headers', async () => {
      const app = createTestApp();

      const res = await app.request('/download?key=path/to/file.txt');
      expect(res.status).toBe(200);

      expect(res.headers.get('Content-Type')).toBe('text/plain');
      expect(res.headers.get('Content-Disposition')).toContain('attachment; filename="file.txt"');
      expect(res.headers.get('Content-Length')).toBe('12');

      const body = await res.text();
      expect(body).toBe('file-content');
    });

    it('rejects missing key with 400', async () => {
      const app = createTestApp();

      const res = await app.request('/download');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects empty key with 400', async () => {
      const app = createTestApp();

      const res = await app.request('/download?key=');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects path traversal with 400', async () => {
      const app = createTestApp();

      const res = await app.request('/download?key=../etc/passwd');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('path traversal');
    });

    it('calls AwsClient.sign() with GET method and fetches from R2', async () => {
      const app = createTestApp();

      await app.request('/download?key=path/to/file.txt');

      expect(mockSign).toHaveBeenCalledTimes(1);

      // sign() receives a URL string and an options object
      const callArgs = mockSign.mock.calls[0];
      const signedUrl = callArgs[0] as string;
      const signOpts = callArgs[1] as { method: string };

      expect(signedUrl).toContain('path/to/file.txt');
      expect(signOpts.method).toBe('GET');
    });

    it('returns 500 on sign failure', async () => {
      mockSign.mockRejectedValue(new Error('Sign failed'));

      const app = createTestApp();

      const res = await app.request('/download?key=path/to/file.txt');
      expect(res.status).toBe(500);
    });

    it('returns 500 when R2 fetch fails', async () => {
      vi.stubGlobal('fetch', async () => new Response(null, { status: 403 }));

      const app = createTestApp();

      const res = await app.request('/download?key=path/to/file.txt');
      expect(res.status).toBe(500);
    });
  });
});
