import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { ValidationError } from '../../lib/error-types';
import { createMockKV } from '../helpers/mock-kv';

const mockFetch = vi.fn();
const mockEmptyR2Bucket = vi.fn();

vi.mock('../../lib/r2-client', () => ({
  createR2Client: vi.fn(() => ({ fetch: mockFetch })),
  getR2Url: vi.fn((endpoint: string, bucket: string, key?: string) =>
    key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`
  ),
  emptyR2Bucket: (...args: unknown[]) => mockEmptyR2Bucket(...args),
}));

vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue({
    accountId: 'test-account',
    endpoint: 'https://test.r2.cloudflarestorage.com',
  }),
}));

describe('Storage Delete Route', () => {
  let app: Hono<{ Bindings: Env; Variables: AuthVariables }>;
  let deleteRoute: typeof import('../../routes/storage/delete').default;
  let envOverrides: Partial<Env>;
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    mockEmptyR2Bucket.mockReset();
    envOverrides = {};
    mockKV = createMockKV();

    // Dynamic import to pick up fresh mocks
    const mod = await import('../../routes/storage/delete');
    deleteRoute = mod.default;

    app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

    // Error handler matching project pattern
    app.onError((err, c) => {
      if (err instanceof ValidationError) {
        return c.json(err.toJSON(), err.statusCode as ContentfulStatusCode);
      }
      return c.json({ error: err.message }, 500);
    });

    // Mock middleware
    app.use('*', async (c, next) => {
      c.env = { KV: mockKV as unknown as KVNamespace, ...envOverrides } as Env;
      c.set('user', { email: 'test@example.com', authenticated: true });
      c.set('bucketName', 'test-bucket');
      return next();
    });

    app.route('/delete', deleteRoute);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- Validation tests ---

  it('rejects empty keys array with no prefixes with 400', async () => {
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects request with neither keys nor prefixes with 400', async () => {
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects keys with path traversal (..) with 400', async () => {
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/../etc/passwd'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toContain('path traversal');
  });

  it('rejects keys starting with / with 400', async () => {
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['/absolute/path.ts'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toContain('must not start with /');
  });

  it('allows previously protected path .claude/ (PROTECTED_PATHS is now empty)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['.claude/settings.json'] }),
    });

    expect(res.status).toBe(200);
  });

  it('allows previously protected path .anthropic/ (PROTECTED_PATHS is now empty)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['.anthropic/config'] }),
    });

    expect(res.status).toBe(200);
  });

  it('allows previously protected path .ssh/ (PROTECTED_PATHS is now empty)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['.ssh/id_rsa'] }),
    });

    expect(res.status).toBe(200);
  });

  it('allows nested previously protected path (PROTECTED_PATHS is now empty)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/.claude/secrets'] }),
    });

    expect(res.status).toBe(200);
  });

  it('rejects more than 1000 keys with 400', async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `file-${i}.ts`);

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toContain('1000');
  });

  // --- Single delete tests ---

  it('allows previously protected paths (PROTECTED_PATHS is now empty)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['.claude/settings.json'] }),
    });

    expect(res.status).toBe(200);
  });

  it('single delete succeeds and returns key in deleted array', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/old-file.ts'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual(['workspace/old-file.ts']);
    expect(body.errors).toEqual([]);

    // Verify correct URL was called
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('workspace/old-file.ts');
    expect(opts.method).toBe('DELETE');
  });

  it('single delete handles R2 error gracefully', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/missing.ts'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual([]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].key).toBe('workspace/missing.ts');
    expect(body.errors[0].error).toContain('404');
  });

  it('single delete handles network error gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/file.ts'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual([]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].error).toBe('Network timeout');
  });

  // --- Batch delete tests ---

  it('batch delete with multiple keys calls batch endpoint', async () => {
    const batchResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
      <DeleteResult>
        <Deleted><Key>workspace/a.ts</Key></Deleted>
        <Deleted><Key>workspace/b.ts</Key></Deleted>
      </DeleteResult>`;

    mockFetch.mockResolvedValueOnce(new Response(batchResponseXml, { status: 200 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/a.ts', 'workspace/b.ts'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual(['workspace/a.ts', 'workspace/b.ts']);
    expect(body.errors).toEqual([]);

    // Verify batch endpoint was called (POST with ?delete)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('?delete');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/xml');
  });

  it('batch delete returns mixed results (some deleted, some errors)', async () => {
    const batchResponseXml = `<?xml version="1.0" encoding="UTF-8"?>
      <DeleteResult>
        <Deleted><Key>workspace/a.ts</Key></Deleted>
        <Error><Key>workspace/b.ts</Key><Code>AccessDenied</Code><Message>Access Denied</Message></Error>
      </DeleteResult>`;

    mockFetch.mockResolvedValueOnce(new Response(batchResponseXml, { status: 200 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/a.ts', 'workspace/b.ts'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual(['workspace/a.ts']);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].key).toBe('workspace/b.ts');
    expect(body.errors[0].error).toBe('Access Denied');
  });

  it('batch delete falls back to individual deletes when batch fails', async () => {
    // Batch request fails
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));
    // Individual deletes succeed
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/a.ts', 'workspace/b.ts'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual(['workspace/a.ts', 'workspace/b.ts']);
    expect(body.errors).toEqual([]);

    // 1 batch call + 2 individual calls
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('batch delete handles complete network failure', async () => {
    // Batch request throws
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/a.ts', 'workspace/b.ts'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual([]);
    expect(body.errors).toHaveLength(2);
    expect(body.errors[0].error).toBe('Batch delete failed');
    expect(body.errors[1].error).toBe('Batch delete failed');
  });

  it('batch delete with unparseable XML response assumes all succeeded', async () => {
    // Response is OK but XML has no <Deleted> or <Error> tags
    mockFetch.mockResolvedValueOnce(new Response('<DeleteResult></DeleteResult>', { status: 200 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/a.ts', 'workspace/b.ts'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; errors: Array<{ key: string; error: string }> };
    // When no results parsed, assume all succeeded
    expect(body.deleted).toEqual(['workspace/a.ts', 'workspace/b.ts']);
    expect(body.errors).toEqual([]);
  });

  // --- Cache invalidation tests ---

  it('invalidates storage-stats KV cache after successful single delete', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/file.ts'] }),
    });

    expect(res.status).toBe(200);
    expect(mockKV.delete).toHaveBeenCalledWith('storage-stats:test-bucket');
  });

  it('invalidates storage-stats KV cache after successful batch delete', async () => {
    const batchResponseXml = `<DeleteResult><Deleted><Key>workspace/a.ts</Key></Deleted></DeleteResult>`;
    mockFetch.mockResolvedValueOnce(new Response(batchResponseXml, { status: 200 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/a.ts', 'workspace/b.ts'] }),
    });

    expect(res.status).toBe(200);
    expect(mockKV.delete).toHaveBeenCalledWith('storage-stats:test-bucket');
  });

  // --- Prefix delete tests ---

  it('prefix delete calls emptyR2Bucket with correct prefix and returns count', async () => {
    mockEmptyR2Bucket.mockResolvedValueOnce(42);

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: ['workspace/folder/'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; deletedPrefixes: { prefix: string; count: number }[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual([]);
    expect(body.deletedPrefixes).toEqual([{ prefix: 'workspace/folder/', count: 42 }]);
    expect(body.errors).toEqual([]);

    expect(mockEmptyR2Bucket).toHaveBeenCalledWith(
      expect.anything(), // r2Client
      'https://test.r2.cloudflarestorage.com',
      'test-bucket',
      'workspace/folder/',
    );
  });

  it('handles mixed keys + prefixes in single request', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 })); // single key delete
    mockEmptyR2Bucket.mockResolvedValueOnce(10);

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keys: ['workspace/file.ts'],
        prefixes: ['workspace/folder/'],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; deletedPrefixes: { prefix: string; count: number }[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual(['workspace/file.ts']);
    expect(body.deletedPrefixes).toEqual([{ prefix: 'workspace/folder/', count: 10 }]);
    expect(body.errors).toEqual([]);
  });

  it('prefix validation rejects path traversal', async () => {
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: ['workspace/../etc/'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toContain('path traversal');
  });

  it('prefix validation rejects prefix starting with /', async () => {
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: ['/absolute/path/'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toContain('must not start with /');
  });

  it('keys-only request still works (backward compat)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/file.ts'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; deletedPrefixes: { prefix: string; count: number }[]; errors: Array<{ key: string; error: string }> };
    expect(body.deleted).toEqual(['workspace/file.ts']);
    expect(body.deletedPrefixes).toEqual([]);
    expect(mockEmptyR2Bucket).not.toHaveBeenCalled();
  });

  it('invalidates stats cache after prefix delete', async () => {
    mockEmptyR2Bucket.mockResolvedValueOnce(5);

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: ['workspace/folder/'] }),
    });

    expect(res.status).toBe(200);
    expect(mockKV.delete).toHaveBeenCalledWith('storage-stats:test-bucket');
  });

  it('does not invalidate stats cache when prefix delete returns 0 objects', async () => {
    mockEmptyR2Bucket.mockResolvedValueOnce(0);

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: ['workspace/empty/'] }),
    });

    expect(res.status).toBe(200);
    expect(mockKV.delete).not.toHaveBeenCalled();
  });

  it('handles emptyR2Bucket error gracefully and reports in errors', async () => {
    mockEmptyR2Bucket.mockRejectedValueOnce(new Error('ListObjectsV2 failed: HTTP 403'));

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: ['workspace/folder/'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; deletedPrefixes: { prefix: string; count: number }[]; errors: Array<{ key: string; error: string }> };
    expect(body.deletedPrefixes).toEqual([]);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].key).toBe('workspace/folder/');
    expect(body.errors[0].error).toContain('ListObjectsV2 failed');
  });

  it('response includes deletedPrefixes with counts for multiple prefixes', async () => {
    mockEmptyR2Bucket.mockResolvedValueOnce(10);
    mockEmptyR2Bucket.mockResolvedValueOnce(25);

    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: ['workspace/a/', 'workspace/b/'] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { deletedPrefixes: { prefix: string; count: number }[] };
    expect(body.deletedPrefixes).toEqual([
      { prefix: 'workspace/a/', count: 10 },
      { prefix: 'workspace/b/', count: 25 },
    ]);
  });
});
