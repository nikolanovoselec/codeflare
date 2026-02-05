import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createMockR2Config } from '../helpers/mock-factories';
import { createTestApp } from '../helpers/test-app';

// Track mock state for assertions - vi.hoisted() ensures these are available when vi.mock() factory runs
const { mockFetch, mockSign, mockCreateR2Client, mockGetR2Url } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  const mockSign = vi.fn();
  return {
    mockFetch,
    mockSign,
    mockCreateR2Client: vi.fn(() => ({ fetch: mockFetch, sign: mockSign })),
    mockGetR2Url: vi.fn((endpoint: string, bucket: string, key?: string) => {
      if (key) return `${endpoint}/${bucket}/${key}`;
      return `${endpoint}/${bucket}`;
    }),
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
import previewRoutes from '../../routes/storage/preview';

describe('Storage Preview Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();

    // Default: sign() returns a Request with a presigned URL
    mockSign.mockResolvedValue(
      new Request('https://test.r2.cloudflarestorage.com/test-bucket/image.png?X-Amz-Signature=abc123', {
        method: 'GET',
      })
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createApp() {
    return createTestApp({
      routes: [{ path: '/preview', handler: previewRoutes }],
      mockKV,
      envOverrides: {
        R2_ACCESS_KEY_ID: 'test-key',
        R2_SECRET_ACCESS_KEY: 'test-secret',
      },
    });
  }

  function createHeadResponse(contentLength: number, contentType: string, lastModified: string) {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Length': String(contentLength),
        'Content-Type': contentType,
        'Last-Modified': lastModified,
      },
    });
  }

  describe('GET /preview', () => {
    it('returns text preview for text files (<1MB)', async () => {
      const textContent = 'Hello, world!\nThis is a test file.';

      // HEAD request to get metadata
      mockFetch
        .mockResolvedValueOnce(createHeadResponse(textContent.length, 'text/plain', 'Mon, 01 Jan 2024 00:00:00 GMT'))
        // GET request to fetch content
        .mockResolvedValueOnce(new Response(textContent, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        }));

      const app = createApp();

      const res = await app.request('/preview?key=test.txt');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        type: string;
        content: string;
        size: number;
        lastModified: string;
      };
      expect(body.type).toBe('text');
      expect(body.content).toBe(textContent);
      expect(body.size).toBe(textContent.length);
      expect(body.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    });

    it('returns image preview with presigned URL', async () => {
      // HEAD request to get metadata
      mockFetch.mockResolvedValueOnce(createHeadResponse(50000, 'image/png', 'Mon, 01 Jan 2024 00:00:00 GMT'));

      const app = createApp();

      const res = await app.request('/preview?key=photo.png');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        type: string;
        url: string;
        size: number;
        lastModified: string;
      };
      expect(body.type).toBe('image');
      expect(body.url).toContain('X-Amz-Signature');
      expect(body.size).toBe(50000);
      expect(body.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    });

    it('returns binary metadata for binary files', async () => {
      // HEAD request to get metadata
      mockFetch.mockResolvedValueOnce(createHeadResponse(2000000, 'application/octet-stream', 'Mon, 01 Jan 2024 00:00:00 GMT'));

      const app = createApp();

      const res = await app.request('/preview?key=archive.zip');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        type: string;
        size: number;
        lastModified: string;
      };
      expect(body.type).toBe('binary');
      expect(body.size).toBe(2000000);
      expect(body.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
      expect(body).not.toHaveProperty('content');
      expect(body).not.toHaveProperty('url');
    });

    it('returns binary for large text files (>1MB)', async () => {
      // HEAD request shows text file larger than 1MB
      mockFetch.mockResolvedValueOnce(createHeadResponse(2_000_000, 'text/plain', 'Mon, 01 Jan 2024 00:00:00 GMT'));

      const app = createApp();

      const res = await app.request('/preview?key=huge.txt');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        type: string;
        size: number;
        lastModified: string;
      };
      expect(body.type).toBe('binary');
      expect(body.size).toBe(2_000_000);
    });

    it('rejects missing key with 400', async () => {
      const app = createApp();

      const res = await app.request('/preview');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects empty key with 400', async () => {
      const app = createApp();

      const res = await app.request('/preview?key=');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects path traversal with 400', async () => {
      const app = createApp();

      const res = await app.request('/preview?key=../etc/shadow');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('path traversal');
    });

    it('handles JSON files as text', async () => {
      const jsonContent = '{"key": "value"}';

      mockFetch
        .mockResolvedValueOnce(createHeadResponse(jsonContent.length, 'application/json', 'Mon, 01 Jan 2024 00:00:00 GMT'))
        .mockResolvedValueOnce(new Response(jsonContent, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));

      const app = createApp();

      const res = await app.request('/preview?key=data.json');
      expect(res.status).toBe(200);

      const body = await res.json() as { type: string; content: string };
      expect(body.type).toBe('text');
      expect(body.content).toBe(jsonContent);
    });

    it('handles JPEG images', async () => {
      mockFetch.mockResolvedValueOnce(createHeadResponse(100000, 'image/jpeg', 'Mon, 01 Jan 2024 00:00:00 GMT'));

      const app = createApp();

      const res = await app.request('/preview?key=photo.jpg');
      expect(res.status).toBe(200);

      const body = await res.json() as { type: string; url: string };
      expect(body.type).toBe('image');
      expect(body.url).toBeTruthy();
    });

    it('returns 500 when HEAD request fails', async () => {
      mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      const app = createApp();

      const res = await app.request('/preview?key=missing.txt');
      expect(res.status).toBe(500);
    });
  });
});
