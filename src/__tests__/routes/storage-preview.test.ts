import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createMockR2Config } from '../helpers/mock-factories';
import { createTestApp } from '../helpers/test-app';

// Track mock state for assertions - vi.hoisted() ensures these are available when vi.mock() factory runs.
// preview.ts (REQ-ENTERPRISE-021) HEADs via fetchObjectWithRegimeFallback (dual-regime read) and
// reuses the proven regime for the text GET via r2Client.fetch. The regime-fallback logic itself is
// covered in r2-migration.test.ts; here we control the HEAD response and the GET body.
const { mockFetch, mockGetR2Url, mockFetchObjectWithRegimeFallback, mockMarkMixedRecovery } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetR2Url: vi.fn((endpoint: string, bucket: string, key?: string) => (key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`)),
  mockFetchObjectWithRegimeFallback: vi.fn(),
  mockMarkMixedRecovery: vi.fn(async () => {}),
}));

vi.mock('../../lib/r2-client', () => ({
  createR2Client: vi.fn(() => ({ fetch: mockFetch })),
  getR2Url: mockGetR2Url,
}));
vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue(createMockR2Config()),
}));
vi.mock('../../lib/r2-migration', () => ({
  fetchObjectWithRegimeFallback: mockFetchObjectWithRegimeFallback,
  markMixedRecovery: mockMarkMixedRecovery,
}));

// Import after mocks are set up
import previewRoutes from '../../routes/storage/preview';

// REQ-STOR-007: Web File Browser

describe('Storage Preview Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  function createHeadResponse(contentLength: number, contentType: string, lastModified: string) {
    return new Response(null, {
      status: 200,
      headers: { 'Content-Length': String(contentLength), 'Content-Type': contentType, 'Last-Modified': lastModified },
    });
  }

  /** Set the HEAD result returned by the dual-regime read helper. */
  function setHead(response: Response) {
    mockFetchObjectWithRegimeFallback.mockResolvedValue({ response, stray: false, sseDisabled: false });
  }

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createApp() {
    return createTestApp({
      routes: [{ path: '/preview', handler: previewRoutes }],
      mockKV,
      envOverrides: { R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret' },
    });
  }

  describe('GET /preview', () => {
    it('returns text preview for text files (<1MB)', async () => {
      const textContent = 'Hello, world!\nThis is a test file.';
      setHead(createHeadResponse(textContent.length, 'text/plain', 'Mon, 01 Jan 2024 00:00:00 GMT'));
      mockFetch.mockResolvedValueOnce(new Response(textContent, { status: 200, headers: { 'Content-Type': 'text/plain' } }));

      const res = await createApp().request('/preview?key=test.txt');
      expect(res.status).toBe(200);

      const body = await res.json() as { type: string; content: string; size: number; lastModified: string };
      expect(body.type).toBe('text');
      expect(body.content).toBe(textContent);
      expect(body.size).toBe(textContent.length);
      expect(body.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    });

    it('returns binary metadata for image files (no content GET)', async () => {
      setHead(createHeadResponse(50000, 'image/png', 'Mon, 01 Jan 2024 00:00:00 GMT'));

      const res = await createApp().request('/preview?key=photo.png');
      expect(res.status).toBe(200);

      const body = await res.json() as { type: string; size: number; lastModified: string };
      expect(body.type).toBe('binary');
      expect(body.size).toBe(50000);
      expect(body.lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
      expect(mockFetch).not.toHaveBeenCalled(); // no text GET for binary
    });

    it('returns binary metadata for binary files', async () => {
      setHead(createHeadResponse(2000000, 'application/octet-stream', 'Mon, 01 Jan 2024 00:00:00 GMT'));

      const res = await createApp().request('/preview?key=archive.zip');
      expect(res.status).toBe(200);

      const body = await res.json() as { type: string; size: number; lastModified: string };
      expect(body.type).toBe('binary');
      expect(body.size).toBe(2000000);
      expect(body).not.toHaveProperty('content');
      expect(body).not.toHaveProperty('url');
    });

    it('returns binary for large text files (>1MB)', async () => {
      setHead(createHeadResponse(2_000_000, 'text/plain', 'Mon, 01 Jan 2024 00:00:00 GMT'));

      const res = await createApp().request('/preview?key=huge.txt');
      expect(res.status).toBe(200);

      const body = await res.json() as { type: string; size: number };
      expect(body.type).toBe('binary');
      expect(body.size).toBe(2_000_000);
      expect(mockFetch).not.toHaveBeenCalled(); // too large to inline → no GET
    });

    it('REQ-STOR-007 AC5: accepts exactly 1 MiB of UTF-8 text', async () => {
      const content = 'é'.repeat(524_288);
      setHead(createHeadResponse(1_048_576, 'text/plain', ''));
      mockFetch.mockResolvedValueOnce(new Response(content));
      const res = await createApp().request('/preview?key=boundary.txt');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ type: 'text', content, size: 1_048_576 });
    });

    it.each([null, '8', 'invalid'])('REQ-STOR-007 AC5: cancels oversized text despite HEAD length %s', async length => {
      const headers = new Headers({ 'Content-Type': 'text/plain' });
      if (length !== null) headers.set('Content-Length', length);
      setHead(new Response(null, { headers }));
      let cancelled = false;
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 4) controller.close();
          else { sent++; controller.enqueue(new Uint8Array(400_000).fill(65)); }
        },
        cancel() { cancelled = true; },
      });
      mockFetch.mockResolvedValueOnce(new Response(body));
      const res = await createApp().request('/preview?key=growing.txt');
      expect(res.status).toBe(200);
      const preview = await res.json() as { type: string; size: number };
      expect(preview.type).toBe('binary');
      expect(preview.size).toBeGreaterThan(1_048_576);
      expect(preview).not.toHaveProperty('content');
      expect(cancelled).toBe(true);
    });

    it('REQ-STOR-007 AC5: returns only metadata if GET is no longer text', async () => {
      setHead(createHeadResponse(4, 'text/plain', ''));
      mockFetch.mockResolvedValueOnce(new Response('data', { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '4' } }));
      const res = await createApp().request('/preview?key=changed.txt');
      expect(res.status).toBe(200);
      const preview = await res.json();
      expect(preview).toMatchObject({ type: 'binary', size: 4 });
      expect(preview).not.toHaveProperty('content');
    });

    it('returns numeric metadata when the binary object HEAD length is invalid', async () => {
      setHead(new Response(null, { headers: { 'Content-Type': 'image/png', 'Content-Length': 'invalid' } }));
      const res = await createApp().request('/preview?key=photo.png');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ type: 'binary', size: 0 });
    });

    it('REQ-STOR-007 AC5: does not return a failed GET body as a preview', async () => {
      setHead(createHeadResponse(4, 'text/plain', ''));
      mockFetch.mockResolvedValueOnce(new Response('upstream error', { status: 503 }));
      const res = await createApp().request('/preview?key=failed.txt');
      expect(res.status).toBe(500);
      expect(await res.json()).not.toHaveProperty('content');
    });

    it('rejects missing key with 400', async () => {
      const res = await createApp().request('/preview');
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
    });

    it('rejects empty key with 400', async () => {
      const res = await createApp().request('/preview?key=');
      expect(res.status).toBe(400);
      expect((await res.json() as { code: string }).code).toBe('VALIDATION_ERROR');
    });

    it('rejects path traversal with 400', async () => {
      const res = await createApp().request('/preview?key=../etc/shadow');
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('path traversal');
    });

    it('handles JSON files as text', async () => {
      const jsonContent = '{"key": "value"}';
      setHead(createHeadResponse(jsonContent.length, 'application/json', 'Mon, 01 Jan 2024 00:00:00 GMT'));
      mockFetch.mockResolvedValueOnce(new Response(jsonContent, { status: 200, headers: { 'Content-Type': 'application/json' } }));

      const res = await createApp().request('/preview?key=data.json');
      expect(res.status).toBe(200);

      const body = await res.json() as { type: string; content: string };
      expect(body.type).toBe('text');
      expect(body.content).toBe(jsonContent);
    });

    it('handles JPEG images as binary metadata', async () => {
      setHead(createHeadResponse(100000, 'image/jpeg', 'Mon, 01 Jan 2024 00:00:00 GMT'));

      const res = await createApp().request('/preview?key=photo.jpg');
      expect(res.status).toBe(200);

      const body = await res.json() as { type: string; size: number };
      expect(body.type).toBe('binary');
      expect(body.size).toBe(100000);
    });

    it('returns 500 when HEAD request fails', async () => {
      setHead(new Response('Not Found', { status: 404 }));

      const res = await createApp().request('/preview?key=missing.txt');
      expect(res.status).toBe(500);
    });
  });
});
