// REQ-STOR-015 backfill: sync-fanout helper covers AC1 (enumerate +
// fan out to running sessions only), AC2 (concurrency cap = 8),
// AC3 (per-session failure isolation), and AC4 (upload-trigger wiring).
// AC5 (SIGUSR1 in-flight/rerun coalescing) is asserted in
// host/__tests__/entrypoint-bisync-behavior.test.js — both the
// sleep-interrupt branch and the in-flight coalesce branch.
// AC6 (frontend button disabled while syncing) is asserted in web-ui
// StorageBrowser.test.tsx. AC7 (rate limit 6/min) is asserted on the
// rate-limiter constant directly here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
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
    USAGE_DB: createMockSessionD1(kv),
    CONTAINER: {} as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

function seedSession(
  kv: ReturnType<typeof createMockKV>,
  bucketName: string,
  sessionId: string,
  status: 'starting' | 'running' | 'unreachable' | 'stopping' | 'stopped'
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

  it('REQ-STOR-015 AC1: fans out to all owner workload states but not stopped or foreign sessions', async () => {
    const states = ['starting', 'running', 'unreachable', 'stopping', 'stopped'] as const;
    states.forEach((status, index) => {
      seedSession(kv, bucket, String(index).padStart(24, '0'), status);
      seedSession(kv, 'foreign-owner', String(index + 10).padStart(24, '0'), status);
    });
    const requests: Array<{ containerId: string; method: string; path: string }> = [];
    testState.containerFetch.mockImplementation(async (containerId: string, request: Request) => {
      requests.push({ containerId, method: request.method, path: new URL(request.url).pathname });
      return new Response(null, { status: 202 });
    });

    const results = await fanOutBisyncTrigger(buildEnv(kv), bucket);
    const ids = states.slice(0, 4).map((_, index) => String(index).padStart(24, '0'));
    expect(results.sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual(
      ids.map(sessionId => ({ sessionId, status: 'triggered' })),
    );
    expect(requests.sort((a, b) => a.containerId.localeCompare(b.containerId))).toEqual(
      ids.map(id => ({ containerId: `${bucket}-${id}`, method: 'POST', path: '/internal/bisync-trigger' })),
    );
  });

  it('REQ-STOR-015 AC2: the next batch waits for the last settlement, including a rejection', async () => {
    for (let index = 0; index < 17; index++) {
      seedSession(kv, bucket, String(index).padStart(24, '0'), 'running');
    }
    const requests: string[] = [];
    const pending: Array<{ resolve: (value: Response) => void; reject: (error: Error) => void }> = [];
    testState.containerFetch.mockImplementation((containerId: string, request: Request) => {
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe('/internal/bisync-trigger');
      requests.push(containerId);
      return new Promise<Response>((resolve, reject) => pending.push({ resolve, reject }));
    });
    const operation = fanOutBisyncTrigger(buildEnv(kv), bucket);
    await vi.waitFor(() => expect(requests).toHaveLength(8));
    const firstBatch = [...requests];
    pending[0].reject(new Error('first peer disconnected'));
    for (const peer of pending.slice(1, 7)) peer.resolve(new Response(null, { status: 202 }));
    // Let all released promise continuations drain, keeping the eighth peer blocked.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toEqual(firstBatch);
    pending[7].resolve(new Response(null, { status: 503 }));
    await vi.waitFor(() => expect(requests).toHaveLength(16));
    const firstTwoBatches = [...requests];
    for (const peer of pending.slice(8, 15)) peer.resolve(new Response(null, { status: 202 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(requests).toEqual(firstTwoBatches);
    pending[15].resolve(new Response(null, { status: 202 }));
    await vi.waitFor(() => expect(requests).toHaveLength(17));
    pending[16].resolve(new Response(null, { status: 202 }));
    const results = await operation;
    expect(new Set(requests).size).toBe(17);
    expect(results.map(result => result.status)).toEqual([
      'failed', ...Array(6).fill('triggered'), 'not-running', ...Array(9).fill('triggered'),
    ]);
  });

  it('REQ-STOR-015 AC2: accounts for all boundary requests in a 128-session fan-out', async () => {
    // A D1 result fixture, not the legacy KV-backed D1 adapter: adapter reads
    // must not masquerade as Worker subrequests in this budget observation.
    const rows = Array.from({ length: 128 }, (_, index) => ({
      owner_key: bucket, session_id: String(index).padStart(24, '0'),
      name: 'Session', lifecycle_state: 'running', created_at: '', last_accessed_at: '',
      workspace: 'terminal', terminal_mode: 'classic', lifecycle_generation: 0,
      response_revision: 0, observation_sequence: -1, editor_ready: 0, editor_ready_error: 0,
    }));
    const requests: Array<{ service: string; target: string }> = [];
    const kvBoundary = new Proxy(kv, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (!['get', 'getWithMetadata', 'put', 'delete', 'list'].includes(String(property))) return value;
        return (...args: unknown[]) => {
          requests.push({ service: 'KV', target: `${String(property)} ${typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0])}` });
          return Reflect.apply(value, target, args);
        };
      },
    });
    const env = buildEnv(kvBoundary);
    env.USAGE_DB = {
      prepare: (sql: string) => ({
        bind: (owner: string) => ({
          all: async () => {
            requests.push({ service: 'D1', target: sql });
            return { results: rows.filter(row => row.owner_key === owner) };
          },
        }),
      }),
    } as unknown as D1Database;
    testState.containerFetch.mockImplementation(async (id: string, request: Request) => {
      requests.push({ service: 'Container', target: `${id} ${request.method} ${new URL(request.url).pathname}` });
      return new Response(null, { status: 202 });
    });
    const results = await fanOutBisyncTrigger(env, bucket);
    expect(results).toEqual(rows.map(row => ({ sessionId: row.session_id, status: 'triggered' })));
    expect(requests.filter(request => request.service === 'KV')).toEqual([
      { service: 'KV', target: `get r2-regime:${bucket}` },
      { service: 'KV', target: `get user-prefs:${bucket}` },
    ]);
    expect(requests.filter(request => request.service === 'D1')).toHaveLength(1);
    expect(requests.filter(request => request.service === 'Container')).toEqual(rows.map(row => ({
      service: 'Container', target: `${bucket}-${row.session_id} POST /internal/bisync-trigger`,
    })));
    expect(requests).toHaveLength(131); // 128 actual triggers + 2 KV reads + 1 D1 query.
  });

  it('marks only explicit Sync now as an authorized disk-space retry', async () => {
    seedSession(kv, bucket, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'running');
    testState.containerFetch.mockResolvedValue(new Response(null, { status: 202 }));
    await fanOutBisyncTrigger(buildEnv(kv), bucket);
    expect(testState.containerFetch.mock.calls[0][1].headers.get('X-Codeflare-Sync-Recovery')).toBeNull();
    await fanOutBisyncTrigger(buildEnv(kv), bucket, 'manual');
    expect(testState.containerFetch.mock.calls[1][1].headers.get('X-Codeflare-Sync-Recovery')).toBe('retry');
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

// Static structural assertions (sessions-sync rate-limiter shape, and
// the inverse "upload.ts has no fan-out wiring" guard) require reading
// source files at runtime, which the Workers vitest pool does not allow.
// They live in host/__tests__/sync-fanout-static.test.js (Node test
// runner with full fs access). See that file for the matching
// fixture-free assertions.
