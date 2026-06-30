/**
 * REQ-ENTERPRISE-018 (Governed Mode): per-bucket R2 encryption-regime state + the lossless,
 * chunked, self-verifying re-encrypt migration engine + driver.
 *
 * The fetch layer is a SIMULATED R2 store keyed by per-object regime: a HEAD succeeds only
 * with the matching regime's SSE headers; a copy (PUT) flips the object to the destination
 * regime. That makes idempotency, resume, verification, and dual-read provable behaviorally —
 * gut the engine and these fail.
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

// Keep the real parseListObjectsXml/xml-utils (the migration parses real S3 XML) while
// stubbing the network client + URL builder.
vi.mock('../../lib/r2-client', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/r2-client')>();
  return { ...actual, createR2Client: mockCreateR2Client, getR2Url: mockGetR2Url };
});

import {
  getR2SsePolicyDisabled,
  getBucketR2Regime,
  isR2SseDisabledForBucket,
  isBucketMigrating,
  regimeForPolicy,
  resolveBucketSseOnEnsure,
  resolveReadRegime,
  getRegimeState,
  setRegimeState,
  migrateBucketEncryption,
  planRegimeReconcile,
  advanceMigration,
  markMixedRecovery,
  fetchObjectWithRegimeFallback,
  type R2SseRegime,
  type RegimeState,
} from '../../lib/r2-migration';

// A valid 32-byte base64 SSE-C key so getSseHeaders/getSseCopyHeaders compute real headers.
const ENCRYPTION_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

// ── KV mock ──────────────────────────────────────────────────────────────────
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

// ── Simulated R2 store ─────────────────────────────────────────────────────────
interface SimObj { regime: R2SseRegime; size: number; etag: string; contentType: string; meta: Record<string, string>; }

function regimeFromHeaders(h: Record<string, string>): R2SseRegime {
  return h['x-amz-server-side-encryption-customer-key'] ? 'sse-c' : 'plain';
}
function keyFromUrl(url: string): string {
  const noQuery = url.split('?')[0];
  const i = noQuery.indexOf('/bkt/');
  return i >= 0 ? noQuery.slice(i + '/bkt/'.length) : '';
}
function listXml(objects: { key: string; size: number }[], truncated = false, nextToken?: string): string {
  const contents = objects
    .map((o) => `<Contents><Key>${o.key}</Key><Size>${o.size}</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"x"</ETag></Contents>`)
    .join('');
  const token = truncated && nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : '';
  return `<?xml version="1.0"?><ListBucketResult>${contents}<IsTruncated>${truncated}</IsTruncated>${token}</ListBucketResult>`;
}

/** Wire mockFetch to a regime-aware in-memory bucket. pageSize forces ListObjectsV2 pagination. */
function makeR2(objects: Record<string, { regime: R2SseRegime; size?: number; etag?: string }>, opts: { pageSize?: number; copyErrorBody?: boolean } = {}) {
  const pageSize = opts.pageSize ?? 1000;
  const store = new Map<string, SimObj>();
  for (const [k, o] of Object.entries(objects)) {
    store.set(k, { regime: o.regime, size: o.size ?? 10, etag: o.etag ?? '"e1"', contentType: 'text/markdown', meta: { 'x-amz-meta-foo': 'bar' } });
  }
  const puts: Array<{ key: string; headers: Record<string, string>; to: R2SseRegime }> = [];
  const heads: Array<{ key: string; regime: R2SseRegime }> = [];

  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (method === 'GET' && url.includes('list-type=2')) {
      const allKeys = [...store.keys()];
      const u = new URL(url);
      const token = u.searchParams.get('continuation-token');
      const start = token ? allKeys.indexOf(token) + 1 : 0;
      const pageKeys = allKeys.slice(start, start + pageSize);
      const truncated = start + pageSize < allKeys.length;
      const nextToken = truncated ? pageKeys[pageKeys.length - 1] : undefined;
      return new Response(listXml(pageKeys.map((k) => ({ key: k, size: store.get(k)!.size })), truncated, nextToken), { status: 200 });
    }
    if (method === 'GET' && url.includes('uploads')) {
      return new Response('<ListMultipartUploadsResult></ListMultipartUploadsResult>', { status: 200 });
    }

    const key = keyFromUrl(url);
    const obj = store.get(key);

    if (method === 'HEAD') {
      const reqRegime = regimeFromHeaders(headers);
      heads.push({ key, regime: reqRegime });
      if (obj && obj.regime === reqRegime) {
        return new Response(null, { status: 200, headers: { etag: obj.etag, 'content-type': obj.contentType, ...obj.meta } });
      }
      return new Response(null, { status: 400 });
    }
    if (method === 'PUT') {
      const to = regimeFromHeaders(headers);
      puts.push({ key, headers, to });
      if (opts.copyErrorBody) {
        return new Response('<?xml version="1.0"?><Error><Code>InternalError</Code></Error>', { status: 200 });
      }
      if (obj) obj.regime = to;
      return new Response('<CopyObjectResult><ETag>"e2"</ETag></CopyObjectResult>', { status: 200 });
    }
    return new Response(null, { status: 500 });
  });

  return { store, puts, heads };
}

const r2Env = {
  R2_ACCESS_KEY_ID: 'ak',
  R2_SECRET_ACCESS_KEY: 'sk',
  ENCRYPTION_KEY,
} as unknown as Env;

const driverEnv = (kv: KVNamespace) => ({ ...r2Env, R2_ACCOUNT_ID: 'acct', KV: kv } as unknown as Env);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Regime helpers ─────────────────────────────────────────────────────────────
describe('regime helpers (REQ-ENTERPRISE-018)', () => {
  it('regimeForPolicy maps the policy boolean to a regime', () => {
    expect(regimeForPolicy(true)).toBe('plain');
    expect(regimeForPolicy(false)).toBe('sse-c');
  });

  it('getR2SsePolicyDisabled reads the wizard toggle; absent ⇒ false', async () => {
    expect(await getR2SsePolicyDisabled({ KV: makeKV().kv } as unknown as Env)).toBe(false);
    expect(await getR2SsePolicyDisabled({ KV: makeKV({ 'setup:r2_sse_disabled': 'active' }).kv } as unknown as Env)).toBe(true);
    expect(await getR2SsePolicyDisabled({ KV: makeKV({ 'setup:r2_sse_disabled': 'inactive' }).kv } as unknown as Env)).toBe(false);
  });

  it('getRegimeState defaults to ready/sse-c when no state object exists', async () => {
    const state = await getRegimeState({ KV: makeKV().kv } as unknown as Env, 'bkt');
    expect(state).toEqual({ status: 'ready', regime: 'sse-c', generation: 0 });
  });

  it('getRegimeState honors a legacy UserPreferences.r2SseRegime=plain marker (one-way fallback)', async () => {
    const kv = makeKV({ 'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'plain' }) }).kv;
    const state = await getRegimeState({ KV: kv } as unknown as Env, 'bkt');
    expect(state.regime).toBe('plain');
    expect(state.status).toBe('ready');
  });

  it('the state object overrides the legacy marker', async () => {
    const kv = makeKV({
      'user-prefs:bkt': JSON.stringify({ r2SseRegime: 'plain' }),
      'r2-regime:bkt': JSON.stringify({ status: 'ready', regime: 'sse-c', generation: 2 }),
    }).kv;
    expect(await getBucketR2Regime({ KV: kv } as unknown as Env, 'bkt')).toBe('sse-c');
  });

  it('isR2SseDisabledForBucket is true iff the committed regime is plain', async () => {
    const plain = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'ready', regime: 'plain', generation: 1 }) }).kv;
    expect(await isR2SseDisabledForBucket({ KV: plain } as unknown as Env, 'bkt')).toBe(true);
    expect(await isR2SseDisabledForBucket({ KV: makeKV().kv } as unknown as Env, 'bkt')).toBe(false);
  });

  it('isBucketMigrating is true for any non-ready status', async () => {
    expect(await isBucketMigrating({ KV: makeKV().kv } as unknown as Env, 'bkt')).toBe(false);
    const migrating = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'migrating', regime: 'sse-c', generation: 0 }) }).kv;
    expect(await isBucketMigrating({ KV: migrating } as unknown as Env, 'bkt')).toBe(true);
    const recovery = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'mixed-recovery', regime: 'sse-c', generation: 0 }) }).kv;
    expect(await isBucketMigrating({ KV: recovery } as unknown as Env, 'bkt')).toBe(true);
  });

  it('setRegimeState writes the dedicated key (not user-prefs) and stamps updatedAt', async () => {
    const { kv, store } = makeKV({ 'user-prefs:bkt': JSON.stringify({ sessionMode: 'advanced' }) });
    await setRegimeState({ KV: kv } as unknown as Env, 'bkt', { status: 'ready', regime: 'plain', generation: 1 });
    expect(JSON.parse(store.get('user-prefs:bkt')!)).toEqual({ sessionMode: 'advanced' }); // prefs untouched
    const stored = JSON.parse(store.get('r2-regime:bkt')!);
    expect(stored.regime).toBe('plain');
    expect(stored.updatedAt).toBeTruthy();
  });

  it('resolveReadRegime: ready retries the opposite regime + flags self-heal; migrating does not self-heal', () => {
    expect(resolveReadRegime({ status: 'ready', regime: 'sse-c', generation: 0 })).toEqual({ primary: false, fallback: true, selfHealOnFallbackHit: true });
    expect(resolveReadRegime({ status: 'ready', regime: 'plain', generation: 0 })).toEqual({ primary: true, fallback: false, selfHealOnFallbackHit: true });
    expect(resolveReadRegime({ status: 'migrating', regime: 'sse-c', generation: 0 }).selfHealOnFallbackHit).toBe(false);
  });
});

describe('resolveBucketSseOnEnsure (lazy-create paths)', () => {
  it('new bucket adopts the policy and stamps a ready state', async () => {
    const { kv, store } = makeKV({ 'setup:r2_sse_disabled': 'active' });
    const disabled = await resolveBucketSseOnEnsure({ KV: kv } as unknown as Env, 'bkt', true);
    expect(disabled).toBe(true);
    expect(JSON.parse(store.get('r2-regime:bkt')!)).toMatchObject({ status: 'ready', regime: 'plain' });
  });

  it('existing bucket keeps its committed regime without migrating', async () => {
    const { kv } = makeKV({ 'setup:r2_sse_disabled': 'active', 'r2-regime:bkt': JSON.stringify({ status: 'ready', regime: 'sse-c', generation: 0 }) });
    expect(await resolveBucketSseOnEnsure({ KV: kv } as unknown as Env, 'bkt', false)).toBe(false);
  });
});

// ── Copy engine ────────────────────────────────────────────────────────────────
describe('migrateBucketEncryption (lossless REPLACE re-encrypt)', () => {
  it('sse-c → plain: REPLACE + copy-source decrypt + no dest SSE + if-match + preserved metadata', async () => {
    const { puts } = makeR2({ 'work/skill.md': { regime: 'sse-c' } });
    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'sse-c', 'plain');

    expect(res).toEqual({ migrated: 1, skipped: 0, oversized: [] });
    const h = puts[0].headers;
    expect(h['x-amz-metadata-directive']).toBe('REPLACE');
    expect(h['x-amz-copy-source']).toBe('/bkt/work/skill.md');
    expect(h['x-amz-copy-source-if-match']).toBe('"e1"');
    expect(h['x-amz-copy-source-server-side-encryption-customer-key']).toBe(ENCRYPTION_KEY); // decrypt source
    expect(h['x-amz-server-side-encryption-customer-key']).toBeUndefined(); // plaintext dest
    expect(h['content-type']).toBe('text/markdown'); // preserved
    expect(h['x-amz-meta-foo']).toBe('bar'); // preserved
  });

  it('plain → sse-c: REPLACE + dest SSE + no copy-source decrypt', async () => {
    const { puts } = makeR2({ 'a.txt': { regime: 'plain' } });
    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'plain', 'sse-c');

    expect(res.migrated).toBe(1);
    const h = puts[0].headers;
    expect(h['x-amz-metadata-directive']).toBe('REPLACE');
    expect(h['x-amz-server-side-encryption-customer-key']).toBe(ENCRYPTION_KEY); // encrypt dest
    expect(h['x-amz-copy-source-server-side-encryption-customer-key']).toBeUndefined(); // plaintext source
  });

  it('is idempotent — skips an object already readable in the target regime (no copy)', async () => {
    const { puts } = makeR2({ 'a.txt': { regime: 'plain' } });
    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'sse-c', 'plain');
    expect(res).toEqual({ migrated: 0, skipped: 1, oversized: [] });
    expect(puts).toHaveLength(0);
  });

  it('no-ops (no network) when from === to', async () => {
    makeR2({ 'a.txt': { regime: 'plain' } });
    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'plain', 'plain');
    expect(res).toEqual({ migrated: 0, skipped: 0, oversized: [] });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('records (does not copy) an object larger than the 5 GB single-CopyObject limit', async () => {
    const { puts } = makeR2({ 'huge.bin': { regime: 'sse-c', size: 6 * 1024 * 1024 * 1024 } });
    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'sse-c', 'plain');
    expect(res.oversized).toEqual(['huge.bin']);
    expect(res.migrated).toBe(0);
    expect(puts).toHaveLength(0);
  });

  it('throws when CopyObject returns 200 with an embedded <Error> body', async () => {
    makeR2({ 'a.txt': { regime: 'sse-c' } }, { copyErrorBody: true });
    await expect(migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'sse-c', 'plain'))
      .rejects.toThrow(/error\/invalid body/);
  });

  it('resumes across pages — migrates every object when the listing is paginated', async () => {
    const objs: Record<string, { regime: R2SseRegime }> = {};
    for (let i = 0; i < 5; i++) objs[`k${i}.md`] = { regime: 'sse-c' };
    const { store } = makeR2(objs, { pageSize: 2 }); // 3 pages of 2,2,1
    const res = await migrateBucketEncryption(r2Env, 'bkt', 'https://r2.test', 'sse-c', 'plain');
    expect(res.migrated).toBe(5);
    expect([...store.values()].every((o) => o.regime === 'plain')).toBe(true);
  });
});

// ── Read-path dual-regime fallback ──────────────────────────────────────────────
describe('fetchObjectWithRegimeFallback (D2 reads stay up)', () => {
  it('reads in the committed regime with no fallback when the primary succeeds', async () => {
    makeR2({ 'a.txt': { regime: 'sse-c' } });
    const { kv } = makeKV(); // default ready/sse-c
    const { response, stray } = await fetchObjectWithRegimeFallback(driverEnv(kv), 'bkt', 'https://r2.test/bkt/a.txt', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(stray).toBe(false);
  });

  it('falls back to the opposite regime on a 400 and flags a stray on a READY bucket', async () => {
    makeR2({ 'a.txt': { regime: 'plain' } }); // committed says sse-c, but object is plain → stray
    const { kv } = makeKV(); // default ready/sse-c
    const { response, stray, sseDisabled } = await fetchObjectWithRegimeFallback(driverEnv(kv), 'bkt', 'https://r2.test/bkt/a.txt', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(stray).toBe(true); // ready bucket + fallback hit ⇒ trigger mixed-recovery
    expect(sseDisabled).toBe(true); // succeeded reading it as plain
  });

  it('falls back without flagging a stray while the bucket is migrating', async () => {
    makeR2({ 'a.txt': { regime: 'plain' } });
    const { kv } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'migrating', regime: 'sse-c', from: 'sse-c', to: 'plain', generation: 0 }) });
    const { response, stray } = await fetchObjectWithRegimeFallback(driverEnv(kv), 'bkt', 'https://r2.test/bkt/a.txt', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(stray).toBe(false);
  });
});

// ── Reconcile decision ──────────────────────────────────────────────────────────
describe('planRegimeReconcile (synchronous decision)', () => {
  it('no-op when the committed regime already matches the policy', async () => {
    const { kv } = makeKV(); // ready/sse-c, policy absent ⇒ sse-c
    const result = await planRegimeReconcile(driverEnv(kv), 'bkt', async () => false);
    expect(result).toMatchObject({ migrating: false, pending: false });
    expect((kv.put as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled(); // no flip
  });

  it('starts a migration (flips to migrating) when the regime differs and no container is healthy', async () => {
    const { kv, store } = makeKV({ 'setup:r2_sse_disabled': 'active' }); // policy plain, committed sse-c
    const result = await planRegimeReconcile(driverEnv(kv), 'bkt', async () => false);
    expect(result.migrating).toBe(true);
    const state = JSON.parse(store.get('r2-regime:bkt')!);
    expect(state).toMatchObject({ status: 'migrating', from: 'sse-c', to: 'plain', regime: 'sse-c' });
    expect(state.leaseExpiresAt).toBeUndefined(); // lease is claimed per-chunk by advanceMigration, not here
  });

  it('defers (pending) without flipping when a container is still healthy (D1: no force-kill)', async () => {
    const { kv, store } = makeKV({ 'setup:r2_sse_disabled': 'active' });
    const result = await planRegimeReconcile(driverEnv(kv), 'bkt', async () => true);
    expect(result).toMatchObject({ migrating: false, pending: true });
    expect(store.has('r2-regime:bkt')).toBe(false); // not flipped
  });

  it('reports an in-flight migration without re-deciding or probing containers', async () => {
    const { kv } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'migrating', regime: 'sse-c', to: 'plain', from: 'sse-c', generation: 0 }) });
    const hasHealthy = vi.fn(async () => true);
    const result = await planRegimeReconcile(driverEnv(kv), 'bkt', hasHealthy);
    expect(result.migrating).toBe(true);
    expect(hasHealthy).not.toHaveBeenCalled();
  });
});

// ── Chunked driver ──────────────────────────────────────────────────────────────
describe('advanceMigration (chunked, verified, self-healing)', () => {
  const drainNoop = { drainContainers: vi.fn(async () => {}) };

  async function runToReady(kv: KVNamespace, deps = drainNoop, max = 20): Promise<RegimeState> {
    for (let i = 0; i < max; i++) {
      const before = await getRegimeState({ KV: kv } as unknown as Env, 'bkt');
      if (before.status === 'ready') return before;
      await advanceMigration(driverEnv(kv), 'bkt', deps);
    }
    return getRegimeState({ KV: kv } as unknown as Env, 'bkt');
  }

  it('migrates then verifies then flips to ready + bumps generation, draining once', async () => {
    const { store } = makeR2({ 'a.md': { regime: 'sse-c' }, 'b.md': { regime: 'sse-c' } });
    const { kv } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'migrating', regime: 'sse-c', from: 'sse-c', to: 'plain', generation: 4, phase: 'migrate', drained: false }) });
    const deps = { drainContainers: vi.fn(async () => {}) };

    const final = await runToReady(kv, deps);

    expect(final).toMatchObject({ status: 'ready', regime: 'plain', generation: 5 });
    expect([...store.values()].every((o) => o.regime === 'plain')).toBe(true);
    expect(deps.drainContainers).toHaveBeenCalledTimes(1); // drained once, before the first chunk
  });

  it('does nothing while another chunk holds a live lease (in-flight lock)', async () => {
    const { puts } = makeR2({ 'a.md': { regime: 'sse-c' } });
    const { kv } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'migrating', regime: 'sse-c', from: 'sse-c', to: 'plain', generation: 0, phase: 'migrate', drained: false, leaseExpiresAt: Date.now() + 60_000 }) });
    const deps = { drainContainers: vi.fn(async () => {}) };

    await advanceMigration(driverEnv(kv), 'bkt', deps);

    expect(deps.drainContainers).not.toHaveBeenCalled();
    expect(puts).toHaveLength(0);
  });

  it('mixed-recovery heals a stray to the committed regime and flips ready WITHOUT changing regime/generation', async () => {
    const { store } = makeR2({ 'stray.md': { regime: 'plain' }, 'ok.md': { regime: 'sse-c' } });
    const { kv } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'mixed-recovery', regime: 'sse-c', generation: 7, phase: 'migrate', drained: false }) });

    const final = await runToReady(kv);

    expect(final).toMatchObject({ status: 'ready', regime: 'sse-c', generation: 7 }); // regime + generation unchanged
    expect(store.get('stray.md')!.regime).toBe('sse-c'); // healed
  });

  it('never throws and records lastError when a chunk fails (releases the lease for retry)', async () => {
    makeR2({ 'a.md': { regime: 'sse-c' } }, { copyErrorBody: true }); // copy fails
    const { kv, store } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'migrating', regime: 'sse-c', from: 'sse-c', to: 'plain', generation: 0, phase: 'migrate', drained: false }) });

    await expect(advanceMigration(driverEnv(kv), 'bkt', drainNoop)).resolves.toBeUndefined();

    const state = JSON.parse(store.get('r2-regime:bkt')!);
    expect(state.status).toBe('migrating'); // not advanced
    expect(state.lastError).toBeTruthy();
    expect(state.leaseExpiresAt).toBeUndefined(); // released so the next poll retries
  });

  it('a premature flip is impossible: a verify failure re-enters the migrate phase instead of going ready', async () => {
    // Object is in neither regime readable as target after a "migrate" — simulate by leaving it
    // in the source regime so the verify HEAD (target) 400s.
    const r2 = makeR2({ 'a.md': { regime: 'sse-c' } });
    // Freeze the object in sse-c: a PUT records but does NOT flip the regime.
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (method === 'GET' && url.includes('list-type=2')) return new Response(listXml([{ key: 'a.md', size: 10 }]), { status: 200 });
      if (method === 'GET' && url.includes('uploads')) return new Response('<ListMultipartUploadsResult></ListMultipartUploadsResult>', { status: 200 });
      if (method === 'HEAD') {
        // The object stays in sse-c forever (the copy never flips it), so a target (plain) HEAD always 400s.
        const reqRegime = regimeFromHeaders(headers);
        return new Response(null, { status: reqRegime === 'sse-c' ? 200 : 400, headers: { etag: '"e1"' } });
      }
      if (method === 'PUT') return new Response('<CopyObjectResult><ETag>"e2"</ETag></CopyObjectResult>', { status: 200 }); // never flips
      return new Response(null, { status: 500 });
    });
    void r2;
    const { kv, store } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'migrating', regime: 'sse-c', from: 'sse-c', to: 'plain', generation: 0, phase: 'verify', drained: true }) });

    await advanceMigration(driverEnv(kv), 'bkt', drainNoop);

    const state = JSON.parse(store.get('r2-regime:bkt')!);
    expect(state.status).toBe('migrating'); // NOT ready
    expect(state.phase).toBe('migrate'); // bounced back to re-migrate the stray
  });

  it('returns immediately on a ready bucket', async () => {
    const { kv } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'ready', regime: 'plain', generation: 1 }) });
    const deps = { drainContainers: vi.fn(async () => {}) };
    await advanceMigration(driverEnv(kv), 'bkt', deps);
    expect(deps.drainContainers).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('markMixedRecovery', () => {
  it('flips a ready bucket into a mixed-recovery scan', async () => {
    const { kv, store } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'ready', regime: 'sse-c', generation: 2 }) });
    await markMixedRecovery(driverEnv(kv), 'bkt');
    expect(JSON.parse(store.get('r2-regime:bkt')!)).toMatchObject({ status: 'mixed-recovery', regime: 'sse-c', generation: 2, phase: 'migrate', drained: false });
  });

  it('is a no-op when a migration is already in flight', async () => {
    const { kv, store } = makeKV({ 'r2-regime:bkt': JSON.stringify({ status: 'migrating', regime: 'sse-c', to: 'plain', generation: 0 }) });
    await markMixedRecovery(driverEnv(kv), 'bkt');
    expect(JSON.parse(store.get('r2-regime:bkt')!).status).toBe('migrating'); // unchanged
  });
});
