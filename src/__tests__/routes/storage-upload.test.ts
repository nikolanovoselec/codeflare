import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createMockR2Config } from '../helpers/mock-factories';
import { createTestApp } from '../helpers/test-app';

const mockFetch = vi.fn();

vi.mock('../../lib/r2-client', () => ({
  createR2Client: vi.fn(() => ({ fetch: mockFetch })),
  getR2Url: vi.fn((endpoint: string, bucket: string, key?: string) =>
    key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`
  ),
  parseInitiateMultipartUploadXml: vi.fn(() => 'upload-id-123'),
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue(createMockR2Config({ accountId: 'test' })),
}));

import uploadRoutes from '../../routes/storage/upload';

describe('Storage Upload Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createApp(bucketName = 'test-bucket') {
    return createTestApp({
      routes: [{ path: '/upload', handler: uploadRoutes }],
      mockKV,
      bucketName,
      envOverrides: {
        R2_ACCESS_KEY_ID: 'test-key',
        R2_SECRET_ACCESS_KEY: 'test-secret',
      },
    });
  }

  // ── Simple upload ──────────────────────────────────────────────────

  describe('POST /upload (simple upload)', () => {
    it('succeeds with valid key and content', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      const content = btoa('hello world');
      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'workspace/file.ts', content }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { key: string; size: number };
      expect(body.key).toBe('workspace/file.ts');
      expect(body.size).toBe(11); // "hello world".length

      // Verify R2 PUT was called
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('workspace/file.ts');
      expect(opts.method).toBe('PUT');
    });

    it('rejects key with path traversal (..)', async () => {
      const app = createApp();

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '../etc/passwd', content: btoa('x') }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects key starting with /', async () => {
      const app = createApp();

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '/absolute/path.ts', content: btoa('x') }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects sensitive paths (.ssh/)', async () => {
      const app = createApp();

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '.ssh/id_rsa', content: btoa('x') }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('protected path');
    });

    it('rejects sensitive paths (.anthropic/)', async () => {
      const app = createApp();

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '.anthropic/auth.json', content: btoa('x') }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects sensitive paths (.config/)', async () => {
      const app = createApp();

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'foo/.config/secrets', content: btoa('x') }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects sensitive paths (.claude.json)', async () => {
      const app = createApp();

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '.claude.json', content: btoa('x') }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects key over 1024 characters', async () => {
      const app = createApp();
      const longKey = 'a'.repeat(1025);

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: longKey, content: btoa('x') }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects missing key', async () => {
      const app = createApp();

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: btoa('x') }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 500 when R2 PUT fails', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test.txt', content: btoa('hello') }),
      });

      expect(res.status).toBe(500);
    });
  });

  // ── Multipart initiate ─────────────────────────────────────────────

  describe('POST /upload/initiate (multipart initiate)', () => {
    it('returns uploadId on success', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(
        new Response('<UploadId>upload-id-123</UploadId>', { status: 200 })
      );

      const res = await app.request('/upload/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'workspace/large.zip' }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { uploadId: string; key: string };
      expect(body.uploadId).toBe('upload-id-123');
      expect(body.key).toBe('workspace/large.zip');
    });

    it('validates key', async () => {
      const app = createApp();

      const res = await app.request('/upload/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '../escape' }),
      });

      expect(res.status).toBe(400);
    });

    it('calls R2 with ?uploads query param', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(
        new Response('<UploadId>upload-id-123</UploadId>', { status: 200 })
      );

      await app.request('/upload/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test.zip' }),
      });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('?uploads');
      expect(opts.method).toBe('POST');
    });
  });

  // ── Multipart part upload ──────────────────────────────────────────

  describe('POST /upload/part (multipart part)', () => {
    it('returns etag on success', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(
        new Response('', {
          status: 200,
          headers: { etag: '"abc123"' },
        })
      );

      const res = await app.request('/upload/part', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'workspace/large.zip',
          uploadId: 'upload-id-123',
          partNumber: 1,
          content: btoa('chunk data'),
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { etag: string };
      expect(body.etag).toBe('abc123'); // quotes stripped
    });

    it('validates key', async () => {
      const app = createApp();

      const res = await app.request('/upload/part', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: '.ssh/id_rsa',
          uploadId: 'upload-id-123',
          partNumber: 1,
          content: btoa('x'),
        }),
      });

      expect(res.status).toBe(400);
    });

    it('sends partNumber and uploadId in URL', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(
        new Response('', { status: 200, headers: { etag: '"e1"' } })
      );

      await app.request('/upload/part', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'file.bin',
          uploadId: 'uid-42',
          partNumber: 3,
          content: btoa('data'),
        }),
      });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('partNumber=3');
      expect(url).toContain('uploadId=uid-42');
    });
  });

  // ── Multipart complete ─────────────────────────────────────────────

  describe('POST /upload/complete (multipart complete)', () => {
    it('succeeds with valid parts', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      const res = await app.request('/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'workspace/large.zip',
          uploadId: 'upload-id-123',
          parts: [
            { partNumber: 1, etag: 'abc' },
            { partNumber: 2, etag: 'def' },
          ],
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { key: string };
      expect(body.key).toBe('workspace/large.zip');
    });

    it('validates key', async () => {
      const app = createApp();

      const res = await app.request('/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: '/bad/key',
          uploadId: 'uid',
          parts: [{ partNumber: 1, etag: 'a' }],
        }),
      });

      expect(res.status).toBe(400);
    });

    it('sends XML body with sorted parts', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      await app.request('/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'file.zip',
          uploadId: 'uid',
          parts: [
            { partNumber: 2, etag: 'b' },
            { partNumber: 1, etag: 'a' },
          ],
        }),
      });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers['Content-Type']).toBe('application/xml');
      // Part 1 should come before Part 2 in the XML
      const body = opts.body as string;
      const idx1 = body.indexOf('<PartNumber>1</PartNumber>');
      const idx2 = body.indexOf('<PartNumber>2</PartNumber>');
      expect(idx1).toBeLessThan(idx2);
    });
  });

  // ── Multipart abort ────────────────────────────────────────────────

  describe('POST /upload/abort (multipart abort)', () => {
    it('succeeds and returns { success: true }', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const res = await app.request('/upload/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'workspace/large.zip',
          uploadId: 'upload-id-123',
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean };
      expect(body.success).toBe(true);
    });

    it('validates key', async () => {
      const app = createApp();

      const res = await app.request('/upload/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: '.anthropic/token',
          uploadId: 'uid',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('sends DELETE to R2 with uploadId', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await app.request('/upload/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'file.zip',
          uploadId: 'uid-99',
        }),
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain('uploadId=uid-99');
      expect(opts.method).toBe('DELETE');
    });
  });
});
