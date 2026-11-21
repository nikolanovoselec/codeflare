import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createMockR2Config } from '../helpers/mock-factories';
import { createTestApp } from '../helpers/test-app';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { requireActiveUser, type AuthVariables } from '../../middleware/auth';
import { resetAuthConfigCache } from '../../lib/access';
import { signSessionJWT } from '../../lib/session-jwt';
import { AppError } from '../../lib/error-types';
import type { Env } from '../../types';

// Track mock state for assertions - vi.hoisted() ensures these are available when vi.mock() factory runs
const {
  mockFetch,
  mockCreateR2Client,
  mockGetR2Url,
  mockParseListObjectsXml,
  mockCreateBucketIfNotExists,
  mockSeedGettingStartedDocs,
  mockSeedAgentConfigs,
} = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return {
    mockFetch,
    mockCreateR2Client: vi.fn(() => ({ fetch: mockFetch })),
    mockGetR2Url: vi.fn((endpoint: string, bucket: string) => `${endpoint}/${bucket}`),
    mockParseListObjectsXml: vi.fn(),
    mockCreateBucketIfNotExists: vi.fn(async () => ({ success: true, created: true })),
    mockSeedGettingStartedDocs: vi.fn(async () => ({ written: ['Getting-Started.md'], skipped: [] })),
    mockSeedAgentConfigs: vi.fn(async () => ({ written: ['.claude/extensions/env.md'], skipped: [] })),
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
  seedAgentConfigs: mockSeedAgentConfigs,
  reconcileAgentConfigs: vi.fn().mockResolvedValue({ written: [], skipped: [], deleted: [], warnings: [] }),
}));

// Import after mocks are set up
import browseRoutes from '../../routes/storage/browse';

// REQ-SEC-010: Path traversal prevention on storage endpoints
// REQ-STOR-016: File browser presentation and traversal safety

describe('Storage Browse Routes / REQ-STOR-007 (web file browser: browse endpoint with prefix validation, rate-limited)', () => {
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

  describe('REQ-STOR-001 AC3/AC4: authenticated owner-to-object request composition', () => {
    function authenticatedApp() {
      resetAuthConfigCache();
      const owners = new Map<string, string>();
      const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      const secret = 'synthetic-owner-request-secret-32-chars';
      app.onError((error, c) => error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode as ContentfulStatusCode)
        : c.json({ error: error.message }, 500));
      app.use('*', async (c, next) => {
        c.env = {
          KV: mockKV as unknown as KVNamespace,
          SAAS_MODE: 'active', OAUTH_CLIENT_ID: 'fixture-client', OAUTH_JWT_SECRET: secret,
          R2_ACCESS_KEY_ID: 'fixture-key', R2_SECRET_ACCESS_KEY: 'fixture-secret',
          CONTAINER: {
            idFromName: (name: string) => name,
            get: (name: string) => ({
              claimBucketOwner: async (email: string, allowInitialClaim: boolean) => {
                const owner = owners.get(name);
                if (owner === email) return 'owned';
                if (owner) return 'conflict';
                if (!allowInitialClaim) return 'ambiguous';
                owners.set(name, email);
                return 'owned';
              },
            }),
          },
        } as unknown as Env;
        return next();
      });
      app.use('*', requireActiveUser);
      app.route('/browse', browseRoutes);
      const request = async (email: string) => {
        const token = await signSessionJWT({ email, sub: email, ghLogin: 'fixture-user' }, secret);
        return app.request('/browse', { headers: { Cookie: `codeflare_session=${token}` } });
      };
      return { owners, request };
    }

    it('selects distinct claimed owners before R2 reads and preserves the real per-owner request allowance', async () => {
      const { owners, request } = authenticatedApp();
      mockKV._set('user:ab@example.com', { role: 'user', accessTier: 'standard' });
      const objectReads: string[] = [];
      mockFetch.mockImplementation(async (input: string) => {
        const bucket = new URL(input).pathname.slice(1);
        expect(owners.has(`bucket-owner:${bucket}`)).toBe(true);
        objectReads.push(bucket);
        return new Response('<ListBucketResult/>', { status: 200 });
      });
      const ownerWrites: string[] = [];
      const store = mockKV.put.getMockImplementation()!;
      mockKV.put.mockImplementation(async (key, value, options) => {
        if (key.startsWith('bucket-owner:')) {
          ownerWrites.push(key);
          throw new Error('same-key ownership KV write rate limited');
        }
        return store(key, value, options);
      });
      for (let index = 0; index < 30; index++) {
        const response = await request('ab@example.com');
        expect(response.status).toBe(200);
        expect(response.headers.get('X-RateLimit-Remaining')).toBe(String(29 - index));
      }
      const limited = await request('ab@example.com');
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ code: 'RATE_LIMIT_ERROR' });
      mockKV._set('user:a+b@example.com', { role: 'user', accessTier: 'standard' });
      expect((await request('a+b@example.com')).status).toBe(200);
      const secondBucket = objectReads.at(-1)!;
      expect(secondBucket).toMatch(/^codeflare-ab-example-com-v2-[a-f0-9]{20}$/);
      expect(objectReads.slice(0, 30)).toEqual(Array(30).fill('codeflare-ab-example-com'));
      expect(objectReads).toHaveLength(31);
      expect(owners.get(`bucket-owner:${secondBucket}`)).toBe('a+b@example.com');
      expect(owners.get('bucket-owner:codeflare-ab-example-com')).toBe('ab@example.com');
      expect(ownerWrites).toEqual([]);
    });

    it('concurrent authenticated requests read the same owner bucket without ownership-write rate-limit failures', async () => {
      const { owners, request } = authenticatedApp();
      mockKV._set('user:ab@example.com', { role: 'user', accessTier: 'standard' });
      const objectReads: string[] = [];
      mockFetch.mockImplementation(async (input: string) => {
        const bucket = new URL(input).pathname.slice(1);
        expect(owners.get(`bucket-owner:${bucket}`)).toBe('ab@example.com');
        objectReads.push(bucket);
        return new Response('<ListBucketResult/>');
      });
      const ownerWrites: string[] = [];
      const store = mockKV.put.getMockImplementation()!;
      mockKV.put.mockImplementation(async (key, value, options) => {
        if (key.startsWith('bucket-owner:')) {
          ownerWrites.push(key);
          throw new Error('same-key ownership KV write rate limited');
        }
        return store(key, value, options);
      });
      const responses = await Promise.all(Array.from({ length: 12 }, () => request('ab@example.com')));
      expect(responses.map(response => response.status)).toEqual(Array(12).fill(200));
      expect(objectReads).toEqual(Array(12).fill('codeflare-ab-example-com'));
      expect(ownerWrites).toEqual([]);
    });

    it('refuses ambiguous legacy identities before object I/O', async () => {
      const { owners, request } = authenticatedApp();
      for (const email of ['ab@example.com', 'a+b@example.com']) {
        mockKV._set(`user:${email}`, { role: 'user', accessTier: 'standard' });
      }
      const objectReads: string[] = [];
      mockFetch.mockImplementation(async (input: string) => {
        objectReads.push(input);
        return new Response('<ListBucketResult/>');
      });
      for (const email of ['ab@example.com', 'a+b@example.com']) {
        const response = await request(email);
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: 'Ambiguous legacy bucket ownership' });
      }
      expect(objectReads).toEqual([]);
      expect([...owners]).toEqual([]);
    });
  });

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
        { overwrite: false, r2SseDisabled: false }
      );
      expect(mockSeedAgentConfigs).toHaveBeenCalledWith(
        expect.any(Object),
        'test-bucket',
        'https://test.r2.cloudflarestorage.com',
        { overwrite: false, mode: 'default', contextModeEnabled: false, r2SseDisabled: false }
      );
    });
  });
});
