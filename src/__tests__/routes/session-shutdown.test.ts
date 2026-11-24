import { env as poolEnv } from 'cloudflare:test';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { D1SessionRepository } from '../../lib/session-repository';
import { SETUP_KEYS, getRegimeStateKey } from '../../lib/kv-keys';
import { createTestApp } from '../helpers/test-app';
// @ts-expect-error Vite raw-loader module used by the Workers test runtime.
import migration from '../../../migrations/usage/0002_runtime_sessions.sql?raw';
// @ts-expect-error Vite raw-loader module used by the Workers test runtime.
import completion from '../../../migrations/usage/0003_complete_session_cutover.sql?raw';
// @ts-expect-error Vite raw-loader module used by the Workers test runtime.
import boundary from '../../../migrations/usage/0004_boundary_activity.sql?raw';

// Real routes, D1 and session/bucket coordinators. Replace only the platform
// namespace, Container SDK/native process and Host transport (no Miniflare proxy).
vi.mock('@cloudflare/containers', () => ({
  getContainer: (namespace: DurableObjectNamespace, name: string) => namespace.getByName(name),
  Container: class {
    constructor(public ctx: DurableObjectState, public env: Env) {}
    async startAndWaitForPorts() {
      const host = this as unknown as { envVars: Record<string, string>; onStart(): Promise<void> };
      const native = this.ctx.container as unknown as { start(options: { envVars: Record<string, string> }): Promise<void> } | undefined;
      await native?.start({ envVars: host.envVars });
      await host.onStart();
    }
    async destroy() { await this.ctx.container?.destroy(); }
    async stop(signal: string | number = 'SIGTERM') { this.ctx.container?.signal(signal === 'SIGTERM' ? 15 : Number(signal)); }
    async schedule(delay: number, callback: string) {
      return { taskId: crypto.randomUUID(), callback, type: 'delayed', time: Math.floor(Date.now() / 1000) + delay, delayInSeconds: delay };
    }
    deleteSchedules() {}
    renewActivityTimeout() {}
  },
}));

import { HERMES_MERGE_BUDGET_MS } from '../../container/hermes-shutdown';
import { container as SessionContainer } from '../../container/index';
import lifecycle from '../../routes/session/lifecycle';
import crud from '../../routes/session/crud';

// @ts-expect-error Vite raw-loader module used by the Workers test runtime.
import shutdown from '../../../migrations/usage/0005_session_shutdown.sql?raw';

const db = (poolEnv as unknown as Env).USAGE_DB;
const repository = new D1SessionRepository(db);
const snapshotId = 'a'.repeat(64);
const stamp = '2026-11-23T10:00:00.000Z';
const gates: Array<() => void> = [];

beforeAll(async () => {
  for (const source of [migration, completion, boundary, shutdown]) {
    for (const statement of source.split(';').map((part: string) => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
});
afterEach(() => { for (const release of gates.splice(0)) release(); });

function gate<T>(fallback: T) {
  let release!: (value: T) => void;
  const promise = new Promise<T>(resolve => { release = resolve; });
  gates.push(() => release(fallback));
  return { promise, release };
}

// The wait bound is test infrastructure, not a production queue ETA. Stop and
// Delete must acknowledge acceptance before the test releases the held Host.
async function bounded(request: Response | Promise<Response>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Shutdown request did not return while the Host was held')), 1_500);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function expectAccepted(request: Response | Promise<Response>) {
  expect((await bounded(request)).ok).toBe(true);
}

function rig(enterprise = true, workspaceSyncEnabled = true, preRolloutRetry = false, holdRetryDestroy = false, raceMonitor: false | 'audit first' | 'exit first' | 'stale audit' | 'stale successful audit' = false) {
  const owner = `shutdown-${crypto.randomUUID()}`;
  const other = `shutdown-${crypto.randomUUID()}`;
  const states = new Map<string, { ready: Promise<void>; instance: SessionContainer; restoreExit: (evidence: object, withoutRetryMarker: boolean, failCleanup: boolean | 'settlement') => void }>();
  const processes = new Map<string, ReturnType<typeof processFixture>>();
  const retained = new Map<string, Record<string, { generation: number }>>();
  const trace: string[] = [];
  const alarms = new Set<string>();
  let lastWriterWork: Promise<unknown> | undefined;
  let publishDelayedAudit: (() => void) | undefined;
  const cleanup = raceMonitor ? { reached: gate<void>(undefined), resume: gate<void>(undefined) } : undefined;

  function processFixture(label: string, initiallyRunning: boolean, hasSnapshot: boolean, directGeneration: boolean) {
    let running = initiallyRunning;
    // Model exit confirmation independently of the running hint. The fixture
    // uses awaited native destroy as its source of positive exit evidence.
    const monitorExit = raceMonitor ? gate<void>(undefined) : undefined;
    const monitor = monitorExit?.promise ?? new Promise<void>(() => {});
    const save = gate<'saved' | 'failed' | 'ambiguous' | 'timed-out' | 'pi-shutdown-unconfirmed' | 'pi-shutdown-timeout'
      | 'missing-reason' | 'not-started' | 'disk-refused' | 'disk-without-dispatch-proof' | { disabledGeneration: number }>('saved');
    let firstSave = true;
    let disabledAtStartup = false;
    const exit = gate<void | 'failed'>(undefined);
    const merge = gate<'skipped' | 'merged' | 'legacy-merged' | 'pending' | 'uncertain' | 'http-504' | 'host-lost'>('skipped');
    const retryResult = gate<'merged' | 'pending' | 'skipped'>('pending');
    const retryDestroy = holdRetryDestroy ? gate<void>(undefined) : undefined;
    let retrying = false;
    let mergeRequest: { intent: string; snapshotId: string; deadline: number; allowPersonalPiProviders: boolean } | undefined;
    let token = `fixture-token-${label}`;
    const native = {
      get running() { return running; },
      monitor: () => monitor,
      interceptOutboundHttps: () => {},
      start: async ({ envVars }: { envVars: Record<string, string> }) => {
        expect(envVars.CODEFLARE_HERMES_RETRY_SNAPSHOT).toBe(snapshotId);
        token = envVars.CONTAINER_AUTH_TOKEN;
        retrying = true;
        trace.push(`${label}:headless-start`);
        running = true;
      },
      signal: () => { trace.push(`${label}:sigterm`); running = false; },
      destroy: async () => {
        if (retrying && retryDestroy) {
          trace.push(`${label}:retry-destroy`);
          await retryDestroy.promise;
        }
        if (await exit.promise === 'failed') throw new Error('Native destroy acknowledgment unavailable');
        trace.push(`${label}:exit`);
        running = false;
      },
      getTcpPort: () => ({ fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === '/health') return Response.json({ healthy: true });
        if (request.headers.get('Authorization') !== `Bearer ${token}`) return Response.json({ error: 'Unauthenticated' }, { status: 401 });
        if (path === '/internal/agent-events/drain') {
          const input = await request.json() as { final?: unknown };
          if (input?.final === true) trace.push(`${label}:final-events`);
          return Response.json({ events: [] });
        }
        if (path === '/internal/final-sync') {
          trace.push(`${label}:save`);
          const result = firstSave ? await save.promise : 'saved';
          firstSave = false;
          if (typeof result === 'object') {
            disabledAtStartup = true;
            return Response.json({ synced: false, reason: 'hermes-disabled-at-startup', generation: result.disabledGeneration }, { status: 409 });
          }
          if (result === 'timed-out' || result === 'not-started') {
            trace.push(`${label}:save-failed`);
            return result === 'timed-out' ? Response.json({ synced: false, reason: 'timeout' }, { status: 504 })
              : Response.json({ synced: false, reason: 'hermes-save-not-started' }, { status: 503 });
          }
          if (result === 'disk-refused' || result === 'disk-without-dispatch-proof') {
            trace.push(`${label}:save-failed`);
            return Response.json({ synced: false, reason: 'disk-space-blocked',
              ...(result === 'disk-refused' ? { syncDispatched: false } : {}),
            }, { status: 409 });
          }
          if (result === 'pi-shutdown-unconfirmed' || result === 'pi-shutdown-timeout' || result === 'missing-reason') {
            trace.push(`${label}:save-failed`);
            return Response.json({ synced: false, ...(result !== 'missing-reason' && { reason: result }) }, { status: 503 });
          }
          if (disabledAtStartup || result === 'failed' || result === 'ambiguous') {
            if (disabledAtStartup) expect(request.headers.get('x-codeflare-hermes-merge')).toBeNull();
            trace.push(`${label}:save-failed`);
            return Response.json({ synced: false, reason: disabledAtStartup || result === 'failed' ? 'bisync-failed' : 'unexpected' }, { status: 500 });
          }
          trace.push(`${label}:saved`);
          expect(request.headers.get('x-codeflare-hermes-merge')).toBe(enterprise && directGeneration && !disabledAtStartup ? '1' : null);
          return Response.json({ synced: true, ...(hasSnapshot && { snapshotId }) });
        }
        if (path === '/internal/hermes-merge') {
          const body = mergeRequest = await request.json() as typeof mergeRequest & {};
          trace.push(`${label}:merge`);
          const status = await (retrying ? retryResult.promise : merge.promise);
          if (status === 'http-504') return new Response(null, { status: 504 });
          if (status === 'host-lost') throw new Error('Host disconnected during consolidation');
          const sessionId = label.split(':').at(-1)!;
          const legacy = status === 'legacy-merged';
          return Response.json({ status: legacy ? 'merged' : status, ...((legacy || status === 'merged') && { receipt: {
            ...(legacy && { revision: 'old-master-revision' }),
            source: { owner: label.startsWith('other:') ? other : owner, sessionId, generation: 1, intent: body.intent, snapshotId: body.snapshotId },
          } }) });
        }
        return Response.json({ error: `Unexpected fixture Host path ${path}` }, { status: 404 });
      } }),
    };
    return { native, monitorExit, directGeneration, get token() { return token; }, save, exit, merge, retryResult, retryDestroy, get mergeRequest() { return mergeRequest; } };
  }

  const idFromName = (name: string) => ({ toString: () => name, equals: (id: DurableObjectId) => id.toString() === name });
  function getByName(address: string) {
    if (!states.has(address)) {
      const process = processes.get(address);
      const first = address.lastIndexOf('-');
      const records = new Map<string, unknown>(process ? [
        ['bucketName', address.slice(0, first)], ['_sessionId', address.slice(first + 1)],
        ['lifecycleGeneration', 1], ['containerAuthToken', process.token], ['workspaceSyncEnabled', workspaceSyncEnabled],
        ['sessionMode', 'advanced'], ['hermes:direct-layout', true],
        ...(process.directGeneration ? [['hermes:direct-generation', 1] as const] : []),
        ...(process.directGeneration && !preRolloutRetry ? [['hermes:writer-generation', 1] as const] : []),
        ['userEmail', 'test@example.com'], ['userGroups', ['shutdown-fixture']],
        ...(raceMonitor === 'stale audit' || raceMonitor === 'stale successful audit' ? [['finalSyncAudit', {
          sessionId: address.slice(first + 1), lifecycleGeneration: 1, terminationIntentId: 'prior-stop',
          outcome: raceMonitor === 'stale successful audit' ? 'completed' : 'errored',
        }] as const] : []),
      ] : []);
      let failExitCleanup: boolean | 'settlement' = false;
      const retentionOwner = address.startsWith('bucket-owner:') ? address.slice('bucket-owner:'.length) : undefined;
      if (retentionOwner) records.set('bucketOwnerEmail', 'test@example.com');
      const storage = {
        get: async (key: string | string[]) => Array.isArray(key)
          ? new Map(key.filter(item => records.has(item)).map(item => [item, structuredClone(records.get(item))]))
          : structuredClone(retentionOwner && key === 'hermes:retention'
            ? { stores: retained.get(retentionOwner) ?? {} } : records.get(key)),
        put: async (key: string | Record<string, unknown>, value?: unknown) => {
          for (const [item, data] of Object.entries(typeof key === 'string' ? { [key]: value } : key)) {
            if (raceMonitor === 'stale successful audit' && item === 'finalSyncAudit') {
              publishDelayedAudit = () => records.set(item, structuredClone(data));
              throw new Error('Current teardown audit unavailable');
            }
            const retryLaunch = typeof key !== 'string' && Object.hasOwn(key, 'hermes:direct-generation');
            if (preRolloutRetry && item === 'hermes:retry-generation') {
              if (retryLaunch) continue;
              if (holdRetryDestroy) throw new Error('Retry provenance storage unavailable');
            }
            records.set(item, structuredClone(data));
          }
        },
        delete: async (key: string | string[]) => {
          if (cleanup && Array.isArray(key) && key.includes('review:boundary-input')) {
            cleanup.reached.release();
            await cleanup.resume.promise;
          }
          if (key === 'monitoredExitGeneration' && failExitCleanup === true) {
            failExitCleanup = false;
            throw new Error('Exit cleanup interrupted');
          }
          return Array.isArray(key) ? key.filter(item => records.delete(item)).length : records.delete(key);
        },
        list: async ({ prefix = '' } = {}) => new Map([...records].filter(([key]) => key.startsWith(prefix))),
        transaction: async <T>(work: (txn: unknown) => Promise<T>): Promise<T> => {
          const pending = new Map<string, unknown>();
          const removed = new Set<string>();
          const get = (key: string) => removed.has(key) ? undefined
            : structuredClone(pending.has(key) ? pending.get(key) : records.get(key));
          const result = await work({ ...storage,
            get: async (key: string | string[]) => Array.isArray(key)
              ? new Map(key.flatMap(name => {
                const value = get(name);
                return value === undefined ? [] : [[name, value] as const];
              })) : get(key),
            put: async (key: string | Record<string, unknown>, value?: unknown) => {
              for (const [name, data] of Object.entries(typeof key === 'string' ? { [key]: value } : key)) {
                if (name === 'hermes:settled-generation' && failExitCleanup === 'settlement') {
                  failExitCleanup = false;
                  throw new Error('Settlement interrupted');
                }
                removed.delete(name);
                pending.set(name, structuredClone(data));
              }
            },
            delete: async (key: string | string[]) => {
              const keys = typeof key === 'string' ? [key] : key;
              if (keys.includes('monitoredExitGeneration') && failExitCleanup === true) {
                failExitCleanup = false;
                throw new Error('Exit cleanup interrupted');
              }
              for (const name of keys) { pending.delete(name); removed.add(name); }
            },
          });
          for (const key of removed) records.delete(key);
          for (const [key, value] of pending) records.set(key, value);
          return result;
        },
        setAlarm: async () => { alarms.add(address); }, deleteAlarm: async () => { alarms.delete(address); },
      };
      let ready = Promise.resolve();
      const instance = new SessionContainer({ id: idFromName(address), container: process?.native, storage,
        // Native startup wires both mandatory Enterprise transports. This fixture
        // stops at the Host boundary; any use of those transports is unexpected.
        exports: Object.fromEntries(['OperatorOwnerInferenceAuthority', 'LlmInterceptor'].map(name =>
          [name, () => ({ fetch: () => { throw new Error(`Unexpected ${name} call`); } })])),
        blockConcurrencyWhile: (work: () => Promise<void>) => { ready = ready.then(work); return ready; },
        waitUntil: (work: Promise<unknown>) => {
          if (raceMonitor && process) lastWriterWork = work;
          void work.catch(() => {});
        },
      } as unknown as DurableObjectState<Env>, envOverrides as Env);
      states.set(address, { ready, instance, restoreExit: (evidence, withoutRetryMarker, failCleanup) => {
        failExitCleanup = failCleanup;
        if (withoutRetryMarker) records.delete('hermes:retry-generation');
        records.set('monitoredExitGeneration', evidence);
      } });
    }
    const { ready, instance } = states.get(address)!;
    return new Proxy(instance, { get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? async (...args: unknown[]) => { await ready; return value.apply(target, args); } : value;
    } });
  }
  const envOverrides: Partial<Env> = {
    USAGE_DB: db,
    R2_ACCOUNT_ID: 'fixture', R2_ENDPOINT: 'https://r2.shutdown.invalid',
    ...(enterprise && { ENTERPRISE_MODE: 'active' }),
    KV: (poolEnv as unknown as Env).KV,
    CONTAINER: { idFromName, getByName, get: (id: DurableObjectId) => getByName(id.toString()) } as unknown as Env['CONTAINER'],
  };
  const app = (bucketName = owner) => createTestApp({ bucketName, mockKV: envOverrides.KV,
    envOverrides, routes: [{ path: '/api/sessions', handler: lifecycle }, { path: '/api/sessions', handler: crud }] });
  const path = (id: string) => `/api/sessions/${id}`;
  async function create(id: string, { bucket = owner, running = true, holdMerge = false, hasSnapshot = true, directGeneration = true }: {
    bucket?: string; running?: boolean; holdMerge?: boolean; hasSnapshot?: boolean; directGeneration?: boolean;
  } = {}) {
    await envOverrides.KV!.put(getRegimeStateKey(bucket), JSON.stringify({ status: 'ready', regime: 'plain', generation: 1 }));
    await envOverrides.KV!.put('r2token:test@example.com', JSON.stringify({ bucketName: bucket, accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' }));
    await envOverrides.KV!.put(SETUP_KEYS.REASONING_CONFIGURATION, JSON.stringify({ schemaVersion: 1, customProfileRevisions: [], routeAssignments: {} }));
    await envOverrides.KV!.put(SETUP_KEYS.GROUP_ROUTING, JSON.stringify({ 'shutdown-fixture': {
      routes: [], defaultRoute: '', reasoning: 'off', allowPersonalPiProviders: true, piDefaultSource: 'pi-native',
    } }));
    await repository.create({ ownerKey: bucket, sessionId: id, name: id, agentType: 'bash',
      createdAt: stamp, lastAccessedAt: stamp, workspace: 'terminal', terminalMode: 'classic' });
    if (running) {
      await repository.start(bucket, id, stamp);
      await repository.project(bucket, id, 1, 0, { lifecycleState: 'running', observedAt: stamp });
    }
    const process = processFixture(bucket === owner ? id : `other:${id}`, running, hasSnapshot, directGeneration);
    if (!holdMerge) process.merge.release('skipped');
    processes.set(`${bucket}-${id}`, process);
    if (!retained.has(bucket)) retained.set(bucket, {});
    if (directGeneration) retained.get(bucket)![id] = { generation: 1 };
    return process;
  }
  async function batch(bucket = owner) {
    const response = await app(bucket).request('/api/sessions/batch-status');
    expect(response.status).toBe(200);
    const { statuses } = await response.json() as { statuses: Record<string, { status: string; shutdownPhase?: string; pendingDelete?: boolean; generation: number }> };
    return statuses;
  }
  const stop = (id: string, bucket = owner, signal?: AbortSignal) => app(bucket).request(`${path(id)}/stop`, { method: 'POST', signal });
  const remove = (id: string) => app().request(path(id), { method: 'DELETE' });
  const kill = (id: string) => app().request(`${path(id)}/kill`, { method: 'POST' });
  const retry = (id: string, bucket = owner) => app(bucket).request(`${path(id)}/retry-memory-consolidation`, { method: 'POST' });
  const session = (id: string) => getByName(`${owner}-${id}`);
  const replayExit = async (id: string, generation: number, terminationIntentId: string, withoutRetryMarker = false, failCleanup: boolean | 'settlement' = false) => {
    states.get(`${owner}-${id}`)!.restoreExit({ owner, session: id, generation, terminationIntentId }, withoutRetryMarker, failCleanup);
    await session(id).collectMetrics({ ownerKey: owner, sessionId: id, generation });
  };
  return { owner, other, app, path, create, batch, stop, remove, kill, retry, trace, replayExit, cleanup, latestWriterWork: () => lastWriterWork!,
    publishDelayedAudit: () => publishDelayedAudit!(), wake: () => getByName(`storage:${owner}`).wakeHermesShutdownQueue(owner), session,
    evictSnapshot: (id: string) => { delete retained.get(owner)![id]; } };
}

const a = 'sessionaaa1';
const b = 'sessionbbb1';
const c = 'sessionccc1';

it.each([true, false])('REQ-SESSION-043: accepts overlapping Stop/Delete in owner order across client reload without duplicating a generation or blocking another owner (workspace sync %s)', async workspaceSyncEnabled => {
  const f = rig(true, workspaceSyncEnabled);
  const [A, B, C, otherA] = await Promise.all([f.create(a), f.create(b), f.create(c), f.create(a, { bucket: f.other })]);
  const originalClient = new AbortController();
  await expectAccepted(f.stop(a, f.owner, originalClient.signal));
  originalClient.abort();
  await vi.waitFor(() => expect(f.trace).toEqual([`${a}:final-events`, `${a}:save`]));

  const waitingDelete = f.remove(b);
  const repeatedHead = f.stop(a);
  await expectAccepted(waitingDelete);
  await expectAccepted(repeatedHead);
  await expectAccepted(f.stop(c));
  await expectAccepted(f.remove(b));
  const reloaded = await f.batch();
  expect(reloaded[b]).toMatchObject({ shutdownPhase: 'queued', pendingDelete: true, generation: 1 });
  expect(reloaded[c]).toMatchObject({ shutdownPhase: 'queued', generation: 1 });
  const catalog = await f.app().request('/api/sessions');
  expect(await catalog.json()).toMatchObject({ sessions: expect.arrayContaining([
    expect.objectContaining({ id: b, shutdownPhase: 'queued', pendingDelete: true }),
    expect.objectContaining({ id: c, shutdownPhase: 'queued' }),
  ]) });
  expect(f.trace).toEqual([`${a}:final-events`, `${a}:save`]);

  otherA.save.release('saved'); otherA.exit.release();
  await expectAccepted(f.stop(a, f.other));
  await vi.waitFor(async () => expect((await f.batch(f.other))[a]?.status).toBe('stopped'));
  expect((await f.batch())[b]?.shutdownPhase).toBe('queued');

  A.save.release('saved'); A.exit.release();
  await vi.waitFor(() => expect(f.trace).toContain(`${b}:save`));
  B.save.release('saved'); B.exit.release();
  await vi.waitFor(() => expect(f.trace).toContain(`${c}:save`));
  C.save.release('saved'); C.exit.release();
  await vi.waitFor(async () => {
    const settled = await f.batch();
    expect(settled[a]?.status).toBe('stopped');
    expect(settled[b]).toBeUndefined();
    expect(settled[c]?.status).toBe('stopped');
  });
  // The Host final-save boundary and positive native exit are ordered effects,
  // including one save for a duplicated generation, not helper call counts.
  expect(f.trace.filter(event => !event.startsWith('other:') && /:(save|exit)$/.test(event))).toEqual([
    `${a}:save`, `${a}:exit`, `${b}:save`, `${b}:exit`, `${c}:save`, `${c}:exit`,
  ]);
});

it.each(['Stop', 'Delete'] as const)('REQ-SESSION-043: %s after definitive Hermes startup disable completes ordinary teardown and releases the queue', async action => {
  const f = rig(true, false);
  const [A, B] = await Promise.all([f.create(a), f.create(b)]);
  expect((await bounded(action === 'Delete' ? f.remove(a) : f.stop(a))).status).toBe(202);
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:save`));
  expect((await bounded(f.stop(b))).status).toBe(202);
  expect((await f.batch())[b]?.shutdownPhase).toBe('queued');

  // Startup resolves after the first action has already been accepted.
  A.save.release({ disabledGeneration: 1 });
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:sigterm`));
  expect((await f.app().request(f.path(a))).status).toBe(200);
  expect((await f.batch())[a]).toMatchObject({ status: 'stopping', shutdownPhase: 'finishing' });
  expect((await f.batch())[b]?.shutdownPhase).toBe('queued');
  A.exit.release();
  B.save.release('saved'); B.exit.release();
  await vi.waitFor(async () => {
    const settled = await f.batch();
    expect(settled[b]?.status).toBe('stopped');
    if (action === 'Delete') expect(settled[a]).toBeUndefined();
    else {
      expect(settled[a]?.status).toBe('stopped');
      expect(settled[a]?.shutdownPhase).toBeUndefined();
      expect((await repository.getSession(f.owner, a))?.mergedSnapshotId).toBeUndefined();
    }
  });
  expect(f.trace.filter(event => event.startsWith(`${a}:`))).toEqual([
    `${a}:final-events`, `${a}:save`, `${a}:save`, `${a}:save-failed`, `${a}:sigterm`, `${a}:exit`,
  ]);
});

it.each(['Stop', 'Delete'] as const)('REQ-SESSION-043: a running predecessor without a direct generation keeps ordinary %s', async action => {
  const f = rig(true, false);
  const A = await f.create(a, { directGeneration: false });
  A.save.release('saved');
  const response = action === 'Delete' ? f.remove(a) : f.stop(a);
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:sigterm`));
  expect((await f.app().request(f.path(a))).status).toBe(200);
  A.exit.release();
  expect((await bounded(response)).status).toBe(200);
  const settled = (await f.batch())[a];
  if (action === 'Delete') expect(settled).toBeUndefined();
  else expect(settled).toMatchObject({ status: 'stopped' });
  expect(f.trace).toEqual([`${a}:final-events`, `${a}:save`, `${a}:saved`, `${a}:sigterm`, `${a}:exit`]);
});

it('REQ-SESSION-043: an unbound Hermes startup result cannot bypass the save gate', async () => {
  const f = rig(true, false);
  const A = await f.create(a);
  A.exit.release();
  expect((await bounded(f.remove(a))).status).toBe(202);
  A.save.release({ disabledGeneration: 0 });
  await vi.waitFor(async () => {
    expect((await f.batch())[a]).toMatchObject({ status: 'stopping', pendingDelete: true });
    expect((await f.batch())[a]?.shutdownPhase).toBeUndefined();
  });
  expect(A.native.running).toBe(true);
  expect(f.trace).not.toContain(`${a}:exit`);
  expect((await f.app().request(f.path(a))).status).toBe(200);
  expect((await bounded(f.stop(a))).status).toBe(409);
  await bounded(f.kill(a));
  expect(f.trace.filter(event => event === `${a}:save`)).toEqual([`${a}:save`]);
});

it.each(['ambiguous', 'timed-out', 'pi-shutdown-unconfirmed', 'pi-shutdown-timeout', 'missing-reason', 'disk-without-dispatch-proof'] as const)('REQ-SESSION-043: unconfirmed final sync (%s) preserves Delete target and holds its successor until authority is revoked', async outcome => {
  const f = rig(true, false);
  const A = await f.create(a);
  const B = await f.create(b);
  A.exit.release();
  await expectAccepted(f.remove(a));
  await expectAccepted(f.stop(b));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:save`));
  A.save.release(outcome);
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:save-failed`));
  await vi.waitFor(async () => {
    const projected = await f.batch();
    expect(projected[a]).toMatchObject({ status: 'stopping', pendingDelete: true });
    expect(projected[a]?.shutdownPhase).toBeUndefined();
    expect(projected[b]?.shutdownPhase).toBe('queued');
  });
  expect((await f.stop(a)).status).toBe(409);
  expect(A.native.running).toBe(true);
  expect(f.trace).not.toContain(`${a}:sigterm`);
  expect(f.trace).not.toContain(`${a}:exit`);
  expect(f.trace).not.toContain(`${b}:save`);

  expect((await bounded(f.kill(a))).status).toBe(200);
  B.save.release('saved'); B.exit.release();
  await vi.waitFor(async () => {
    const settled = await f.batch();
    expect(settled[a]?.status).toBe('stopped');
    expect(settled[b]?.status).toBe('stopped');
  });
  expect(f.trace.filter(event => event.startsWith(`${a}:`))).toEqual([`${a}:final-events`, `${a}:save`, `${a}:save-failed`, `${a}:exit`]);
});

it.each(['failed', 'not-started', 'disk-refused'] as const)('REQ-SESSION-043: Retry Stop can recover after final save was %s', async outcome => {
  const f = rig();
  const A = await f.create(a);
  A.save.release(outcome);
  A.exit.release();
  await expectAccepted(f.stop(a));
  await vi.waitFor(async () => {
    expect(f.trace).toContain(`${a}:save-failed`);
    expect((await f.batch())[a]).toMatchObject({ status: 'stopping' });
    expect((await f.batch())[a].shutdownPhase).toBeUndefined();
  });
  await expectAccepted(f.stop(a));
  await vi.waitFor(async () => expect((await f.batch())[a]?.status).toBe('stopped'));
  expect(f.trace.filter(event => event === `${a}:save`)).toHaveLength(2);
});

it('REQ-MEM-044: a legacy Host receipt cannot authorize fixed-master success or Delete', async () => {
  const f = rig();
  const A = await f.create(a, { holdMerge: true });
  await expectAccepted(f.remove(a));
  A.save.release('saved');
  A.merge.release('legacy-merged');
  A.exit.release();
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({
    status: 'stopped', shutdownPhase: 'memory-not-merged', pendingDelete: true,
  }));
  expect((await f.app().request(f.path(a))).status).toBe(200);
});

it('REQ-SESSION-043: retains an accepted Delete through finishing and removes the row only after confirmed exit', async () => {
  const f = rig();
  const A = await f.create(a);
  await expectAccepted(f.remove(a));
  A.save.release('saved');
  await vi.waitFor(async () => {
    expect((await f.batch())[a]).toMatchObject({ status: 'stopping', shutdownPhase: 'finishing', pendingDelete: true });
  });
  expect(f.trace).toContain(`${a}:saved`);
  const retained = await f.app().request(f.path(a));
  expect(retained.status).toBe(200);
  expect((await f.batch())[a]?.status).not.toBe('stopped');
  A.exit.release();
  await vi.waitFor(async () => expect((await f.app().request(f.path(a))).status).toBe(404));
  expect(f.trace).toContain(`${a}:exit`);
});

it('REQ-SESSION-043: Kill removes queued Delete work immediately without a final save or implicit deletion', async () => {
  const f = rig();
  const [A, B, C] = await Promise.all([f.create(a), f.create(b), f.create(c)]);
  await expectAccepted(f.stop(a));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:save`));
  await expectAccepted(f.remove(b));
  await expectAccepted(f.stop(c));
  expect((await f.batch())[b]).toMatchObject({ shutdownPhase: 'queued', pendingDelete: true });
  B.exit.release();
  expect((await bounded(f.kill(b))).status).toBe(200);
  expect((await f.batch())[b]).toMatchObject({ status: 'stopped', generation: 1 });
  expect(f.trace).not.toContain(`${a}:saved`);
  A.save.release('saved'); A.exit.release();
  C.save.release('saved'); C.exit.release();
  await vi.waitFor(async () => expect((await f.batch())[c]?.status).toBe('stopped'));
  expect(f.trace.filter(event => event.startsWith(`${b}:`))).toEqual([`${b}:exit`]);
  expect((await f.app().request(f.path(b))).status).toBe(200);
});

it('REQ-MEM-044: Resume after an unconfirmed master transfer keeps the saved snapshot without a merge receipt', async () => {
  const f = rig();
  const A = await f.create(a, { holdMerge: true });
  A.save.release('saved');
  A.exit.release();
  await expectAccepted(f.stop(a));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:merge`));
  A.merge.release('uncertain');
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ status: 'stopped', shutdownPhase: 'memory-not-merged' }));
  const saved = await repository.getSession(f.owner, a);
  const resumed = await repository.start(f.owner, a, stamp, saved!.lifecycleGeneration, saved!.shutdown);
  expect(resumed).toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 2 });
  expect((await f.batch())[a]?.shutdownPhase).toBeUndefined();
  expect(resumed?.mergedSnapshotId).toBeUndefined();
  expect(await repository.shutdownHead(f.owner)).toBeNull();
});

it('REQ-MEM-044: a carried-forward legacy receipt cannot authorize reseeding', async () => {
  const f = rig();
  await f.create(a, { running: false });
  // The predecessor promoted a bare snapshot into this column and cleared shutdown_json.
  await db.prepare('UPDATE runtime_sessions SET hermes_merged_snapshot=?3 WHERE owner_key=?1 AND session_id=?2')
    .bind(f.owner, a, snapshotId).run();
  const started = await repository.start(f.owner, a, stamp);
  expect(started?.lifecycleState).toBe('starting');
  expect(started?.mergedSnapshotId).toBeUndefined();
});

it('REQ-MEM-044: a failed restore does not consume the saved merge receipt', async () => {
  const f = rig();
  const A = await f.create(a, { holdMerge: true });
  A.save.release('saved'); A.exit.release();
  await expectAccepted(f.stop(a));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:merge`));
  A.merge.release('merged');
  await vi.waitFor(async () => {
    expect((await f.batch())[a]?.status).toBe('stopped');
    expect((await f.batch())[a]?.shutdownPhase).toBeUndefined();
  });
  const saved = (await repository.getSession(f.owner, a))!;
  const first = await repository.start(f.owner, a, stamp, saved.lifecycleGeneration, saved.shutdown);
  expect(first?.mergedSnapshotId).toBe(snapshotId);
  await repository.project(f.owner, a, 2, 0, { lifecycleState: 'running', observedAt: stamp });
  const stopped = await repository.claimStop(f.owner, a, 'failed-restore-stop', stamp, 2);
  expect(stopped).not.toBeNull();
  await repository.confirmStopped(f.owner, a, 2, 'failed-restore-stop', stamp);
  const second = await repository.start(f.owner, a, stamp, 2);
  expect(second?.mergedSnapshotId).toBe(snapshotId);
  const observation = { lifecycleState: 'running' as const, observedAt: stamp, hermesRestoredSnapshot: snapshotId };
  expect(await repository.project(f.owner, a, 2, 1, observation)).toBe(false);
  expect((await repository.getSession(f.owner, a))?.mergedSnapshotId).toBe(snapshotId);
  expect(await repository.project(f.owner, a, 3, 0, {
    ...observation, cpu: '17%', hermesRestoredSnapshot: 'b'.repeat(64),
  })).toBe(true);
  const beforeReplay = await repository.getSession(f.owner, a);
  expect(beforeReplay).toMatchObject({ mergedSnapshotId: snapshotId, observationSequence: 0, cpu: '17%' });
  expect(await repository.project(f.owner, a, 3, 0, { ...observation, cpu: '99%' })).toBe(false);
  // An equal-sequence replay cannot change the metrics, revision, or receipt.
  expect(await repository.getSession(f.owner, a)).toEqual(beforeReplay);
  expect(await repository.project(f.owner, a, 3, 1, { ...observation, cpu: '21%' })).toBe(true);
  expect(await repository.getSession(f.owner, a)).toMatchObject({ observationSequence: 1, cpu: '21%' });
  expect((await repository.getSession(f.owner, a))?.mergedSnapshotId).toBeUndefined();
});

it('REQ-SESSION-043: rejects headless Retry for an active session or a different owner without starting work', async () => {
  const f = rig();
  await f.create(a);
  const own = await f.retry(a);
  expect(own.status).toBe(409);
  expect((await f.retry(a, f.other)).status).toBe(404);
  expect((await f.batch())[a]).toMatchObject({ status: 'running', generation: 1 });
  expect(f.trace).toEqual([]);
});

it.each([false, true])('REQ-SESSION-043: an evicted snapshot cannot start Retry (already queued %s)', async queued => {
  const f = rig();
  const A = await f.create(a, { holdMerge: true });
  A.save.release('saved'); A.exit.release(); A.merge.release('pending');
  await expectAccepted(f.remove(a));
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ status: 'stopped', shutdownPhase: 'memory-not-merged' }));
  if (queued) {
    const B = await f.create(b);
    await expectAccepted(f.stop(b));
    await vi.waitFor(() => expect(f.trace).toContain(`${b}:save`));
    await expectAccepted(f.retry(a));
    f.evictSnapshot(a);
    B.save.release('saved'); B.exit.release();
    await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ shutdownPhase: 'memory-not-merged' }));
  } else {
    f.evictSnapshot(a);
  }
  const response = await f.retry(a);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'Saved memory is no longer available for consolidation' });
  expect((await f.batch())[a]).toMatchObject({ status: 'stopped', generation: 1, pendingDelete: true });
  expect(f.trace).not.toContain(`${a}:headless-start`);
});

it('REQ-SESSION-043: Retry launches only the headless runtime with the same confirmed snapshot', async () => {
  const f = rig();
  const A = await f.create(a, { holdMerge: true });
  A.save.release('saved');
  A.exit.release();
  await expectAccepted(f.stop(a));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:merge`));
  const first = A.mergeRequest;
  A.merge.release('pending');
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ status: 'stopped', shutdownPhase: 'memory-not-merged' }));
  await expectAccepted(f.retry(a));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:headless-start`));
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ retryingMemory: true, shutdownPhase: 'consolidating' }));
  const terminal = await f.session(a).fetch(new Request('http://container/terminal', { headers: { upgrade: 'websocket' } }));
  expect(terminal.status).toBe(409);
  await vi.waitFor(() => expect(f.trace.filter(event => event === `${a}:merge`)).toHaveLength(2));
  expect(A.mergeRequest).toMatchObject({ intent: first?.intent, snapshotId });
  A.retryResult.release('merged');
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ status: 'stopped', generation: 2 }));
  expect((await f.batch())[a]?.shutdownPhase).toBeUndefined();
  expect(f.trace.filter(event => event === `${a}:save`)).toHaveLength(1);
});

it.each([false, true])('REQ-MEM-042 AC3: headless Retry preserves settlement of the saved writer after Delete (pre-rollout %s)', async preRolloutRetry => {
  const f = rig(true, true, preRolloutRetry);
  const A = await f.create(a, { holdMerge: true });
  const writer = { sessionId: a, generation: 1 };
  const session = f.session(a);
  A.save.release('saved');
  A.exit.release();
  A.merge.release('pending');
  await expectAccepted(f.stop(a));
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ status: 'stopped', shutdownPhase: 'memory-not-merged' }));
  expect(await session.hermesWriterSettled(f.owner, writer)).toBe(false);
  A.retryResult.release('merged');
  await expectAccepted(f.retry(a));
  await vi.waitFor(async () => {
    expect((await f.batch())[a]).toMatchObject({ status: 'stopped', generation: 2 });
    expect((await f.batch())[a]?.shutdownPhase).toBeUndefined();
  });
  expect((await f.remove(a)).status).toBe(200);
  expect((await f.app().request(f.path(a))).status).toBe(404);
  expect(await session.hermesWriterSettled(f.owner, writer)).toBe(true);
  expect(await session.hermesWriterSettled(f.owner, { ...writer, generation: 2 })).toBe(false);
});

it.each([false, true])('REQ-MEM-042 AC3: late exit replay after a skipped pre-rollout Retry preserves the saved writer (monitor first %s)', async monitorFirst => {
  const f = rig(true, true, true, monitorFirst);
  const A = await f.create(a, { holdMerge: true });
  A.save.release('saved');
  A.exit.release();
  A.merge.release('pending');
  await expectAccepted(f.stop(a));
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ status: 'stopped', shutdownPhase: 'memory-not-merged' }));
  const intent = (await repository.getSession(f.owner, a))!.shutdown!.intent;
  A.retryResult.release('skipped');
  await expectAccepted(f.retry(a));
  if (monitorFirst) {
    await vi.waitFor(() => expect(f.trace).toContain(`${a}:retry-destroy`));
    await f.replayExit(a, 2, intent);
    expect(await repository.getSession(f.owner, a)).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 2 });
    A.retryDestroy!.release();
  }
  await vi.waitFor(async () => {
    const row = await repository.getSession(f.owner, a);
    expect(row).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 2 });
    expect(row?.shutdown).toBeUndefined();
  });
  // Both the Retry job and the marker can be absent after an old-version teardown.
  await f.replayExit(a, 2, intent, true);
  expect((await f.remove(a)).status).toBe(200);
  const session = f.session(a);
  expect(await session.hermesWriterSettled(f.owner, { sessionId: a, generation: 1 })).toBe(true);
  expect(await session.hermesWriterSettled(f.owner, { sessionId: a, generation: 2 })).toBe(false);
});

it('REQ-MEM-042 AC3: replay settles the admitted writer after interrupted exit cleanup', async () => {
  const f = rig();
  const A = await f.create(a);
  A.save.release('saved');
  await expectAccepted(f.stop(a));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:sigterm`));
  const row = await repository.getSession(f.owner, a);
  expect(row?.terminationIntentId).toBeTruthy();
  await f.replayExit(a, 1, row!.terminationIntentId!, false, true);
  expect(await repository.getSession(f.owner, a)).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 1 });
  const session = f.session(a);
  await session.collectMetrics({ ownerKey: f.owner, sessionId: a, generation: 1 });
  // The monitor, not the outstanding destroy call, supplied exit evidence.
  A.exit.release('failed');
  await vi.waitFor(async () => {
    await f.wake();
    expect((await f.batch())[a]?.shutdownPhase).toBeUndefined();
  });
  expect((await f.remove(a)).status).toBe(200);
  expect(await session.hermesWriterSettled(f.owner, { sessionId: a, generation: 1 })).toBe(true);
});

it.each([true, false])('REQ-MEM-042 AC3: settlement rollback allows replay after queued Delete of a pre-rollout writer (matching intent %s)', async matchingIntent => {
  const f = rig(true, true, true);
  const A = await f.create(a);
  A.save.release('saved');
  await expectAccepted(f.remove(a));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:sigterm`));
  const row = await repository.getSession(f.owner, a);
  expect(row?.terminationIntentId).toBeTruthy();
  await f.replayExit(a, 1, row!.terminationIntentId!, false, 'settlement');
  expect(await repository.getSession(f.owner, a)).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 1 });
  A.exit.release('failed');
  await vi.waitFor(async () => {
    await f.wake();
    expect(await repository.getSession(f.owner, a)).toBeNull();
  });
  const session = f.session(a);
  const writer = { sessionId: a, generation: 1 };
  expect(await session.hermesWriterSettled(f.owner, writer)).toBe(false);
  if (matchingIntent) await session.collectMetrics({ ownerKey: f.owner, sessionId: a, generation: 1 });
  else await f.replayExit(a, 1, crypto.randomUUID());
  expect(await session.hermesWriterSettled(f.owner, writer)).toBe(matchingIntent);
});

it.each(['audit first', 'exit first', 'stale audit', 'stale successful audit'] as const)('REQ-MEM-042 AC3: a monitored writer exit settles across graceful teardown cleanup (%s)', async order => {
  const f = rig(true, true, false, false, order);
  const auditFirst = order === 'audit first';
  const failsAudit = order === 'stale successful audit';
  const A = await f.create(a);
  const confirmReached = gate<void>(undefined);
  const confirmResume = gate<void>(undefined);
  const confirmStopped = D1SessionRepository.prototype.confirmStopped;
  const spy = vi.spyOn(D1SessionRepository.prototype, 'confirmStopped').mockImplementation(async function (this: D1SessionRepository, ...args) {
    if (args[0] === f.owner && args[1] === a) {
      confirmReached.release();
      await confirmResume.promise;
    }
    return confirmStopped.apply(this, args);
  });
  try {
    A.save.release('saved');
    // Keep the stopped row when testing stale success so D1 exit alone could otherwise pass.
    await expectAccepted(failsAudit ? f.stop(a) : f.remove(a));
    await bounded(f.cleanup!.reached.promise.then(() => new Response()));
    A.monitorExit!.release();
    await bounded(confirmReached.promise.then(() => new Response()));
    if (auditFirst) {
      f.cleanup!.resume.release();
      await vi.waitFor(() => expect(f.trace).toContain(`${a}:sigterm`));
    }
    confirmResume.release();
    await f.latestWriterWork();
    expect((await f.batch())[a]?.status).toBe('stopped');
    if (!auditFirst) f.cleanup!.resume.release();
    A.exit.release('failed');
    await vi.waitFor(async () => {
      await f.wake();
      const row = await repository.getSession(f.owner, a);
      if (failsAudit) {
        expect(row).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 1 });
        expect(row?.shutdown).toBeUndefined();
      } else expect(row).toBeNull();
    });
    const writer = { sessionId: a, generation: 1 };
    const session = f.session(a);
    if (failsAudit) {
      expect(await session.hermesWriterSettled(f.owner, writer)).toBe(false);
      f.publishDelayedAudit();
    }
    expect(await session.hermesWriterSettled(f.owner, writer)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

it('REQ-SESSION-006: deleting an already stopped, settled row does not launch or stop a native process', async () => {
  const f = rig(false);
  await f.create(a, { running: false });
  expect((await f.remove(a)).status).toBe(200);
  expect((await f.app().request(f.path(a))).status).toBe(404);
  expect(f.trace).toEqual([]);
});


it('REQ-SESSION-043: fences terminal and browser ingress before merge but preserves existing native authority until formal teardown', async () => {
  const f = rig();
  const A = await f.create(a, { holdMerge: true });
  await expectAccepted(f.stop(a));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:save`));
  const terminal = () => f.session(a).fetch(new Request('http://container/terminal', { headers: { upgrade: 'websocket' } }));
  expect((await terminal()).status).toBe(409);
  const nativeAuthority = () => f.session(a).getPersonalPiSession({ bucket: f.owner, sessionId: a, email: 'test@example.com' }, true);
  await expect(nativeAuthority()).resolves.toMatchObject({ generation: 1 });
  const privatePost = (path: string, headers?: HeadersInit) => f.session(a).forwardExisting(new Request(`http://container${path}`, { method: 'POST', headers }));
  expect((await privatePost('/internal/hermes-merge')).status).toBe(404);
  expect((await privatePost('/internal/final-sync', { 'x-codeflare-hermes-merge': '1' })).status).toBe(404);
  A.save.release('saved');
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ status: 'stopping', shutdownPhase: 'consolidating' }));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:merge`));
  expect(A.mergeRequest).toMatchObject({ snapshotId, allowPersonalPiProviders: true });
  expect(A.mergeRequest!.deadline).toBeGreaterThan(Date.now());
  await expect(nativeAuthority()).resolves.toMatchObject({ generation: 1 });
  expect(f.trace).not.toContain(`${a}:sigterm`);
  A.merge.release('merged');
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ shutdownPhase: 'finishing' }));
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:sigterm`));
  await expect(nativeAuthority()).rejects.toThrow();
  A.exit.release();
  await vi.waitFor(async () => expect((await f.batch())[a]?.status).toBe('stopped'));
  // REQ-SESSION-032 AC1: one final notification attempt precedes sync; teardown reuses it.
  expect(f.trace.filter(event => [`${a}:final-events`, `${a}:save`].includes(event))).toEqual([`${a}:final-events`, `${a}:save`]);
});

it('REQ-SESSION-043: retains a saved failed Delete after exit and advances the queue without deleting it', async () => {
  const f = rig();
  const [A, B] = await Promise.all([f.create(a, { holdMerge: true }), f.create(b)]);
  await expectAccepted(f.remove(a));
  await expectAccepted(f.stop(b));
  A.save.release('saved'); A.merge.release('pending');
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ status: 'stopping', pendingDelete: true }));
  expect(f.trace).not.toContain(`${b}:save`);
  A.exit.release(); B.save.release('saved'); B.exit.release();
  await vi.waitFor(async () => {
    const settled = await f.batch();
    expect(settled[a]).toMatchObject({ status: 'stopped', shutdownPhase: 'memory-not-merged', pendingDelete: true });
    expect(settled[b]?.status).toBe('stopped');
  });
  expect(await f.session(a).hermesWriterSettled(f.owner, { sessionId: a, generation: 1 })).toBe(false);
  expect((await f.remove(a)).status).toBe(409);
  expect((await f.app().request(f.path(a))).status).toBe(200);
});

it('REQ-SESSION-043: Kill during inference retains the session, rejects a late receipt and allows the next writer only after exit', async () => {
  const f = rig();
  const [A, B] = await Promise.all([f.create(a, { holdMerge: true }), f.create(b)]);
  await expectAccepted(f.remove(a));
  await expectAccepted(f.stop(b));
  A.save.release('saved');
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:merge`));
  const killed = f.kill(a);
  expect((await f.batch())[b]?.shutdownPhase).toBe('queued');
  expect(f.trace).not.toContain(`${b}:save`);
  A.exit.release();
  expect((await bounded(killed)).status).toBe(200);
  A.merge.release('merged');
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({
    status: 'stopped', shutdownPhase: 'memory-not-merged', pendingDelete: false,
  }));
  expect((await f.app().request(f.path(a))).status).toBe(200);
  const stopped = await repository.getSession(f.owner, a);
  expect(stopped?.shutdown?.snapshotId).toBe(snapshotId);
  expect(stopped?.mergedSnapshotId).toBeUndefined();
  B.save.release('saved'); B.exit.release();
  await vi.waitFor(async () => expect((await f.batch())[b]?.status).toBe('stopped'));
  expect(f.trace.indexOf(`${a}:exit`)).toBeLessThan(f.trace.indexOf(`${b}:save`));
});


it('REQ-SESSION-043: stops a confirmed save without a trustworthy baseline but never infers a merge or deletes it', async () => {
  const f = rig();
  const A = await f.create(a, { hasSnapshot: false });
  await expectAccepted(f.remove(a));
  A.save.release('saved'); A.exit.release();
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({
    status: 'stopped', shutdownPhase: 'memory-not-merged', pendingDelete: true,
  }));
  expect(f.trace).not.toContain(`${a}:merge`);
  expect((await f.app().request(f.path(a))).status).toBe(200);
});

it.each(['uncertain', 'http-504', 'host-lost'] as const)('REQ-SESSION-043: unconfirmed master transfer (%s) retains Delete and releases the queue only after exit', async outcome => {
  const f = rig();
  const [A, B] = await Promise.all([f.create(a, { holdMerge: true }), f.create(b)]);
  await expectAccepted(f.remove(a));
  await expectAccepted(f.stop(b));
  A.save.release('saved');
  await vi.waitFor(() => expect(f.trace).toContain(`${a}:merge`));
  A.merge.release(outcome);
  expect((await f.batch())[b]?.shutdownPhase).toBe('queued');
  expect(f.trace).not.toContain(`${b}:save`);
  A.exit.release(); B.save.release('saved'); B.exit.release();
  await vi.waitFor(async () => {
    const settled = await f.batch();
    expect(settled[a]).toMatchObject({ status: 'stopped', shutdownPhase: 'memory-not-merged', pendingDelete: true });
    expect(settled[b]?.status).toBe('stopped');
  });
  expect(f.trace.indexOf(`${a}:exit`)).toBeLessThan(f.trace.indexOf(`${b}:save`));
  expect(f.trace.filter(event => event === `${a}:merge`)).toEqual([`${a}:merge`]);
  const stopped = await repository.getSession(f.owner, a);
  expect(stopped?.shutdown?.snapshotId).toBe(snapshotId);
  expect(stopped?.mergedSnapshotId).toBeUndefined();
});

it('REQ-SESSION-043: Kill during pending teardown preserves the saved merge retry', async () => {
  const f = rig();
  const A = await f.create(a);
  const intent = 'pending-merge';
  expect(await repository.updateShutdown((await repository.getSession(f.owner, a))!, { intent, phase: 'queued', delete: true })).toBe(true);
  const row = (await repository.getSession(f.owner, a))!;
  expect(await repository.updateShutdown(row, { intent, phase: 'finishing-pending', delete: true, snapshotId })).toBe(true);
  A.exit.release();
  expect((await f.kill(a)).status).toBe(200);
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({
    status: 'stopped', shutdownPhase: 'memory-not-merged', pendingDelete: false,
  }));
  expect((await repository.getSession(f.owner, a))?.shutdown?.snapshotId).toBe(snapshotId);
  await expectAccepted(f.retry(a));
});

it('REQ-SESSION-043: Kill after a verified no-op does not offer a merge retry', async () => {
  const f = rig();
  const A = await f.create(a);
  const intent = 'skipped-merge';
  expect(await repository.updateShutdown((await repository.getSession(f.owner, a))!, { intent, phase: 'queued', delete: true })).toBe(true);
  const row = (await repository.getSession(f.owner, a))!;
  expect(await repository.updateShutdown(row, { intent, phase: 'finishing', delete: true, snapshotId })).toBe(true);
  A.exit.release();
  expect((await f.kill(a)).status).toBe(200);
  await vi.waitFor(async () => {
    const stopped = (await f.batch())[a];
    expect(stopped?.status).toBe('stopped');
    expect(stopped?.shutdownPhase).toBeUndefined();
  });
  expect((await f.app().request(f.path(a))).status).toBe(200);
  expect((await f.retry(a)).status).toBe(409);
});

it.each(['finishing', 'merged'] as const)('REQ-MEM-044: persisted legacy result (%s) cannot authorize Delete or reseed', async phase => {
  const f = rig();
  await f.create(a);
  const intent = 'old-merge';
  expect(await repository.updateShutdown((await repository.getSession(f.owner, a))!, { intent, phase: 'queued', delete: true })).toBe(true);
  const row = (await repository.getSession(f.owner, a))!;
  expect(await repository.updateShutdown(row, { intent, phase, delete: true, snapshotId, revision: 'old-masters', teardownClaimed: true })).toBe(true);
  expect(await repository.claimStop(f.owner, a, intent, stamp, row.lifecycleGeneration)).not.toBeNull();
  expect(await repository.confirmStopped(f.owner, a, row.lifecycleGeneration, intent, stamp)).toBe(true);
  if (phase === 'finishing') await f.wake();
  await vi.waitFor(async () => expect((await f.batch())[a]).toMatchObject({ status: 'stopped', shutdownPhase: 'memory-not-merged' }));
  expect((await f.remove(a)).status).toBe(409);
  const stopped = (await repository.getSession(f.owner, a))!;
  const started = await repository.start(f.owner, a, stamp, stopped.lifecycleGeneration, stopped.shutdown);
  expect(started?.lifecycleState).toBe('starting');
  expect(started?.mergedSnapshotId).toBeUndefined();
});

it('REQ-SESSION-043: a Host that never responds reaches the merge observation deadline', async () => {
  const f = rig();
  const [A, B] = await Promise.all([f.create(a, { holdMerge: true }), f.create(b)]);
  const clock = new AbortController();
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeouts = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms =>
    ms > HERMES_MERGE_BUDGET_MS ? clock.signal : nativeTimeout(ms));
  try {
    await expectAccepted(f.remove(a));
    await expectAccepted(f.stop(b));
    A.save.release('saved');
    await vi.waitFor(() => expect(f.trace).toContain(`${a}:merge`));
    clock.abort(new DOMException('Merge deadline expired', 'TimeoutError'));
    await vi.waitFor(async () => expect((await f.batch())[a]?.shutdownPhase).toBe('finishing'));
    expect((await f.batch())[b]?.shutdownPhase).toBe('queued');
    A.exit.release(); B.save.release('saved'); B.exit.release();
    await vi.waitFor(async () => {
      const settled = await f.batch();
      expect(settled[a]).toMatchObject({ status: 'stopped', shutdownPhase: 'memory-not-merged', pendingDelete: true });
      expect(settled[b]?.status).toBe('stopped');
    });
    expect(f.trace.indexOf(`${a}:exit`)).toBeLessThan(f.trace.indexOf(`${b}:save`));
    expect((await repository.getSession(f.owner, a))?.shutdown?.snapshotId).toBe(snapshotId);
  } finally { timeouts.mockRestore(); }
});

it('REQ-SESSION-011: non-Enterprise Stop retains the ordinary final-sync and exit lane', async () => {
  const f = rig(false);
  const A = await f.create(a);
  A.save.release('saved'); A.exit.release();
  const result = await f.stop(a);
  expect(result.status).toBe(200);
  expect((await f.batch())[a]).toMatchObject({ status: 'stopped' });
  expect(f.trace).toEqual([`${a}:final-events`, `${a}:save`, `${a}:saved`, `${a}:sigterm`, `${a}:exit`]);
});
