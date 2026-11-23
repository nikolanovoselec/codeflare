import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { ValidationError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

// Track mock state for assertions - vi.hoisted() ensures these are available when vi.mock() factory runs
const { mockFetch, mockCreateR2Client, mockGetR2Url, mockParseListObjectsXml } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return {
    mockFetch,
    mockCreateR2Client: vi.fn(() => ({ fetch: mockFetch })),
    mockGetR2Url: vi.fn((endpoint: string, bucket: string) => `${endpoint}/${bucket}`),
    mockParseListObjectsXml: vi.fn(),
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
  getR2Config: vi.fn().mockResolvedValue({
    accountId: 'test-account',
    endpoint: 'https://test.r2.cloudflarestorage.com',
  }),
}));

// Import after mocks are set up
import statsRoutes from '../../routes/storage/stats';

describe('Storage Stats Routes / REQ-STOR-006 (storage stats endpoint reports bytes + object counts per tier quota) / REQ-STOR-014 (R2 object listing pagination via continuationToken)', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.clearAllMocks();

    // Default: non-truncated response with one file inside a folder
    mockParseListObjectsXml.mockReturnValue({
      objects: [
        { key: 'folder/test.txt', size: 100, lastModified: '2024-01-01T00:00:00Z' },
      ],
      prefixes: [],
      isTruncated: false,
    });

    mockFetch.mockResolvedValue(new Response('<ListBucketResult></ListBucketResult>', { status: 200 }));
  });

  afterEach(() => {
    vi.clearAllMocks();
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

    app.route('/stats', statsRoutes);
    return app;
  }

  describe('GET /stats', () => {
    it('returns 200 with correct shape', async () => {
      const app = createTestApp();

      const res = await app.request('/stats');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        totalFiles: number;
        totalFolders: number;
        totalSizeBytes: number;
      };
      expect(body).toHaveProperty('totalFiles');
      expect(body).toHaveProperty('totalFolders');
      expect(body).toHaveProperty('totalSizeBytes');
      expect(body.totalFiles).toBe(1);
      expect(body.totalFolders).toBe(1);
      expect(body.totalSizeBytes).toBe(100);
    });

    it('paginates through IsTruncated responses', async () => {
      const { parseListObjectsXml } = await vi.importActual<typeof import('../../lib/r2-client')>('../../lib/r2-client');
      mockParseListObjectsXml.mockImplementation(parseListObjectsXml);
      const page = (key: string, size: number, next?: string) => new Response(
        `<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`
        + `<Name>test-bucket</Name><KeyCount>1</KeyCount><IsTruncated>${Boolean(next)}</IsTruncated>`
        + (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : '')
        + `<Contents><Key>${key}</Key><Size>${size}</Size><LastModified>2024-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>`,
      );
      mockFetch.mockResolvedValueOnce(page('folder1/file1.txt', 50, 'token-abc'))
        .mockResolvedValueOnce(page('folder2/file2.txt', 75));

      const app = createTestApp();

      const res = await app.request('/stats');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        totalFiles: number;
        totalFolders: number;
        totalSizeBytes: number;
      };
      expect(body.totalFiles).toBe(2);
      expect(body.totalFolders).toBe(2);
      expect(body.totalSizeBytes).toBe(125);

      // Should have made 2 fetch calls
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Second call should include the continuation token
      const secondUrl = mockFetch.mock.calls[1][0] as string;
      const urlParams = new URLSearchParams(secondUrl.split('?')[1]);
      expect(urlParams.get('continuation-token')).toBe('token-abc');
    });

    it.each([
      ['missing continuation', ['<IsTruncated>true</IsTruncated>']],
      ['repeated continuation', Array(2).fill('<IsTruncated>true</IsTruncated><NextContinuationToken>same</NextContinuationToken>') as string[]],
      ['missing truncation state', ['']],
      ['ambiguous truncation state', ['<IsTruncated>false</IsTruncated><IsTruncated>unknown</IsTruncated>']],
      ['ambiguous object size', ['<IsTruncated>false</IsTruncated><Contents><Key>bad.txt</Key><Size>1</Size><Size/><LastModified>2024-01-01T00:00:00Z</LastModified></Contents>']],
      ['invalid object size', ['<IsTruncated>false</IsTruncated><Contents><Key>bad.txt</Key><Size>-1</Size><LastModified>2024-01-01T00:00:00Z</LastModified></Contents>']],
    ] as const)('REQ-STOR-014 AC1: refuses to cache a listing with %s', async (_reason, pages) => {
      const { parseListObjectsXml } = await vi.importActual<typeof import('../../lib/r2-client')>('../../lib/r2-client');
      mockParseListObjectsXml.mockImplementation(parseListObjectsXml);
      for (const page of pages) mockFetch.mockResolvedValueOnce(new Response(`<ListBucketResult>${page}</ListBucketResult>`));
      mockFetch.mockImplementation(async () => new Response('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'));
      const response = await createTestApp().request('/stats');
      expect(response.status).toBe(500);
      expect(await mockKV.get('storage-stats:test-bucket', 'json')).toBeNull();
    });

    it('REQ-STOR-014 AC1: a continuation 404 is not an empty bucket', async () => {
      mockParseListObjectsXml.mockReturnValueOnce({ objects: [], prefixes: [], isTruncated: true, nextContinuationToken: 'next' });
      mockFetch.mockResolvedValueOnce(new Response('<ListBucketResult/>'))
        .mockResolvedValueOnce(new Response(null, { status: 404 }));
      const response = await createTestApp().request('/stats');
      expect(response.status).toBe(500);
      expect(await mockKV.get('storage-stats:test-bucket', 'json')).toBeNull();
    });

    it('returns zeroes for a first-page 404', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
      const response = await createTestApp().request('/stats');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ totalFiles: 0, totalFolders: 0, totalSizeBytes: 0 });
    });

    it('uses KV cache when fresh (<60s)', async () => {
      const cachedData = {
        totalFiles: 10,
        totalFolders: 3,
        totalSizeBytes: 5000,
        cachedAt: Date.now(),
      };
      mockKV._set('storage-stats:test-bucket', cachedData);

      const app = createTestApp();

      const res = await app.request('/stats');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        totalFiles: number;
        totalFolders: number;
        totalSizeBytes: number;
      };
      expect(body.totalFiles).toBe(10);
      expect(body.totalFolders).toBe(3);
      expect(body.totalSizeBytes).toBe(5000);

      // Should NOT have called R2
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('refreshes stale cache (>60s)', async () => {
      const staleData = {
        totalFiles: 10,
        totalFolders: 3,
        totalSizeBytes: 5000,
        cachedAt: Date.now() - 61_000, // 61 seconds ago
      };
      mockKV._set('storage-stats:test-bucket', staleData);

      const app = createTestApp();

      const res = await app.request('/stats');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        totalFiles: number;
        totalFolders: number;
        totalSizeBytes: number;
      };
      // Should return fresh data from R2, not stale cache
      expect(body.totalFiles).toBe(1);
      expect(body.totalFolders).toBe(1);
      expect(body.totalSizeBytes).toBe(100);

      // Should have called R2
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Should have updated the cache
      expect(mockKV.put).toHaveBeenCalled();
    });

    it('returns 500 on R2 error', async () => {
      mockFetch.mockResolvedValue(new Response('Error', { status: 403 }));

      const app = createTestApp();

      const res = await app.request('/stats');
      expect(res.status).toBe(500);
    });

    it('derives folder count from object key paths', async () => {
      mockParseListObjectsXml.mockReturnValue({
        objects: [
          { key: 'folder1/a.txt', size: 10, lastModified: '2024-01-01T00:00:00Z' },
          { key: 'folder1/b.txt', size: 20, lastModified: '2024-01-01T00:00:00Z' },
          { key: 'folder2/c.txt', size: 30, lastModified: '2024-01-01T00:00:00Z' },
        ],
        prefixes: [],
        isTruncated: false,
      });

      const app = createTestApp();

      const res = await app.request('/stats');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        totalFiles: number;
        totalFolders: number;
        totalSizeBytes: number;
      };
      expect(body.totalFiles).toBe(3);
      expect(body.totalFolders).toBe(2);
      expect(body.totalSizeBytes).toBe(60);
    });

    it('handles empty bucket', async () => {
      mockParseListObjectsXml.mockReturnValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      const app = createTestApp();

      const res = await app.request('/stats');
      expect(res.status).toBe(200);

      const body = await res.json() as {
        totalFiles: number;
        totalFolders: number;
        totalSizeBytes: number;
      };
      expect(body.totalFiles).toBe(0);
      expect(body.totalFolders).toBe(0);
      expect(body.totalSizeBytes).toBe(0);
    });
  });
});
