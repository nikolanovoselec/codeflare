import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createMockR2Config } from '../helpers/mock-factories';
import { createTestApp } from '../helpers/test-app';

// Track mock state for assertions - vi.hoisted() ensures these are available when vi.mock() factory runs
const {
  mockFetch,
  mockCreateR2Client,
  mockGetR2Url,
  mockParseListObjectsXml,
  mockCreateBucketIfNotExists,
  mockSeedGettingStartedDocs,
} = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return {
    mockFetch,
    mockCreateR2Client: vi.fn(() => ({ fetch: mockFetch })),
    mockGetR2Url: vi.fn((endpoint: string, bucket: string) => `${endpoint}/${bucket}`),
    mockParseListObjectsXml: vi.fn(),
    mockCreateBucketIfNotExists: vi.fn(async () => ({ success: true, created: true })),
    mockSeedGettingStartedDocs: vi.fn(async () => ({ written: ['Getting-Started.md'], skipped: [] })),
  };
});

// Mock r2-client module
vi.mock('../../lib/r2-client', () => ({
  createR2Client: mockCreateR2Client,
  getR2Url: mockGetR2Url,
  parseListObjectsXml: mockParseListObjectsXml,
}));

// Mock r2-config
vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue(createMockR2Config()),
}));

vi.mock('../../lib/r2-admin', () => ({
  createBucketIfNotExists: mockCreateBucketIfNotExists,
}));

vi.mock('../../lib/r2-seed', () => ({
  seedGettingStartedDocs: mockSeedGettingStartedDocs,
}));

// Import after mocks are set up
import browseRoutes from '../../routes/storage/browse';

describe('Storage Browse Routes', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();

    // Default: successful response with one object and one prefix
    mockParseListObjectsXml.mockReturnValue({
      objects: [{ key: 'test.txt', size: 100, lastModified: '2024-01-01T00:00:00Z' }],
      prefixes: ['folder/'],
      isTruncated: false,
    });

    mockCreateBucketIfNotExists.mockResolvedValue({ success: true, created: true });
    mockSeedGettingStartedDocs.mockResolvedValue({ written: ['Getting-Started.md'], skipped: [] });
    mockFetch.mockResolvedValue(new Response('<ListBucketResult></ListBucketResult>', { status: 200 }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createApp() {
    return createTestApp({
      routes: [{ path: '/browse', handler: browseRoutes }],
      mockKV,
      envOverrides: {
        CLOUDFLARE_API_TOKEN: 'test-token',
        R2_ACCESS_KEY_ID: 'test-key',
        R2_SECRET_ACCESS_KEY: 'test-secret',
      },
    });
  }

  describe('GET /browse', () => {
    it('returns objects and prefixes for valid request', async () => {
      const app = createApp();

      const res = await app.request('/browse');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        objects: Array<{ key: string; size: number; lastModified: string }>;
        prefixes: string[];
        isTruncated: boolean;
      };
      expect(body.objects).toHaveLength(1);
      expect(body.objects[0].key).toBe('test.txt');
      expect(body.objects[0].size).toBe(100);
      expect(body.prefixes).toEqual(['folder/']);
      expect(body.isTruncated).toBe(false);
    });

    it('uses default maxKeys=200 when not specified', async () => {
      const app = createApp();

      await app.request('/browse');

      // Verify the URL passed to r2Client.fetch includes max-keys=200
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      const urlParams = new URLSearchParams(calledUrl.split('?')[1]);
      expect(urlParams.get('max-keys')).toBe('200');
    });

    it('passes prefix to R2 client', async () => {
      const app = createApp();

      await app.request('/browse?prefix=workspace/');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      const urlParams = new URLSearchParams(calledUrl.split('?')[1]);
      expect(urlParams.get('prefix')).toBe('workspace/');
    });

    it('passes continuationToken when provided', async () => {
      const app = createApp();

      await app.request('/browse?continuationToken=abc123');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const calledUrl = mockFetch.mock.calls[0][0] as string;
      const urlParams = new URLSearchParams(calledUrl.split('?')[1]);
      expect(urlParams.get('continuation-token')).toBe('abc123');
    });

    it('rejects prefix with path traversal (..) with 400', async () => {
      const app = createApp();

      const res = await app.request('/browse?prefix=../etc/passwd');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('path traversal');
    });

    it('rejects maxKeys=0 with 400', async () => {
      const app = createApp();

      const res = await app.request('/browse?maxKeys=0');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects maxKeys=-1 with 400', async () => {
      const app = createApp();

      const res = await app.request('/browse?maxKeys=-1');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects maxKeys=1001 with 400', async () => {
      const app = createApp();

      const res = await app.request('/browse?maxKeys=1001');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('rejects maxKeys="abc" with 400', async () => {
      const app = createApp();

      const res = await app.request('/browse?maxKeys=abc');
      expect(res.status).toBe(400);

      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('handles empty results (no objects, no prefixes)', async () => {
      mockParseListObjectsXml.mockReturnValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      const app = createApp();

      const res = await app.request('/browse');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        objects: unknown[];
        prefixes: string[];
        isTruncated: boolean;
      };
      expect(body.objects).toEqual([]);
      expect(body.prefixes).toEqual([]);
      expect(body.isTruncated).toBe(false);
    });

    it('uses custom maxKeys when valid', async () => {
      const app = createApp();

      await app.request('/browse?maxKeys=50');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      const urlParams = new URLSearchParams(calledUrl.split('?')[1]);
      expect(urlParams.get('max-keys')).toBe('50');
    });

    it('uses custom delimiter', async () => {
      const app = createApp();

      await app.request('/browse?delimiter=|');

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      const urlParams = new URLSearchParams(calledUrl.split('?')[1]);
      expect(urlParams.get('delimiter')).toBe('|');
    });

    it('returns 500 when R2 request fails', async () => {
      mockFetch.mockResolvedValue(new Response('Error', { status: 403 }));

      const app = createApp();

      const res = await app.request('/browse');
      expect(res.status).toBe(500);
    });

    it('auto-creates missing bucket and seeds docs once', async () => {
      mockFetch.mockResolvedValue(new Response('Not found', { status: 404 }));

      const app = createApp();

      const res = await app.request('/browse');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        objects: unknown[];
        prefixes: string[];
        isTruncated: boolean;
      };
      expect(body).toEqual({ objects: [], prefixes: [], isTruncated: false });
      expect(mockCreateBucketIfNotExists).toHaveBeenCalledWith('test-account', 'test-token', 'test-bucket');
      expect(mockSeedGettingStartedDocs).toHaveBeenCalledWith(
        expect.any(Object),
        'test-bucket',
        'https://test.r2.cloudflarestorage.com',
        { overwrite: false }
      );
    });
  });
});
