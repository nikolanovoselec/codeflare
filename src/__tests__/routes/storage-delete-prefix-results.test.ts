import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../types';
import type { AuthVariables } from '../../middleware/auth';
import { createMockKV } from '../helpers/mock-kv';

// Only the AWS transport and configuration are replaced. The route, XML
// parsing, pagination, and emptyR2Bucket implementation all run unchanged.
vi.mock('aws4fetch', () => ({
  AwsClient: class {
    sign(url: string, init?: RequestInit) { return Promise.resolve(new Request(url, init)); }
    fetch(url: string, init?: RequestInit) { return globalThis.fetch(url, init); }
  },
}));
vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue({
    accountId: 'test-account', endpoint: 'https://test.r2.cloudflarestorage.com',
  }),
}));

import deleteRoute from '../../routes/storage/delete';

const prefix = 'workspace/folder/';
const listing = '<ListBucketResult><IsTruncated>false</IsTruncated>'
  + '<Contents><Key>workspace/folder/a.ts</Key><Size>1</Size><LastModified>2024-01-01T00:00:00Z</LastModified></Contents>'
  + '<Contents><Key>workspace/folder/b.ts</Key><Size>1</Size><LastModified>2024-01-01T00:00:00Z</LastModified></Contents>'
  + '</ListBucketResult>';

describe('Storage Delete Route real prefix results / REQ-STOR-007 AC4', () => {
  let app: Hono<{ Bindings: Env; Variables: AuthVariables }>;
  const transport = vi.fn<typeof fetch>();

  beforeEach(() => {
    transport.mockReset();
    vi.stubGlobal('fetch', transport);
    const kv = createMockKV();
    app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
    app.use('*', async (c, next) => {
      c.env = {
        KV: kv as unknown as KVNamespace,
        R2_ACCESS_KEY_ID: 'test-access-key', R2_SECRET_ACCESS_KEY: 'test-secret-key',
      } as Env;
      c.set('user', { email: 'test@example.com', authenticated: true });
      c.set('bucketName', 'test-bucket');
      return next();
    });
    app.route('/delete', deleteRoute);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reports a quiet per-object error against the prefix, never as completed deletion', async () => {
    transport
      .mockResolvedValueOnce(new Response(listing))
      .mockResolvedValueOnce(new Response('<DeleteResult><Error><Key>workspace/folder/b.ts</Key><Code>AccessDenied</Code><Message>Denied</Message></Error></DeleteResult>'));
    const res = await app.request('/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [prefix] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; deletedPrefixes: unknown[]; errors: { key: string; error: string }[] };
    expect(body.deleted).toEqual([]);
    expect(body.deletedPrefixes).toEqual([]);
    expect(body.errors).toEqual([{ key: prefix, error: expect.any(String) }]);
    expect(body.errors[0].error.length).toBeGreaterThan(0);
  });

  it('reports the completed count for a genuine quiet DeleteResult', async () => {
    transport
      .mockResolvedValueOnce(new Response(listing))
      .mockResolvedValueOnce(new Response('<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>'));
    const res = await app.request('/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [prefix] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: [], deletedPrefixes: [{ prefix, count: 2 }], errors: [],
    });
  });
});
