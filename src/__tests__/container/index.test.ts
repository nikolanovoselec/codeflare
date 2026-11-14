import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { getBucketName } from '../../lib/access';
import { createLogger, type Logger } from '../../lib/logger';
import { env, runInDurableObject } from 'cloudflare:test';
import type { DurableObject as NativeDurableObject } from 'cloudflare:workers';
import { OperatorActivity } from '../../operators/activity';

// Shared, hoisted call-order log so the mocked base Container can record when
// super.startAndWaitForPorts() runs relative to interceptOutboundHttps() — used
// by the REQ-ENTERPRISE-004 pre-start interception-ordering test below.
const lifecycleSerialization = vi.hoisted(() => ({ enabled: false }));
const { callOrder, scanRuntime } = vi.hoisted(() => ({ callOrder: [] as string[],
  scanRuntime: { enabled: false, result: null as unknown } }));
vi.mock('../../operators/runtime', async importOriginal => ({
  ...await importOriginal<typeof import('../../operators/runtime')>(),
  driveDispatcherRuntime: async (input: { activity: {
    beginDrive: () => Promise<{ ok: boolean; state?: { generation: number } }>;
    commitDrive: (generation: number, update: unknown) => Promise<unknown> } }) => {
    if (!scanRuntime.enabled) throw Error('Unexpected Dispatcher runtime');
    const begun = await input.activity.beginDrive();
    if (!begun.ok || !begun.state) return { ok: false, reason: 'not-admitted' };
    await input.activity.commitDrive(begun.state.generation, { schemaVersion: 1,
      status: 'completed', checkpoint: null, result: scanRuntime.result });
    return { ok: true };
  },
}));

/**
 * Container DO class tests.
 *
 * The container class (src/container/index.ts) extends Cloudflare's Container<Env>
 * base class. Idle detection is owned by collectMetrics (polls /activity every 60s
 * and explicitly calls stop('SIGTERM') when idleMs > idleTimeoutPref). The SDK's
 * sleepAfter field is pinned to '24h' and plays no role in idle decisions.
 *
 * What we CAN test in isolation:
 * - Constructor initialization (bucketName loading, envVars population)
 * - Internal route dispatch table structure
 * - onStart/onStop lifecycle (KV timestamp updates)
 * - destroy() cleanup
 * - idleTimeoutPref persistence and loading
 *
 * What we CANNOT test without full Container runtime:
 * - setBucketName persistence (calls ctx.storage.put)
 * - The full fetch override (calls super.fetch for non-internal routes)
 */

// Mock dependencies before importing the container class
vi.mock('../../lib/r2-config', () => ({
  getR2Config: vi.fn().mockResolvedValue({ accountId: 'test-account', endpoint: 'https://r2.test' }),
}));

vi.mock('../../lib/logger', async importOriginal => {
  const actual = await importOriginal<typeof import('../../lib/logger')>();
  return {
    ...actual,
    createLogger: vi.fn((...args: Parameters<typeof actual.createLogger>) => {
      const real = actual.createLogger(...args);
      return {
        debug: vi.fn((...values: Parameters<typeof real.debug>) => { if (lifecycleSerialization.enabled) real.debug(...values); }),
        info: vi.fn((...values: Parameters<typeof real.info>) => { if (lifecycleSerialization.enabled) real.info(...values); }),
        warn: vi.fn((...values: Parameters<typeof real.warn>) => { if (lifecycleSerialization.enabled) real.warn(...values); }),
        error: vi.fn((...values: Parameters<typeof real.error>) => { if (lifecycleSerialization.enabled) real.error(...values); }),
        child: vi.fn().mockReturnThis(),
      };
    }),
  };
});

// Mock the @cloudflare/containers module
vi.mock('@cloudflare/containers', () => ({
  Container: class MockContainer {
    ctx: any;
    env: any;
    envVars?: Record<string, string>;
    defaultPort?: number;
    sleepAfter?: string;

    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }

    async fetch(_request: Request): Promise<Response> {
      return new Response('base fetch', { status: 200 });
    }

    async destroy(): Promise<void> {}
    async getState(): Promise<{ status: string }> {
      return { status: 'running' };
    }
    async getActivityInfo(): Promise<any> {
      return null;
    }
    async schedule(seconds: number, method: string, payload?: unknown) {
      return { taskId: 'mock-schedule', callback: method, payload, type: 'delayed' as const,
        time: Math.floor(Date.now() / 1000) + seconds, delayInSeconds: seconds };
    }
    async listSchedules(_method: string): Promise<unknown[]> { return []; }
    deleteSchedules(_method: string): void {}
    renewActivityTimeout(): void {}
    async stop(_signal: string): Promise<void> {}
    onStart(): void {}
    onStop(): void {}
    onError(_error: unknown): void {}
    onActivityExpired(): void {}
    async startAndWaitForPorts(..._args: any[]): Promise<void> {
      callOrder.push('super.startAndWaitForPorts');
    }
  },
}));

// Now import the container class after mocks are set up
import { container as ContainerClass } from '../../container/index';

// REQ-SESSION-019: Final-sync drain endpoint authentication
// REQ-ENTERPRISE-017: AI Gateway Configured in the Setup Wizard
// REQ-ENTERPRISE-023: Strict Gateway Egress Controller Transport
// REQ-OPS-010: Graceful container shutdown preserves data
// REQ-OPS-016: sleepAfter preference persistence and lifecycle
// REQ-SESSION-006: User can stop, restart, and delete sessions
// REQ-SESSION-008: Container restart preserves R2 bucket

describe('container DO class / REQ-SESSION-002 (one container per session) / REQ-SESSION-019', () => {
  let mockStorage: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteAll: ReturnType<typeof vi.fn>;
    setAlarm: ReturnType<typeof vi.fn>;
    deleteAlarm: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  let mockTcpPortFetch: ReturnType<typeof vi.fn>;
  let mockContainerRuntime: {
    running: boolean;
    getTcpPort: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    monitor: ReturnType<typeof vi.fn>;
    signal: ReturnType<typeof vi.fn>;
  };
  let mockCtx: {
    storage: typeof mockStorage;
    id: { toString: () => string };
    blockConcurrencyWhile: ReturnType<typeof vi.fn>;
    waitUntil: ReturnType<typeof vi.fn>;
    container: typeof mockContainerRuntime;
  };
  let mockEnv: any;

  beforeEach(() => {
    mockStorage = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      deleteAll: vi.fn().mockResolvedValue(undefined),
      setAlarm: vi.fn().mockResolvedValue(undefined),
      deleteAlarm: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(async (fn: (txn: { get: typeof mockStorage.get; put: typeof mockStorage.put;
        delete: typeof mockStorage.delete }) => Promise<unknown>) =>
        await fn({ get: mockStorage.get, put: mockStorage.put, delete: mockStorage.delete })),
    };
    mockTcpPortFetch = vi.fn();
    mockContainerRuntime = {
      running: true,
      getTcpPort: vi.fn().mockReturnValue({ fetch: mockTcpPortFetch }),
      start: vi.fn(() => { throw new Error('unexpected container start'); }),
      destroy: vi.fn(),
      monitor: vi.fn(() => new Promise<void>(() => {})),
      signal: vi.fn(),
    };
    mockCtx = {
      storage: mockStorage,
      id: { toString: () => 'test-do-id-hex' },
      blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => fn()),
      waitUntil: vi.fn(),
      container: mockContainerRuntime,
    };
    mockEnv = {
      R2_ACCOUNT_ID: 'test-account',
      R2_ENDPOINT: 'https://r2.test',
      R2_ACCESS_KEY_ID: 'test-key',
      R2_SECRET_ACCESS_KEY: 'test-secret',
      KV: { get: vi.fn().mockResolvedValue(null) },
    };
  });

  async function captureLifecycleSerialization() {
    const { setLogLevel } = await import('../../lib/logger');
    const lines: string[] = [];
    const capture = (value: unknown) => { lines.push(String(value)); };
    const log = vi.spyOn(console, 'log').mockImplementation(capture);
    const warn = vi.spyOn(console, 'warn').mockImplementation(capture);
    const error = vi.spyOn(console, 'error').mockImplementation(capture);
    setLogLevel('info');
    lifecycleSerialization.enabled = true;
    return {
      lines,
      entries: () => lines.map(line => JSON.parse(line) as { message: string; data?: Record<string, unknown> }),
      restore: () => {
        lifecycleSerialization.enabled = false;
        setLogLevel('silent');
        log.mockRestore(); warn.mockRestore(); error.mockRestore();
      },
    };
  }

  describe('REQ-SETUP-004 + REQ-ENTERPRISE-086: durable operation owners', () => {
    function ownerFixture() {
      const values = new Map<string, unknown>();
      mockStorage.get.mockImplementation(async (key: string) => values.get(key));
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { values.set(key, structuredClone(value)); });
      mockStorage.delete.mockImplementation(async (key: string) => values.delete(key));
      const kv = createMockKV();
      mockEnv.KV = kv;
      mockEnv.USAGE_DB = createMockSessionD1(kv);
      return { kv, instance: new ContainerClass(mockCtx as any, mockEnv),
        restart: () => new ContainerClass(mockCtx as any, mockEnv) };
    }

    it('REQ-SETUP-004: concurrent configure cannot both publish; interrupted same-task retry recovers without takeover', async () => {
      const f = ownerFixture();
      const setup = await import('../../routes/setup/index');
      let finish!: (success: boolean) => Promise<void>;
      const writes: string[] = [];
      const run = vi.spyOn(setup, 'runSetupConfiguration').mockImplementation((input, lifetime) => {
        writes.push(input.body.customDomain);
        finish = lifetime.settled;
        return new Response('running');
      });
      const input = { requestUrl: 'https://worker.example.test/api/setup/configure', body: {
        customDomain: 'one.example.test', allowedUsers: ['admin@example.test'], adminUsers: ['admin@example.test'],
      } };
      try {
        expect((await f.instance.configureDeployment(input)).status).toBe(200);
        const rejected = await f.instance.configureDeployment(input);
        expect(await rejected.text()).toMatch(/already in progress/);
        expect(writes).toEqual(['one.example.test']);
        await finish(false); // task failed: not authority to apply a different payload
        const different = await f.instance.configureDeployment({ ...input, body: { ...input.body, customDomain: 'two.example.test' } });
        expect(await different.text()).toMatch(/same configuration/);
        const restarted = f.restart();
        expect((await restarted.configureDeployment(input)).status).toBe(200);
        expect(writes).toEqual(['one.example.test', 'one.example.test']);
        // A new DO incarnation may resume the same durable authority even if no terminal callback ran.
        const afterCrash = f.restart();
        const foreign = await afterCrash.configureDeployment({ ...input, body: { ...input.body, customDomain: 'two.example.test' } });
        expect(await foreign.text()).toMatch(/same configuration/);
        expect((await afterCrash.configureDeployment(input)).status).toBe(200);
        await finish(true);
        expect((await afterCrash.configureDeployment({ ...input, body: { ...input.body, customDomain: 'two.example.test' } })).status).toBe(200);
        expect(writes.at(-1)).toBe('two.example.test');
        await finish(true);
      } finally { run.mockRestore(); }
    });

    it('REQ-ENTERPRISE-086: lost completion response gates migration until explicit abort confirms recovery', async () => {
      const f = ownerFixture();
      const client = await import('../../lib/r2-client');
      const canonicalBytes = 'keep this object';
      let object = canonicalBytes;
      let generation = 0;
      const fetcher = vi.spyOn(client, 'createR2Client').mockReturnValue({ fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith('?uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>uncertain</UploadId></InitiateMultipartUploadResult>');
        if (init?.method === 'POST') throw new Error('completion response lost');
        if (init?.method === 'DELETE' && new URL(url).searchParams.has('uploadId')) return new Response(null, { status: 404 });
        if (init?.method === 'DELETE') object = '';
        return new Response(null, { status: 503 });
      } } as any);
      const migration = await import('../../lib/r2-migration');
      const drive = vi.spyOn(migration, 'advanceMigrationChunk').mockImplementation(async (_env, _bucket, deps) => {
        generation += 1;
        await deps.beforeReady?.({ status: 'ready', regime: 'plain', generation });
        f.kv._set('r2-regime:bucket', { status: 'ready', regime: 'plain', generation });
      });
      try {
        expect((await f.instance.runBucketMultipart({ bucketName: 'bucket', key: 'draft.md', action: 'initiate' })).status).toBe(200);
        await expect(f.instance.runBucketMultipart({ bucketName: 'bucket', key: 'draft.md', action: 'complete', uploadId: 'uncertain', parts: [{ partNumber: 1, etag: 'abc' }] })).rejects.toThrow();
        f.kv._set('r2-regime:bucket', { status: 'migrating', regime: 'sse-c', generation: 0, drained: false });
        await f.instance.advanceBucketMigration('bucket');
        expect(generation).toBe(0);
        expect(await f.kv.get('r2-regime:bucket', 'json')).toMatchObject({ status: 'migrating', drained: false });
        const aborted = await f.instance.runBucketMultipart({ bucketName: 'bucket', key: 'draft.md', action: 'abort', uploadId: 'uncertain' });
        expect(aborted.status).toBe(200);
        await f.instance.advanceBucketMigration('bucket');
        expect(generation).toBe(1);
        expect(object).toBe(canonicalBytes);
      } finally { fetcher.mockRestore(); drive.mockRestore(); }
    });

    it('REQ-ENTERPRISE-086: in-flight completion settles before migration; stale/unknown IDs preserve parts and request restart', async () => {
      const f = ownerFixture();
      const client = await import('../../lib/r2-client');
      let complete!: () => void;
      let completing!: () => void;
      const entered = new Promise<void>(resolve => { completing = resolve; });
      const gate = new Promise<void>(resolve => { complete = resolve; });
      const objects = new Map<string, string>();
      let generation = 0;
      let initiations = 0;
      const parts = new Set(['managed-stale', 'untracked']);
      const fetcher = vi.spyOn(client, 'createR2Client').mockReturnValue({ fetch: async (url: string, init?: RequestInit) => {
        if (url.endsWith('?uploads')) return new Response(`<InitiateMultipartUploadResult><UploadId>${++initiations === 1 ? 'managed-1' : 'managed-stale'}</UploadId></InitiateMultipartUploadResult>`);
        if (init?.method === 'DELETE') { parts.delete(new URL(url).searchParams.get('uploadId')!); return new Response(null, { status: 204 }); }
        if (url.includes('uploadId=managed-1') && init?.method === 'POST') {
          completing(); await gate; objects.set('draft.md', 'retained bytes');
          return new Response('<CompleteMultipartUploadResult><ETag>"abc"</ETag></CompleteMultipartUploadResult>');
        }
        return new Response(null, { status: 503 });
      } } as any);
      const migration = await import('../../lib/r2-migration');
      const drive = vi.spyOn(migration, 'advanceMigrationChunk').mockImplementation(async (_env, _bucket, deps) => {
        expect(objects.get('draft.md')).toBe('retained bytes');
        generation += 1;
        await deps.beforeReady?.({ status: 'ready', regime: 'plain', generation });
        f.kv._set('r2-regime:bucket', { status: 'ready', regime: 'plain', generation });
      });
      try {
        const initiated = await f.instance.runBucketMultipart({ bucketName: 'bucket', key: 'draft.md', action: 'initiate' });
        expect(await initiated.json()).toMatchObject({ uploadId: 'managed-1' });
        expect((await f.instance.runBucketMultipart({ bucketName: 'bucket', key: 'held.md', action: 'initiate' })).status).toBe(200);
        const completion = f.instance.runBucketMultipart({ bucketName: 'bucket', key: 'draft.md', action: 'complete', uploadId: 'managed-1', parts: [{ partNumber: 1, etag: 'abc' }] });
        await entered;
        const advancing = f.instance.advanceBucketMigration('bucket');
        await Promise.resolve();
        expect(generation).toBe(0);
        complete();
        expect((await completion).status).toBe(200);
        await advancing;
        // Eventual KV consistency cannot resurrect a pre-flip upload generation.
        f.kv._set('r2-regime:bucket', { status: 'ready', regime: 'sse-c', generation: 0 });
        for (const uploadId of ['managed-stale', 'untracked']) {
          const refused = await f.instance.runBucketMultipart({ bucketName: 'bucket', key: 'held.md', action: 'complete', uploadId, parts: [{ partNumber: 1, etag: 'abc' }] });
          expect(refused.status).toBe(409);
          expect(await refused.json()).toMatchObject({ code: 'MULTIPART_RESTART_REQUIRED' });
          expect(objects.get('draft.md')).toBe('retained bytes');
          expect([...parts]).toEqual(['managed-stale', 'untracked']);
        }
      } finally { fetcher.mockRestore(); drive.mockRestore(); }
    });
  });

  describe('REQ-OPERATOR-061: configured Renovate run settings', () => {
    function scheduler(interval = 900, lifetimeSeconds = 14_400) {
      const stored = new Map<string, unknown>();
      mockStorage.get.mockImplementation(async (key: string) => stored.get(key));
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { stored.set(key, value); });
      const binding = { installationId: 'dispatcher-install', registrationId: 'scan-generation-one',
        bucket: 'owner-bucket', sessionId: 'session0001', sessionGeneration: 3 };
      let current: Record<string, unknown> | null = { ...binding, repository: 'acme/updates', repositoryId: 424242,
        baseBranch: 'trunk', automaticRuns: true, repetitionIntervalSeconds: interval,
        activatedAt: '2026-09-28T00:00:00.000Z', human: { email: 'admin@example.test',
          expiresAt: Math.floor(Date.now() / 1000) + lifetimeSeconds } };
      const original = structuredClone(current);
      let availability: 'current' | 'unavailable' | 'rpc-error' = 'current';
      const live = (id: string) => current?.registrationId === id
        && (current.human as { expiresAt: number }).expiresAt * 1000 > Date.now() ? current : null;
      const observation = async (id: string) => {
        if (!live(id)) return { status: 'denied' as const };
        if (availability === 'rpc-error') throw Error('Temporary Registry RPC outage');
        return availability === 'unavailable' ? { status: 'unavailable' as const }
          : { status: 'current' as const, registration: current };
      };
      let eligible = false, activityId: string | undefined;
      const activities = new Map<string, { executionStatus: string }>();
      const reads: Request[] = [], admissions: unknown[] = [];
      mockEnv.CONTAINER = { idFromName: () => ({ toString: () => 'test-do-id-hex' }) };
      mockEnv.OPERATOR_ACTIVITY = { getByName: (id: string) => ({
        getRuntimePlan: async () => {
          if (id !== activityId) throw Error('Foreign or replacement Activity');
          return { activityId: id };
        },
        getBrowserDetail: async () => activities.get(id),
      }) };
      mockEnv.OPERATOR_REGISTRY = { getByName: () => ({
        retainedProspectiveRenovateRetryTargets: async () => [],
        observeProspectiveRenovateRegistration: observation,
        currentProspectiveRenovateRegistration: async (id: string) => {
          const observed = await observation(id);
          return observed.status === 'current' ? observed.registration : null;
        },
        reserveProspectiveRenovateActivity: async (input: { activityId: string }) => {
          admissions.push(input); activityId ??= input.activityId;
          // Scheduler-only fixture reconciles an already-completed original Activity.
          if (!activities.has(activityId)) activities.set(activityId, { executionStatus: 'completed' });
          return { ok: true, activityId, actor: binding };
        },
        readProspectiveRenovateAdmission: async () => ({ repositoryId: 424242, pullRequest: 17,
          head: 'a'.repeat(40), actor: binding }),
      }) };
      let readHook: ((request: Request) => Promise<void>) | undefined;
      let listingHook: (() => Promise<void>) | undefined;
      (mockCtx as any).exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => {
        reads.push(request); await readHook?.(request);
        return request.url.endsWith('/repos/acme/updates') ? Response.json({ id: 424242,
          full_name: 'acme/updates', default_branch: 'trunk' }) : Response.json(eligible ? [{
            number: 17, state: 'open', draft: false, created_at: '2026-09-28T00:00:00.001Z',
            user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: 'a'.repeat(40) },
            base: { ref: 'trunk', sha: 'b'.repeat(40), repo: { id: 424242, full_name: 'acme/updates' } },
          }] : []);
      } }) };
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      type Row = { taskId: string; callback: string; payload: unknown; type: 'delayed'; time: number; delayInSeconds: number };
      const rows: Row[] = [{ taskId: 'metrics', callback: 'collectMetrics', payload: '', type: 'delayed',
        time: Math.floor(Date.now() / 1000) + 60, delayInSeconds: 60 }];
      let lost = false, sequence = 0;
      vi.spyOn(instance, 'listSchedules').mockImplementation(async method => {
        await listingHook?.();
        return rows.filter(row => !method || row.callback === method) as never;
      });
      vi.spyOn(instance, 'deleteSchedules').mockImplementation(method => {
        for (let index = rows.length - 1; index >= 0; index--) if (rows[index].callback === method) rows.splice(index, 1);
      });
      vi.spyOn(instance, 'schedule').mockImplementation(async (delay, callback, payload) => {
        const row: Row = { taskId: `task-${++sequence}`, callback, payload, type: 'delayed',
          time: Math.floor(Date.now() / 1000) + Number(delay), delayInSeconds: Number(delay) };
        rows.push(row);
        if (lost) { lost = false; throw Error('accepted schedule response lost'); }
        return row as never;
      });
      const scans = () => rows.filter(row => row.callback === 'scanRenovate');
      const deliver = async (row: Row) => {
        if (Date.now() < row.time * 1000) throw Error('not due');
        try { await (instance.scanRenovate as unknown as (payload: unknown) => Promise<void>)(row.payload); }
        finally { const index = rows.indexOf(row); if (index >= 0) rows.splice(index, 1); }
      };
      return { instance, binding, rows, reads, admissions, activities, scans, deliver,
        change: (patch: Record<string, unknown> | null) => { current = patch === null ? null : { ...current, ...patch }; },
        restore: () => { current = structuredClone(original); availability = 'current'; },
        unavailable: (kind: 'unavailable' | 'rpc-error' = 'unavailable') => { availability = kind; },
        eligible: () => { eligible = true; },
        legacy: () => { stored.clear(); stored.set('renovate:scan', { ...binding }); },
        onListing: (hook?: () => Promise<void>) => { listingHook = hook; },
        loseAck: () => { lost = true; }, onRead: (hook: (request: Request) => Promise<void>) => { readHook = hook; } };
    }
    it('REQ-OPERATOR-061 AC1/3: explicit verified activation can replace an unbounded legacy pin', async () => {
      const f = scheduler();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      try {
        f.legacy();
        expect(await f.instance.armRenovateScan(f.binding)).toEqual({ ok: true });
        expect(f.scans().map(row => row.delayInSeconds)).toEqual([900]);
        f.unavailable();
        clock.mockReturnValue(f.scans()[0].time * 1000);
        await f.deliver(f.scans()[0]).catch(() => {});
        expect(f.reads).toEqual([]); expect(f.admissions).toEqual([]);
        expect(f.scans()).toHaveLength(1);
      } finally { clock.mockRestore(); }
    });

    it.each(['unavailable', 'rpc-error'] as const)(
      'REQ-OPERATOR-061 AC2/3/7: due one-shot survives final %s authority loss without protected work, then admits one Activity', async fault => {
        const f = scheduler();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
        try {
          expect(await f.instance.armRenovateScan(f.binding)).toEqual({ ok: true });
          f.eligible(); f.unavailable(fault);
          clock.mockReturnValue(f.scans()[0].time * 1000);
          await f.deliver(f.scans()[0]).catch(() => {});
          expect(f.reads).toEqual([]); expect(f.admissions).toEqual([]); expect([...f.activities]).toEqual([]);
          expect(f.scans()).toHaveLength(1);
          // More than one outage delivery must not buy authority or duplicate successors.
          clock.mockReturnValue(f.scans()[0].time * 1000);
          await f.deliver(f.scans()[0]).catch(() => {});
          expect(f.reads).toEqual([]); expect(f.admissions).toEqual([]); expect([...f.activities]).toEqual([]);
          expect(f.scans()).toHaveLength(1);
          f.restore();
          clock.mockReturnValue(f.scans()[0].time * 1000); await f.deliver(f.scans()[0]);
          expect(f.reads.map(request => request.url)).toEqual(['https://api.github.com/repos/acme/updates',
            'https://api.github.com/repos/acme/updates/pulls?state=open&per_page=100&page=1']);
          const admitted = [...f.activities];
          expect(admitted).toEqual([[expect.any(String), { executionStatus: 'completed' }]]);
          clock.mockReturnValue(f.scans()[0].time * 1000); await f.deliver(f.scans()[0]);
          expect([...f.activities]).toEqual(admitted);
          expect(f.scans()).toHaveLength(1);
        } finally { clock.mockRestore(); }
      });

    it('REQ-OPERATOR-061 AC3/5: authority loss while rearm waits for concurrent arm reconciliation retains one bounded observation', async () => {
      const f = scheduler();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      let releasePage!: () => void, pageEntered!: () => void;
      const pageReady = new Promise<void>(resolve => { pageEntered = resolve; });
      const page = new Promise<void>(resolve => { releasePage = resolve; });
      let releaseListing!: () => void, listingEntered!: () => void;
      const listingReady = new Promise<void>(resolve => { listingEntered = resolve; });
      const listing = new Promise<void>(resolve => { releaseListing = resolve; });
      try {
        await f.instance.armRenovateScan(f.binding);
        clock.mockReturnValue(f.scans()[0].time * 1000);
        f.onRead(async request => { if (request.url.includes('/pulls?')) { pageEntered(); await page; } });
        const delivered = f.deliver(f.scans()[0]);
        await Promise.race([pageReady, delivered.then(() => { throw Error('Due scan completed without observing the held page'); })]);
        f.onListing(async () => { listingEntered(); await listing; });
        const reconciled = f.instance.armRenovateScan(f.binding);
        await Promise.race([listingReady, reconciled.then(() => { throw Error('Concurrent arm did not reconcile its schedule'); })]);
        releasePage();
        // Let the callback finish discovery and enqueue rearm behind the held public arm.
        // The outage is a real serialization boundary, not a selected private-call ordinal.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const beforeOutage = [...f.reads];
        f.unavailable(); releaseListing();
        await Promise.all([delivered.catch(() => {}), reconciled]);
        f.onListing();
        expect(f.reads).toEqual(beforeOutage); expect(f.admissions).toEqual([]); expect([...f.activities]).toEqual([]);
        expect(f.scans()).toHaveLength(1);
        clock.mockReturnValue(f.scans()[0].time * 1000);
        await f.deliver(f.scans()[0]).catch(() => {});
        expect(f.reads).toEqual(beforeOutage); expect([...f.activities]).toEqual([]);
        expect(f.scans()).toHaveLength(1);
        f.restore(); f.eligible();
        clock.mockReturnValue(f.scans()[0].time * 1000); await f.deliver(f.scans()[0]);
        expect([...f.activities]).toEqual([[expect.any(String), { executionStatus: 'completed' }]]);
        expect(f.scans()).toHaveLength(1);
      } finally { releasePage(); releaseListing(); clock.mockRestore(); }
    });

    it.each([1.9, 0.9])('REQ-OPERATOR-061 AC3: insufficient authority time cannot advance the configured scan interval (%s)', async remaining => {
      const f = scheduler(900, 1000);
      const now = Math.floor(Date.now() / 1000) * 1000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        await f.instance.armRenovateScan(f.binding);
        f.unavailable(); clock.mockReturnValue(now + 1_000_000 - remaining * 1000);
        await f.deliver(f.scans()[0]).catch(() => {});
        expect(f.reads).toEqual([]); expect([...f.activities]).toEqual([]);
        expect(f.scans()).toEqual([]);
        f.restore();
        expect(f.scans()).toEqual([]);
      } finally { clock.mockRestore(); }
    });

    it.each(['expiry', 'denial', 'generation', 'legacy'] as const)(
      'REQ-OPERATOR-061 AC3: %s terminates a pending outage observation without work or new authority', async fault => {
        const f = scheduler(900, 2000), now = Math.floor(Date.now() / 1000) * 1000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        try {
          await f.instance.armRenovateScan(f.binding);
          f.unavailable(); clock.mockReturnValue(f.scans()[0].time * 1000);
          await f.deliver(f.scans()[0]).catch(() => {});
          expect(f.scans()).toHaveLength(1);
          if (fault === 'expiry') clock.mockReturnValue(now + 2_000_000);
          else clock.mockReturnValue(f.scans()[0].time * 1000);
          if (fault === 'denial') f.change(null);
          if (fault === 'generation') { f.restore(); f.change({ sessionGeneration: 4 }); }
          if (fault === 'legacy') f.legacy();
          await f.deliver(f.scans()[0]).catch(() => {});
          expect(f.reads).toEqual([]); expect(f.admissions).toEqual([]); expect([...f.activities]).toEqual([]);
          expect(f.scans()).toEqual([]);
          f.restore();
          // No automatic new arm when authority later becomes valid.
          expect(f.scans()).toEqual([]);
          expect(f.rows.find(row => row.taskId === 'metrics')).toMatchObject({ callback: 'collectMetrics' });
        } finally { clock.mockRestore(); }
      });

    it.each([900, 7200, 3600])('delivers a registered %i-second scan and one same-interval successor without touching metrics', async interval => {
      const f = scheduler(interval), now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        expect(await f.instance.armRenovateScan(f.binding)).toEqual({ ok: true });
        expect(f.scans().map(row => row.time)).toEqual([Math.floor(now / 1000) + interval]);
        await expect(f.deliver(f.scans()[0])).rejects.toThrow('not due');
        expect(f.reads).toEqual([]);
        clock.mockReturnValue(f.scans()[0].time * 1000);
        await f.deliver(f.scans()[0]);
        expect(f.reads.map(request => request.url)).toEqual(['https://api.github.com/repos/acme/updates',
          'https://api.github.com/repos/acme/updates/pulls?state=open&per_page=100&page=1']);
        expect(f.scans().map(row => row.time)).toEqual([Math.floor(Date.now() / 1000) + interval]);
        expect(f.rows.find(row => row.taskId === 'metrics')).toMatchObject({ callback: 'collectMetrics', delayInSeconds: 60 });
      } finally { clock.mockRestore(); }
    });
    it.each([900, 7200])('reconciles lost acknowledgement at %i seconds without duplication or postponement', async interval => {
      const f = scheduler(interval); f.loseAck();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
      try {
        await expect(f.instance.armRenovateScan(f.binding)).rejects.toThrow();
        const accepted = structuredClone(f.scans());
        clock.mockReturnValue(Date.now() + 10_000);
        expect(await Promise.all([f.instance.armRenovateScan(f.binding), f.instance.armRenovateScan(f.binding)]))
          .toEqual([{ ok: true }, { ok: true }]);
        expect(f.scans()).toEqual(accepted);
      } finally { clock.mockRestore(); }
    });
    it('automatic off makes an already-delivered callback inert with no protected reads admission or successor', async () => {
      const f = scheduler(); await f.instance.armRenovateScan(f.binding);
      const due = f.scans()[0]; f.change(null);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(due.time * 1000);
      try { await f.deliver(due); } finally { clock.mockRestore(); }
      expect(f.reads).toEqual([]); expect(f.admissions).toEqual([]); expect(f.scans()).toEqual([]);
    });
    it('explicit new-generation activation replaces the due row and an old delivered payload cannot borrow the new arm', async () => {
      const f = scheduler(); await f.instance.armRenovateScan(f.binding);
      const old = f.scans()[0], newer = { ...f.binding, registrationId: 'scan-generation-two' };
      const clock = vi.spyOn(Date, 'now').mockReturnValue(old.time * 1000);
      try {
        f.change({ registrationId: newer.registrationId, repetitionIntervalSeconds: 7200 });
        expect(await f.instance.armRenovateScan(newer)).toEqual({ ok: true });
        const accepted = structuredClone(f.scans());
        expect(accepted.map(row => row.time)).toEqual([Math.floor(Date.now() / 1000) + 7200]);
        await f.deliver(old);
        expect(f.reads).toEqual([]); expect(f.admissions).toEqual([]); expect(f.scans()).toEqual(accepted);
      } finally { clock.mockRestore(); }
    });
    it('a payload-less legacy callback cannot execute the latest armed registration', async () => {
      const f = scheduler(); await f.instance.armRenovateScan(f.binding);
      const accepted = structuredClone(f.scans());
      await (f.instance.scanRenovate as unknown as (payload?: unknown) => Promise<void>)();
      expect(f.reads).toEqual([]); expect(f.admissions).toEqual([]); expect(f.scans()).toEqual(accepted);
    });
    it('a delivered old scan cannot rearm its stale generation after activation wins during metadata I/O', async () => {
      const f = scheduler(); await f.instance.armRenovateScan(f.binding);
      const old = f.scans()[0]; let changed = false;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(old.time * 1000);
      try {
        f.onRead(async () => {
          if (changed) return; changed = true;
          f.change({ registrationId: 'scan-generation-two', repetitionIntervalSeconds: 7200 });
          await f.instance.armRenovateScan({ ...f.binding, registrationId: 'scan-generation-two' });
        });
        await f.deliver(old).catch(() => {});
        expect(f.admissions).toEqual([]);
        expect(f.scans().map(row => row.delayInSeconds)).toEqual([7200]);
      } finally { clock.mockRestore(); }
    });
  });

  it.each(['preparation', 'start'])('REQ-OPERATOR-061 AC2/7: a lost %s acknowledgement retains original Activity and actor at later configured scans', async lost => {
    const stored = new Map<string, unknown>();
    mockStorage.get.mockImplementation(async (key: string) => stored.get(key));
    mockStorage.put.mockImplementation(async (key: string, value: unknown) => { stored.set(key, value); });
    mockEnv.ENCRYPTION_KEY = btoa('k'.repeat(32));
    const human = { subject: 'admin', email: 'admin@example.test', issuer: 'https://owner.cloudflareaccess.com',
      audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 20,
      expiresAt: Math.floor(Date.now() / 1000) + 14_400 };
    const pin = { installationId: 'dispatcher-install', registrationId: 'original-admin',
      bucket: getBucketName(human.email, mockEnv.CLOUDFLARE_WORKER_NAME), sessionId: 'session0001', sessionGeneration: 3 };
    const actor = { registrationId: pin.registrationId, bucket: pin.bucket,
      sessionId: pin.sessionId, sessionGeneration: pin.sessionGeneration };
    mockEnv.CONTAINER = {
      idFromName: () => ({ toString: () => 'test-do-id-hex' }),
      get: () => ({ claimBucketOwner: async (email: string) => email === human.email ? 'owned' : 'conflict' }),
      getByName: (name: string) => ({ getPersonalPiSession: async (ref: { bucket: string; sessionId: string; email: string }) => {
        if (name !== `${pin.bucket}-${pin.sessionId}` || ref.bucket !== actor.bucket
          || ref.sessionId !== actor.sessionId || ref.email !== human.email) throw Error('Foreign source Host');
        return { generation: actor.sessionGeneration };
      } }),
    };
    const current = { ...pin, repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk',
      repetitionIntervalSeconds: 900, controlsRevision: 1, installationRevision: 1, operatorRevision: 1,
      releaseId: 'release', bundleDigest: 'c'.repeat(64), activatedAt: '2026-09-28T00:00:00.000Z', human, accessJwt: 'a-jwt' };
    const retained = { repositoryId: 424242, pullRequest: 1300, head: 'a'.repeat(40), createdAt: '2026-09-28T00:00:00.001Z' };
    let reservedId: string | undefined;
    let state: 'absent' | 'prepared' | 'queued' = 'absent';
    const history: Array<{ activityId: string; effect: string; invocation?: string }> = [];
    const selection = { controlsRevision: 1,
      installation: { id: pin.installationId, operatorId: 'dispatcher', revision: 1, enabled: true,
        releaseId: 'release', policy: { capabilities: ['fetch'], resourceProfileId: null },
        configurationJson: JSON.stringify({ renovate: { repository: current.repository, automaticRuns: true, repetitionIntervalSeconds: 900 } }) },
      operator: { operatorId: 'dispatcher', profile: 'dispatcher', revision: 1,
        policy: { capabilities: ['fetch'], resourceProfileId: null }, invokers: { users: [human.email], groups: [] } },
      release: { id: 'release', bundleDigest: current.bundleDigest },
      manifestJson: JSON.stringify({ id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '4' }) };
    mockEnv.OPERATOR_REGISTRY = { getByName: () => ({
      resolveManagementExecution: async () => ({ ok: true, value: selection }),
      observeProspectiveRenovateRegistration: async () => ({ status: 'current', registration: current }),
      currentProspectiveRenovateRegistration: async () => current,
      retainedProspectiveRenovateRetryTargets: async () => [retained],
      reserveProspectiveRenovateActivity: async (input: { activityId: string; pullRequest: number }) => {
        if (input.pullRequest !== retained.pullRequest) throw Error('Cutoff exception widened');
        reservedId ??= input.activityId;
        return { ok: true, activityId: reservedId, actor };
      },
      readProspectiveRenovateAdmission: async (id: string) => ({ ...retained, activityId: id, actor }),
    }) };
    mockEnv.OPERATOR_ACTIVITY = { getByName: (id: string) => {
      if (id !== reservedId) throw Error('Replacement Activity');
      return { bindDispatcherOwnerSource: async (source: { bucket: string; sessionId: string; sessionGeneration: number }) => source.bucket === actor.bucket
          && source.sessionId === actor.sessionId && source.sessionGeneration === actor.sessionGeneration,
        getRuntimePlan: async () => null,
        getBrowserDetail: async () => state === 'absent' ? null : ({ executionStatus: state }),
        prepareAuthorized: async (intent: { activityId: string; expectedRevision: number;
          expectedInstallationRevision: number; expectedControlsRevision: number; deadline: number },
        _context: unknown, invocation: string, boundary: unknown, prospectiveAdmissionId?: string) => {
          expect(intent).toMatchObject({ activityId: reservedId, expectedRevision: current.operatorRevision,
            expectedInstallationRevision: current.installationRevision, expectedControlsRevision: current.controlsRevision,
            deadline: human.expiresAt * 1000 });
          expect(boundary).toBeUndefined();
          expect(prospectiveAdmissionId).toBe(reservedId);
          state = 'prepared'; history.push({ activityId: intent.activityId, effect: 'prepared', invocation });
          if (lost === 'preparation') throw Error('Accepted preparation acknowledgement lost');
          return { ok: true };
        },
        start: async () => { state = 'queued'; history.push({ activityId: id, effect: 'started' });
          throw Error('Accepted start acknowledgement lost'); },
      };
    } };
    (mockCtx as any).exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) =>
      request.url.endsWith('/repos/acme/updates') ? Response.json({ id: 424242, full_name: 'acme/updates', default_branch: 'trunk' })
        : Response.json([{ number: 1300, state: 'open', draft: false, created_at: retained.createdAt,
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: retained.head },
          base: { ref: 'trunk', sha: 'b'.repeat(40), repo: { id: 424242, full_name: 'acme/updates' } } }]) }) };
    const session = new ContainerClass(mockCtx as any, mockEnv);
    const rows: Array<{ payload: unknown; delay: number }> = [];
    vi.spyOn(session, 'listSchedules').mockResolvedValue([]);
    vi.spyOn(session, 'deleteSchedules').mockImplementation(() => {});
    vi.spyOn(session, 'schedule').mockImplementation(async (delay, _method, payload) => {
      rows.push({ payload, delay: Number(delay) });
      return { taskId: 'scan', callback: 'scanRenovate', payload, type: 'delayed',
        time: Math.floor(Date.now() / 1000) + Number(delay), delayInSeconds: Number(delay) };
    });
    expect(await session.armRenovateScan(pin)).toEqual({ ok: true });
    const now = Date.now(), clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now + 900_000);
      await session.scanRenovate(pin);
      const originalHistory = structuredClone(history);
      expect(originalHistory).toEqual([{ activityId: reservedId, effect: 'prepared',
        invocation: JSON.stringify({ repository: current.repository }) },
        ...(lost === 'start' ? [{ activityId: reservedId, effect: 'started' }] : [])]);
      clock.mockReturnValue(now + 1_800_000);
      await session.scanRenovate(pin);
      expect(history).toEqual(originalHistory);
      expect(state).toBe(lost === 'preparation' ? 'prepared' : 'queued');
      expect(rows.map(row => row.delay)).toEqual([900, 900, 900]);
    } finally { clock.mockRestore(); }
  });

  it('REQ-OPERATOR-061: a lost scheduler acknowledgement is reconciled without creating another hourly callback', async () => {
    const saved = new Map<string, unknown>();
    mockStorage.get.mockImplementation(async (key: string) => saved.get(key));
    mockStorage.put.mockImplementation(async (key: string, value: unknown) => { saved.set(key, value); });
    mockEnv.CONTAINER = { idFromName: (name: string) => ({ toString: () =>
      name === 'owner-bucket-session0001' ? 'test-do-id-hex' : 'foreign-do' }) };
    mockEnv.OPERATOR_ACTIVITY = {};
    mockEnv.OPERATOR_REGISTRY = { getByName: () => ({
      retainedProspectiveRenovateRetryTargets: async () => [],
      async observeProspectiveRenovateRegistration() {
        return { status: 'current', registration: await this.currentProspectiveRenovateRegistration() };
      },
      currentProspectiveRenovateRegistration: async () => ({ repository: 'nikolanovoselec/komodo', repositoryId: 973175879, baseBranch: 'main', repetitionIntervalSeconds: 3600, installationId: 'dispatcher-install',
        registrationId: 'registered-admin', bucket: 'owner-bucket', sessionId: 'session0001', sessionGeneration: 3,
        human: { expiresAt: Math.floor(Date.now() / 1000) + 14_400 } }),
    }) };
    const instance = new ContainerClass(mockCtx as any, mockEnv);
    const scheduled: Array<{ callback: string; due: number; payload?: unknown }> = [];
    vi.spyOn(instance, 'listSchedules').mockImplementation(async () => scheduled as never);
    vi.spyOn(instance, 'schedule').mockImplementation(async (_delay, callback, payload) => {
      scheduled.push({ callback, due: Date.now() + 3_600_000, payload });
      throw Error('Scheduler accepted callback but response was lost');
    });
    const binding = { registrationId: 'registered-admin', installationId: 'dispatcher-install',
      bucket: 'owner-bucket', sessionId: 'session0001', sessionGeneration: 3 };
    await expect(instance.armRenovateScan(binding)).rejects.toThrow();
    const retries = await Promise.all([instance.armRenovateScan(binding), instance.armRenovateScan(binding)]);
    expect(retries).toEqual([{ ok: true }, { ok: true }]);
    expect(scheduled).toEqual([{ callback: 'scanRenovate', due: expect.any(Number), payload: expect.any(Object) }]);
    // Overlapping first-time activation requests start with no persisted row.
    const fresh = new ContainerClass(mockCtx as any, mockEnv);
    const initiallyEmpty: Array<{ callback: string; due: number; payload?: unknown }> = [];
    vi.spyOn(fresh, 'listSchedules').mockImplementation(async () => initiallyEmpty as never);
    vi.spyOn(fresh, 'schedule').mockImplementation(async (_delay, callback, payload) => {
      await Promise.resolve();
      initiallyEmpty.push({ callback, due: Date.now() + 3_600_000, payload });
      return { taskId: 'future', callback, payload, type: 'delayed',
        time: Math.floor(Date.now() / 1000) + 3600, delayInSeconds: 3600 };
    });
    expect(await Promise.all([fresh.armRenovateScan(binding), fresh.armRenovateScan(binding)]))
      .toEqual([{ ok: true }, { ok: true }]);
    expect(initiallyEmpty).toEqual([{ callback: 'scanRenovate', due: expect.any(Number), payload: expect.any(Object) }]);
    // SDK still exposes its due row during the callback and deletes it afterward.
    await (fresh.scanRenovate as unknown as (payload: unknown) => Promise<void>)(initiallyEmpty[0].payload);
    initiallyEmpty.shift(); // SDK deletion of the previously due row.
    expect(initiallyEmpty).toEqual([{ callback: 'scanRenovate', due: expect.any(Number), payload: expect.any(Object) }]);
  });

  it('REQ-OPERATOR-061: an armed admin-session callback scans complete post-cutoff Komodo pages', async () => {
    const stored = new Map<string, unknown>();
    mockStorage.get.mockImplementation(async (key: string) => stored.get(key));
    mockStorage.put.mockImplementation(async (key: string, value: unknown) => { stored.set(key, value); });
    const activatedAt = '2026-09-28T00:00:00.000Z';
    mockEnv.ENCRYPTION_KEY = btoa('k'.repeat(32));
    const seen: Array<{ pullRequest: number; activityId: string }> = [];
    let reservedActivityId: string | undefined;
    const unauthorizedEffects: string[] = [];
    let uncertainStatus: 'queued' | 'running' = 'queued';
    const reserve = async (input: { pullRequest: number; activityId: string; createdAt: string }) => {
      seen.push({ pullRequest: input.pullRequest, activityId: input.activityId });
      if (input.pullRequest === 1302) reservedActivityId ??= input.activityId;
      return { ok: input.pullRequest === 1302, activityId: reservedActivityId ?? input.activityId,
        actor: { registrationId: 'active-admin', bucket: 'owner-bucket', sessionId: 'session0001', sessionGeneration: 3 } };
    };
    mockEnv.CONTAINER = { idFromName: (name: string) => ({ toString: () =>
      name === 'owner-bucket-session0001' ? 'test-do-id-hex' : 'foreign-do' }) };
    mockEnv.OPERATOR_REGISTRY = { getByName: () => ({
      resolveManagementExecution: async () => ({ ok: true, value: {
        controlsRevision: 1, installation: { id: 'dispatcher-install', operatorId: 'dispatcher', revision: 1,
          configurationJson: JSON.stringify({ renovate: { repository: 'nikolanovoselec/komodo', automaticRuns: true, repetitionIntervalSeconds: 3600 } }),
          enabled: true, policy: { capabilities: ['fetch'], resourceProfileId: null }, releaseId: 'release' },
        operator: { operatorId: 'dispatcher', revision: 1, profile: 'dispatcher',
          invokers: { users: ['admin@example.test'], groups: [] } },
        release: { id: 'release', bundleDigest: 'c'.repeat(64) }, manifestJson: JSON.stringify({ id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '3' }),
      } }),
      retainedProspectiveRenovateRetryTargets: async () => [],
      async observeProspectiveRenovateRegistration() {
        return { status: 'current', registration: await this.currentProspectiveRenovateRegistration() };
      },
      currentProspectiveRenovateRegistration: async () => ({ repository: 'nikolanovoselec/komodo', repositoryId: 973175879, baseBranch: 'main', repetitionIntervalSeconds: 3600, controlsRevision: 1, installationRevision: 1, operatorRevision: 1, releaseId: 'release', bundleDigest: 'c'.repeat(64), activatedAt, installationId: 'dispatcher-install',
        registrationId: 'active-admin', bucket: 'owner-bucket', sessionId: 'session0001', sessionGeneration: 3,
        human: { subject: 'admin', email: 'admin@example.test', issuer: 'https://owner.cloudflareaccess.com',
          audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
          expiresAt: Math.floor(Date.now() / 1000) + 14_400 }, accessJwt: 'sealed-jwt' }),
      reserveProspectiveRenovateActivity: reserve,
      readProspectiveRenovateAdmission: async (id: string) => id === reservedActivityId ? {
        activityId: id, repository: 'nikolanovoselec/komodo', baseBranch: 'main', repositoryId: 973175879, pullRequest: 1302, head: 'c'.repeat(40),
        actor: { registrationId: 'active-admin', bucket: 'owner-bucket', sessionId: 'session0001',
          sessionGeneration: 3 },
      } : null,
    }) };
    mockEnv.OPERATOR_ACTIVITY = { getByName: (id: string) => {
      if (id !== reservedActivityId) throw Error('Uncertain admission identity changed');
      return { getBrowserDetail: async () => ({ executionStatus: uncertainStatus }),
        getRuntimePlan: async () => null,
        prepareAuthorized: async () => { uncertainStatus = 'running'; unauthorizedEffects.push('replacement-preparation');
          return { ok: true }; },
        start: async () => { uncertainStatus = 'running'; unauthorizedEffects.push('replacement-start'); },
        publishRenovateAssessment: async () => { unauthorizedEffects.push('publication'); },
      };
    } };
    (mockCtx as any).exports = { GitHubInterceptor: () => ({ fetch: async (request: Request) => {
      const url = new URL(request.url), page = Number(url.searchParams.get('page'));
      if (url.pathname === '/repos/nikolanovoselec/komodo') return Response.json({ id: 973175879,
        full_name: 'nikolanovoselec/komodo', default_branch: 'main' });
      if (url.pathname === '/repos/nikolanovoselec/komodo/pulls') return Response.json(page === 1
        ? [...Array.from({ length: 99 }, (_, index) => ({ number: index + 1,
          state: 'open', created_at: activatedAt, updated_at: '2026-09-29T00:00:00.000Z',
          body: 'Release notes and update links '.repeat(40),
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
          head: { sha: 'a'.repeat(40) }, draft: false, base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 973175879, full_name: 'nikolanovoselec/komodo' } } })),
          { number: 1302, created_at: '2026-09-28T00:00:00.001Z', state: 'open',
            user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
            head: { sha: 'c'.repeat(40) }, draft: false, base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 973175879, full_name: 'nikolanovoselec/komodo' } } }]
        : [{ number: 1303, created_at: '2026-09-28T00:00:00.002Z', state: 'open',
          user: { id: 1, login: 'renovate[bot]', type: 'Bot' }, head: { sha: 'd'.repeat(40) },
          draft: false, base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 973175879, full_name: 'nikolanovoselec/komodo' } } },
        { number: 1304, created_at: '2026-09-28T00:00:00.003Z', state: 'open',
          user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: 'e'.repeat(40) },
          draft: false, base: { ref: 'release', sha: 'b'.repeat(40), repo: { id: 973175879, full_name: 'nikolanovoselec/komodo' } } }]);
      throw Error(`Unexpected GitHub read ${url.pathname}`);
    } }) };
    const instance = new ContainerClass(mockCtx as any, mockEnv);
    let deliver: (() => Promise<void>) | undefined;
    vi.spyOn(instance, 'schedule').mockImplementation(async (delay, method, payload) => {
      const due = Date.now() + Number(delay) * 1000;
      deliver = async () => {
        if (Date.now() < due) throw Error('Scheduled scan not due');
        await (instance as unknown as Record<string, (payload: unknown) => Promise<void>>)[method](payload);
      };
      return { taskId: 'prospective-scan', callback: method, payload,
        type: 'delayed', time: Math.floor(due / 1000), delayInSeconds: Number(delay) };
    });
    const arm = (instance as unknown as { armRenovateScan: (input: unknown) => Promise<{ ok: boolean }> }).armRenovateScan;
    expect(await arm.call(instance, { registrationId: 'active-admin', installationId: 'dispatcher-install',
      bucket: 'owner-bucket', sessionId: 'session0001', sessionGeneration: 3 })).toMatchObject({ ok: true });
    expect(deliver).toBeDefined();
    const activatedClock = Date.now();
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(activatedClock + 3_600_001);
    try { await deliver?.(); }
    finally { clock.mockRestore(); }
    expect(seen).toEqual([{ pullRequest: 1302, activityId: expect.any(String) }]);
    // An existing uncertain/prepared Activity has no plan. A later callback
    // must leave it untouched, not manufacture a replacement or publish.
    const repeatClock = vi.spyOn(Date, 'now').mockReturnValue(activatedClock + 7_200_001);
    try { await deliver?.(); } finally { repeatClock.mockRestore(); }
    expect(seen.map(row => row.pullRequest)).toEqual([1302, 1302]);
    expect(reservedActivityId).toBe(seen[0].activityId);
    expect(uncertainStatus).toBe('queued');
    expect(unauthorizedEffects).toEqual([]);
    seen.length = 0;
    let continuationUnavailable = false;
    (mockCtx as any).exports.GitHubInterceptor = () => ({ fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/repos/nikolanovoselec/komodo') return Response.json({ id: 973175879,
        full_name: 'nikolanovoselec/komodo', default_branch: 'main' });
      if (url.searchParams.get('page') === '2') {
        continuationUnavailable = true;
        return new Response('unavailable', { status: 503 });
      }
      return Response.json(Array.from({ length: 100 }, (_, index) => ({ number: index + 1,
        created_at: '2026-09-28T00:00:00.001Z', state: 'open',
        user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
        head: { sha: 'c'.repeat(40) }, draft: false, base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 973175879, full_name: 'nikolanovoselec/komodo' } } })));
    } });
    const nextClock = vi.spyOn(Date, 'now').mockReturnValue(activatedClock + 10_800_001);
    try { await deliver?.().catch(() => {}); }
    finally { nextClock.mockRestore(); }
    expect(continuationUnavailable).toBe(true);
    expect(seen).toEqual([]);
    // Even a valid candidate on the first page is not admitted when a
    // subsequent page exceeds the scan-specific byte bound.
    (mockCtx as any).exports.GitHubInterceptor = () => ({ fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === '/repos/nikolanovoselec/komodo') return Response.json({ id: 973175879,
        full_name: 'nikolanovoselec/komodo', default_branch: 'main' });
      const rows = Array.from({ length: 100 }, (_, index) => ({ number: 1302 + index,
        created_at: '2026-09-28T00:00:00.001Z', state: 'open',
        user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
        head: { sha: 'c'.repeat(40) }, draft: false, base: { ref: 'main', sha: 'b'.repeat(40), repo: { id: 973175879, full_name: 'nikolanovoselec/komodo' } } }));
      return Response.json(url.searchParams.get('page') === '1' ? rows
        : [{ ...rows[0], body: 'x'.repeat(2 * 1024 * 1024 + 1) }]);
    } });
    const hugeClock = vi.spyOn(Date, 'now').mockReturnValue(activatedClock + 14_400_001);
    try { await deliver?.().catch(() => {}); } finally { hugeClock.mockRestore(); }
    expect(seen).toEqual([]);
  });

  it.each(['valid', 'empty', 'extra-target', 'duplicate-target', 'wrong-head', 'foreign-pr', 'wrong-repository'])('REQ-OPERATOR-061/048: a winning scan retains repository-only admission and fences %s simulated singleton collection without parent publication', async resultCase => {
    const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
    await runInDurableObject(namespace.getByName(`container-fixture-${crypto.randomUUID()}`), async (_instance, native) => {
      const stored = new Map<string, unknown>();
      mockStorage.get.mockImplementation(async (key: string) => stored.get(key));
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { stored.set(key, value); });
      mockEnv.ENCRYPTION_KEY = btoa('k'.repeat(32));
      mockEnv.LOADER = {};
      const bucket = getBucketName('admin@example.test', mockEnv.CLOUDFLARE_WORKER_NAME);
      mockEnv.KV = { get: async (key: string) => key === 'user:admin@example.test'
        ? JSON.stringify({ role: 'admin' }) : null };
      mockEnv.USAGE_DB = { prepare: () => ({ bind: (...args: unknown[]) => ({ first: async () =>
        args[0] === bucket && args[1] === 'session0001' ? {
          owner_key: bucket, session_id: 'session0001', lifecycle_state: 'running', lifecycle_generation: 3,
          created_at: new Date().toISOString(), last_accessed_at: new Date().toISOString(),
          workspace: 'default', terminal_mode: 'terminal', name: 'Admin session', response_revision: 0,
          observation_sequence: 0, editor_ready: 1, editor_ready_error: 0,
        } : null }) }) };
      const human = { subject: 'admin', email: 'admin@example.test', issuer: 'https://owner.cloudflareaccess.com',
        audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 20,
        expiresAt: Math.floor(Date.now() / 1000) + 14_400 };
      const bundle = { schemaVersion: 1, sourceCommit: 'f'.repeat(40),
        versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' },
        className: 'FlueDispatcherAgent', compatibilityDate: '2026-09-10',
        compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js',
        modules: { 'index.js': { js: 'export default class FlueDispatcherAgent {}' } } };
      const bundleBytes = new TextEncoder().encode(JSON.stringify(bundle));
      const bundleDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bundleBytes)))
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      const selection = { controlsRevision: 1, installation: { id: 'dispatcher-install', operatorId: 'dispatcher',
        revision: 1, enabled: true, releaseId: 'release',
        configurationJson: JSON.stringify({ renovate: { repository: 'acme/updates', automaticRuns: true, repetitionIntervalSeconds: 3600 } }), policy: { capabilities: ['fetch'], resourceProfileId: null } },
        operator: { id: 'dispatcher', operatorId: 'dispatcher', revision: 1, profile: 'dispatcher',
          policy: { capabilities: ['fetch'], resourceProfileId: null },
          invokers: { users: [human.email], groups: [] } },
        release: { id: 'release', bundleDigest, sourceCommit: bundle.sourceCommit }, manifestJson: JSON.stringify({
          id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion: '3' }) };
      let reservedActivityId: string | null = null;
      const registry = { resolveManagementExecution: async () => ({ ok: true, value: selection }),
        getManagementBundle: async () => bundleBytes,
        admitManagement: async (request: object) => ({ ok: true, value: { ...request,
          admittedAt: Date.now(), selection } }), upsertOwnedActivity: async () => {},
        retainedProspectiveRenovateRetryTargets: async () => [],
        async observeProspectiveRenovateRegistration() {
          return { status: 'current', registration: await this.currentProspectiveRenovateRegistration() };
        },
        currentProspectiveRenovateRegistration: async () => ({ repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk', repetitionIntervalSeconds: 3600, controlsRevision: 1, installationRevision: 1, operatorRevision: 1, releaseId: 'release', bundleDigest, registrationId: 'registered-admin',
          activatedAt: '2026-09-28T00:00:00.000Z', installationId: 'dispatcher-install', bucket,
          sessionId: 'session0001', sessionGeneration: 3, human, accessJwt: 'sealed-admin' }),
        reserveProspectiveRenovateActivity: async (input: { activityId: string }) => {
          reservedActivityId ??= input.activityId;
          return { ok: true, activityId: reservedActivityId,
            actor: { registrationId: 'registered-admin', bucket,
              sessionId: 'session0001', sessionGeneration: 3 } };
        },
        readProspectiveRenovateAdmission: async (id: string) => id !== reservedActivityId ? null : ({ activityId: id,
          installationId: 'dispatcher-install', repository: 'acme/updates', baseBranch: 'trunk', repositoryId: 424242, pullRequest: 1302,
          controlsRevision: 1, installationRevision: 1, operatorRevision: 1, releaseId: 'release', bundleDigest,
          head: 'c'.repeat(40), ownerKey: await (await import('../../operators/browser-activity')).operatorOwnerKey(human),
          activatedAt: '2026-09-28T00:00:00.000Z', createdAt: '2026-09-28T00:00:00.001Z',
          actor: { registrationId: 'registered-admin', bucket, sessionId: 'session0001',
            sessionGeneration: 3, subject: human.subject, email: human.email, issuer: human.issuer,
            audiences: human.audiences } }),
      };
      mockEnv.CONTAINER = {
        idFromName: (name: string) => ({ toString: () => name === `${bucket}-session0001` ? 'test-do-id-hex' : 'foreign-do' }),
        get: () => ({ claimBucketOwner: async (email: string) => email === human.email ? 'owned' : 'conflict' }),
        getByName: (name: string) => ({ getPersonalPiSession: async (ref: { bucket: string; sessionId: string; email: string }) => {
          if (name !== `${bucket}-session0001` || ref.bucket !== bucket
            || ref.sessionId !== 'session0001' || ref.email !== human.email) throw Error('Foreign source Host');
          return { generation: 3 };
        } }),
      };
      mockEnv.OPERATOR_REGISTRY = { getByName: () => registry };
      const writes: string[] = [];
      Object.defineProperty(native, 'exports', { configurable: true, value: { GitHubInterceptor: () => ({
        fetch: async (request: Request) => {
          const url = new URL(request.url);
          if (request.method === 'POST' && url.pathname.endsWith('/comments')) {
            writes.push('comment');
            return Response.json({ id: 801 });
          }
          if (url.pathname === '/user') return Response.json({ id: 9, login: 'admin' });
          if (url.pathname === '/repos/acme/updates' || url.pathname === '/repos/acme/updates/') return Response.json({
            id: 424242, full_name: 'acme/updates', default_branch: 'trunk',
            permissions: { admin: true } });
          if (url.pathname === '/repos/acme/updates/pulls/1302') return Response.json({
            number: 1302, state: 'open', mergeable: true, mergeable_state: 'clean',
            created_at: '2026-09-28T00:00:00.001Z', user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
            head: { sha: 'c'.repeat(40) }, base: { sha: 'b'.repeat(40), ref: 'trunk', repo: { id: 424242, full_name: 'acme/updates' } } });
          if (url.pathname.endsWith('/comments')) return Response.json(writes.map(() => ({ id: 801,
            body: `<!-- Codeflare Renovate ${'activity-id'} -->`, user: { id: 9, login: 'admin' } })));
          throw Error(`Unexpected publisher GitHub route ${url.pathname}`);
        },
      }) } });
      const activity = new OperatorActivity(native, mockEnv);
      let loseAcceptedStart = true;
      const activityTransport = new Proxy(activity, { get(target, key) {
        if (key === 'start') return async (capability: string) => {
          const result = await target.start(capability);
          if (result.ok && loseAcceptedStart) {
            loseAcceptedStart = false;
            throw Error('Accepted start response lost');
          }
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      mockEnv.OPERATOR_ACTIVITY = { idFromName: () => native.id, getByName: (id: string) => {
        if (reservedActivityId && id !== reservedActivityId) throw Error('New Activity identity after reservation');
        return activityTransport;
      } };
      const pending: Promise<unknown>[] = [];
      (mockCtx as any).waitUntil = (work: Promise<unknown>) => { pending.push(work); };
      scanRuntime.enabled = true;
      const terminal = { pullRequest: 1302, headSha: 'c'.repeat(40), decision: 'DO_NOT_MERGE',
        comment: 'Missing authoritative upgrade evidence.', outcome: 'NOT_MERGED' };
      scanRuntime.result = { repository: resultCase === 'wrong-repository' ? 'foreign/repo' : 'acme/updates', results:
        resultCase === 'empty' ? [] : resultCase === 'duplicate-target' ? [terminal, terminal]
          : resultCase === 'extra-target' ? [terminal, { ...terminal, pullRequest: 1303 }]
          : [{ ...terminal, ...(resultCase === 'wrong-head' ? { headSha: 'd'.repeat(40) } : {}),
            ...(resultCase === 'foreign-pr' ? { pullRequest: 1303 } : {}) }] };
      (mockCtx as any).exports = { OperatorRuntimeCapability: () => ({ fetch: async () => Response.json({}) }),
        GitHubInterceptor: () => ({ fetch: async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === '/repos/acme/updates') return Response.json({ id: 424242,
          full_name: 'acme/updates', default_branch: 'trunk' });
        if (url.pathname === '/repos/acme/updates/pulls') return Response.json(url.searchParams.get('page') === '1'
          ? [{ number: 1302, state: 'open', created_at: '2026-09-28T00:00:00.001Z',
            user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
            head: { sha: 'c'.repeat(40) }, draft: false, base: { ref: 'trunk', sha: 'b'.repeat(40), repo: { id: 424242, full_name: 'acme/updates' } } }] : []);
        throw Error('Unexpected GitHub route');
      } }) };
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_request, init) => {
        const cookie = new Headers(init?.headers).get('Cookie');
        return cookie === 'CF_Authorization=sealed-admin'
          ? Response.json({ id: human.subject, email: human.email, groups: [] })
          : new Response(null, { status: 401 });
      };
      try {
      const session = new ContainerClass(mockCtx as any, mockEnv);
      let deliver: (() => Promise<void>) | undefined;
      vi.spyOn(session, 'schedule').mockImplementation(async (delay, method, payload) => {
        const due = Date.now() + Number(delay) * 1000;
        deliver = async () => {
          if (Date.now() < due) throw Error('Scheduled scan not due');
          await (session as unknown as Record<string, (payload: unknown) => Promise<void>>)[method](payload);
        };
        return { taskId: 'prospective-scan', callback: method, payload,
          type: 'delayed', time: Math.floor(due / 1000), delayInSeconds: Number(delay) };
      });
      const armed = await (session as unknown as { armRenovateScan: (input: unknown) => Promise<unknown> })
        .armRenovateScan({ registrationId: 'registered-admin', installationId: 'dispatcher-install',
          bucket, sessionId: 'session0001', sessionGeneration: 3 });
      expect(armed).toMatchObject({ ok: true });
      expect(deliver).toBeDefined();
      const activatedClock = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(activatedClock + 3_600_001);
      try { await deliver?.(); await Promise.all(pending.splice(0)); }
      finally { clock.mockRestore(); }
      const detail = await activity.getBrowserDetail();
      expect(detail).toMatchObject({ operatorId: 'dispatcher', activityId: reservedActivityId });
      expect(['queued', 'running', 'completed']).toContain(detail?.executionStatus);
      const pinned = await activity.getRuntimePlan();
      expect(pinned).toMatchObject({ invocationJson: JSON.stringify({
        repository: 'acme/updates' }),
        executionContext: { owner: { subject: human.subject, email: human.email } } });
      // Seed only simulated SDK settlement, then exercise actual Activity collection.
      // This is a focused scanner/collector test, not native compiled journey or effect evidence.
      const saved = await native.storage.get<{ drive: { generation: number }; receipt: { intentDigest: string } }>('admission');
      await native.storage.put('admission', { ...saved, drive: { generation: saved!.drive.generation,
        status: 'waiting', checkpoint: { submissionId: 'submission-1',
          inputDigest: saved!.receipt.intentDigest, artifactDigest: bundleDigest }, result: null } });
      await native.storage.put('dispatcher:lease', { generation: saved!.drive.generation,
        artifactDigest: bundleDigest, inputDigest: saved!.receipt.intentDigest,
        expiresAt: Date.now() + 15_000_000, submissionId: 'submission-1', settledSubmissionId: 'submission-1',
        status: 'settled' });
      await native.storage.put(`dispatcher:result:${saved!.drive.generation}`, scanRuntime.result);
      Object.defineProperties(native, {
        facets: { configurable: true, value: { get: () => ({
          _cf_initAsFacet: async () => {},
          fetch: async () => { throw new Error('Durable collection must not refetch SDK history'); },
        }) } },
        exports: { configurable: true, value: { ...(native as unknown as { exports: object }).exports,
          OperatorDispatcherCapability: () => ({ fetch: async () => new Response() }),
          OperatorDispatcherTail: () => ({ tail: async () => {} }) } },
      });
      mockEnv.LOADER = { get: () => ({ getDurableObjectClass: () => ({}) }) };
      expect((await activity.getBrowserDetail())?.executionStatus).toBe('waiting');
      // The same-head reservation is never replaced on the next valid hourly callback.
      const nextClock = vi.spyOn(Date, 'now').mockReturnValue(activatedClock + 7_200_001);
      try { await deliver?.(); await Promise.all(pending.splice(0)); }
      finally { nextClock.mockRestore(); }
      expect((await activity.getBrowserDetail())?.activityId).toBe(detail?.activityId);
      if (resultCase === 'valid') {
        expect((await activity.getBrowserDetail())?.executionStatus).toBe('completed');
        expect((await activity.getBrowserDetail())?.result).toEqual(scanRuntime.result);
      } else {
        expect((await activity.getBrowserDetail())?.executionStatus).not.toBe('completed');
        expect((await activity.getBrowserDetail())?.result).toBeNull();
      }
      expect(writes).toEqual([]);
      const publishClock = vi.spyOn(Date, 'now').mockReturnValue(activatedClock + 10_800_001);
      try { await deliver?.(); await Promise.all(pending.splice(0)); }
      finally { publishClock.mockRestore(); }
      expect(writes).toEqual([]);
      if (resultCase === 'valid') expect((await activity.getBrowserDetail())?.executionStatus).toBe('completed');
      else expect((await activity.getBrowserDetail())?.executionStatus).not.toBe('completed');
      } finally { globalThis.fetch = originalFetch; scanRuntime.enabled = false; scanRuntime.result = null; }
    });
  });

  it('REQ-OPERATOR-053: Review child stop requires the owned container destruction to finish', async () => {
    const instance = new ContainerClass(mockCtx as any, mockEnv);
    Object.assign(instance, { _operatorContainerProfile: { activityId: 'review-activity', sessionId: 'review-session' } });
    let finishDestroy!: () => void;
    let enteredDestroy = false, settled = false;
    const destruction = new Promise<void>(resolve => { finishDestroy = resolve; });
    vi.spyOn(instance, 'superDestroy').mockImplementation(() => {
      enteredDestroy = true;
      return destruction;
    });
    const stopping = instance.stopOperatorSession('review-activity', 'review-session')
      .then(status => { settled = true; return status; });
    expect(enteredDestroy).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    finishDestroy();
    expect(await stopping).toBe('stopped');
    await expect(instance.stopOperatorSession('foreign-activity', 'review-session')).rejects.toThrow();
    vi.spyOn(instance, 'superDestroy').mockRejectedValue(new Error('destruction unavailable'));
    expect(await instance.stopOperatorSession('review-activity', 'review-session')).toBe('unknown');
  });

  describe('REQ-OPERATOR-053: session-owned PR boundary join', () => {
    it('joins push and Pi input in either order, and refuses a delayed previous lifecycle', async () => {
      const records = new Map<string, unknown>([
        ['lifecycleGeneration', 1], ['bucketName', 'review-owner'],
        ['_sessionId', 'review1234'], ['userEmail', 'owner@example.test'],
      ]);
      mockStorage.get.mockImplementation(async (key: string) => records.get(key));
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { records.set(key, value); });
      mockStorage.delete.mockImplementation(async (key: string) => { records.delete(key); });
      mockStorage.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => work({
        get: (key: string) => Promise.resolve(records.get(key)),
        put: async (key: string, value: unknown) => { records.set(key, value); },
        delete: async (key: string) => { records.delete(key); },
      }));
      mockEnv.ENCRYPTION_KEY = btoa('k'.repeat(32));
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await mockCtx.blockConcurrencyWhile.mock.results.at(-1)?.value;
      const human = { subject: 'owner', email: 'owner@example.test',
        issuer: 'https://team.cloudflareaccess.com', audiences: ['aud'],
        issuedAt: Math.floor(Date.now() / 1000) - 1, expiresAt: Math.floor(Date.now() / 1000) + 300 };
      await instance.bindReviewHuman({ bucket: 'review-owner', sessionId: 'review1234', generation: 1,
        human, accessJwt: 'private.jwt' });
      const input = { repositoryId: 138, pullRequest: 34, acknowledgedHead: null,
        targetHead: 'a'.repeat(40), payload: { rejectedFindings: [] } };
      const push = { sessionId: 'review1234', generation: 1, owner: 'owner', repository: 'repo',
        ref: 'refs/heads/feature', head: input.targetHead };
      const staged = { sessionId: 'review1234', generation: 1, input,
        owner: 'owner', repository: 'repo', ref: 'refs/heads/feature' };
      const observed = { owner: push.owner, repository: push.repository, ref: push.ref, head: push.head };
      expect(await instance.stageBoundaryInput(staged)).toBeNull();
      expect(await instance.stagePushEvidence(push)).toMatchObject({ generation: 1, input, push: observed });
      records.delete('review:boundary-input');
      records.delete('review:push-evidence');
      expect(await instance.stagePushEvidence(push)).toBeNull();
      expect(await instance.stageBoundaryInput(staged)).toMatchObject({ generation: 1, input, push: observed });
      records.delete('review:push-evidence');
      const creation = { sessionId: 'review1234', generation: 1, pullRequest: 34,
        repositoryId: 138, repositoryNodeId: 'R_node_138', pullRequestNodeId: 'PR_node_34',
        owner: 'owner', repository: 'repo', headRefName: 'feature', baseRefName: 'main' };
      expect(await instance.stagePrCreationEvidence({ ...creation, head: 'f'.repeat(40) })).toBeNull();
      expect(await instance.stagePrCreationEvidence({ ...creation, head: input.targetHead }))
        .toMatchObject({ input, creation: { repositoryNodeId: 'R_node_138', pullRequestNodeId: 'PR_node_34' } });
      expect(await instance.stageBoundaryInput({ ...staged, repository: 'other-repo' })).toBeNull();
      expect(await instance.stageBoundaryInput(staged)).toMatchObject({ generation: 1, input, push: observed });
      records.set('shutdownRequested', Date.now());
      await expect(instance.stagePushEvidence(push)).rejects.toThrow();
      records.delete('shutdownRequested');
      records.set('lifecycleGeneration', 2);
      await expect(instance.stagePushEvidence(push)).rejects.toThrow();
      await expect(instance.getReadyBoundary({ bucket: 'review-owner', sessionId: 'review1234',
        email: human.email, generation: 1 })).rejects.toThrow();
    });
  });

  describe('constructor', () => {
    it('initializes with defaultPort 8080', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.defaultPort).toBe(8080);
    });

    it('initializes with sleepAfter pinned to 24h (SDK timer disabled)', () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.sleepAfter).toBe('24h');
    });

    it('initializes with idleTimeoutPref 12h (fail-safe default per REQ-OPS-006 AC8)', () => {
      // The class-field default is the MAXIMUM supported value (12h), not the
      // minimum. A short fallback would kill the container before storage
      // reads / user-pref writes complete; a long fallback only lets the
      // container live longer than expected. See REQ-OPS-006 AC8 + AD/issue
      // codeflare#294 context.
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      expect(instance.idleTimeoutPref).toBe('12h');
    });

    it('REQ-SESSION-008: sync policy survives initial configuration, both restart directions, and DO wake', async () => {
      const persisted = new Map<string, unknown>();
      mockStorage.get.mockImplementation(async (key: string) => persisted.get(key));
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { persisted.set(key, value); });
      let instance = new ContainerClass(mockCtx as any, mockEnv);
      await mockCtx.blockConcurrencyWhile.mock.results.at(-1)!.value;
      const initial = await instance.fetch(new Request('http://container/_internal/setBucketName', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bucketName: 'test-bucket', workspaceSyncEnabled: false }),
      }));
      expect(initial.status).toBe(200);
      expect(instance.envVars?.SYNC_POLICY_MODE).toBe('exclude');
      for (const syncPolicyMode of ['include', 'exclude', 'include']) {
        const response = await instance.fetch(new Request('http://container/_internal/setBucketName', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bucketName: 'test-bucket', syncPolicyMode, workspaceSyncEnabled: false }),
        }));
        expect(response.status).toBe(409);
        expect(persisted.get('syncPolicyMode')).toBe(syncPolicyMode);
        expect(instance.envVars?.SYNC_POLICY_MODE).toBe(syncPolicyMode);
        expect(instance.envVars?.SYNC_MODE).toBe('none');
        instance = new ContainerClass(mockCtx as any, mockEnv);
        await mockCtx.blockConcurrencyWhile.mock.results.at(-1)!.value;
        expect(instance.envVars?.SYNC_POLICY_MODE).toBe(syncPolicyMode);
        expect(instance.envVars?.SYNC_MODE).toBe('none');
      }
      for (const syncPolicyMode of ['Include', null, true, '']) {
        const response = await instance.fetch(new Request('http://container/_internal/setBucketName', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bucketName: 'test-bucket', syncPolicyMode }),
        }));
        expect(response.status).toBe(400);
        expect(persisted.get('syncPolicyMode')).toBe('include');
        expect(instance.envVars?.SYNC_POLICY_MODE).toBe('include');
      }
      persisted.set('syncPolicyMode', 'Include');
      new ContainerClass(mockCtx as any, mockEnv);
      await expect(mockCtx.blockConcurrencyWhile.mock.results.at(-1)!.value).rejects.toThrow(/sync policy/i);
    });

    it('calls blockConcurrencyWhile in constructor', () => {
      new ContainerClass(mockCtx as any, mockEnv);
      expect(mockCtx.blockConcurrencyWhile).toHaveBeenCalledTimes(1);
    });

    it.each(['pi-native', 'managed', undefined, 'invalid', true])(
      'REQ-ENTERPRISE-089: DO wake restores only a valid native startup source (%s)', async source => {
        const persisted = new Map<string, unknown>([
          ['bucketName', 'test-bucket'], ['piDefaultSource', source], ['allowPersonalPiProviders', true],
          ['routeCatalog', ['development']], ['defaultRoute', 'development'], ['defaultReasoning', 'medium'],
        ]);
        mockStorage.get.mockImplementation(async (key: string) => persisted.get(key));
        mockEnv.ENTERPRISE_MODE = 'active';
        const instance = new ContainerClass(mockCtx as any, mockEnv);
        await mockCtx.blockConcurrencyWhile.mock.results.at(-1)!.value;
        expect(instance.envVars?.ENTERPRISE_PI_DEFAULT_SOURCE).toBe(source === 'pi-native' ? 'pi-native' : undefined);
        expect(instance.envVars?.ENTERPRISE_PI_PERSONAL_PROVIDERS).toBe('true');
        expect(instance.envVars?.ENTERPRISE_DEFAULT_ROUTE).toBe('development');
        expect(instance.envVars?.ENTERPRISE_DEFAULT_REASONING).toBe('medium');
      });

    it('restores containerAuthToken from storage so DO wake does not desync from a running container', async () => {
      // Regression for the silent-401 bug: prior to persistence, every DO
      // wake regenerated a fresh UUID via updateEnvVars() while the
      // container process kept its old CONTAINER_AUTH_TOKEN env var, so the
      // Bearer header attached by the fetch override no longer matched and
      // every proxied request received `{"error":"Unauthorized"}` from
      // host/src/server.ts until the user manually recreated the session.
      const PRIOR_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return PRIOR_TOKEN;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      // Constructor's blockConcurrencyWhile body has multiple sequential
      // awaits before updateEnvVars() fires; vi.waitFor polls until the
      // microtask chain finishes (same pattern as the
      // "constructor loads bucketName and calls updateEnvVars" test).
      await vi.waitFor(() => {
        expect(instance.envVars).toBeDefined();
        expect(instance.envVars?.CONTAINER_AUTH_TOKEN).toBe(PRIOR_TOKEN);
      });
      // Storage.put must NOT be called with a new UUID for this key —
      // we restored, not regenerated.
      const putKeys = mockStorage.put.mock.calls.map((c) => c[0]);
      expect(putKeys).not.toContain('containerAuthToken');
    });

    it('persists a freshly-generated containerAuthToken so subsequent wakes restore it', async () => {
      // No prior token in storage → generator path. Must write back so the
      // next wake's restore branch sees a value and skips re-generation.
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await vi.waitFor(() => {
        expect(instance.envVars).toBeDefined();
        expect(instance.envVars?.CONTAINER_AUTH_TOKEN).toMatch(/^[0-9a-f-]{36}$/);
      });
      const tok = instance.envVars?.CONTAINER_AUTH_TOKEN;

      // And the generated token landed in storage under the same key the
      // restore branch reads, so a subsequent wake will hit the restore
      // path instead of regenerating.
      await vi.waitFor(() => {
        const putCalls = mockStorage.put.mock.calls;
        const tokenPut = putCalls.find((c) => c[0] === 'containerAuthToken');
        expect(tokenPut).toBeDefined();
        expect(tokenPut?.[1]).toBe(tok);
      });
    });

  });

  // REQ-VAULT-008 AC1: Container DO mints a per-session vault encryption
  // key, persists it in ctx.storage, and returns the same value on
  // every read until container.destroy() wipes storage. The key is
  // injected by the Worker into SilverBullet's /.config response so
  // SB encrypts IndexedDB without prompting the user.
  describe('claimBucketOwner / REQ-STOR-001 tenant isolation', () => {
    it('atomically preserves the first allowed owner and rejects a colliding identity', async () => {
      let owner: string | undefined;
      mockStorage.get.mockImplementation(async (key: string) => key === 'bucketOwnerEmail' ? owner : null);
      mockStorage.put.mockImplementation(async (key: string, value: string) => {
        if (key === 'bucketOwnerEmail') owner = value;
      });
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await expect(instance.claimBucketOwner('ab@example.com', true)).resolves.toBe('owned');
      await expect(instance.claimBucketOwner('a+b@example.com', true)).resolves.toBe('conflict');
      expect(owner).toBe('ab@example.com');
      expect(mockStorage.transaction).toHaveBeenCalledTimes(2);
    });

    it('serializes simultaneous ownership claims so exactly one colliding identity wins', async () => {
      let owner: string | undefined;
      let transactionTail = Promise.resolve();
      mockStorage.get.mockImplementation(async (key: string) => key === 'bucketOwnerEmail' ? owner : null);
      mockStorage.put.mockImplementation(async (key: string, value: string) => {
        if (key === 'bucketOwnerEmail') owner = value;
      });
      mockStorage.transaction.mockImplementation((fn: (txn: { get: typeof mockStorage.get; put: typeof mockStorage.put }) => Promise<unknown>) => {
        const result = transactionTail.then(() => fn({ get: mockStorage.get, put: mockStorage.put }));
        transactionTail = result.then(() => undefined, () => undefined);
        return result;
      });
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const results = await Promise.all([
        instance.claimBucketOwner('ab@example.com', true),
        instance.claimBucketOwner('a+b@example.com', true),
      ]);

      expect(results.sort()).toEqual(['conflict', 'owned']);
      expect(owner).toBe('ab@example.com');
    });

    it('refuses an ambiguous first claim without persisting an owner', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await expect(instance.claimBucketOwner('ab@example.com', false)).resolves.toBe('ambiguous');
      expect(mockStorage.put).not.toHaveBeenCalledWith('bucketOwnerEmail', expect.anything());
    });
  });

  describe('ensureVaultKey (REQ-VAULT-008 AC1)', () => {
    it('generates a 32-byte vault key on first call and persists it', async () => {
      // Fresh DO -- no key in storage. ensureVaultKey() must generate
      // 32 random bytes, base64-encode them, persist under the
      // `vaultKey` storage key, and return the encoded string.
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'vaultKey') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // Constructor blockConcurrencyWhile may have run by now; wait
      // for envVars to be settled so we know init finished.
      // Wait for the constructor's blockConcurrencyWhile body to reach
      // the vaultKey restore -- once the storage.get('vaultKey') call
      // lands in the mock, init is past the relevant restore branch.
      await vi.waitFor(() =>
        expect(mockStorage.get.mock.calls.some((c) => c[0] === 'vaultKey')).toBe(true),
      );

      const key = await (instance as any).ensureVaultKey();
      expect(typeof key).toBe('string');
      // base64 of 32 bytes = 44 chars (including trailing '=' padding).
      expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);

      // Persistence: the storage layer must have been called with
      // ('vaultKey', <key>). Find the last put call for this key.
      const putCall = mockStorage.put.mock.calls.find((c) => c[0] === 'vaultKey');
      expect(putCall).toBeDefined();
      expect(putCall?.[1]).toBe(key);
    });

    it('returns the same key on every subsequent call without re-generating', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'vaultKey') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // Wait for the constructor's blockConcurrencyWhile body to reach
      // the vaultKey restore -- once the storage.get('vaultKey') call
      // lands in the mock, init is past the relevant restore branch.
      await vi.waitFor(() =>
        expect(mockStorage.get.mock.calls.some((c) => c[0] === 'vaultKey')).toBe(true),
      );

      const first = await (instance as any).ensureVaultKey();
      const second = await (instance as any).ensureVaultKey();
      const third = await (instance as any).ensureVaultKey();

      expect(first).toBe(second);
      expect(second).toBe(third);

      // Only ONE write to storage; subsequent calls must hit the
      // in-memory cache.
      const puts = mockStorage.put.mock.calls.filter((c) => c[0] === 'vaultKey');
      expect(puts.length).toBe(1);
    });

    it('restores an existing key from storage instead of generating a new one (DO wake)', async () => {
      // Simulates a DO that previously generated a key, hibernated,
      // and is now waking up. Storage returns the previously persisted
      // value; ensureVaultKey() must return it untouched and MUST NOT
      // write a new value to storage.
      const PRIOR_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'vaultKey') return PRIOR_KEY;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // Wait for the constructor's blockConcurrencyWhile body to reach
      // the vaultKey restore -- once the storage.get('vaultKey') call
      // lands in the mock, init is past the relevant restore branch.
      await vi.waitFor(() =>
        expect(mockStorage.get.mock.calls.some((c) => c[0] === 'vaultKey')).toBe(true),
      );

      const key = await (instance as any).ensureVaultKey();
      expect(key).toBe(PRIOR_KEY);

      // No new put for vaultKey on this run -- the restore branch must
      // not regenerate.
      const newPuts = mockStorage.put.mock.calls.filter((c) => c[0] === 'vaultKey');
      expect(newPuts.length).toBe(0);
    });
  });

  describe('internal route dispatch', () => {
    it('dispatches POST /_internal/setBucketName to handler', async () => {
      // No existing bucket - storage returns null for all keys
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const body = await response.json() as { success: boolean; bucketName: string };
      expect(body.success).toBe(true);
      expect(body.bucketName).toBe('new-bucket');
    });

    it('returns 409 when bucket name already set but stores sessionId', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'existing-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', sessionId: 'sess1234' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(409);
      // sessionId should still be stored even on 409
      expect(mockStorage.put).toHaveBeenCalledWith('_sessionId', 'sess1234');
    });

    it('dispatches GET /_internal/getBucketName to handler', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/getBucketName', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      const body = await response.json() as { bucketName: string | null };
      expect(body).toHaveProperty('bucketName');
    });

    it('setBucketName returns 400 for missing bucketName', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(400);
    });

    it('REQ-SEC-009 AC3: setBucketName rejects a non-canonical sessionId before storage or state mutation', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', sessionId: 'Bad-session' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'sessionId must be 8-24 lowercase alphanumeric characters when provided',
      });
      expect(mockStorage.put).not.toHaveBeenCalled();
      expect(instance._sessionId).toBeNull();
      expect(instance._bucketName).toBeNull();
    });

    it('setBucketName stores sessionId in DO storage', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;  // No bucket yet
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', sessionId: 'mysession123' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      expect(mockStorage.put).toHaveBeenCalledWith('_sessionId', 'mysession123');
    });

    it('setBucketName stores sessionMode and passes it as SESSION_MODE env var', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', sessionMode: 'advanced' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      // SESSION_MODE should be in envVars
      expect(instance.envVars?.SESSION_MODE).toBe('advanced');
    });

    it('setBucketName defaults SESSION_MODE to "default" when sessionMode not provided', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      // Should default to 'default'
      expect(instance.envVars?.SESSION_MODE).toBe('default');
    });

    it('setBucketName returns 400 for non-string sessionMode', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', sessionMode: 123 }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(400);
    });

    // REQ-MEM-001 AC4 / REQ-SESSION-016: the previous regression coverage
    // exercised applyBucketName and applyPrefsOnRestart in isolation with
    // userTimezone already in the input arg, which would stay green even if
    // the handleSetBucketName destructure were reverted to the PR #390 bug
    // shape (silently dropping userTimezone from the Worker JSON body).
    // These two tests post to /_internal/setBucketName end-to-end and assert
    // the env var actually surfaces, so removing the destructure makes them
    // red.
    it('setBucketName reads userTimezone from JSON body and emits USER_TIMEZONE env var', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', userTimezone: 'Europe/Zurich' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      expect(mockStorage.put).toHaveBeenCalledWith('userTimezone', 'Europe/Zurich');
      expect(instance.envVars?.USER_TIMEZONE).toBe('Europe/Zurich');
    });

    it('setBucketName updates USER_TIMEZONE on restart (bucket already set, prefs change path)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'existing-bucket';
        if (key === 'userTimezone') return 'Europe/Zurich';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'existing-bucket', userTimezone: 'America/New_York' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(409);

      expect(mockStorage.put).toHaveBeenCalledWith('userTimezone', 'America/New_York');
      expect(instance.envVars?.USER_TIMEZONE).toBe('America/New_York');
    });

    // REQ-MEM-001 AC4: malformed IANA shapes (path traversal, junk) must
    // not reach storage or the env var. entrypoint.sh uses USER_TIMEZONE
    // to build the /etc/localtime symlink target, so a value like
    // '../../etc/shadow' would otherwise be an unbounded-path injection vector.
    it('setBucketName rejects malformed userTimezone shape (first-time path)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return null;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'new-bucket', userTimezone: '../../etc/shadow' }),
        headers: { 'Content-Type': 'application/json' },
      });

      // 200 is intentional: malformed values are silently dropped per the
      // sticky-once-set semantics in applyBucketName, not surfaced as a 400.
      const response = await instance.fetch(request);
      expect(response.status).toBe(200);

      const putCalls = mockStorage.put.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(putCalls).not.toContain('userTimezone');
      expect(instance.envVars?.USER_TIMEZONE).toBeUndefined();
    });

    // Mirror of the first-time-path test for the restart branch in
    // applyPrefsOnRestart. A revert of normalizeIanaTz on the restart
    // branch (container-env.ts applyPrefsOnRestart) would otherwise slip
    // past CI because the only HTTP malformed-shape assertion lives on
    // the first-time path.
    it('setBucketName rejects malformed userTimezone shape (restart path, bucket already set)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'existing-bucket';
        if (key === 'userTimezone') return 'Europe/Zurich';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/setBucketName', {
        method: 'POST',
        body: JSON.stringify({ bucketName: 'existing-bucket', userTimezone: '../../etc/shadow' }),
        headers: { 'Content-Type': 'application/json' },
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(409);

      const putCalls = mockStorage.put.mock.calls
        .filter((c: unknown[]) => c[0] === 'userTimezone')
        .map((c: unknown[]) => c[1] as string);
      expect(putCalls).not.toContain('../../etc/shadow');
      expect(instance.envVars?.USER_TIMEZONE).toBe('Europe/Zurich');
    });

    it('proxies unknown routes via super.fetch when container is running', async () => {
      mockContainerRuntime.running = true;
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'authorized-proxy-fixture';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => expect(instance.envVars?.CONTAINER_AUTH_TOKEN).toBe('authorized-proxy-fixture'));
      const request = new Request('http://container/unknown-route', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('base fetch');
    });
  });

  describe('REQ-SESSION-012 AC1/AC4: forwardExisting never starts a replacement workload', () => {
    it('forwards to the surviving runtime with its existing auth token despite stale persisted SDK state', async () => {
      const token = 'existing-container-token';
      const persisted = new Map<string, unknown>([['containerAuthToken', token], ['lifecycleGeneration', 7]]);
      mockStorage.get.mockImplementation(async (key: string) => persisted.get(key) ?? null);
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { persisted.set(key, value); });
      mockTcpPortFetch.mockImplementation(async (forwarded: Request) => {
        const url = new URL(forwarded.url);
        if (url.protocol !== 'http:') throw new Error('Container port does not support HTTPS');
        return url.hostname === 'container' && url.pathname === '/api/terminal/testsession123-1/ws'
          && url.search === '?tab=1' && forwarded.headers.get('Upgrade') === 'websocket'
          && forwarded.headers.get('Authorization') === `Bearer ${token}`
          ? new Response('surviving terminal', { status: 200 })
          : new Response('Unauthorized forwarding', { status: 401 });
      });
      let started = false;
      mockContainerRuntime.start.mockImplementation(() => { started = true; throw new Error('unexpected container start'); });
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => expect(instance._containerAuthToken).toBe(token));
      const request = new Request('https://enterprise.codeflare.ch/api/terminal/testsession123-1/ws?tab=1', {
        headers: { Upgrade: 'websocket', Authorization: 'Bearer forged' },
      });
      const response = await (instance as any).forwardExisting(request);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('surviving terminal');
      expect(mockContainerRuntime.running).toBe(true);
      expect(started).toBe(false);
      expect(persisted.get('lifecycleGeneration')).toBe(7);
    });

    it('native terminal upgrade fails closed when the existing runtime is absent', async () => {
      mockContainerRuntime.running = false;
      mockStorage.get.mockImplementation(async (key: string) => key === 'containerAuthToken' ? 'existing-token' : null);
      mockTcpPortFetch.mockRejectedValue(new Error('no existing process'));
      mockContainerRuntime.start.mockImplementation(() => { mockContainerRuntime.running = true; });
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const response = await instance.fetch(new Request('https://example.com/terminal', {
        headers: { Upgrade: 'websocket' },
      }));
      expect(response.status).toBe(503);
      expect(mockContainerRuntime.running).toBe(false);
    });

    it('reaches a surviving process when the coordinator running flag is transiently false', async () => {
      mockContainerRuntime.running = false;
      mockStorage.get.mockImplementation(async (key: string) => key === 'containerAuthToken' ? 'existing-token' : null);
      mockTcpPortFetch.mockResolvedValue(new Response('healthy survivor', { status: 200 }));
      let started = false;
      mockContainerRuntime.start.mockImplementation(() => { started = true; throw new Error('unexpected container start'); });
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const response = await instance.forwardExisting(new Request('http://container/health'));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('healthy survivor');
      expect(started).toBe(false);
    });

    it('returns unavailable when no runtime exists and does not allocate a replacement generation', async () => {
      mockContainerRuntime.running = false;
      const persisted = new Map<string, unknown>([['containerAuthToken', 'existing-token'], ['lifecycleGeneration', 7]]);
      mockStorage.get.mockImplementation(async (key: string) => persisted.get(key) ?? null);
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { persisted.set(key, value); });
      mockTcpPortFetch.mockRejectedValue(new Error('no existing process'));
      let started = false;
      mockContainerRuntime.start.mockImplementation(() => { started = true; throw new Error('unexpected container start'); });
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const response = await (instance as any).forwardExisting(new Request('http://container/health'));
      expect(response.status).toBe(503);
      expect(started).toBe(false);
      expect(persisted.get('lifecycleGeneration')).toBe(7);
    });
  });

  describe('REQ-SESSION-018 AC7: only a resolved process monitor confirms its captured generation', () => {
    const owner = 'test-bucket';
    const sessionId = 'abcdef1234567890';

    async function attachedMonitor(generation: number, sdkRunning = true) {
      const kv = createMockKV();
      const key = `session:${owner}:${sessionId}`;
      kv._set(key, {
        id: sessionId, userId: owner, status: 'running', lifecycleGeneration: generation,
        createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
      });
      const persisted = new Map<string, unknown>([
        ['bucketName', owner], ['_sessionId', sessionId], ['lifecycleGeneration', generation],
        ['containerAuthToken', 'existing-token'],
      ]);
      mockStorage.get.mockImplementation(async (key: string) => persisted.get(key) ?? null);
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { persisted.set(key, value); });
      mockStorage.delete.mockImplementation(async (key: string) => { persisted.delete(key); });
      mockStorage.transaction.mockImplementation(async (work: (txn: unknown) => Promise<unknown>) => work({
        get: (key: string) => Promise.resolve(persisted.get(key)),
        put: async (key: string, value: unknown) => { persisted.set(key, value); },
        delete: async (key: string) => { persisted.delete(key); },
      }));
      mockEnv.USAGE_DB = createMockSessionD1(kv);
      mockContainerRuntime.running = sdkRunning;
      if (!sdkRunning) mockTcpPortFetch.mockResolvedValue(new Response('healthy'));
      let resolveExit!: () => void;
      let rejectExit!: (error: unknown) => void;
      mockContainerRuntime.monitor.mockImplementation(() => new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; }));
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => expect(instance._sessionId).toBe(sessionId));
      await vi.waitFor(() => expect(resolveExit).toBeDefined());
      const completeExit = async () => {
        resolveExit();
        await vi.waitFor(async () => expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopped'));
      };
      return { kv, key, completeExit, resolveExit, rejectExit, persisted, instance };
    }

    async function reconstruct() {
      let completion!: Promise<void>;
      mockCtx.blockConcurrencyWhile.mockImplementation((work: () => Promise<void>) => {
        completion = work();
        return completion;
      });
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await completion;
      return instance;
    }

    function observeOwnedExitWork() {
      const rejected: unknown[] = [];
      const emitted: Array<{ level: string; message: string; data: Record<string, unknown> }> = [];
      // Handle the actual promise registered with the DO owner immediately.
      mockCtx.waitUntil.mockImplementation((completion: Promise<unknown>) => {
        void Promise.resolve(completion).then(() => undefined, error => { rejected.push(error); });
      });
      const logger = (context: Record<string, unknown> = {}): Logger => ({
        debug: (message, data) => { emitted.push({ level: 'debug', message, data: { ...context, ...data } }); },
        info: (message, data) => { emitted.push({ level: 'info', message, data: { ...context, ...data } }); },
        warn: (message, data) => { emitted.push({ level: 'warn', message, data: { ...context, ...data } }); },
        error: (message, _error, data) => { emitted.push({ level: 'error', message, data: { ...context, ...data } }); },
        child: data => logger({ ...context, ...data }),
      });
      vi.mocked(createLogger).mockImplementationOnce(() => logger());
      return {
        emitted,
        async expectFailure(error: Error) {
          await vi.waitFor(() => expect(rejected).toContain(error));
        },
      };
    }

    function deferExitConfirmation(mode: 'rejected' | 'refused') {
      const original = mockEnv.USAGE_DB as D1Database;
      let blocked = true;
      mockEnv.USAGE_DB = {
        prepare(sql: string) {
          const statement = original.prepare(sql);
          // Boundary fault injection only; outcomes never assert SQL text.
          if (!sql.includes("SET lifecycle_state='stopped'")) return statement;
          return { bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return { run: async () => {
              if (!blocked) return bound.run();
              if (mode === 'rejected') throw Error('exit persistence unavailable');
              return { success: true, meta: { changes: 0 } };
            } };
          } };
        },
      };
      return () => { blocked = false; };
    }

    function seedExitIncident(kv: ReturnType<typeof createMockKV>, key: string, generation: number, incidentId: string | null) {
      kv._set(key, {
        id: sessionId, userId: owner, status: incidentId ? 'unreachable' : 'running', lifecycleGeneration: generation,
        ...(incidentId ? { unreachableIncidentId: incidentId,
          unreachableFirstObservedAt: '2026-01-01T00:00:00.000Z', unreachableDeadlineMs: 2_000_000_000_000 } : {}),
        createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
      });
    }

    const exitRetryCases = (['rejected', 'refused'] as const).flatMap(mode =>
      [null, 'original-exit-incident'].map(incidentId => ({ mode, incidentId })));

    describe.each(['resolved', 'rollout'] as const)('attached %s exit scheduling ownership', completion => {
      it.each(exitRetryCases)(
        'REQ-SESSION-026 AC1-3: $mode confirmation with incident $incidentId rejects owned completion and remains retryable',
        async ({ mode, incidentId }) => {
          const observed = observeOwnedExitWork();
          const { instance, kv, key, persisted, resolveExit, rejectExit } = await attachedMonitor(21);
          seedExitIncident(kv, key, 21, incidentId);
          persisted.set('usageSeconds', 23);
          const allowConfirmation = deferExitConfirmation(mode);
          const unavailable = Error('required exit alarm unavailable');
          const schedule = vi.spyOn(instance, 'schedule').mockRejectedValue(unavailable);
          try {
            if (completion === 'rollout') rejectExit(Error('Runtime signalled the container to exit due to a new version rollout: 143'));
            else resolveExit();
            await observed.expectFailure(unavailable);
            expect(observed.emitted.map(entry => entry.data)).toContainEqual(expect.objectContaining({
              sessionId, lifecycleGeneration: 21, incidentId, errorClass: 'schedule_failed',
            }));
            expect(persisted.get('monitoredExitGeneration')).toEqual({ owner, session: sessionId, generation: 21 });
            expect(persisted.get('lifecycleGeneration')).toBe(21);
            expect(persisted.get('usageSeconds')).toBe(23);
            expect(await kv.get(key, 'json')).toMatchObject({
              status: 'stopping', lifecycleGeneration: 21, terminationGeneration: 21,
              terminationIntentId: 'monitored-exit-21', ...(incidentId ? { unreachableIncidentId: incidentId } : {}),
            });
            allowConfirmation();
            schedule.mockRestore();
            await reconstruct();
            expect(await kv.get(key, 'json')).toMatchObject({ status: 'stopped', lifecycleGeneration: 21 });
            expect(persisted.has('monitoredExitGeneration')).toBe(false);
            expect(persisted.get('usageSeconds')).toBe(23);
          } finally { schedule.mockRestore(); }
        },
      );
    });

    it.each(exitRetryCases)(
      'REQ-SESSION-026 AC1-3: reconstruction $mode confirmation with incident $incidentId owns retry failure without poisoning startup',
      async ({ mode, incidentId }) => {
        const { kv, key, persisted } = await attachedMonitor(22);
        seedExitIncident(kv, key, 22, incidentId);
        const evidence = { owner, session: sessionId, generation: 22 };
        persisted.set('monitoredExitGeneration', evidence);
        persisted.set('usageSeconds', 23);
        const allowConfirmation = deferExitConfirmation(mode);
        const observed = observeOwnedExitWork();
        const unavailable = Error('restored exit alarm unavailable');
        const schedule = vi.spyOn(ContainerClass.prototype, 'schedule').mockRejectedValue(unavailable);
        try {
          // Startup remains usable; required work rejects through its separate DO completion.
          const restored = await reconstruct();
          await observed.expectFailure(unavailable);
          expect(observed.emitted.map(entry => entry.data)).toContainEqual(expect.objectContaining({
            sessionId, lifecycleGeneration: 22, incidentId, errorClass: 'schedule_failed',
          }));
          expect(persisted.get('monitoredExitGeneration')).toEqual(evidence);
          expect(persisted.get('lifecycleGeneration')).toBe(22);
          expect(persisted.get('usageSeconds')).toBe(23);
          expect(await kv.get(key, 'json')).toMatchObject({
            status: 'stopping', lifecycleGeneration: 22, terminationGeneration: 22,
            terminationIntentId: 'monitored-exit-22', ...(incidentId ? { unreachableIncidentId: incidentId } : {}),
          });
          expect(restored._sessionId).toBe(sessionId);
          allowConfirmation();
          schedule.mockRestore();
          await reconstruct();
          expect(await kv.get(key, 'json')).toMatchObject({ status: 'stopped', lifecycleGeneration: 22 });
          expect(persisted.has('monitoredExitGeneration')).toBe(false);
          expect(persisted.get('usageSeconds')).toBe(23);
        } finally { schedule.mockRestore(); }
      },
    );

    it.each(exitRetryCases)(
      'REQ-SESSION-026 AC1-3: metrics caller receives $mode exit-retry alarm failure with observed incident $incidentId',
      async ({ mode, incidentId }) => {
        const observed = observeOwnedExitWork();
        const { instance, kv, key, persisted } = await attachedMonitor(24);
        seedExitIncident(kv, key, 24, incidentId);
        persisted.set('monitoredExitGeneration', { owner, session: sessionId, generation: 24 });
        persisted.set('usageSeconds', 23);
        const allowConfirmation = deferExitConfirmation(mode);
        const unavailable = Error('metrics exit alarm unavailable');
        const schedule = vi.spyOn(instance, 'schedule').mockRejectedValue(unavailable);
        try {
          await expect(instance.collectMetrics({ ownerKey: owner, sessionId, generation: 24 })).rejects.toBe(unavailable);
          expect(observed.emitted.map(entry => entry.data)).toContainEqual(expect.objectContaining({
            sessionId, lifecycleGeneration: 24, incidentId, errorClass: 'schedule_failed',
          }));
          expect(await kv.get(key, 'json')).toMatchObject({ status: 'stopping', lifecycleGeneration: 24, terminationIntentId: 'monitored-exit-24' });
          expect(persisted.get('monitoredExitGeneration')).toEqual({ owner, session: sessionId, generation: 24 });
          expect(persisted.get('usageSeconds')).toBe(23);
          allowConfirmation();
          schedule.mockRestore();
          await reconstruct();
          expect(await kv.get(key, 'json')).toMatchObject({ status: 'stopped', lifecycleGeneration: 24 });
          expect(persisted.has('monitoredExitGeneration')).toBe(false);
          expect(persisted.get('usageSeconds')).toBe(23);
        } finally { schedule.mockRestore(); }
      },
    );

    it('REQ-SESSION-026: a transient metrics retry-alarm failure preserves its existing second chance and exit ownership', async () => {
      const { instance, kv, key, persisted } = await attachedMonitor(25);
      persisted.set('monitoredExitGeneration', { owner, session: sessionId, generation: 25 });
      const allowConfirmation = deferExitConfirmation('refused');
      const queue: unknown[] = [];
      let unavailable = true;
      const schedule = vi.spyOn(instance, 'schedule').mockImplementation(async (_delay, _method, payload) => {
        if (unavailable) { unavailable = false; throw Error('transient scheduler outage'); }
        queue.push(payload);
        return {} as Awaited<ReturnType<typeof instance.schedule>>;
      });
      try {
        await expect(instance.collectMetrics({ ownerKey: owner, sessionId, generation: 25 })).resolves.toBeUndefined();
        expect(queue).toContainEqual({ ownerKey: owner, sessionId, generation: 25 });
        expect(await kv.get(key, 'json')).toMatchObject({ status: 'stopping', lifecycleGeneration: 25 });
        expect(persisted.get('monitoredExitGeneration')).toEqual({ owner, session: sessionId, generation: 25 });
        allowConfirmation();
        schedule.mockRestore();
        await reconstruct();
        expect(await kv.get(key, 'json')).toMatchObject({ status: 'stopped', lifecycleGeneration: 25 });
      } finally { schedule.mockRestore(); }
    });

    it('REQ-SESSION-026: alarm unavailability does not poison a working reconstruction without pending exit work', async () => {
      const { kv, key, persisted } = await attachedMonitor(23);
      let resolveRestoredExit!: () => void;
      mockContainerRuntime.monitor.mockImplementation(() => new Promise<void>(resolve => { resolveRestoredExit = resolve; }));
      const schedule = vi.spyOn(ContainerClass.prototype, 'schedule').mockRejectedValue(Error('alarm unavailable'));
      try {
        const restored = await reconstruct();
        mockTcpPortFetch.mockResolvedValueOnce(new Response('surviving workload'));
        const response = await restored.forwardExisting(new Request('http://container/health'));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('surviving workload');
        expect(await kv.get(key, 'json')).toMatchObject({ status: 'running', lifecycleGeneration: 23 });
        expect(persisted.has('monitoredExitGeneration')).toBe(false);
        resolveRestoredExit();
        await vi.waitFor(async () => expect(await kv.get(key, 'json')).toMatchObject({ status: 'stopped', lifecycleGeneration: 23 }));
      } finally { schedule.mockRestore(); }
    });

    it.each([
      { completion: 'resolved' as const, reason: 'unknown' },
      { completion: 'exit-137' as const, reason: 'unknown' },
      { completion: 'explicit-rollout' as const, reason: 'platform' },
    ])('REQ-SESSION-025 AC1-2: $completion exit preserves observed incident without inventing an initiator', async ({ completion, reason }) => {
      const capture = await captureLifecycleSerialization();
      try {
        const f = await attachedMonitor(17);
        seedExitIncident(f.kv, f.key, 17, 'monitor-incident-17');
        expect(capture.entries().filter(entry => entry.message === 'process_exit_confirmed')).toEqual([]);
        if (completion === 'resolved') f.resolveExit();
        else f.rejectExit(new Error(completion === 'explicit-rollout'
          ? 'Runtime signalled the container to exit due to a new version rollout: 143'
          : 'container exited with unexpected exit code: 137'));
        await vi.waitFor(async () => expect(await f.kv.get(f.key, 'json')).toMatchObject({ status: 'stopped' }));
        expect((await f.kv.get(f.key, 'json') as Record<string, unknown>).unreachableIncidentId).toBeUndefined();
        expect(capture.entries()).toContainEqual(expect.objectContaining({ message: 'process_exit_confirmed', data: expect.objectContaining({
          sessionId, lifecycleGeneration: 17, incidentId: 'monitor-incident-17', terminationIntentId: 'monitored-exit-17', reason,
        }) }));
      } finally { capture.restore(); }
    });

    it('REQ-SESSION-025 AC1: stale monitored-exit authority cannot emit confirmation for a replacement', async () => {
      const capture = await captureLifecycleSerialization();
      try {
        const f = await attachedMonitor(17);
        f.kv._set(f.key, { id: sessionId, userId: owner, status: 'running', lifecycleGeneration: 18 });
        const { confirmMonitoredExit } = await import('../../container/container-lifecycle');
        expect(await confirmMonitoredExit(mockCtx as any, mockEnv, owner, sessionId, 17)).toBe(false);
        expect(await f.kv.get(f.key, 'json')).toMatchObject({ status: 'running', lifecycleGeneration: 18 });
        expect(capture.entries().filter(entry => entry.message === 'process_exit_confirmed')).toEqual([]);
      } finally { capture.restore(); }
    });

    it('REQ-SESSION-024: an old scheduled generation cannot observe or signal the replacement', async () => {
      const { instance, kv, key, persisted } = await attachedMonitor(12);
      persisted.set('lifecycleGeneration', 13);
      kv._set(key, { id: sessionId, userId: owner, status: 'running', lifecycleGeneration: 13 });
      const effects: string[] = [];
      mockTcpPortFetch.mockImplementation(async () => { effects.push('probe'); throw Error('old alarm'); });
      mockContainerRuntime.signal.mockImplementation(() => { effects.push('signal'); });
      mockContainerRuntime.destroy.mockImplementation(async () => { effects.push('destroy'); });
      await instance.collectMetrics({ ownerKey: owner, sessionId, generation: 12 });
      expect(effects).toEqual([]);
      expect(await kv.get(key, 'json')).toMatchObject({ status: 'running', lifecycleGeneration: 13 });
    });

    it('does not release ownership after a transport monitor rejection', async () => {
      const { kv, key, persisted } = await attachedMonitor(12);
      let rejectExit!: (error: unknown) => void;
      mockContainerRuntime.monitor.mockImplementation(() => new Promise<void>((_, reject) => { rejectExit = reject; }));
      const reconstructed = await reconstruct();
      await vi.waitFor(() => expect(rejectExit).toBeDefined());
      rejectExit(new Error('network connection lost'));
      await vi.waitFor(() => expect((reconstructed as any).logger.warn).toHaveBeenCalledWith(
        'Container monitor failed', { sessionId, lifecycleGeneration: 12, incidentId: null, errorClass: 'monitor_failed' },
      ));
      expect((await kv.get(key, 'json') as { status: string }).status).toBe('running');
      expect(persisted.has('monitoredExitGeneration')).toBe(false);
    });

    it.each([
      'container exited with unexpected exit code: 137',
      'Runtime signalled the container to exit due to a new version rollout: 143',
    ])('confirms an explicit nonzero process exit from the low-level monitor: %s', async (message) => {
      const { kv, key } = await attachedMonitor(13);
      let rejectExit!: (error: unknown) => void;
      mockContainerRuntime.monitor.mockImplementation(() => new Promise<void>((_, reject) => { rejectExit = reject; }));
      await reconstruct();
      await vi.waitFor(() => expect(rejectExit).toBeDefined());
      rejectExit(new Error(message));
      await vi.waitFor(async () => expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopped'));
    });

    it('observes an existing process after reconstruction with a false SDK running flag, without starting it', async () => {
      const { kv, key, completeExit } = await attachedMonitor(9, false);
      expect(mockTcpPortFetch).toHaveBeenCalled();
      expect(mockContainerRuntime.start).not.toHaveBeenCalled();
      await completeExit();
      expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopped');
    });

    it('discards obsolete exit evidence and observes the replacement generation', async () => {
      const { kv, key, persisted } = await attachedMonitor(8);
      persisted.set('monitoredExitGeneration', { owner, session: sessionId, generation: 7 });
      let resolveReplacement!: () => void;
      mockContainerRuntime.monitor.mockImplementation(() => new Promise<void>((resolve) => { resolveReplacement = resolve; }));
      await reconstruct();
      await vi.waitFor(() => expect(resolveReplacement).toBeDefined());
      expect(persisted.has('monitoredExitGeneration')).toBe(false);
      resolveReplacement();
      await vi.waitFor(async () => expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopped'));
    });

    it('does not attach an exit monitor to an unverified absent runtime', async () => {
      mockContainerRuntime.running = false;
      mockTcpPortFetch.mockRejectedValue(new Error('port unavailable'));
      mockStorage.get.mockImplementation(async (key: string) => ({ bucketName: 'owner', _sessionId: 'session1234', lifecycleGeneration: 2, containerAuthToken: 'token' })[key as 'bucketName']);
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => expect(instance._sessionId).toBe('session1234'));
      await vi.waitFor(() => expect(mockTcpPortFetch).toHaveBeenCalled());
      expect(mockContainerRuntime.monitor).not.toHaveBeenCalled();
      expect(mockContainerRuntime.start).not.toHaveBeenCalled();
    });

    it('reconciles pending boundary cancellation after coordinator reconstruction', async () => {
      const { kv, key, resolveExit, persisted, instance } = await attachedMonitor(10);
      kv._set(key, {
        id: sessionId, userId: owner, status: 'running', lifecycleGeneration: 10,
        boundaryActivityId: 'boundary-activity',
        createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
      });
      const binding = { session: { bucket: owner, sessionId, generation: 10 } };
      const cancelBoundaryStart = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
      mockEnv.OPERATOR_ACTIVITY = { getByName: () => ({
        getBoundaryStartBinding: async () => binding, cancelBoundaryStart,
      }) };
      let scheduled!: () => void;
      const firstRetry = new Promise<void>((resolve) => { scheduled = resolve; });
      vi.spyOn(instance, 'schedule').mockImplementation(async () => { scheduled(); return {} as Awaited<ReturnType<typeof instance.schedule>>; });
      resolveExit();
      await firstRetry;
      expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopping');
      await vi.waitFor(() => expect(persisted.get('monitoredExitGeneration')).toEqual({ owner, session: sessionId, generation: 10 }));
      const reconstructed = await reconstruct();
      expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopped');
      await vi.waitFor(() => expect(persisted.has('monitoredExitGeneration')).toBe(false));
      expect(reconstructed._sessionId).toBe(sessionId);
      expect(mockContainerRuntime.start).not.toHaveBeenCalled();
    });

    it('retains positive exit evidence through a failed D1 confirmation and retries it', async () => {
      const { kv, key, resolveExit, persisted } = await attachedMonitor(11);
      const original = mockEnv.USAGE_DB as D1Database;
      let failOnce = true;
      mockEnv.USAGE_DB = {
        prepare(sql: string) {
          const statement = original.prepare(sql);
          if (!sql.includes("SET lifecycle_state='stopped'")) return statement;
          return { bind(...values: unknown[]) {
            const bound = statement.bind(...values);
            return { run: async () => {
              if (failOnce) { failOnce = false; throw new Error('D1 temporarily unavailable'); }
              return bound.run();
            } };
          } };
        },
      };
      resolveExit();
      await vi.waitFor(() => expect(failOnce).toBe(false));
      expect(persisted.get('monitoredExitGeneration')).toEqual({ owner, session: sessionId, generation: 11 });
      expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopping');
      await reconstruct();
      expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopped');
      await vi.waitFor(() => expect(persisted.has('monitoredExitGeneration')).toBe(false));
      expect(mockContainerRuntime.start).not.toHaveBeenCalled();
    });

    it('confirms a running session only when its attached process monitor resolves', async () => {
      const { kv, key, completeExit } = await attachedMonitor(7);
      expect((await kv.get(key, 'json') as { status: string }).status).toBe('running');
      await completeExit();
      expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopped');
    });

    it.each(['resolved exit', 'rollout exit'] as const)('cannot stop a replacement when the old monitor completes late: %s', async (completion) => {
      const { kv, key, resolveExit, rejectExit, persisted, instance } = await attachedMonitor(7);
      let retryScheduled!: () => void;
      const retry = new Promise<void>((resolve) => { retryScheduled = resolve; });
      vi.spyOn(instance, 'schedule').mockImplementation(async () => { retryScheduled(); return {} as Awaited<ReturnType<typeof instance.schedule>>; });
      kv._set(key, {
        id: sessionId, userId: owner, status: 'running', lifecycleGeneration: 8,
        createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
      });
      if (completion === 'rollout exit') rejectExit(new Error('Runtime signalled the container to exit due to a new version rollout: 143'));
      else resolveExit();
      await retry;
      expect(persisted.get('monitoredExitGeneration')).toEqual({ owner, session: sessionId, generation: 7 });
      expect(await kv.get(key, 'json')).toMatchObject({ status: 'running', lifecycleGeneration: 8 });
    });

    it('does not overwrite newer positive exit evidence when an old callback resolves', async () => {
      const { kv, key, resolveExit, persisted, instance } = await attachedMonitor(7);
      const newer = { owner, session: sessionId, generation: 8 };
      persisted.set('lifecycleGeneration', 8);
      persisted.set('monitoredExitGeneration', newer);
      kv._set(key, {
        id: sessionId, userId: owner, status: 'stopping', lifecycleGeneration: 8,
        terminationIntentId: 'newer-intent',
        createdAt: '2026-01-01T00:00:00.000Z', lastAccessedAt: '2026-01-01T00:00:00.000Z',
      });
      let scheduled!: () => void;
      const oldRetry = new Promise<void>((resolve) => { scheduled = resolve; });
      vi.spyOn(instance, 'schedule').mockImplementation(async () => { scheduled(); return {} as Awaited<ReturnType<typeof instance.schedule>>; });
      resolveExit();
      await oldRetry;
      expect(persisted.get('monitoredExitGeneration')).toEqual(newer);
      await reconstruct();
      expect((await kv.get(key, 'json') as { status: string }).status).toBe('stopped');
      await vi.waitFor(() => expect(persisted.has('monitoredExitGeneration')).toBe(false));
    });
  });

  describe('fetch gate — 503 when container not running / REQ-SESSION-009 (DO fetch gates on container.running, returns 503 for non-internal routes) / REQ-SESSION-012 (wake-loop prevention: HTTP remains gated while volatile WS state stays retryable)', () => {
    it('should return 503 for non-internal routes when container is not running', async () => {
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/some-route', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(503);
    });

    async function assertNativeUpgrade(path: string, running: boolean) {
      mockContainerRuntime.running = running;
      const token = 'existing-token';
      const persisted = new Map<string, unknown>([['containerAuthToken', token], ['lifecycleGeneration', 7]]);
      mockStorage.get.mockImplementation(async (key: string) => persisted.get(key) ?? null);
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { persisted.set(key, value); });
      let started = false;
      mockContainerRuntime.start.mockImplementation(() => { started = true; throw new Error('replacement started'); });
      mockTcpPortFetch.mockImplementation(async (request: Request) => {
        const url = new URL(request.url);
        if (url.protocol !== 'http:' || url.hostname !== 'container' || url.pathname !== path
          || url.search !== '?reconnect=a%2Fb&empty=&bare'
          || request.headers.get('Authorization') !== `Bearer ${token}`
          || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
          return new Response('Invalid private-port identity', { status: 401 });
        }
        const pair = new WebSocketPair();
        pair[1].accept();
        pair[1].addEventListener('message', event => pair[1].send(event.data));
        pair[1].addEventListener('close', () => pair[1].close(1000));
        return new Response(null, { status: 101, webSocket: pair[0] });
      });
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // Reuse the existing native DO harness namespace (no Docker startup).
      // Dispatch the actual container override through Stub.fetch; only the
      // private port/SDK platform collaborators are fixtures, not fetch().
      const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
      const nativeStub = namespace.getByName(`container-fixture-${crypto.randomUUID()}`);
      await runInDurableObject<NativeDurableObject, void>(nativeStub as DurableObjectStub<NativeDurableObject>, async nativeInstance => {
        nativeInstance.fetch = (request: Request) => instance.fetch(request);
      });
      const response = await nativeStub.fetch(new Request(`https://codeflare.ch${path}?reconnect=a%2Fb&empty=&bare`, {
        headers: { Upgrade: 'websocket', Authorization: 'Bearer forged' },
      }));
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      expect(socket).not.toBeNull();
      socket.accept();
      try {
        const payload = Uint8Array.from({ length: 256 * 1024 }, (_, index) => index % 251);
        const reply = new Promise<unknown>((resolve, reject) => {
          socket.addEventListener('message', event => resolve(event.data), { once: true });
          socket.addEventListener('close', () => reject(new Error('Closed before protocol echo')), { once: true });
        });
        socket.send(payload);
        expect(new Uint8Array(await reply as ArrayBuffer)).toEqual(payload);
        expect(started).toBe(false);
        expect(persisted.get('lifecycleGeneration')).toBe(7);
      } finally { socket.close(1000); }
    }

    it('REQ-SESSION-012 AC4: native terminal fetch probes only the existing port when SDK state is stale', async () => {
      await assertNativeUpgrade('/terminal', false);
    });

    it.each([
      ['/terminal', true],
      ['/api/vscode/abcdef1234567890/ws', true],
      ['/api/vscode/abcdef1234567890/ws', false],
    ] as const)('REQ-IDE-001 AC3/AC6 / REQ-SESSION-012 AC4: native %s upgrade survives SDK running=%s without restarting', async (path, running) => {
      await assertNativeUpgrade(path, running);
    });

    it.each(['missing token', 'absent port'])('REQ-IDE-001 AC5 / REQ-SESSION-012 AC4: native editor %s returns 503 without a replacement generation', async reason => {
      mockContainerRuntime.running = false;
      const persisted = new Map<string, unknown>([['lifecycleGeneration', 7]]);
      if (reason === 'absent port') persisted.set('containerAuthToken', 'existing-token');
      mockStorage.get.mockImplementation(async (key: string) => persisted.get(key) ?? null);
      mockStorage.put.mockImplementation(async (key: string, value: unknown) => { persisted.set(key, value); });
      mockTcpPortFetch.mockRejectedValue(new Error('no existing process'));
      let started = false;
      mockContainerRuntime.start.mockImplementation(() => { started = true; mockContainerRuntime.running = true; });
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const response = await instance.fetch(new Request('https://codeflare.ch/api/vscode/abcdef1234567890/ws', {
        headers: { Upgrade: 'websocket' },
      }));
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('Existing container unavailable');
      expect(started).toBe(false);
      expect(mockContainerRuntime.running).toBe(false);
      expect(persisted.get('lifecycleGeneration')).toBe(7);
    });

    it('should allow internal routes when container is not running', async () => {
      mockContainerRuntime.running = false;
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/_internal/getBucketName', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      // Internal routes are handled by the route map before the gate
      expect(response.status).toBe(200);
      const body = await response.json() as { bucketName: string | null };
      expect(body).toHaveProperty('bucketName');
    });

    it.each([undefined, 'Bearer caller-supplied'])('REQ-SEC-022 AC1: missing lifecycle credentials refuse protected forwarding (%s)', async (authorization) => {
      mockContainerRuntime.running = true;
      // No restored configuration: a bucket would generate a lifecycle token during hydration.
      mockStorage.get.mockResolvedValue(null);
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await mockCtx.blockConcurrencyWhile.mock.results.at(-1)!.value;
      const upstreamState = { syncRequested: false };
      const proto = Object.getPrototypeOf(Object.getPrototypeOf(instance));
      const upstream = vi.spyOn(proto, 'fetch').mockImplementation(async () => {
        upstreamState.syncRequested = true;
        return new Response('sync started', { status: 200 });
      });
      try {
        const response = await instance.fetch(new Request('http://container/internal/bisync-trigger', {
          method: 'POST', headers: authorization ? { Authorization: authorization } : {},
        }));
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'Container authorization unavailable' });
        expect(upstreamState.syncRequested).toBe(false);
      } finally { upstream.mockRestore(); }
    });

    it('REQ-SEC-022 AC1: proxied non-internal request gets Authorization: Bearer <containerAuthToken> injected before super.fetch', async () => {
      mockContainerRuntime.running = true;
      const PRIOR_TOKEN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return PRIOR_TOKEN;
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // Wait for constructor's blockConcurrencyWhile body to finish restoring
      // containerAuthToken from storage, so the fetch override sees it.
      await vi.waitFor(() => {
        expect(instance.envVars?.CONTAINER_AUTH_TOKEN).toBe(PRIOR_TOKEN);
      });

      // Spy on the MockContainer (super) prototype's fetch and capture the
      // Request the DO override forwards.
      const proto = Object.getPrototypeOf(Object.getPrototypeOf(instance));
      const superFetchSpy = vi.spyOn(proto, 'fetch')
        .mockResolvedValue(new Response('proxied', { status: 200 }));

      try {
        const request = new Request('http://container/some-route', { method: 'GET' });
        await instance.fetch(request);

        expect(superFetchSpy).toHaveBeenCalledTimes(1);
        const forwarded = superFetchSpy.mock.calls[0][0] as Request;
        expect(forwarded.headers.get('Authorization')).toBe(`Bearer ${PRIOR_TOKEN}`);
      } finally {
        superFetchSpy.mockRestore();
      }
    });

    it('should return JSON error body with correct Content-Type', async () => {
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      const request = new Request('http://container/some-route', {
        method: 'GET',
      });

      const response = await instance.fetch(request);
      expect(response.status).toBe(503);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      const body = await response.json() as { error: string };
      expect(body.error).toBe('Container not running');
    });
  });

  describe('destroy', () => {
    // Supplied DO storage: public reads observe actual SUT writes/deletes.
    async function destroyFixture(withIdentity = true) {
      const stored = new Map<string, unknown>(withIdentity ? [
        ['bucketName', 'test-bucket'], ['_sessionId', 'sess123'],
        ['lifecycleGeneration', 7], ['observationSequence', 6],
        ['containerAuthToken', 'destroy-wire-token'],
      ] : []);
      const storage = {
        get: async (key: string) => stored.get(key),
        put: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); },
        delete: async (key: string | string[]) => {
          for (const item of typeof key === 'string' ? [key] : key) stored.delete(item);
        },
      };
      mockStorage.get.mockImplementation(storage.get);
      mockStorage.put.mockImplementation(storage.put);
      mockStorage.delete.mockImplementation(storage.delete);
      let ready = Promise.resolve();
      mockCtx.blockConcurrencyWhile.mockImplementation((work: () => Promise<void>) => {
        ready = work();
        return ready;
      });
      const wire: Array<{ path: string; method: string; authorization: string | null }> = [];
      const fetch = async (input: string | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        wire.push({ path, method: request.method, authorization: request.headers.get('Authorization') });
        return Response.json(path === '/internal/agent-events/drain'
          ? { hostNow: Date.now(), events: [] } : { synced: true });
      };
      mockTcpPortFetch.mockImplementation(fetch);
      mockContainerRuntime.running = true;
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await ready;
      let started = false;
      mockContainerRuntime.start.mockImplementation(() => { started = true; });
      vi.spyOn(instance, 'stop').mockImplementation(async () => { mockContainerRuntime.running = false; });
      return { instance, storage, fetch, wire, started: () => started };
    }

    it('REQ-SESSION-025 AC1-2: user Stop retains final-sync context and confirms only after native completion', async () => {
      const capture = await captureLifecycleSerialization();
      let resolveNative!: () => void;
      try {
        const kv = createMockKV();
        const key = 'session:test-bucket:sess123';
        kv._set(key, { id: 'sess123', userId: 'test-bucket', status: 'unreachable',
          lifecycleGeneration: 7, unreachableIncidentId: 'stop-incident-7',
          unreachableFirstObservedAt: '2026-01-01T00:00:00.000Z', unreachableDeadlineMs: 120_000 });
        mockEnv.USAGE_DB = createMockSessionD1(kv);
        mockEnv.CONTAINER = { idFromName: () => mockCtx.id };
        const f = await destroyFixture();
        let providerReached!: () => void;
        const providerRequested = new Promise<void>(resolve => { providerReached = resolve; });
        const nativeCompletion = new Promise<void>(resolve => { resolveNative = resolve; });
        vi.spyOn(f.instance, 'superDestroy').mockImplementation(() => { providerReached(); return nativeCompletion; });
        let drainObserved = false;
        mockTcpPortFetch.mockImplementation(async (input: string | Request, init?: RequestInit) => {
          const request = new Request(input, init);
          if (new URL(request.url).pathname !== '/internal/final-sync') return f.fetch(input, init);
          expect(await f.storage.get('_sessionId')).toBeUndefined();
          expect(await f.storage.get('bucketName')).toBeUndefined();
          expect(await f.storage.get('containerAuthToken')).toBeUndefined();
          expect(request.method).toBe('POST');
          expect(request.headers.get('Authorization')).toBe('Bearer destroy-wire-token');
          drainObserved = true;
          return Response.json({ synced: true });
        });
        const stop = f.instance.stopSession({ bucket: 'test-bucket', sessionId: 'sess123', generation: 7 });
        const settled = stop.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
        try {
          await providerRequested;
          expect(drainObserved).toBe(true);
          const stopping = await kv.get(key, 'json') as { terminationIntentId: string; status: string };
          expect(stopping.status).toBe('stopping');
          expect(stopping.terminationIntentId).toEqual(expect.any(String));
          const context = { sessionId: 'sess123', lifecycleGeneration: 7,
            incidentId: 'stop-incident-7', terminationIntentId: stopping.terminationIntentId };
          const correlation = { ...context, reason: 'user' };
          // Audit outcome reasons retain their existing meaning; initiator classification belongs to the transition log.
          expect(await f.storage.get('finalSyncAudit')).toMatchObject({ ...context, outcome: 'completed', httpStatus: 200 });
          expect(capture.entries()).toContainEqual(expect.objectContaining({
            data: expect.objectContaining({ ...correlation, outcome: 'completed', httpStatus: 200 }),
          }));
          expect(capture.entries().filter(entry => entry.message === 'process_exit_confirmed')).toEqual([]);
          resolveNative();
          expect(await settled).toEqual({ ok: true });
          expect(await kv.get(key, 'json')).toMatchObject({ status: 'stopped', lifecycleGeneration: 7 });
          expect(capture.entries()).toContainEqual(expect.objectContaining({ message: 'process_exit_confirmed', data: expect.objectContaining(correlation) }));
          expect(JSON.stringify(capture.lines)).not.toContain('destroy-wire-token');
          expect(f.started()).toBe(false);
        } finally { resolveNative(); await settled; }
      } finally { capture.restore(); }
    });

    it('REQ-SESSION-025 AC1-2: direct destroy retains available context without inventing authenticated user provenance', async () => {
      const capture = await captureLifecycleSerialization();
      try {
        const f = await destroyFixture();
        await f.instance.destroy();
        expect(await f.storage.get('_sessionId')).toBeUndefined();
        expect(await f.storage.get('finalSyncAudit')).toMatchObject({ sessionId: 'sess123', lifecycleGeneration: 7, outcome: 'completed', httpStatus: 200 });
        expect(capture.entries()).toContainEqual(expect.objectContaining({ data: expect.objectContaining({
          sessionId: 'sess123', lifecycleGeneration: 7, reason: 'unknown', outcome: 'completed',
        }) }));
        expect(mockContainerRuntime.running).toBe(false);
        expect(f.started()).toBe(false);
      } finally { capture.restore(); }
    });

    it.each(['host-reason', 'fetch-error', 'cleanup-error', 'stop-error', 'provider-error'] as const)(
      'REQ-SESSION-025 AC4: teardown %s retains safe diagnostics and best-effort/exit authority', async stage => {
        const capture = await captureLifecycleSerialization();
        const sensitive = 'Bearer cf-sensitive-token transcript-fragment terminal-fragment /home/user/private/customer.txt';
        try {
          const f = await destroyFixture();
          let nativeReached = false;
          const stopSignals: Array<Parameters<typeof f.instance.stop>[0]> = [];
          vi.spyOn(f.instance, 'superDestroy').mockImplementation(async () => {
            nativeReached = true;
            if (stage === 'provider-error') throw Error(sensitive);
          });
          if (stage === 'cleanup-error') {
            mockStorage.delete.mockImplementation(async (key: string | string[]) => {
              if (key === 'bucketName') throw Error(sensitive);
              return f.storage.delete(key);
            });
          }
          if (stage === 'stop-error') {
            vi.spyOn(f.instance, 'stop').mockImplementation(async signal => { stopSignals.push(signal); throw Error(sensitive); });
          }
          let authenticatedDrain = false;
          mockTcpPortFetch.mockImplementation(async (input: string | Request, init?: RequestInit) => {
            const request = new Request(input, init);
            if (new URL(request.url).pathname !== '/internal/final-sync') return f.fetch(input, init);
            expect(request.headers.get('Authorization')).toBe('Bearer destroy-wire-token');
            authenticatedDrain = true;
            if (stage === 'fetch-error') throw Error(sensitive);
            return stage === 'host-reason' ? Response.json({ synced: false, reason: sensitive }, { status: 504 }) : Response.json({ synced: true });
          });
          if (stage === 'provider-error') {
            await expect(f.instance.destroy()).rejects.toThrow(sensitive);
            expect(capture.entries().filter(entry => entry.message === 'process_exit_confirmed')).toEqual([]);
          } else if (stage === 'cleanup-error') {
            await expect(f.instance.destroy()).rejects.toThrow('Operational storage cleanup incomplete');
          } else await expect(f.instance.destroy()).resolves.toBeUndefined();
          expect(authenticatedDrain).toBe(true);
          expect(nativeReached).toBe(true);
          if (stage === 'cleanup-error') {
            expect(await f.storage.get('bucketName')).toBe('test-bucket');
            expect(await f.storage.get('shutdownRequested')).toEqual(expect.any(Number));
            expect(await f.storage.get('containerAuthToken')).toBeUndefined();
            expect((await f.instance.fetch(new Request('http://container/workspace'))).status).toBe(503);
          }
          if (stage === 'stop-error') expect(stopSignals).toContain('SIGTERM');
          const audit = await f.storage.get('finalSyncAudit');
          const outcome = stage === 'host-reason' ? 'incomplete' : stage === 'fetch-error' ? 'errored' : 'completed';
          expect(audit).toMatchObject({ sessionId: 'sess123', lifecycleGeneration: 7, outcome });
          if (stage === 'host-reason') expect(audit).toMatchObject({ httpStatus: 504 });
          expect(capture.entries()).toContainEqual(expect.objectContaining({ data: expect.objectContaining({
            sessionId: 'sess123', lifecycleGeneration: 7, outcome,
            ...(stage === 'host-reason' || stage === 'fetch-error' ? { errorClass: expect.any(String) } : {}),
          }) }));
          const serialized = JSON.stringify({ logs: capture.lines, audit });
          for (const forbidden of ['cf-sensitive-token', 'transcript-fragment', 'terminal-fragment', '/home/user/private/customer.txt', 'destroy-wire-token']) expect(serialized).not.toContain(forbidden);
          expect(f.started()).toBe(false);
        } finally { capture.restore(); }
      },
    );

    it('REQ-SESSION-009 AC1: public destroy removes the forwarding credential and subsequent fetch stays unavailable without starting', async () => {
      const f = await destroyFixture();
      const socket = () => new Request('http://container/terminal', { headers: { Upgrade: 'websocket' } });
      expect((await f.instance.fetch(socket())).status).toBe(200);
      await f.instance.destroy();
      expect((await f.instance.fetch(socket())).status).toBe(503);
      const response = await f.instance.fetch(new Request('http://container/workspace'));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Container not running' });
      const bucket = await f.instance.fetch(new Request('http://container/_internal/getBucketName'));
      expect(await bucket.json()).toEqual({ bucketName: null });
      expect(await f.storage.get('containerAuthToken')).toBeUndefined();
      expect(await f.storage.get('_sessionId')).toBeUndefined();
      expect(f.started()).toBe(false);
    });

    it('REQ-SESSION-009 AC4: a delivered metrics callback after public destroy leaves schedules and service effects unchanged', async () => {
      const f = await destroyFixture();
      type Task = { taskId: string; callback: string; payload: unknown; type: 'delayed'; time: number; delayInSeconds: number };
      let tasks: Task[] = [{ taskId: 'queued', callback: 'collectMetrics', payload: {}, type: 'delayed', time: 0, delayInSeconds: 60 }];
      vi.spyOn(f.instance, 'listSchedules').mockImplementation(async method => tasks.filter(task => !method || task.callback === method) as never);
      vi.spyOn(f.instance, 'deleteSchedules').mockImplementation(method => { tasks = tasks.filter(task => task.callback !== method); });
      vi.spyOn(f.instance, 'schedule').mockImplementation(async (delay, callback, payload) => {
        const task: Task = { taskId: 'rearmed', callback: String(callback), payload, type: 'delayed', time: 0, delayInSeconds: Number(delay) };
        tasks.push(task);
        return task as never;
      });
      await f.instance.destroy();
      expect(await f.instance.listSchedules('collectMetrics')).toEqual([]);
      const effects: string[] = [];
      mockEnv.USAGE_DB = { prepare: () => { effects.push('d1'); throw Error('Destroyed session reached D1'); } };
      mockContainerRuntime.start.mockImplementation(() => { effects.push('start'); });
      mockContainerRuntime.signal.mockImplementation(() => { effects.push('signal'); });
      mockContainerRuntime.destroy.mockImplementation(() => { effects.push('force'); });
      vi.spyOn(f.instance, 'stop').mockImplementation(async () => { effects.push('stop'); });
      const wireBefore = [...f.wire];
      await f.instance.collectMetrics({ ownerKey: 'test-bucket', sessionId: 'sess123', generation: 7 });
      expect(await f.instance.listSchedules('collectMetrics')).toEqual([]);
      expect(f.wire).toEqual(wireBefore);
      expect(effects).toEqual([]);
      expect(await f.storage.get('observationSequence')).toBe(6);
    });

    it('REQ-SESSION-011 AC1 / REQ-SESSION-019 AC1: authenticated final-sync completion precedes SIGTERM even with a transient false running flag', async () => {
      const f = await destroyFixture();
      mockContainerRuntime.running = false;
      let reached!: () => void;
      const requested = new Promise<void>(resolve => { reached = resolve; });
      let complete!: (response: Response) => void;
      const response = new Promise<Response>(resolve => { complete = resolve; });
      const order: string[] = [];
      mockTcpPortFetch.mockImplementation(async (input: string | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname === '/internal/final-sync') {
          expect(request.method).toBe('POST');
          expect(request.headers.get('Authorization')).toBe('Bearer destroy-wire-token');
          order.push('authenticated-final-sync');
          reached();
          return response;
        }
        return Response.json({ hostNow: Date.now(), events: [] });
      });
      vi.spyOn(f.instance, 'stop').mockImplementation(async signal => {
        order.push(String(signal));
        mockContainerRuntime.running = false;
      });
      const completion = f.instance.destroy();
      await requested;
      expect(order).toEqual(['authenticated-final-sync']);
      mockContainerRuntime.running = true;
      order.push('sync-completed');
      complete(Response.json({ synced: true }));
      await completion;
      expect(order).toEqual(['authenticated-final-sync', 'sync-completed', 'SIGTERM']);
      expect(await f.storage.get('finalSyncAudit')).toEqual(expect.objectContaining({ outcome: 'completed', httpStatus: 200 }));
    });

    it('REQ-SESSION-019 AC1: missing token emits no outgoing request and leaves a readable bounded teardown audit', async () => {
      const f = await destroyFixture(false);
      const entered = Date.now();
      await expect(f.instance.destroy()).resolves.toBeUndefined();
      expect(f.wire).toEqual([]);
      const audit = await f.storage.get('finalSyncAudit') as { at: number; outcome: string; reason: string; running: boolean };
      expect(audit).toEqual({ outcome: 'errored', reason: 'missing-auth-token', at: expect.any(Number), running: true });
      expect(audit.at).toBeGreaterThanOrEqual(entered);
      expect(audit.at).toBeLessThanOrEqual(entered + 135_000);
      expect(mockContainerRuntime.running).toBe(false);
      expect(f.started()).toBe(false);
    });

    it.each(['storage-fence', 'storage-read', 'storage-delete', 'final-sync', 'response-body', 'audit-write', 'stop', 'provider'] as const)(
      'REQ-SESSION-011 AC5: an awaited %s stall cannot extend the shared 135-second teardown deadline', async stage => {
        vi.useFakeTimers();
        try {
          const f = await destroyFixture(stage !== 'storage-read');
          let reached!: () => void;
          const stalled = new Promise<void>(resolve => { reached = resolve; });
          const hang = <T,>(): Promise<T> => { reached(); return new Promise<T>(() => {}); };
          const { put, get } = f.storage;
          const { fetch } = f;
          if (stage === 'storage-fence' || stage === 'audit-write') {
            mockStorage.put.mockImplementation(async (key: string, value: unknown) =>
              key === (stage === 'storage-fence' ? 'shutdownRequested' : 'finalSyncAudit') ? hang<void>() : put(key, value));
          }
          if (stage === 'storage-read') mockStorage.get.mockImplementation(async (key: string) => key === 'containerAuthToken' ? hang<unknown>() : get(key));
          if (stage === 'storage-delete') mockStorage.delete.mockImplementation(() => hang<void>());
          if (stage === 'final-sync' || stage === 'response-body') {
            mockTcpPortFetch.mockImplementation(async (input: string | Request, init?: RequestInit) => {
              if (new URL(new Request(input, init).url).pathname !== '/internal/final-sync') return fetch(input, init);
              if (stage === 'final-sync') return hang<Response>();
              reached();
              return new Response(new ReadableStream<Uint8Array>({ start() {} }));
            });
          }
          if (stage === 'stop') vi.spyOn(f.instance, 'stop').mockImplementation(() => hang<void>());
          if (stage === 'provider') vi.spyOn(f.instance, 'superDestroy').mockImplementation(() => hang<void>());
          let result = 'pending';
          const completion = f.instance.destroy().then(() => { result = 'resolved'; }, error => { result = (error as Error).message; });
          await stalled;
          await vi.advanceTimersByTimeAsync(134_999);
          expect(result).toBe('pending');
          await vi.advanceTimersByTimeAsync(1);
          await completion;
          expect(result).toBe('teardown deadline exceeded');
          expect(f.started()).toBe(false);
        } finally { vi.useRealTimers(); }
      },
    );

    // Most existing tests in this block assert storage cleanup, not the new
    // graceful-shutdown polling. Default to !running so the override skips the
    // 25 s SIGTERM-and-poll branch; tests that need the graceful path opt in.
    beforeEach(() => {
      mockContainerRuntime.running = false;
    });

    it('calls super.destroy() and cleans up operational storage', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await instance.destroy();

      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
      expect(mockStorage.delete).toHaveBeenCalledWith('metricsTransportRecovery');
    });

    it('REQ-SESSION-022 AC1: clears transport recovery independently when later teardown cleanup fails', async () => {
      mockStorage.delete.mockImplementation(async (key: string) => {
        if (key === '_sessionId') throw new Error('storage unavailable');
      });
      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await expect(instance.destroy()).rejects.toThrow('Operational storage cleanup incomplete');

      const deletedKeys = mockStorage.delete.mock.calls.map((call) => call[0]);
      expect(deletedKeys).toContain('metricsTransportRecovery');
      expect(deletedKeys.indexOf('metricsTransportRecovery')).toBeLessThan(deletedKeys.indexOf('_sessionId'));
    });

    it('deletes SESSION_ID_KEY to prevent onStop from resurrecting KV entry', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      await instance.destroy();

      expect(mockStorage.delete).toHaveBeenCalledWith('_sessionId');
      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });

    it('persists the shutdown marker before clearing process identifiers', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await instance.destroy();
      const markerOrder = mockStorage.put.mock.invocationCallOrder[
        mockStorage.put.mock.calls.findIndex((call: unknown[]) => call[0] === 'shutdownRequested')
      ];
      const identifierClearOrder = mockStorage.delete.mock.invocationCallOrder[
        mockStorage.delete.mock.calls.findIndex((call: unknown[]) => call[0] === '_sessionId')
      ];
      expect(markerOrder).toBeLessThan(identifierClearOrder);
    });

    // REQ-SESSION-018 AC5: destroy() persists the deliberate-stop marker (and
    // drops the metrics alarm) BEFORE clearing identifiers, so a DO eviction
    // mid-shutdown cannot let a surviving collectMetrics alarm self-heal a
    // deliberately-stopped session back to running. The marker must be PERSISTED
    // (survives the eviction that resets in-memory fields), not an in-memory flag.
    it('persists the shutdown marker and drops the metrics alarm before clearing identifiers', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const deleteSchedulesSpy = vi.spyOn(instance, 'deleteSchedules' as any);

      await instance.destroy();

      expect(mockStorage.put).toHaveBeenCalledWith('shutdownRequested', expect.any(Number));
      expect(deleteSchedulesSpy).toHaveBeenCalledWith('collectMetrics');
    });

    it('REQ-SEC-012 AC3: destroy() clears persisted containerAuthToken so next session under same DO ID starts fresh', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'old-token-uuid';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('containerAuthToken');
      });

      await instance.destroy();

      // Persisted token must be deleted so a fresh DO incarnation does not
      // inherit it (cross-lifecycle reuse would defeat REQ-SEC-012 AC1).
      expect(mockStorage.delete).toHaveBeenCalledWith('containerAuthToken');
      // And the in-memory copy is nulled so any racing fetch() does not
      // continue to inject the now-revoked token.
      expect((instance as unknown as { _containerAuthToken: string | null })._containerAuthToken).toBeNull();
    });

    it('nulls _bucketName so onStop memory fallback fails', async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const mockKvGet = vi.fn().mockResolvedValue({
        id: 'sess123',
        status: 'running',
        name: 'Test',
      });
      mockEnv.KV = { get: mockKvGet, put: mockKvPut };

      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        return null;
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await vi.waitFor(() => {
        expect(mockStorage.get).toHaveBeenCalledWith('bucketName');
      });

      await instance.destroy();

      // After destroy, onStop should NOT write to KV because
      // both _sessionId (storage) and _bucketName (memory) are cleared
      mockKvPut.mockClear();
      // Storage.get for _sessionId returns null after delete
      mockStorage.get.mockImplementation(async () => null);

      await instance.onStop();

      // Give async work time to complete
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockKvPut).not.toHaveBeenCalled();
    });

    it('onStop does not resurrect the retired KV session projection', async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      mockEnv.KV = { get: vi.fn(), put: mockKvPut };
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await instance.onStop();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(mockKvPut).not.toHaveBeenCalled();
    });

    // REQ-VAULT-006: shutdown bisync completes vault writes before SIGKILL (graceful SIGTERM drain)
    it('graceful shutdown: sends SIGTERM and exits the polling loop once the container reports !running', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });
      mockContainerRuntime.running = true;

      const instance = new ContainerClass(mockCtx as any, mockEnv);

      // SIGTERM simulation: the trap exits, container.running flips to false
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        mockContainerRuntime.running = false;
      });

      await instance.destroy();

      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
      expect(mockContainerRuntime.running).toBe(false);
      // Storage cleanup also happened
      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });

    it('REQ-SESSION-011: drains a final R2 sync (POST /internal/final-sync) BEFORE signalling stop', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      mockContainerRuntime.running = true;

      const order: string[] = [];
      // Record the drain call and resolve it OK so drainFinalSync completes
      // its happy path; the order array proves it lands before stop().
      mockTcpPortFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/internal/final-sync')) {
          order.push('finalsync');
        }
        return new Response(JSON.stringify({ synced: true }), { status: 200 });
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        order.push('stop');
        mockContainerRuntime.running = false;
      });

      await instance.destroy();

      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
      // The whole point of the fix: the live bisync is awaited while the
      // container is still running, then we stop. Never the reverse.
      expect(order).toEqual(['finalsync', 'stop']);
    });

    it('REQ-SESSION-011: the final-sync drain authenticates with the container token captured BEFORE the storage clear (401 regression)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-teardown-456';
        return null;
      });
      mockContainerRuntime.running = true;

      // Capture the drain request init so the Authorization header is assertable.
      // The raw port.fetch bypasses the DO fetch override that injects auth; pre-fix
      // this request carried no header and the in-container host 401'd it on EVERY
      // stop/delete (observed: 30 days of outcome:incomplete httpStatus:401 audits,
      // zero successes) - the actual bisync-on-delete data loss.
      let drainInit: RequestInit | undefined;
      mockTcpPortFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/internal/final-sync')) {
          drainInit = init;
          // The drain fires AFTER the operational-storage clear (REQ-SESSION-009
          // ordering), so a header here proves the token was captured pre-clear,
          // not read late from already-wiped storage.
          expect(mockStorage.delete).toHaveBeenCalledWith('containerAuthToken');
        }
        return new Response(JSON.stringify({ synced: true }), { status: 200 });
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        mockContainerRuntime.running = false;
      });

      await instance.destroy();

      expect((drainInit?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer tok-teardown-456');
    });

    it('REQ-SESSION-011: missing auth token records the reason and makes zero final-sync requests', async () => {
      mockStorage.get.mockResolvedValue(null);
      mockContainerRuntime.running = true;
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      vi.spyOn(instance, 'stop' as any).mockImplementation(async () => { mockContainerRuntime.running = false; });

      await instance.destroy();

      expect(mockTcpPortFetch).not.toHaveBeenCalledWith(expect.stringContaining('/internal/final-sync'), expect.anything());
      expect(mockStorage.put).toHaveBeenCalledWith('finalSyncAudit', expect.objectContaining({ reason: 'missing-auth-token' }));
    });

    it('REQ-SESSION-011: still stops when the final-sync drain fails (best-effort, no throw)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      mockContainerRuntime.running = true;

      // Drain endpoint rejects: drainFinalSync must swallow it so teardown
      // still proceeds to stop rather than wedging the destroy.
      mockTcpPortFetch.mockRejectedValue(new Error('Connection refused'));

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        mockContainerRuntime.running = false;
      });

      await expect(instance.destroy()).resolves.toBeUndefined();
      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
    });

    // #516: a deliberate stop/delete that lands during a transient not-running
    // reading (DO wake / deploy-roll) must STILL attempt the final drain - skipping
    // it silently dropped the last edits. Pre-fix, the running gate skipped the whole
    // block. Post-fix, the drain fetch fires regardless and the outcome is persisted.
    it('REQ-SESSION-011/#516: attempts the final-sync drain on delete even when container.running reads transiently false, and persists a durable audit marker', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      // The transient: container reports not-running at teardown start.
      mockContainerRuntime.running = false;

      let drainAttempted = false;
      mockTcpPortFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/internal/final-sync')) {
          drainAttempted = true;
          return new Response(JSON.stringify({ synced: true }), { status: 200 });
        }
        return new Response('', { status: 200 });
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await instance.destroy();

      // Drain was attempted despite running===false (the #516 fix).
      expect(drainAttempted).toBe(true);
      // The outcome is durably recorded - never silently swallowed.
      const auditPut = mockStorage.put.mock.calls.find((c) => c[0] === 'finalSyncAudit');
      expect(auditPut).toBeDefined();
      expect((auditPut![1] as { outcome: string }).outcome).toBe('completed');
    });

    // Any non-OK final-sync HTTP response (res.ok === false) must be recorded as a
    // non-completed, queryable audit outcome carrying the session id + http
    // status/reason - never swallowed - and the session must still delete (data
    // loss past the window is acceptable per the fix decision; a SILENT loss is
    // not). Post budget-inversion fix a host *timeout* 504 no longer reaches the DO
    // (the DO's AbortSignal at FINAL_SYNC_BUDGET_MS=120s fires before the host's
    // 125s 504), so the authoritative ceiling path is the fetch *rejection* covered
    // by the "errored" sibling test below; this case guards the reachable non-OK
    // branch (e.g. a fast 503/non-2xx) and the body-capture plumbing. The 504 here
    // is illustrative of the res.ok===false mapping, not the timeout race.
    it('REQ-SESSION-011: a non-OK final-sync response is audited as "incomplete" with the session id + http status/reason, and the delete still proceeds', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === '_sessionId') return 'sess123';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      mockContainerRuntime.running = true;

      mockTcpPortFetch.mockImplementation(async (url: string) => {
        if (typeof url === 'string' && url.includes('/internal/final-sync')) {
          return new Response(JSON.stringify({ synced: false, reason: 'timeout' }), { status: 504 });
        }
        return new Response('', { status: 200 });
      });

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      // The constructor loads _sessionId via blockConcurrencyWhile; the test mock
      // does not await that init, so set the in-memory field directly (as the
      // containerStartedAt test does). destroy() captures host._sessionId before
      // the storage-clear nulls it.
      (instance as any)._sessionId = 'sess123';
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
        mockContainerRuntime.running = false;
      });

      await expect(instance.destroy()).resolves.toBeUndefined();
      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');

      const auditPut = mockStorage.put.mock.calls.find((c) => c[0] === 'finalSyncAudit');
      expect(auditPut).toBeDefined();
      const event = auditPut![1] as { outcome: string; sessionId?: string; httpStatus?: number; reason?: string };
      expect(event.outcome).toBe('incomplete'); // 504 is res.ok===false -> not completed
      expect(event.sessionId).toBe('sess123'); // captured before the storage-clear nulls _sessionId
      expect(event.httpStatus).toBe(504);
      expect(event.reason).toBe('timeout');
    });

    // This is the AUTHORITATIVE ceiling path post budget-inversion fix: when the
    // sync runs past the DO's FINAL_SYNC_BUDGET_MS, the DO's AbortSignal.timeout
    // aborts the fetch (an 'AbortError' rejection) before the host's 125s 504 can
    // return - so the drain rejects, and that must audit as 'errored' (not a
    // swallowed completion) while destroy still proceeds. Also covers a transient
    // not-running reading where the port fetch simply fails.
    it('#516: persists outcome "errored" and still completes destroy when the drain fetch is aborted/rejected (DO AbortSignal ceiling)', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        if (key === 'containerAuthToken') return 'tok-final-sync';
        return null;
      });
      mockContainerRuntime.running = false;
      const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      mockTcpPortFetch.mockRejectedValue(abortErr);
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      await expect(instance.destroy()).resolves.toBeUndefined();
      const auditPut = mockStorage.put.mock.calls.find((c) => c[0] === 'finalSyncAudit');
      expect(auditPut).toBeDefined();
      expect((auditPut![1] as { outcome: string }).outcome).toBe('errored');
    });

    it('REQ-SESSION-006 AC2: rejects after logging when forced SDK destroy rejects', async () => {
      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const forcedError = new Error('provider force-destroy failed');
      const superDestroySpy = vi.spyOn(instance, 'superDestroy').mockRejectedValue(forcedError);
      const loggerWarn = (instance as any).logger.warn as ReturnType<typeof vi.fn>;

      await expect(instance.destroy()).rejects.toBe(forcedError);

      expect(superDestroySpy).toHaveBeenCalled();
      expect(loggerWarn).toHaveBeenCalledWith(
        'Forced destroy failed or exceeded teardown deadline',
        { sessionId: null, lifecycleGeneration: null, incidentId: null, reason: 'unknown', errorClass: 'native_destroy_failed' },
      );
    });

    it('REQ-SESSION-011 AC5: rejects at the entry-to-exit deadline and observes a later forced-destroy rejection', async () => {
      vi.useFakeTimers();
      try {
        mockContainerRuntime.running = true;
        const instance = new ContainerClass(mockCtx as any, mockEnv);
        const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);
        const loggerWarn = (instance as any).logger.warn as ReturnType<typeof vi.fn>;
        let rejectForcedDestroy!: (error: Error) => void;
        const forcedDestroy = new Promise<void>((_, reject) => {
          rejectForcedDestroy = reject;
        });
        const superDestroySpy = vi.spyOn(instance, 'superDestroy').mockReturnValue(forcedDestroy);

        const destroyPromise = instance.destroy();
        const deadlineRejection = expect(destroyPromise).rejects.toThrow('teardown deadline exceeded');
        await vi.advanceTimersByTimeAsync(136_000);
        await deadlineRejection;

        expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
        expect(mockContainerRuntime.running).toBe(true);
        expect(superDestroySpy).toHaveBeenCalled();
        expect(loggerWarn).toHaveBeenCalledWith(
          'Forced destroy failed or exceeded teardown deadline',
          { sessionId: null, lifecycleGeneration: null, incidentId: null, reason: 'unknown', errorClass: 'teardown_deadline_exceeded' },
        );

        rejectForcedDestroy(new Error('late provider rejection'));
        await vi.advanceTimersByTimeAsync(0);
        expect(loggerWarn).toHaveBeenCalledWith(
          'Forced destroy failed after teardown deadline',
          { sessionId: null, lifecycleGeneration: null, incidentId: null, reason: 'unknown', errorClass: 'native_destroy_failed' },
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('onStop logs shutdownElapsedMs reflecting real elapsed time between destroy and onStop', async () => {
      vi.useFakeTimers();
      try {
        mockStorage.get.mockImplementation(async (key: string) => {
          if (key === 'bucketName') return 'test-bucket';
          return null;
        });
        mockContainerRuntime.running = true;

        const instance = new ContainerClass(mockCtx as any, mockEnv);
        // Stop spy that takes "real" time to flip running flag. Drives
        // _shutdownStartedAt to actually accumulate elapsed time the
        // assertion below can pin a lower bound on.
        vi.spyOn(instance, 'stop' as any).mockImplementation(async () => {
          // simulate a slow shutdown (e.g. bisync still running)
          await new Promise((resolve) => setTimeout(resolve, 1500));
          mockContainerRuntime.running = false;
        });

        const loggerInfo = (instance as any).logger.info as ReturnType<typeof vi.fn>;
        loggerInfo.mockClear();

        const destroyPromise = instance.destroy();
        // Drive enough fake time for the 1500ms stop + polling pollMs to
        // finish; 2000 is comfortably above both.
        await vi.advanceTimersByTimeAsync(2000);
        await destroyPromise;

        // Drive additional time before onStop fires, so any regression
        // that computes elapsed-ms incorrectly (e.g. uses onStop's own
        // start rather than destroy's _shutdownStartedAt) shows up as a
        // smaller-than-expected number.
        await vi.advanceTimersByTimeAsync(3000);
        await instance.onStop();

        const stoppedCall = loggerInfo.mock.calls.find(
          (call) => call[0] === 'Container SDK stop observed (exit unverified)',
        );
        expect(stoppedCall).toBeDefined();
        const meta = stoppedCall![1] as { shutdownElapsedMs: number | null };
        expect(meta.shutdownElapsedMs).toBeTypeOf('number');
        // Lower bound: destroy ran ~2s, then 3s before onStop = 5s total.
        // Pin to 4500 to absorb timer fuzz but still fail if the
        // implementation reports onStop's own elapsed (3000) or zero.
        expect(meta.shutdownElapsedMs).toBeGreaterThanOrEqual(4500);
      } finally {
        vi.useRealTimers();
      }
    });

    it('graceful shutdown: still calls super.destroy() if stop() rejects', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });
      mockContainerRuntime.running = true;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockRejectedValue(new Error('signal delivery failed'));

      // The override must catch the throw; the route depends on destroy() always returning
      await expect(instance.destroy()).resolves.toBeUndefined();
      expect(stopSpy).toHaveBeenCalledWith('SIGTERM');
      // Storage cleanup still ran
      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });

    it('graceful shutdown: skips SIGTERM when ctx.container is already not running', async () => {
      mockStorage.get.mockImplementation(async (key: string) => {
        if (key === 'bucketName') return 'test-bucket';
        return null;
      });
      mockContainerRuntime.running = false;

      const instance = new ContainerClass(mockCtx as any, mockEnv);
      const stopSpy = vi.spyOn(instance, 'stop' as any).mockResolvedValue(undefined);

      await instance.destroy();

      // No need to send SIGTERM if the container is already gone
      expect(stopSpy).not.toHaveBeenCalled();
      expect(mockStorage.delete).toHaveBeenCalledWith('bucketName');
    });
  });
});
