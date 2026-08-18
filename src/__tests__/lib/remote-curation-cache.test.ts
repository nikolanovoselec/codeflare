import { describe, expect, it, vi } from 'vitest';
import {
  activateManagedRelease,
  createR2ManagedReleaseCache,
  getManagedReleaseCacheBucketName,
  type ActiveManagedRelease,
  type ManagedReleaseCache,
} from '../../lib/remote-curation-cache';

vi.mock('../../lib/r2-client', () => ({
  createR2Client: () => ({
    sign: async (url: string, init?: RequestInit) => new Request(url, init),
  }),
  getR2Url: (endpoint: string, bucket: string, key?: string) =>
    `${endpoint.replace(/\/$/, '')}/${bucket}${key ? `/${key}` : ''}`,
}));

function pointer(sequence: number, digest: string): ActiveManagedRelease {
  return {
    schemaVersion: 1,
    sequence,
    digest,
    repositoryId: 123,
    sourceCommit: String(sequence).padStart(40, 'a').slice(-40),
    seedAbi: 1,
    releaseId: sequence,
    releaseTag: `release-${sequence}`,
    runtimeDependencyHash: 'c'.repeat(64),
    activatedAt: '2026-08-18T00:00:00.000Z',
  };
}

function memoryCache(initial?: { pointer: ActiveManagedRelease; etag: string }) {
  let active = initial;
  const objects = new Map<string, Uint8Array>();
  const cache: ManagedReleaseCache = {
    putImmutable: vi.fn(async (key, bytes) => {
      if (!objects.has(key)) objects.set(key, bytes);
    }),
    readActive: vi.fn(async () => active),
    createActive: vi.fn(async (next) => {
      if (active) return false;
      active = { pointer: next, etag: 'created' };
      return true;
    }),
    replaceActive: vi.fn(async (next, etag) => {
      if (!active || active.etag !== etag) return false;
      active = { pointer: next, etag: `etag-${next.sequence}` };
      return true;
    }),
  };
  return { cache, objects, getActive: () => active };
}

// REQ-STOR-020: activation is content-addressed and monotonic under races.
describe('managed release deployment cache', () => {
  it('REQ-STOR-020 AC1+AC2: active release cache is content-addressed and monotonic', async () => {
    const state = memoryCache();
    const candidate = pointer(2, 'd'.repeat(64));

    const active = await activateManagedRelease({
      cache: state.cache,
      candidate,
      bundle: new Uint8Array([1, 2]),
      signature: new Uint8Array([3]),
    });

    expect(active).toEqual(candidate);
    expect([...state.objects.keys()].sort()).toEqual([
      `releases/${candidate.digest}/seed-v1.json.gz`,
      `releases/${candidate.digest}/seed-v1.sig`,
    ]);
    expect(state.cache.createActive).toHaveBeenCalledTimes(1);
  });

  it('keeps a higher active sequence and rejects conflicting identity at the same sequence', async () => {
    const higher = pointer(9, '9'.repeat(64));
    const state = memoryCache({ pointer: higher, etag: 'current' });

    await expect(activateManagedRelease({
      cache: state.cache,
      candidate: pointer(8, '8'.repeat(64)),
      bundle: new Uint8Array([8]),
      signature: new Uint8Array([8]),
    })).resolves.toEqual(higher);

    await expect(activateManagedRelease({
      cache: state.cache,
      candidate: pointer(9, 'x'.repeat(64)),
      bundle: new Uint8Array([9]),
      signature: new Uint8Array([9]),
    })).rejects.toThrow(/same sequence/i);
    expect(state.cache.replaceActive).not.toHaveBeenCalled();
  });

  it('rereads once after a lost CAS and accepts the winning higher sequence', async () => {
    const state = memoryCache({ pointer: pointer(1, '1'.repeat(64)), etag: 'old' });
    const winner = pointer(3, '3'.repeat(64));
    vi.mocked(state.cache.replaceActive).mockImplementationOnce(async () => {
      vi.mocked(state.cache.readActive).mockResolvedValueOnce({ pointer: winner, etag: 'winner' });
      return false;
    });

    const active = await activateManagedRelease({
      cache: state.cache,
      candidate: pointer(2, '2'.repeat(64)),
      bundle: new Uint8Array([2]),
      signature: new Uint8Array([2]),
    });

    expect(active).toEqual(winner);
    expect(state.cache.readActive).toHaveBeenCalledTimes(2);
  });
});

describe('R2 managed release cache boundary', () => {
  it('derives a stable deployment bucket from both account and worker identity', async () => {
    const first = await getManagedReleaseCacheBucketName(' account-1 ', 'worker-a');
    expect(first).toMatch(/^codeflare-managed-[0-9a-f]{24}$/);
    await expect(getManagedReleaseCacheBucketName('account-1', 'worker-a')).resolves.toBe(first);
    await expect(getManagedReleaseCacheBucketName('account-1', 'worker-b')).resolves.not.toBe(first);
    await expect(getManagedReleaseCacheBucketName('account-2', 'worker-a')).resolves.not.toBe(first);
  });

  it('uses configuration-scoped pointer keys, real create/update CAS headers, and R2 SSE', async () => {
    const requests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      requests.push(request);
      return new Response('', { status: 200 });
    });
    const fingerprint = 'f'.repeat(64);
    const cache = createR2ManagedReleaseCache({
      env: { R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' } as never,
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucketName: 'cache-bucket',
      configFingerprint: fingerprint,
      fetcher: fetcher as typeof fetch,
    });

    await expect(cache.createActive(pointer(1, '1'.repeat(64)))).resolves.toBe(true);
    await expect(cache.replaceActive(pointer(2, '2'.repeat(64)), '"etag-1"')).resolves.toBe(true);

    expect(requests).toHaveLength(2);
    expect(requests[0].url).toContain(`/configs/${fingerprint}/active.json`);
    expect(requests[0].headers.get('if-none-match')).toBe('*');
    expect(requests[0].headers.get('if-match')).toBeNull();
    expect(requests[1].headers.get('if-match')).toBe('"etag-1"');
    expect(requests[1].headers.get('if-none-match')).toBeNull();
    for (const request of requests) {
      expect(request.headers.get('x-amz-server-side-encryption')).toBe('AES256');
    }
  });

  it('accepts an idempotent immutable create conflict only when stored bytes are identical', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 412 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200, headers: { etag: '"same"' } }));
    const cache = createR2ManagedReleaseCache({
      env: { R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' } as never,
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucketName: 'cache-bucket',
      configFingerprint: 'f'.repeat(64),
      fetcher,
    });

    await expect(cache.putImmutable(`releases/${'d'.repeat(64)}/seed-v1.json.gz`, bytes)).resolves.toBeUndefined();
    const put = fetcher.mock.calls[0][0] as Request;
    expect(put.headers.get('if-none-match')).toBe('*');
    expect(put.headers.get('x-amz-server-side-encryption')).toBe('AES256');
  });

  it('cancels an active-pointer response that exceeds its bound without buffering the full body', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const cache = createR2ManagedReleaseCache({
      env: { R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' } as never,
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucketName: 'cache-bucket',
      configFingerprint: 'f'.repeat(64),
      fetcher: vi.fn(async () => new Response(body, { status: 200, headers: { etag: '"pointer"' } })),
    });

    await expect(cache.readActive()).rejects.toThrow(/exceeds/i);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(32);
  });

  it('rejects an immutable create conflict when the existing object differs', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 412 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }));
    const cache = createR2ManagedReleaseCache({
      env: { R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' } as never,
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucketName: 'cache-bucket',
      configFingerprint: 'f'.repeat(64),
      fetcher,
    });

    await expect(cache.putImmutable(
      `releases/${'d'.repeat(64)}/seed-v1.sig`,
      new Uint8Array([1]),
    )).rejects.toThrow(/immutable cache conflict/i);
  });
});
