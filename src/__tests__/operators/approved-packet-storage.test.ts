import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { persistApprovedPacketAttachment, readApprovedPacketAttachment } from '../../operators/attachments';

const bytes = new TextEncoder().encode('{"packet":true}');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const file = { name: 'packet.json', mediaType: 'application/json', locator: 'packet-1', size: bytes.length, sha256 };
const projection = { schemaVersion: 1, activityId: 'activity-1', files: [file] };
const key = '.codeflare/operator-inputs/activity-1/packet-1';

function store(options: { migration?: boolean; encrypted?: boolean; ambiguous?: boolean; existing?: Uint8Array } = {}) {
  const objects = new Map<string, Uint8Array>();
  if (options.existing) objects.set(key, options.existing);
  const requests: { method: string; key: string; headers: Headers; body: Uint8Array }[] = [];
  const fetcher = async (request: Request) => {
    const url = new URL(request.url);
    const objectKey = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    const body = new Uint8Array(await request.arrayBuffer());
    requests.push({ method: request.method, key: objectKey, headers: request.headers, body });
    if (request.method === 'GET') return objects.has(objectKey) ? new Response(objects.get(objectKey)) : new Response(null, { status: 404 });
    if (request.method === 'PUT') {
      if (objects.has(objectKey)) return new Response(null, { status: 412 });
      objects.set(objectKey, body);
      if (options.ambiguous) throw new Error('connection lost after write');
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 405 });
  };
  return { objects, requests, fetcher, migrating: async () => !!options.migration,
    sseDisabled: async () => !options.encrypted };
}

async function persist(input: Uint8Array, fixture: ReturnType<typeof store>, declared = projection) {
  return persistApprovedPacketAttachment({ projection: declared, file, bytes: input,
    ownerBucket: 'owner-bucket', endpoint: 'https://r2.example.test',
    fetcher: fixture.fetcher, authorize: async () => {}, isBucketMigrating: fixture.migrating,
    isSseDisabledForBucket: fixture.sseDisabled,
    sseKey: btoa('k'.repeat(32)) });
}

async function expectDenied(operation: () => Promise<unknown>) {
  // Attach the rejection handler in the same turn as the boundary call.
  const outcome = await operation().then(() => 'accepted', () => 'denied');
  expect(outcome).toBe('denied');
}

describe('REQ-OPERATOR-050/052: parent-owned immutable packet storage', () => {
  it('writes only the fixed owner-bucket key conditionally and verifies exact readback', async () => {
    const fixture = store();
    expect(await persist(bytes, fixture)).toEqual(file);
    expect(fixture.objects.get(key)).toEqual(bytes);
    const put = fixture.requests.find(request => request.method === 'PUT');
    expect(put).toMatchObject({ key, body: bytes });
    expect(put?.headers.get('if-none-match')).toBe('*');
    expect(put?.headers.has('x-amz-server-side-encryption-customer-algorithm')).toBe(false);
  });

  it('accepts the same descriptor after projection reconstruction with reordered fields', async () => {
    const fixture = store();
    const reconstructed = { schemaVersion: 1, activityId: projection.activityId,
      files: [{ locator: file.locator, sha256: file.sha256, size: file.size,
        mediaType: file.mediaType, name: file.name }] };
    expect(await persist(bytes, fixture, reconstructed)).toEqual(file);
    expect(await readApprovedPacketAttachment({ projection: reconstructed,
      file: { sha256: file.sha256, size: file.size, locator: file.locator,
        name: file.name, mediaType: file.mediaType }, ownerBucket: 'owner-bucket',
      endpoint: 'https://r2.example.test', fetcher: fixture.fetcher, authorize: async () => {},
      isBucketMigrating: fixture.migrating, isSseDisabledForBucket: fixture.sseDisabled,
      sseKey: btoa('k'.repeat(32)) })).toEqual(bytes);
  });

  it('replays only verified accepted bytes without another write and denies a changed stored object', async () => {
    const fixture = store();
    await persist(bytes, fixture);
    const received = await readApprovedPacketAttachment({ projection, file, ownerBucket: 'owner-bucket',
      endpoint: 'https://r2.example.test', fetcher: fixture.fetcher, authorize: async () => {},
      isBucketMigrating: fixture.migrating, isSseDisabledForBucket: fixture.sseDisabled,
      sseKey: btoa('k'.repeat(32)) });
    expect(received).toEqual(bytes);
    expect(fixture.requests.filter(request => request.method === 'PUT')).toHaveLength(1);
    fixture.objects.set(key, new TextEncoder().encode('substituted'));
    await expect(readApprovedPacketAttachment({ projection, file, ownerBucket: 'owner-bucket',
      endpoint: 'https://r2.example.test', fetcher: fixture.fetcher, authorize: async () => {},
      isBucketMigrating: fixture.migrating, isSseDisabledForBucket: fixture.sseDisabled,
      sseKey: btoa('k'.repeat(32)) })).rejects.toThrow();
  });

  it('uses the owner bucket encryption regime for both write and verification read', async () => {
    const fixture = store({ encrypted: true });
    expect(await persist(bytes, fixture)).toEqual(file);
    const put = fixture.requests.find(request => request.method === 'PUT');
    const read = fixture.requests.find(request => request.method === 'GET');
    expect(put?.headers.get('x-amz-server-side-encryption-customer-algorithm')).toBe('AES256');
    expect(read?.headers.get('x-amz-server-side-encryption-customer-algorithm')).toBe('AES256');
  });

  it('reconciles an ambiguous conditional write only when the stored bytes are identical', async () => {
    const fixture = store({ ambiguous: true });
    expect(await persist(bytes, fixture)).toEqual(file);
    expect(fixture.objects.get(key)).toEqual(bytes);
    const different = store({ existing: new TextEncoder().encode('substituted') });
    await expect(persist(bytes, different)).rejects.toThrow();
    expect(different.objects.get(key)).toEqual(new TextEncoder().encode('substituted'));
  });

  it('denies revoked authority before any protected R2 I/O', async () => {
    const fixture = store();
    await expect(persistApprovedPacketAttachment({ projection, file, bytes, ownerBucket: 'owner-bucket',
      endpoint: 'https://r2.example.test', fetcher: fixture.fetcher,
      authorize: async () => { throw new Error('Source session stopped'); },
      isBucketMigrating: fixture.migrating, isSseDisabledForBucket: fixture.sseDisabled,
      sseKey: btoa('k'.repeat(32)) })).rejects.toThrow();
    expect(fixture.requests).toEqual([]);
  });

  it('denies migration, missing readback, changed bytes and oversized or symlink-substitute inputs', async () => {
    const migrating = store({ migration: true });
    await expectDenied(() => persist(bytes, migrating));
    expect(migrating.objects.size).toBe(0);
    const changed = store();
    await expectDenied(() => persist(new TextEncoder().encode('changed'), changed));
    expect(changed.objects.size).toBe(0);
    const oversized = store();
    await expectDenied(() => persist(new Uint8Array(8 * 1024 * 1024 + 1), oversized));
    expect(oversized.objects.size).toBe(0);
    const absent = store();
    absent.fetcher = async request => request.method === 'GET' ? new Response(null, { status: 404 })
      : new Response(null, { status: 200 });
    await expectDenied(() => persist(bytes, absent));
    await expectDenied(() => persist({ symlink: '/tmp/packet' } as unknown as Uint8Array, store()));
  });
});
