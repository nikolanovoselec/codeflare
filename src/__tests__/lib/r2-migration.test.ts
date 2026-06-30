/**
 * REQ-ENTERPRISE-018 (Governed Mode): per-bucket R2 encryption-regime resolution
 * + lossless server-side re-encrypt migration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';

const { mockFetch, mockCreateR2Client, mockGetR2Url } = vi.hoisted(() => {
  const mockFetch = vi.fn();
  return {
    mockFetch,
    mockCreateR2Client: vi.fn(() => ({ fetch: mockFetch })),
    mockGetR2Url: vi.fn((endpoint: string, bucket: string, key?: string) =>
      key ? `${endpoint}/${bucket}/${key}` : `${endpoint}/${bucket}`
    ),
  };
});

// Keep the real parseListObjectsXml (the migration parses real S3 XML) while
// stubbing the network client + URL builder.
vi.mock('../../lib/r2-client', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/r2-client')>();
  return { ...actual, createR2Client: mockCreateR2Client, getR2Url: mockGetR2Url };
});

import {
  getR2SsePolicyDisabled,
  getBucketR2Regime,
  isR2SseDisabledForBucket,
  setBucketR2Regime,
  regimeForPolicy,
  resolveBucketSseOnEnsure,
  reconcileBucketRegimeOnLogin,
  migrateBucketEncryption,
} from '../../lib/r2-migration';

// A valid 32-byte base64 SSE-C key so getSseHeaders/getSseCopyHeaders compute real headers.
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function makeKV(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    kv: {
      get: vi.fn(async (key: string, type?: string) => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === 'json' ? JSON.parse(raw) : raw;
      }),
      put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
    } as unknown as KVNamespace,
  };
}

function listXml(objects: { key: string; size: number }[]): string {
  const contents = objects
    .map((o) => `<Contents><Key>${o.key}</Key><Size>${o.size}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"x"</ETag></Contents>`)
    .join('');
  return `<?xml version="1.0"?><ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`;
}

/** Route mockFetch: list → XML; HEAD → headProbe(); PUT → record + ok. */
function wireFetch(opts: {
  objects: { key: string; size: number }[];
  headOk: boolean;
  puts: Array<{ url: string; headers: Record<string, string> }>;
}) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('list-type=2')) {
      return new Response(listXml(opts.objects), { status: 200 });
    }
    if (method === 'HEAD') {
      return new Response(null, { status: opts.headOk ? 200 : 400 });
    }
    if (method === 'PUT') {
      opts.puts.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 500 });
  });
}

const r2Env = {
  R2_ACCESS_KEY_ID: 'ak',
  R2_SECRET_ACCESS_KEY: 'sk',
  ENCRYPTION_KEY,
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('regime helpers (REQ-ENTERPRISE-018)', () => {
  it('regimeForPolicy maps the policy boolean to a regime', () => {
    expect(regimeForPolicy(true)).toBe('plain');
    expect(regimeForPolicy(false)).toBe('sse-c');
  });

  it('getR2SsePolicyDisabled reads the wizard toggle; absent ⇒ false', async () => {
    const absent = makeKV();
    expect(await getR2SsePolicyDisabled({ KV: absent.kv } as unknown as Env)).toBe(false);
    const active = makeKV({ 'setup:r2_sse_disabled': 'active' });
    expect(await getR2SsePolicyDisabled({ KV: active.kv } as unknown as Env)).toBe(true);
    const inactive = makeKV({ 'setup:r2_sse_disabled': 'inactive' });
    expect(await getR2SsePolicyDisabled({ KV: inactive.kv } as unknown as Env)).toBe(false);
  });

  it('getBucketR2Regime returns plain only when the marker is plain; absent ⇒ sse-c', async () => {
    const plain = makeKV({ 'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'plain' }) });
    expect(await getBucketR2Regime({ KV: plain.kv } as unknown as Env, 'bkt')).toBe('plain');
    const legacy = makeKV({ 'user-prefs:bkt': JSON.stringify({ sessionMode: 'advanced' }) });
    expect(await getBucketR2Regime({ KV: legacy.kv } as unknown as Env, 'bkt')).toBe('sse-c');
    const none = makeKV();
    expect(await getBucketR2Regime({ KV: none.kv } as unknown as Env, 'bkt')).toBe('sse-c');
  });

  it('isR2SseDisabledForBucket is true iff the marker is plain', async () => {
    const plain = makeKV({ 'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'plain' }) });
    expect(await isR2SseDisabledForBucket({ KV: plain.kv } as unknown as Env, 'bkt')).toBe(true);
    const none = makeKV();
    expect(await isR2SseDisabledForBucket({ KV: none.kv } as unknown as Env, 'bkt')).toBe(false);
  });

  it('setBucketR2Regime merges the marker without clobbering other prefs', async () => {
    const { kv, store } = makeKV({ 'user-prefs:bkt': JSON.stringify({ sessionMode: 'advanced', lastPreseedHash: 'abc' }) });
    await setBucketR2Regime({ KV: kv } as unknown as Env, 'bkt', 'plain');
    const stored = JSON.parse(store.get('user-prefs:bkt')!);
    expect(stored).toEqual({ sessionMode: 'advanced', lastPreseedHash: 'abc', r2SseRegime: 'plain' });
  });

  it('setBucketR2Regime is a no-op write when the marker already matches', async () => {
    const { kv } = makeKV({ 'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'plain' }) });
    await setBucketR2Regime({ KV: kv } as unknown as Env, 'bkt', 'plain');
    expect(kv.put).not.toHaveBeenCalled();
  });
});

describe('resolveBucketSseOnEnsure (lazy-create paths)', () => {
  it('new bucket adopts the policy and stamps the marker (policy active)', async () => {
    const { kv, store } = makeKV({ 'setup:r2_sse_disabled': 'active' });
    const disabled = await resolveBucketSseOnEnsure({ KV: kv } as unknown as Env, 'bkt', true);
    expect(disabled).toBe(true);
    expect(JSON.parse(store.get('user-prefs:bkt')!).r2SseRegime).toBe('plain');
  });

  it('existing bucket keeps its current marker without migrating', async () => {
    const { kv } = makeKV({ 'setup:r2_sse_disabled': 'active', 'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'sse-c' }) });
    const disabled = await resolveBucketSseOnEnsure({ KV: kv } as unknown as Env, 'bkt', false);
    // Marker (sse-c) wins over policy (active) — no migration in this path.
    expect(disabled).toBe(false);
  });
});

describe('migrateBucketEncryption (lossless re-encrypt)', () => {
  it('sse-c → plain: copy-source SSE-C decrypt + no dest SSE + MetadataDirective COPY', async () => {
    const puts: Array<{ url: string; headers: Record<string, string> }> = [];
    wireFetch({ objects: [{ key: 'work/skill.md', size: 10 }], headOk: false, puts });

    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'sse-c', 'plain');

    expect(res.migrated).toBe(1);
    expect(puts).toHaveLength(1);
    const h = puts[0].headers;
    expect(h['x-amz-metadata-directive']).toBe('COPY');
    expect(h['x-amz-copy-source']).toBe('/bkt/work/skill.md');
    // Decrypt the SSE-C source.
    expect(h['x-amz-copy-source-server-side-encryption-customer-key']).toBe(ENCRYPTION_KEY);
    // Destination is plaintext — NO dest SSE-C headers.
    expect(h['x-amz-server-side-encryption-customer-key']).toBeUndefined();
  });

  it('plain → sse-c: dest SSE-C + no copy-source SSE + MetadataDirective COPY', async () => {
    const puts: Array<{ url: string; headers: Record<string, string> }> = [];
    wireFetch({ objects: [{ key: 'a.txt', size: 5 }], headOk: false, puts });

    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'plain', 'sse-c');

    expect(res.migrated).toBe(1);
    const h = puts[0].headers;
    expect(h['x-amz-metadata-directive']).toBe('COPY');
    // Encrypt the destination.
    expect(h['x-amz-server-side-encryption-customer-key']).toBe(ENCRYPTION_KEY);
    // Source is plaintext — NO copy-source SSE-C headers.
    expect(h['x-amz-copy-source-server-side-encryption-customer-key']).toBeUndefined();
  });

  it('is idempotent — skips an object already in the target regime (HEAD 200, no copy)', async () => {
    const puts: Array<{ url: string; headers: Record<string, string> }> = [];
    wireFetch({ objects: [{ key: 'a.txt', size: 5 }], headOk: true, puts });

    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'sse-c', 'plain');

    expect(res).toEqual({ migrated: 0, skipped: 1 });
    expect(puts).toHaveLength(0);
  });

  it('no-ops (no network) when from === to', async () => {
    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'plain', 'plain');
    expect(res).toEqual({ migrated: 0, skipped: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on an object larger than the 5 GB single-CopyObject limit', async () => {
    const puts: Array<{ url: string; headers: Record<string, string> }> = [];
    wireFetch({ objects: [{ key: 'huge.bin', size: 6 * 1024 * 1024 * 1024 }], headOk: false, puts });

    await expect(migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'sse-c', 'plain'))
      .rejects.toThrow(/5 GB/);
    expect(puts).toHaveLength(0);
  });
});

describe('reconcileBucketRegimeOnLogin (first-login background migration)', () => {
  // R2_ACCOUNT_ID lets the real getR2Config resolve an endpoint synchronously (no network).
  const loginEnv = (kv: KVNamespace) => ({ ...r2Env, R2_ACCOUNT_ID: 'acct', KV: kv } as unknown as Env);
  const LOCK = 'r2-migration-lock:bkt';

  it('migrates an existing bucket whose marker differs from the policy, flips the marker, releases the lock', async () => {
    const puts: Array<{ url: string; headers: Record<string, string> }> = [];
    wireFetch({ objects: [{ key: 'a.txt', size: 5 }], headOk: false, puts });
    const { kv, store } = makeKV({ 'setup:r2_sse_disabled': 'active', 'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'sse-c' }) });

    await reconcileBucketRegimeOnLogin(loginEnv(kv), 'bkt');

    expect(puts).toHaveLength(1); // migration ran
    expect(JSON.parse(store.get('user-prefs:bkt')!).r2SseRegime).toBe('plain'); // marker advanced only on a complete pass
    expect(store.has(LOCK)).toBe(false); // lock released
  });

  it('is a no-op when the marker already matches the policy (no list/copy, no lock)', async () => {
    wireFetch({ objects: [{ key: 'a.txt', size: 5 }], headOk: false, puts: [] });
    const { kv, store } = makeKV({ 'setup:r2_sse_disabled': 'active', 'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'plain' }) });

    await reconcileBucketRegimeOnLogin(loginEnv(kv), 'bkt');

    expect(mockFetch).not.toHaveBeenCalled();
    expect(store.has(LOCK)).toBe(false);
  });

  it('dedupes: skips entirely when a migration lock is already held (concurrent tab/reload)', async () => {
    wireFetch({ objects: [{ key: 'a.txt', size: 5 }], headOk: false, puts: [] });
    const { kv, store } = makeKV({
      'setup:r2_sse_disabled': 'active',
      'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'sse-c' }),
      [LOCK]: '1',
    });

    await reconcileBucketRegimeOnLogin(loginEnv(kv), 'bkt');

    expect(mockFetch).not.toHaveBeenCalled(); // another pass owns the lock
    expect(JSON.parse(store.get('user-prefs:bkt')!).r2SseRegime).toBe('sse-c'); // marker untouched
    expect(store.get(LOCK)).toBe('1'); // the foreign lock is NOT deleted (only a lock this call took is released)
  });

  it('never throws and leaves the marker un-advanced when migration fails, releasing the lock for retry', async () => {
    // A >5 GB object makes migrateBucketEncryption throw; the login reconcile must swallow it.
    wireFetch({ objects: [{ key: 'huge.bin', size: 6 * 1024 * 1024 * 1024 }], headOk: false, puts: [] });
    const { kv, store } = makeKV({ 'setup:r2_sse_disabled': 'active', 'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'sse-c' }) });

    await expect(reconcileBucketRegimeOnLogin(loginEnv(kv), 'bkt')).resolves.toBeUndefined();

    expect(JSON.parse(store.get('user-prefs:bkt')!).r2SseRegime).toBe('sse-c'); // marker NOT advanced
    expect(store.has(LOCK)).toBe(false); // lock released so the next login retries
  });

  it('never rejects when an early KV read fails (the whole body is guarded, not just the migration)', async () => {
    // The first await is the policy read (KV.get). A KV transient there must be swallowed —
    // it runs in the caller's waitUntil, where a rejected promise would be unhandled. Pins the
    // widened guard: if only migrateBucketEncryption were wrapped (the pre-fix shape), this rejects.
    const { kv, store } = makeKV({ 'setup:r2_sse_disabled': 'active', 'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'sse-c' }) });
    (kv.get as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('KV transient on policy read'));

    await expect(reconcileBucketRegimeOnLogin(loginEnv(kv), 'bkt')).resolves.toBeUndefined();

    expect(mockFetch).not.toHaveBeenCalled(); // never reached the migration
    expect(JSON.parse(store.get('user-prefs:bkt')!).r2SseRegime).toBe('sse-c'); // marker untouched
    expect(store.has(LOCK)).toBe(false); // no lock taken
  });
});
