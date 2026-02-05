import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { ValidationError } from '../../lib/error-types';

const mockFetch = vi.fn();

vi.mock('../../lib/r2-client', () => ({
  createR2Client: vi.fn(() => ({ fetch: mockFetch })),
  getR2Url: vi.fn((endpoint: string, bucket: string, key?: string) =>
    key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`
  ),
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

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    envOverrides = {};

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
      c.env = { ...envOverrides } as Env;
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

  it('rejects empty keys array with 400', async () => {
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing keys field with 400', async () => {
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

  it('rejects protected path .claude/ with 400 when enabled', async () => {
    envOverrides.PROTECTED_PATHS_ENABLED = 'true';
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['.claude/settings.json'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toContain('protected path');
  });

  it('rejects protected path .anthropic/ with 400 when enabled', async () => {
    envOverrides.PROTECTED_PATHS_ENABLED = 'true';
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['.anthropic/config'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects protected path .ssh/ with 400 when enabled', async () => {
    envOverrides.PROTECTED_PATHS_ENABLED = 'true';
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['.ssh/id_rsa'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects nested protected path with 400 when enabled', async () => {
    envOverrides.PROTECTED_PATHS_ENABLED = 'true';
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['workspace/.claude/secrets'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
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

  it('rejects protected paths (protection always on)', async () => {
    const res = await app.request('/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['.claude/settings.json'] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; code: string };
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toContain('protected');
  });

  it('single delete succeeds and returns key in deleted array', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', { status: 204 }));

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
    mockFetch.mockResolvedValueOnce(new Response('', { status: 204 }));
    mockFetch.mockResolvedValueOnce(new Response('', { status: 204 }));

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
});
