// REQ-STOR-015 backfill: sync-fanout helper covers AC1 (enumerate +
// fan out to running sessions only), AC2 (concurrency cap = 8),
// AC3 (per-session failure isolation), and AC4 (upload-trigger wiring).
// AC5 (SIGUSR1 in-flight/rerun coalescing) is asserted in
// entrypoint-bisync-trigger.test.js. AC6 (frontend button disabled while
// syncing) is asserted in web-ui StorageBrowser.test.tsx. AC7 (rate
// limit 6/min) is asserted on the rate-limiter constant directly here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { fanOutBisyncTrigger } from '../../lib/sync-fanout';

// Hoisted mutable state so vi.mock() factory below can read the latest
// per-test container behavior without re-defining the module mock.
const testState = vi.hoisted(() => ({
  containerFetch: vi.fn(),
  // Track which session IDs got their container.fetch called and when,
  // so we can verify concurrency-cap chunking semantics.
  fetchOrder: [] as Array<{ sessionId: string; t: number }>,
  resetForCappedTest: false,
}));

vi.mock('@cloudflare/containers', () => ({
  getContainer: vi.fn((_binding: unknown, containerId: string) => ({
    fetch: (req: Request) => testState.containerFetch(containerId, req),
  })),
}));

function buildEnv(kv: ReturnType<typeof createMockKV>): Env {
  return {
    KV: kv as unknown as KVNamespace,
    CONTAINER: {} as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

function seedSession(
  kv: ReturnType<typeof createMockKV>,
  bucketName: string,
  sessionId: string,
  status: 'running' | 'stopped'
): void {
  // Use the metadata fast-path so list() returns SessionListMetadata.
  // SessionListMetadata.s is the status field (compact serialization).
  kv._set(
    `session:${bucketName}:${sessionId}`,
    {
      id: sessionId,
      name: 'Test',
      userId: bucketName,
      status,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
    },
    { s: status === 'running' ? 'r' : 's' }
  );
}

describe('fanOutBisyncTrigger (REQ-STOR-015 backfill)', () => {
  let kv: ReturnType<typeof createMockKV>;
  const bucket = 'test-bucket';

  beforeEach(() => {
    kv = createMockKV();
    testState.containerFetch.mockReset();
    testState.fetchOrder.length = 0;
  });

  it('AC1: enumerates the user sessions and fans out only to running ones', async () => {
    seedSession(kv, bucket, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'running');
    seedSession(kv, bucket, 'bbbbbbbbbbbbbbbbbbbbbbbb', 'stopped');
    seedSession(kv, bucket, 'cccccccccccccccccccccccc', 'running');
    testState.containerFetch.mockResolvedValue(new Response(null, { status: 202 }));

    const results = await fanOutBisyncTrigger(buildEnv(kv), bucket);

    // Only the two running sessions get triggered; the stopped one is
    // skipped client-side per AC1.
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'triggered')).toBe(true);
    expect(testState.containerFetch).toHaveBeenCalledTimes(2);
  });

  it('AC1: returns empty array when the user has zero running sessions', async () => {
    seedSession(kv, bucket, 'dddddddddddddddddddddddd', 'stopped');
    seedSession(kv, bucket, 'eeeeeeeeeeeeeeeeeeeeeeee', 'stopped');

    const results = await fanOutBisyncTrigger(buildEnv(kv), bucket);

    expect(results).toEqual([]);
    expect(testState.containerFetch).not.toHaveBeenCalled();
  });

  it('AC2: caps concurrent in-flight container.fetch calls at 8', async () => {
    // Seed 20 running sessions and slow each container.fetch to keep
    // them outstanding for one microtask window. Then count the maximum
    // overlap of in-flight calls - it must be 8 or fewer.
    for (let i = 0; i < 20; i++) {
      seedSession(kv, bucket, `${i.toString().padStart(24, 'a')}`, 'running');
    }

    let inFlight = 0;
    let peak = 0;
    testState.containerFetch.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield once so the next .map() iteration can launch before we
      // resolve. Without an await, Promise.all would observe sequential
      // synchronous returns and never see overlap.
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return new Response(null, { status: 202 });
    });

    const results = await fanOutBisyncTrigger(buildEnv(kv), bucket);

    expect(results).toHaveLength(20);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1); // sanity: some parallelism happened
  });

  it('AC3: per-session failures do not break the rest of the fan-out', async () => {
    seedSession(kv, bucket, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'running'); // throws
    seedSession(kv, bucket, 'bbbbbbbbbbbbbbbbbbbbbbbb', 'running'); // 503 - not-running
    seedSession(kv, bucket, 'cccccccccccccccccccccccc', 'running'); // 202 - triggered

    testState.containerFetch.mockImplementation(async (containerId: string) => {
      if (containerId.includes('aaaaaaaa')) throw new Error('container went away');
      if (containerId.includes('bbbbbbbb')) return new Response(null, { status: 503 });
      return new Response(null, { status: 202 });
    });

    const results = await fanOutBisyncTrigger(buildEnv(kv), bucket);

    // All three sessions get an entry. The thrown one is 'failed', the
    // 503 is 'not-running', the 202 is 'triggered'. None should affect
    // the others' outcomes.
    expect(results).toHaveLength(3);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['failed', 'not-running', 'triggered']);
    const failed = results.find((r) => r.status === 'failed');
    expect(failed?.error).toContain('container went away');
  });

  it('AC1: 503 from container is reported as not-running, not failed', async () => {
    seedSession(kv, bucket, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'running');
    testState.containerFetch.mockResolvedValue(new Response(null, { status: 503 }));

    const results = await fanOutBisyncTrigger(buildEnv(kv), bucket);

    expect(results).toEqual([
      { sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'not-running' },
    ]);
  });

  it('AC1: fan-out POSTs to /internal/bisync-trigger on each container', async () => {
    seedSession(kv, bucket, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'running');
    let capturedRequest: Request | undefined;
    testState.containerFetch.mockImplementation(async (_id: string, req: Request) => {
      capturedRequest = req;
      return new Response(null, { status: 202 });
    });

    await fanOutBisyncTrigger(buildEnv(kv), bucket);

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.method).toBe('POST');
    expect(capturedRequest!.url).toContain('/internal/bisync-trigger');
  });
});

describe('REQ-STOR-015 AC4: upload-side fire-and-forget trigger', () => {
  it('AC4 contract: upload.ts wires fanOutBisyncTrigger through executionCtx.waitUntil', async () => {
    // Static check: the upload route module imports fanOutBisyncTrigger
    // AND its source contains the waitUntil wiring + .catch() defensive
    // wrapper that prevents a trigger failure from poisoning the upload
    // 200 response (lessons from prior incident around upload-side
    // sync surfacing as 500s).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const upload = fs.readFileSync(
      path.resolve(__dirname, '../../routes/storage/upload.ts'),
      'utf8'
    );
    expect(upload).toContain("from '../../lib/sync-fanout'");
    expect(upload).toContain('fanOutBisyncTrigger');
    expect(upload).toMatch(/c\.executionCtx\?\.waitUntil\(/);
    // .catch(() => undefined) is the defensive wrapper that swallows
    // trigger failures so the R2 PUT can return 200 cleanly.
    expect(upload).toMatch(/\.catch\(\(\) => undefined\)/);
  });
});

describe('REQ-STOR-015 AC7: sessions-sync rate limit is 6/min', () => {
  it('uses windowMs=60_000 + maxRequests=6 + keyPrefix=sessions-sync', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
    const lifecycle = fs.readFileSync(
      path.resolve(__dirname, '../../routes/session/lifecycle.ts'),
      'utf8'
    );
    // The block must contain all three required fields. Use a multi-
    // line regex so we tolerate field ordering and whitespace.
    expect(lifecycle).toMatch(/sessionsSyncRateLimiter\s*=\s*createRateLimiter\(\s*\{[\s\S]*?windowMs:\s*60_?000[\s\S]*?\}\s*\)/);
    expect(lifecycle).toMatch(/sessionsSyncRateLimiter\s*=\s*createRateLimiter\(\s*\{[\s\S]*?maxRequests:\s*6[\s\S]*?\}\s*\)/);
    expect(lifecycle).toMatch(/sessionsSyncRateLimiter\s*=\s*createRateLimiter\(\s*\{[\s\S]*?keyPrefix:\s*['"]sessions-sync['"][\s\S]*?\}\s*\)/);
    // The limiter must actually be attached to POST /sync.
    expect(lifecycle).toMatch(/app\.post\(\s*['"]\/sync['"]\s*,\s*sessionsSyncRateLimiter/);
  });
});
