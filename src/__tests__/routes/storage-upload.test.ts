import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import type { Env } from '../../types';
import { createMockR2Config } from '../helpers/mock-factories';
import { createTestApp } from '../helpers/test-app';

const mockFetch = vi.fn();
const managedState = vi.hoisted(() => ({ snapshot: { configured: false, enabled: false } as any }));

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
vi.mock('../../lib/remote-curation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/remote-curation')>()),
  readManagedEnvironmentSnapshot: vi.fn(async () => managedState.snapshot),
}));

import uploadRoutes, { performBucketMultipart } from '../../routes/storage/upload';
import deleteRoutes from '../../routes/storage/delete';

// REQ-STOR-007: Web File Browser

describe('Storage Upload Routes / REQ-STOR-008 (file upload via direct-to-R2 PUT)', () => {
  let mockKV: ReturnType<typeof createMockKV>;
  let multipartReceipts: Map<string, unknown>;
  const seedManagedUpload = (key: string, id: string) => multipartReceipts.set(`multipart:upload:${id}`, { key, generation: 0, regime: 'sse-c' });

  beforeEach(() => {
    mockKV = createMockKV();
    multipartReceipts = new Map();
    mockFetch.mockReset();
    managedState.snapshot = { configured: false, enabled: false };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createApp(bucketName = 'test-bucket', envOverrides: Partial<Env> = {}) {
    const env = { KV: mockKV, R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret', ...envOverrides } as unknown as Env;
    const storage = {
      get: async (key: string) => multipartReceipts.get(key),
      put: async (key: string, value: unknown) => { multipartReceipts.set(key, value); },
      delete: async (key: string) => multipartReceipts.delete(key),
    } as unknown as Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;
    return createTestApp({
      routes: [{ path: '/upload', handler: uploadRoutes }, { path: '/delete', handler: deleteRoutes }],
      mockKV, bucketName,
      envOverrides: { ...env, CONTAINER: { getByName: () => ({ runBucketMultipart: async (input: Parameters<typeof performBucketMultipart>[2] | Request) => performBucketMultipart(env, storage, input instanceof Request ? await input.json() as Parameters<typeof performBucketMultipart>[2] : input) }) } as unknown as Env['CONTAINER'] },
    });
  }

  async function configureProtectedPolicy() {
    const releaseDigest = 'd'.repeat(64);
    const policyValue = {
      schemaVersion: 1, releaseDigest, resourcePolicy: 'immutable',
      paths: ['.codeflare/managed-paths.json'], resourceRoots: [],
    };
    const policyBytes = new TextEncoder().encode(`${JSON.stringify(policyValue)}\n`);
    const pathsDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', policyBytes)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    managedState.snapshot = {
      configured: true, enabled: true,
      config: { resourcePolicy: 'immutable' },
      active: { digest: releaseDigest, sequence: 1 },
    };
    mockKV._set('user-prefs:test-bucket', {
      managedEnvironmentApplied: {
        digest: releaseDigest, sequence: 1, mode: 'default', managedExtensionsDigest: 'e'.repeat(64),
        resourcePolicy: 'immutable', managedPathsDigest: pathsDigest,
        projectionIdentity: 'v1:claude-code,codex,copilot,antigravity,opencode,pi',
        appliedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    mockFetch.mockResolvedValue(new Response(policyBytes, { status: 200 }));
  }

  it.each([
    ['/upload', { content: 'aGk=' }, 'PUT'],
    ['/upload/initiate', {}, 'POST'],
    ['/upload/part', { uploadId: 'u', partNumber: 1, content: 'aGk=' }, 'PUT'],
    ['/upload/complete', { uploadId: 'u', parts: [{ partNumber: 1, etag: 'abc' }] }, 'POST'],
    ['/upload/abort', { uploadId: 'u' }, 'DELETE'],
  ])('allows ordinary upload operation %s while managed reconciliation is pending', async (path, payload, method) => {
    seedManagedUpload('Uploads/report.txt', 'u');
    mockKV._set('user-prefs:test-bucket', {
      managedEnvironmentReconciliation: { targets: [{ digest: 'd'.repeat(64), sequence: 1, mode: 'default' }] },
    });
    mockFetch.mockResolvedValueOnce(new Response(path === '/upload/complete' ? '<CompleteMultipartUploadResult><ETag>"abc"</ETag></CompleteMultipartUploadResult>' : '', { status: 200, headers: { ETag: 'abc' } }));
    const response = await createApp().request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, key: 'Uploads/report.txt' }),
    });
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][1].method).toBe(method);
  });

  it.each([
    ['/upload', { key: '.codeflare/managed-paths.json', content: btoa('replacement') }],
    ['/delete', { keys: ['.codeflare/managed-paths.json'] }],
    ['/delete', { keys: ['.codeflare/managed-paths.json', 'Uploads/user.txt'] }],
    ['/delete', { prefixes: ['.codeflare/'] }],
  ])('REQ-ENTERPRISE-030 AC1: migration refusal precedes conflicting managed policy for %s (%j)', async (path, payload) => {
    await configureProtectedPolicy();
    mockKV._set('r2-regime:test-bucket', {
      status: 'migrating', regime: 'sse-c', from: 'sse-c', to: 'plain', generation: 1,
    });
    const response = await createApp().request(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'BUCKET_MIGRATING' });
    // Neither policy retrieval nor protected object read/write/delete may occur.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['/upload', { content: btoa('bytes') }],
    ['/upload/initiate', {}],
    ['/upload/part', { uploadId: 'u', partNumber: 1, content: btoa('part') }],
  ])('REQ-SEC-005: %s emits SSE-C only for the committed encrypted regime', async (path, payload) => {
    const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const app = createApp('test-bucket', { ENCRYPTION_KEY });
    for (const regime of ['sse-c', 'plain']) {
      mockKV._set('r2-regime:test-bucket', { status: 'ready', regime, generation: 1 });
      mockFetch.mockClear().mockImplementation(async () => new Response('', { headers: { ETag: 'part-etag' } }));
      let uploadId: string | undefined;
      if (path === '/upload/part') {
        const initiated = await app.request('/upload/initiate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'Uploads/file.txt' }),
        });
        expect(initiated.status).toBe(200);
        ({ uploadId } = await initiated.json() as { uploadId: string });
        mockFetch.mockClear();
      }
      const response = await app.request(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'Uploads/file.txt', ...payload, ...(uploadId ? { uploadId } : {}) }),
      });
      expect(response.status).toBe(200);
      const headers = new Headers(mockFetch.mock.calls[0][1].headers);
      expect(headers.get('x-amz-server-side-encryption-customer-key')).toBe(regime === 'sse-c' ? ENCRYPTION_KEY : null);
      expect(headers.get('x-amz-server-side-encryption-customer-algorithm')).toBe(regime === 'sse-c' ? 'AES256' : null);
      expect(headers.has('x-amz-server-side-encryption-customer-key-MD5')).toBe(regime === 'sse-c');
    }
  });

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

    it('REQ-ENTERPRISE-030: denies protected upload before the user-object R2 request', async () => {
      await configureProtectedPolicy();
      const app = createApp();

      const res = await app.request('/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '.codeflare/managed-paths.json', content: btoa('replacement') }),
      });

      expect(res.status).toBe(403);
      expect(mockFetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    });

    it.each([
      ['/upload/initiate', { key: '.codeflare/managed-paths.json' }],
      ['/upload/part', { key: '.codeflare/managed-paths.json', uploadId: 'u', partNumber: 1, content: btoa('part') }],
      ['/upload/complete', { key: '.codeflare/managed-paths.json', uploadId: 'u', parts: [{ partNumber: 1, etag: 'abc' }] }],
      ['/upload/abort', { key: '.codeflare/managed-paths.json', uploadId: 'u' }],
    ])('REQ-ENTERPRISE-030: denies protected multipart mutation at %s before user R2', async (path, body) => {
      await configureProtectedPolicy();
      const app = createApp();
      const res = await app.request(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
      expect(mockFetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
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

    it('allows previously sensitive paths (.ssh/) (PROTECTED_PATHS is now empty)', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '.ssh/id_rsa', content: btoa('x') }),
      });

      expect(res.status).toBe(200);
    });

    it('allows previously sensitive paths (.anthropic/) (PROTECTED_PATHS is now empty)', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '.anthropic/auth.json', content: btoa('x') }),
      });

      expect(res.status).toBe(200);
    });

    it('allows previously sensitive paths (.config/) (PROTECTED_PATHS is now empty)', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'foo/.config/secrets', content: btoa('x') }),
      });

      expect(res.status).toBe(200);
    });

    it('allows previously sensitive paths (.claude.json) (PROTECTED_PATHS is now empty)', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '.claude.json', content: btoa('x') }),
      });

      expect(res.status).toBe(200);
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

    it('returns 400 ValidationError for invalid base64 content (FIX-10)', async () => {
      const app = createApp();

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test.txt', content: '!!!not-valid-base64!!!' }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('Invalid base64 content');
    });
  });

  // ── Multipart initiate ─────────────────────────────────────────────
  // REQ-STOR-008 AC1: POST /api/storage/upload/initiate creates a multipart upload and returns an upload ID

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
  // REQ-STOR-008 AC2: POST /api/storage/upload/part uploads a single part (base64 body) for a given upload ID

  describe('POST /upload/part (multipart part)', () => {
    it('returns etag on success', async () => {
      seedManagedUpload('workspace/large.zip', 'upload-id-123');
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

    it('allows previously protected key (.ssh/) (PROTECTED_PATHS is now empty)', async () => {
      seedManagedUpload('.ssh/id_rsa', 'upload-id-123');
      const app = createApp();
      mockFetch.mockResolvedValueOnce(
        new Response('', { status: 200, headers: { etag: '"abc"' } })
      );

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

      expect(res.status).toBe(200);
    });

    it('returns 400 ValidationError for invalid base64 content in part upload (FIX-10)', async () => {
      seedManagedUpload('workspace/large.zip', 'upload-id-123');
      const app = createApp();

      const res = await app.request('/upload/part', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'workspace/large.zip',
          uploadId: 'upload-id-123',
          partNumber: 1,
          content: '!!!not-valid-base64!!!',
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json() as { error: string; code: string };
      expect(body.code).toBe('VALIDATION_ERROR');
      expect(body.error).toContain('Invalid base64 content');
    });

    it('sends partNumber and uploadId in URL', async () => {
      seedManagedUpload('file.bin', 'uid-42');
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
  // REQ-STOR-008 AC3: POST /api/storage/upload/complete finalizes the multipart upload

  describe('POST /upload/complete (multipart complete)', () => {
    it.each(['unknown', 'old-generation'] as const)('REQ-ENTERPRISE-086: %s completion returns actionable restart without R2 writes', async state => {
      if (state === 'old-generation') seedManagedUpload('held.bin', 'old-id');
      mockKV._set('r2-regime:test-bucket', { status: 'ready', regime: 'plain', generation: 1 });
      let remoteParts = 'preserved';
      mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST' || init?.method === 'DELETE') remoteParts = 'consumed';
        return new Response('<CompleteMultipartUploadResult><ETag>"abc"</ETag></CompleteMultipartUploadResult>');
      });
      const response = await createApp().request('/upload/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'held.bin', uploadId: state === 'unknown' ? 'unknown' : 'old-id', parts: [{ partNumber: 1, etag: 'abc' }] }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'MULTIPART_RESTART_REQUIRED', error: expect.stringMatching(/restart/i) });
      expect(remoteParts).toBe('preserved');
    });

    it.each(['', '<Error><Code>InternalError</Code></Error>', '<CompleteMultipartUploadResult><ETag></ETag></CompleteMultipartUploadResult>'])(
      'REQ-ENTERPRISE-086: unverifiable completion response %s retains recovery admission', async result => {
        seedManagedUpload('held.bin', 'held-id');
        mockFetch.mockResolvedValueOnce(new Response(result));
        const app = createApp();
        const response = await app.request('/upload/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'held.bin', uploadId: 'held-id', parts: [{ partNumber: 1, etag: 'abc' }] }),
        });
        expect(response.status).not.toBe(200);
        const successor = await app.request('/upload/initiate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'next.bin' }) });
        expect(successor.status).toBe(409);
        expect(await successor.json()).toMatchObject({ code: 'MULTIPART_RESTART_REQUIRED' });
      });

    it('succeeds with valid parts', async () => {
      seedManagedUpload('workspace/large.zip', 'upload-id-123');
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('<CompleteMultipartUploadResult><ETag>"abc"</ETag></CompleteMultipartUploadResult>', { status: 200 }));

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
      seedManagedUpload('file.zip', 'uid');
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('<CompleteMultipartUploadResult><ETag>"abc"</ETag></CompleteMultipartUploadResult>', { status: 200 }));

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
  // REQ-STOR-008 AC4: POST /api/storage/upload/abort cancels an in-progress multipart upload

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

    it('does not report success when R2 rejects the bucket-scoped abort', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('denied', { status: 403 }));

      const res = await app.request('/upload/abort', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'workspace/large.zip', uploadId: 'upload-id-123' }),
      });

      expect(res.status).toBe(500);
    });

    it('allows previously protected key (.anthropic/) (PROTECTED_PATHS is now empty)', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const res = await app.request('/upload/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: '.anthropic/token',
          uploadId: 'uid',
        }),
      });

      expect(res.status).toBe(200);
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

  // ── Rate limit shared by all multipart endpoints ────────────────────────
  // REQ-STOR-008 AC5: all multipart upload endpoints share the upload rate
  // limit (60/min). The upload router registers storageUploadRateLimiter via
  // app.use('*', ...) so a single KV-backed limiter covers /, /initiate,
  // /part, /complete, and /abort.
  describe('REQ-STOR-008 AC5: shared rate limit across multipart endpoints', () => {
    it('exhausting limit on /upload/initiate causes a subsequent /upload/part to 429', async () => {
      const app = createApp();
      // Each /upload/initiate hits R2 once and consumes the response body via
      // response.text(). A single shared Response would have its body locked
      // after the first call, so use mockImplementation to build a fresh one
      // per invocation.
      mockFetch.mockImplementation(async () => new Response('<xml/>', { status: 200 }));

      // Exhaust the 60/min limit by making 60 successful /upload/initiate calls.
      for (let i = 0; i < 60; i++) {
        const res = await app.request('/upload/initiate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: `workspace/file-${i}.ts` }),
        });
        expect(res.status, `initiate call ${i + 1} should succeed`).toBe(200);
      }

      // 61st call to a DIFFERENT endpoint must 429 — proving the limiter is
      // shared, not per-route. If each endpoint had its own bucket this would
      // return 200 (or its normal failure code, not 429).
      const res = await app.request('/upload/part', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'workspace/file.ts',
          uploadId: 'upload-id-123',
          partNumber: 1,
          content: btoa('chunk'),
        }),
      });
      expect(res.status).toBe(429);
    });

    it('exhausting limit on /upload/part causes /upload/complete to 429', async () => {
      seedManagedUpload('workspace/file.ts', 'upload-id-123');
      const app = createApp();
      // Fresh Response per call (same reasoning as the test above; /upload/part
      // reads response.headers and the body slot is implicitly tied to the
      // single Response instance).
      mockFetch.mockImplementation(async () =>
        new Response('', { status: 200, headers: { etag: '"e"' } })
      );

      for (let i = 0; i < 60; i++) {
        const res = await app.request('/upload/part', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: 'workspace/file.ts',
            uploadId: 'upload-id-123',
            partNumber: i + 1,
            content: btoa('x'),
          }),
        });
        expect(res.status, `part call ${i + 1} should succeed`).toBe(200);
      }

      const res = await app.request('/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'workspace/file.ts',
          uploadId: 'upload-id-123',
          parts: [{ partNumber: 1, etag: 'e' }],
        }),
      });
      expect(res.status).toBe(429);
    });
  });

  // ── Storage-stats cache invalidation ────────────────────────────

  describe('storage-stats cache invalidation', () => {
    it('invalidates KV cache after successful simple upload', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 200 }));

      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'workspace/file.ts', content: btoa('hello') }),
      });

      expect(res.status).toBe(200);
      expect(mockKV.delete).toHaveBeenCalledWith('storage-stats:test-bucket');
    });

    it('invalidates KV cache after successful multipart complete', async () => {
      seedManagedUpload('workspace/large.zip', 'uid');
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('<CompleteMultipartUploadResult><ETag>"abc"</ETag></CompleteMultipartUploadResult>', { status: 200 }));

      const res = await app.request('/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'workspace/large.zip',
          uploadId: 'uid',
          parts: [{ partNumber: 1, etag: 'a' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(mockKV.delete).toHaveBeenCalledWith('storage-stats:test-bucket');
    });

    it('does not invalidate cache when simple upload fails', async () => {
      const app = createApp();
      mockFetch.mockResolvedValueOnce(new Response('', { status: 500 }));

      await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'test.txt', content: btoa('hello') }),
      });

      expect(mockKV.delete).not.toHaveBeenCalledWith('storage-stats:test-bucket');
    });
  });

  // REQ-ENTERPRISE-021: every write path is gated 409 while the bucket's encryption regime is
  // migrating, so no object can land in the wrong (pre-flip) regime. The gate short-circuits
  // before any R2 call.
  describe('Governed Mode write gate (REQ-ENTERPRISE-021)', () => {
    function migratingApp() {
      mockKV._set('r2-regime:test-bucket', { status: 'migrating', regime: 'sse-c', from: 'sse-c', to: 'plain', generation: 0 });
      return createApp();
    }

    it('blocks a simple upload with 409 BUCKET_MIGRATING and never touches R2', async () => {
      const app = migratingApp();
      const res = await app.request('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'workspace/file.ts', content: btoa('hi') }),
      });
      expect(res.status).toBe(409);
      expect((await res.json() as { code: string }).code).toBe('BUCKET_MIGRATING');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('blocks multipart initiate / part / complete with 409', async () => {
      const app = migratingApp();
      const post = (path: string, body: unknown) =>
        app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

      const initiate = await post('/upload/initiate', { key: 'big.bin' });
      const part = await post('/upload/part', { key: 'big.bin', uploadId: 'u1', partNumber: 1, content: btoa('x') });
      const complete = await post('/upload/complete', { key: 'big.bin', uploadId: 'u1', parts: [{ partNumber: 1, etag: 'e' }] });

      expect(initiate.status).toBe(409);
      expect(part.status).toBe(409);
      expect(complete.status).toBe(409);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('blocks multipart abort during migration before user R2', async () => {
      const app = migratingApp();
      const res = await app.request('/upload/abort', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'big.bin', uploadId: 'u1' }),
      });
      expect(res.status).toBe(409);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
