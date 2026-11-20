import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { SETUP_KEYS } from '../../lib/kv-keys';
import { CONTAINER_POLL_BUDGET_MS } from '../../container/container-metrics';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { D1SessionRepository } from '../../lib/session-repository';

const nativeDestroyByContext = vi.hoisted(() => new WeakMap<object, () => Promise<void>>());
const nativeStartByContext = vi.hoisted(() => new WeakMap<object, (env?: Record<string, string>) => Promise<void>>());
const schedulesByContext = vi.hoisted(() => new WeakMap<object, Map<string, unknown>>());
const scheduleFailureByContext = vi.hoisted(() => new WeakMap<object, () => boolean>());
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(public ctx: object, public env: unknown) {}
    deleteSchedules(method: string) { schedulesByContext.get(this.ctx)?.delete(method); }
    async schedule(_delay: number, method: string, payload: unknown) {
      if (scheduleFailureByContext.get(this.ctx)?.()) throw Error('exit reconciliation alarm unavailable');
      schedulesByContext.get(this.ctx)?.set(method, payload);
    }
    async startAndWaitForPorts() {
      await nativeStartByContext.get(this.ctx)?.((this as { envVars?: Record<string, string> }).envVars);
      await (this as unknown as { onStart(): Promise<void> }).onStart();
    }
    async stop() {
      (this.ctx as { container?: { signal(): void } }).container?.signal();
    }
    async destroy() {
      const destroy = nativeDestroyByContext.get(this.ctx);
      if (!destroy) throw Error('Missing simulated native destruction');
      await destroy();
    }
  },
}));

import { container as SessionContainer } from '../../container/index';

type StopRef = { bucket: string; sessionId: string; generation: number };
const ref: StopRef = { bucket: 'owner-bucket', sessionId: 'session12345678', generation: 7 };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Model the platform lifetime boundary: pending I/O is canceled on disconnect
// unless an unsettled waitUntil task still owns execution. Assert D1/runtime
// outcomes, not implementation calls or promise-registration counts.
async function fixture(initial: 'stopped' | 'starting' | 'running' | 'stopping' | 'unreachable' = 'running', generation = ref.generation) {
  const kv = createMockKV();
  const key = `session:${ref.bucket}:${ref.sessionId}`;
  kv._set(key, { id: ref.sessionId, userId: ref.bucket, name: 'Retained workspace',
    status: initial, lifecycleGeneration: generation, responseRevision: 4,
    ...(initial === 'stopping' ? { terminationIntentId: 'retained-intent', terminationGeneration: ref.generation } : {}) });
  const db = createMockSessionD1(kv);
  let confirmationUnavailable = false;
  let databaseUnavailable = false;
  const checkpoints = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  const pendingIO = new Set<ReturnType<typeof deferred>>();
  const pause = async (stage: string) => {
    const checkpoint = checkpoints.get(stage);
    if (!checkpoint) return;
    checkpoint.entered.resolve();
    pendingIO.add(checkpoint.release);
    try { await checkpoint.release.promise; }
    finally { pendingIO.delete(checkpoint.release); }
  };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (databaseUnavailable) throw Error('D1 unavailable');
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values);
      const run = bound.run.bind(bound);
      bound.run = (async () => {
        if (/SET\s+lifecycle_state='stopping'/.test(sql)) await pause('claim');
        if (/SET\s+lifecycle_state='stopped'/.test(sql)) await pause('confirmation');
        if (confirmationUnavailable && /SET\s+lifecycle_state='stopped'/.test(sql)) throw Error('D1 unavailable');
        return run();
      }) as typeof bound.run;
      return bound;
    };
    return statement;
  };
  const env = { USAGE_DB: db, KV: kv, R2_ACCOUNT_ID: 'test-account', R2_ENDPOINT: 'https://r2.test',
    CONTAINER: { idFromName: (name: string) => ({ toString: () => name }) } } as unknown as Env;
  const repository = new D1SessionRepository(db);
  let running = initial !== 'starting' && initial !== 'stopped';
  let startGate: ReturnType<typeof deferred> | undefined;
  const startEntered = deferred();
  let launched = false;
  let launchSyncMode: string | undefined;
  let draining = false;
  let teardownGate: ReturnType<typeof deferred> | undefined;
  let teardownEntered = deferred();
  const protectedWork = new Set<Promise<unknown>>();
  const workFailures: unknown[] = [];
  const storage = new Map<string, unknown>([['lifecycleGeneration', generation]]);
  const schedules = new Map<string, unknown>();
  const configureStart = (bucket = ref.bucket) => {
    storage.set('bucketName', bucket);
    storage.set('_sessionId', ref.sessionId);
  };
  let scheduleUnavailable = false;
  let nativeForbidden = false;
  async function coordinator() {
    // Lifecycle proof survives reconstruction; operational identity remains absent.
    let ready: Promise<unknown> = Promise.resolve();
    const ctx = {
      id: { toString: () => `${ref.bucket}-${ref.sessionId}` },
      container: initial === 'starting' || initial === 'stopped' ? {
        get running() { return running; },
        signal() { running = false; },
        getTcpPort: () => ({ fetch: async () => new Response('', { status: 503 }) }),
        monitor: () => new Promise<void>(() => {}),
      } : undefined,
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
      waitUntil: (task: Promise<unknown>) => {
        protectedWork.add(task);
        void task.finally(() => protectedWork.delete(task)).catch(error => { workFailures.push(error); });
      },
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => {
          if (key === 'finalSyncAudit') await pause('audit');
          if (key === 'sleepAfter') await pause('configuration');
          storage.set(key, value);
        },
        delete: async (key: string | string[]) => typeof key === 'string'
          ? storage.delete(key)
          : key.reduce((count, name) => count + Number(storage.delete(name)), 0),
      },
    };
    Object.assign(ctx.storage, { transaction: async (work: (txn: typeof ctx.storage) => Promise<unknown>) => work(ctx.storage) });
    schedulesByContext.set(ctx, schedules);
    scheduleFailureByContext.set(ctx, () => scheduleUnavailable);
    nativeStartByContext.set(ctx, async env => {
      launchSyncMode = env?.SYNC_MODE;
      startEntered.resolve();
      // The SDK can already be committed to a native call when Stop arrives.
      // Model the callback arriving late even after cancellation was requested.
      await startGate?.promise;
      launched = true;
      running = true;
    });
    nativeDestroyByContext.set(ctx, async () => {
      if (nativeForbidden) throw Error('native destruction must not be repeated');
      if (draining) throw Error('duplicate concurrent teardown');
      draining = true;
      teardownEntered.resolve();
      try {
        await teardownGate?.promise;
        running = false; // positive destruction confirmation, including idempotent repeat
      } finally { draining = false; }
    });
    const instance = new SessionContainer(ctx as unknown as DurableObjectState<Env>, env);
    await ready;
    return instance;
  }
  return { env, kv, key, repository, coordinator, workFailures, configureStart, enteredStart: () => startEntered.promise,
    launched: () => launched, launchSyncMode: () => launchSyncMode,
    holdStart: () => { startGate = deferred(); return startGate; },
    forbidNative: () => { nativeForbidden = true; },
    failSchedule: (fail: boolean) => { scheduleUnavailable = fail; },
    reconcile: async (instance: Awaited<ReturnType<typeof coordinator>>) => {
      const payload = schedules.get('collectMetrics');
      if (!payload) throw Error('no exit reconciliation scheduled');
      schedules.delete('collectMetrics');
      await instance.collectMetrics(payload as Parameters<typeof instance.collectMetrics>[0]);
    },
    settleWork: async () => { while (protectedWork.size) await Promise.allSettled(protectedWork); },
    read: () => repository.getSession(ref.bucket, ref.sessionId),
    running: () => running,
    holdTeardown: () => { teardownGate = deferred(); teardownEntered = deferred(); return teardownGate; },
    enteredTeardown: () => teardownEntered.promise,
    holdIO: (stage: string) => {
      const checkpoint = { entered: deferred(), release: deferred() };
      checkpoints.set(stage, checkpoint);
      return { entered: checkpoint.entered.promise, resolve: checkpoint.release.resolve };
    },
    pause,
    disconnect: () => {
      if (protectedWork.size) return;
      startGate?.reject(Error('caller disconnected'));
      teardownGate?.reject(Error('caller disconnected'));
      for (const io of pendingIO) io.reject(Error('caller disconnected'));
    },
    failConfirmation: (fail: boolean) => { confirmationUnavailable = fail; },
    failDatabase: (fail: boolean) => { databaseUnavailable = fail; },
  };
}

function configureLaunch(instance: SessionContainer, generation: number, workspaceSyncEnabled = false) {
  return instance.fetch(new Request('http://container/_internal/setBucketName', {
    method: 'POST', headers: { 'X-Codeflare-Start-Generation': String(generation) },
    body: JSON.stringify({ bucketName: ref.bucket, sessionId: ref.sessionId, sleepAfter: '1h', workspaceSyncEnabled }),
  }));
}

describe('REQ-SESSION-018 AC4: pending Start cannot outlive its Stop', () => {
  it.each(['stopSession', 'killSession'] as const)('cancels a Start delayed in preparation before %s finishes', async terminate => {
    const f = await fixture('stopped', 6);
    f.configureStart();
    const instance = await f.coordinator();
    const preparation = f.holdIO('preparation');
    const get = f.kv.get.getMockImplementation()!;
    f.kv.get.mockImplementation(async (key, type) => {
      if (key === SETUP_KEYS.MCP_PORTALS) await f.pause('preparation');
      return get(key, type);
    });
    expect((await configureLaunch(instance, 6)).headers.get('X-Codeflare-Start-Claim')).toBe('7');
    const launch = instance.startSession(ref).catch(error => error);
    try {
      await preparation.entered;
      const stop = instance[terminate](ref);
      await vi.waitFor(async () => expect(await f.read()).toMatchObject({ lifecycleState: 'stopping' }));
      preparation.resolve();
      expect(await launch).toBeInstanceOf(Error);
      await stop;
      expect(f.launched()).toBe(false);
      expect(f.running()).toBe(false);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
    } finally { preparation.resolve(); }
  });

  it('keeps ownership when the pending startup has not settled by the shutdown check', async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture('stopped', 6);
      f.configureStart();
      const instance = await f.coordinator();
      const gate = f.holdStart();
      expect((await configureLaunch(instance, 6)).headers.get('X-Codeflare-Start-Claim')).toBe('7');
      const launch = instance.startSession(ref).catch(error => error);
      try {
        await f.enteredStart();
        const stop = instance.stopSession(ref).catch(error => error);
        await vi.advanceTimersByTimeAsync(CONTAINER_POLL_BUDGET_MS);
        expect(await stop).toBeInstanceOf(Error);
        expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7 });
        expect(await f.repository.start(ref.bucket, ref.sessionId, new Date().toISOString())).toBeNull();
        gate.resolve();
        expect(await launch).toBeInstanceOf(Error);
        await instance.stopSession(ref);
        expect(f.running()).toBe(false);
        expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
      } finally { gate.resolve(); }
    } finally { vi.useRealTimers(); }
  });

  it.each(['stopSession', 'killSession'] as const)('quiesces a late native launch before %s can release ownership', async terminate => {
    const f = await fixture('stopped', 6);
    f.configureStart();
    const instance = await f.coordinator();
    const launch = f.holdStart();
    expect((await configureLaunch(instance, 6)).headers.get('X-Codeflare-Start-Claim')).toBe('7');
    const start = instance.startSession(ref).catch(error => error);
    await f.enteredStart();
    const stop = instance[terminate](ref);
    await vi.waitFor(async () => expect(await f.read()).toMatchObject({ lifecycleState: 'stopping' }));
    expect(await f.repository.start(ref.bucket, ref.sessionId, new Date().toISOString())).toBeNull();
    launch.resolve();
    expect(await start).toBeInstanceOf(Error);
    await stop;
    expect(f.running()).toBe(false);
    await expect(instance.startSession(ref)).rejects.toThrow();
    expect(f.running()).toBe(false);
    expect((await configureLaunch(instance, 7)).headers.get('X-Codeflare-Start-Claim')).toBe('8');
    await instance.startSession({ ...ref, generation: 8 });
    expect(f.running()).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 8 });
  });
});

describe('REQ-SESSION-008: startup configuration uses the admitted run and bucket', () => {
  it('only the winning configuration can claim and launch the stopped session', async () => {
    const f = await fixture('stopped');
    f.configureStart();
    const instance = await f.coordinator();
    const gate = f.holdIO('configuration');
    const native = f.holdStart();
    const configure = (workspaceSyncEnabled: boolean) => configureLaunch(instance, 7, workspaceSyncEnabled);
    const winner = configure(true);
    try {
      await gate.entered;
      expect((await configure(false)).status).toBe(412);
      gate.resolve();
      expect((await winner).headers.get('X-Codeflare-Start-Claim')).toBe('8');
      expect((await configure(false)).status).toBe(412);
      await f.enteredStart();
      f.disconnect();
      native.resolve();
      await f.settleWork();
      expect(f.launchSyncMode()).toBe('full');
      expect(await f.read()).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 8 });
    } finally { gate.resolve(); native.resolve(); }
  });

  it('an unfenced HTTP request cannot change a running replacement', async () => {
    const f = await fixture('running', 8);
    f.configureStart();
    const instance = await f.coordinator();
    const response = await instance.fetch(new Request('http://container/_internal/setBucketName', {
      method: 'POST', body: JSON.stringify({ bucketName: ref.bucket, sessionId: ref.sessionId, workspaceSyncEnabled: true }),
    }));
    expect(response.status).toBe(412);
    expect(instance.envVars?.SYNC_MODE).toBe('none');
    expect(f.running()).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 8 });
  });

  it('an unpinned callback cannot adopt a fresh claim', async () => {
    const f = await fixture('starting');
    f.configureStart();
    const instance = await f.coordinator();
    await expect(instance.onStart()).rejects.toThrow('D1 start claim required');
    expect(await f.read()).toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 7 });
  });

  it.each(['stale generation', 'different bucket'] as const)('rejects %s without changing the configured identity', async conflict => {
    const f = await fixture('stopped');
    const storedBucket = conflict === 'different bucket' ? 'earlier-bucket' : ref.bucket;
    f.configureStart(storedBucket);
    const instance = await f.coordinator();
    const response = await instance.fetch(new Request('http://container/_internal/setBucketName', {
      method: 'POST', headers: { 'X-Codeflare-Start-Generation': conflict === 'stale generation' ? '6' : '7' },
      body: JSON.stringify({ bucketName: ref.bucket, sessionId: ref.sessionId, sleepAfter: '1h' }),
    }));
    expect(response.status).toBe(412);
    const configured = await instance.fetch(new Request('http://container/_internal/getBucketName'));
    expect(await configured.json()).toMatchObject({ bucketName: storedBucket });
    expect(f.running()).toBe(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
  });
});

describe('REQ-SESSION-035: caller-independent Stop and manual recovery', () => {
  it('finishes the claimed Stop after caller loss and erased operational identity, preserving the session for restart', async () => {
    const f = await fixture();
    const instance = await f.coordinator();
    const gate = f.holdTeardown();
    const stop = instance.stopSession(ref);
    await vi.waitFor(async () => expect((await f.read())?.lifecycleState).toBe('stopping'));
    f.disconnect();
    gate.resolve();
    await stop;
    expect(f.running()).toBe(false);
    expect(await f.read()).toMatchObject({ name: 'Retained workspace', lifecycleState: 'stopped', lifecycleGeneration: 7 });
    expect(await f.repository.start(ref.bucket, ref.sessionId, new Date().toISOString())).toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 8 });
  });

  it.each(['stopping', 'unreachable'] as const)('reconstructs and finishes an owner retry from %s without operational keys', async status => {
    const f = await fixture(status);
    const instance = await f.coordinator();
    await instance.stopSession(ref);
    expect(f.running()).toBe(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7, terminationIntentId: undefined });
  });

  it.each(['claim', 'boundary', 'confirmation'] as const)(
    'protects the entire Stop when the caller disconnects during %s I/O', async stage => {
      const f = await fixture();
      if (stage === 'boundary') {
        f.kv._set(f.key, { id: ref.sessionId, status: 'running', lifecycleGeneration: 7, boundaryActivityId: 'pending-activity' });
        f.env.OPERATOR_ACTIVITY = { getByName: () => ({
          getBoundaryStartBinding: async () => ({ session: ref }),
          cancelBoundaryStart: async () => { await f.pause('boundary'); return { ok: true }; },
        }) } as unknown as Env['OPERATOR_ACTIVITY'];
      }
      const instance = await f.coordinator();
      const checkpoint = f.holdIO(stage);
      const stop = instance.stopSession(ref);
      await checkpoint.entered;
      f.disconnect();
      checkpoint.resolve();
      await stop;
      expect(f.running()).toBe(false);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7,
        terminationIntentId: undefined, boundaryActivityId: undefined });
    },
  );

  it('rejects a termination intent pinned to a different generation without changing ownership', async () => {
    const f = await fixture('stopping');
    f.kv._set(f.key, { id: ref.sessionId, status: 'stopping', lifecycleGeneration: 7,
      terminationIntentId: 'retained-intent', terminationGeneration: 6 });
    const before = await f.read();
    await expect((await f.coordinator()).stopSession(ref)).rejects.toThrow();
    expect(await f.read()).toEqual(before);
    expect(f.running()).toBe(true);
  });

  it('retains the same intent while retrying a reconstructed stopping generation', async () => {
    const f = await fixture('stopping');
    const instance = await f.coordinator();
    const gate = f.holdTeardown();
    const stop = instance.stopSession(ref);
    await f.enteredTeardown();
    expect((await f.read())?.terminationIntentId).toBe('retained-intent');
    gate.resolve();
    await stop;
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
  });

  it('retains stopping when D1 confirmation fails and completes after recovery with a new coordinator', async () => {
    const f = await fixture();
    f.failConfirmation(true);
    await expect((await f.coordinator()).stopSession(ref)).rejects.toThrow();
    expect(f.running()).toBe(false);
    const retained = await f.read();
    expect(retained).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7 });
    expect(retained?.terminationIntentId).toBeTruthy();
    f.failConfirmation(false);
    await (await f.coordinator()).stopSession(ref);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7, terminationIntentId: undefined });
  });

  it('allows retry on the same coordinator after a transient D1 confirmation failure', async () => {
    const f = await fixture();
    const instance = await f.coordinator();
    f.failConfirmation(true);
    await expect(instance.stopSession(ref)).rejects.toThrow();
    f.failConfirmation(false);
    await instance.stopSession(ref);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
  });

  it('coalesces concurrent requests for the same generation without concurrent teardown', async () => {
    const f = await fixture();
    const instance = await f.coordinator();
    const gate = f.holdTeardown();
    const first = instance.stopSession(ref);
    await vi.waitFor(async () => expect((await f.read())?.lifecycleState).toBe('stopping'));
    const retry = instance.stopSession(ref);
    gate.resolve();
    await Promise.all([first, retry]);
    expect(f.running()).toBe(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
  });

  it('treats a retry after a lost successful response as already completed', async () => {
    const f = await fixture();
    await (await f.coordinator()).stopSession(ref);
    const before = await f.read();
    await (await f.coordinator()).stopSession(ref);
    expect(await f.read()).toEqual(before);
  });

  it('does not claim or destroy on a D1 outage before the claim and permits retry after recovery', async () => {
    const f = await fixture();
    const instance = await f.coordinator();
    f.failDatabase(true);
    await expect(instance.stopSession(ref)).rejects.toThrow();
    expect(f.running()).toBe(true);
    f.failDatabase(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'running', terminationIntentId: undefined });
    await instance.stopSession(ref);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
  });

  it('keeps an unconfirmed destruction stopping and lets the owner retry it', async () => {
    const f = await fixture();
    const instance = await f.coordinator();
    const gate = f.holdTeardown();
    const stop = instance.stopSession(ref);
    await vi.waitFor(async () => expect((await f.read())?.lifecycleState).toBe('stopping'));
    gate.reject(Error('destruction unconfirmed'));
    await expect(stop).rejects.toThrow('destruction unconfirmed');
    expect(f.running()).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7 });
    f.holdTeardown().resolve();
    await instance.stopSession(ref);
    expect(f.running()).toBe(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
  });

  it('rejects a stale retry without terminating a replacement generation', async () => {
    const f = await fixture();
    await expect((await f.coordinator()).stopSession({ ...ref, generation: 6 })).rejects.toThrow();
    expect(f.running()).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 7, terminationIntentId: undefined });
  });

  it('rejects an owner/session address mismatch without claiming or terminating either session', async () => {
    const f = await fixture();
    f.kv._set(`session:other-owner:${ref.sessionId}`, { id: ref.sessionId, status: 'running', lifecycleGeneration: 7 });
    await expect((await f.coordinator()).stopSession({ ...ref, bucket: 'other-owner' })).rejects.toThrow();
    expect(f.running()).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'running', terminationIntentId: undefined });
    expect(await f.repository.getSession('other-owner', ref.sessionId)).toMatchObject({ lifecycleState: 'running', terminationIntentId: undefined });
  });

  it('does not destroy while a pending Protected Action cancellation is unconfirmed', async () => {
    const f = await fixture();
    f.kv._set(f.key, { id: ref.sessionId, status: 'running', lifecycleGeneration: 7, boundaryActivityId: 'pending-activity' });
    await expect((await f.coordinator()).stopSession(ref)).rejects.toThrow();
    expect(f.running()).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', boundaryActivityId: 'pending-activity' });
  });
});

// Conditional contract: REQ-SESSION-011 AC5, 018 AC4/7, 026 AC1/2,
// 035 AC2/4 and 042 AC1/3. Only the already-dispatched native operation's
// positive completion may release its captured Stop intent after the deadline.
describe('ordinary Stop late native exit confirmation', () => {
  async function lateStop(stage: 'provider' | 'audit' = 'provider') {
    const f = await fixture();
    const instance = await f.coordinator();
    const native = f.holdTeardown();
    const audit = stage === 'audit' ? f.holdIO('audit') : undefined;
    const result = instance.stopSession(ref).then(() => 'resolved', (error: Error) => error.message);
    if (audit) await audit.entered;
    else await f.enteredTeardown();
    f.disconnect();
    await vi.advanceTimersByTimeAsync(135_000);
    expect(await result).toBe('teardown deadline exceeded');
    await f.enteredTeardown();
    audit?.resolve();
    expect(f.running()).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7 });
    return { f, instance, native };
  }

  it.each(['provider', 'audit'] as const)('confirms only positive late native success after the shared deadline is exhausted at %s', async stage => {
    vi.useFakeTimers();
    try {
      const { f, native } = await lateStop(stage);
      native.resolve();
      await f.settleWork();
      await vi.advanceTimersByTimeAsync(0);
      await f.settleWork();
      expect(f.running()).toBe(false);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7, terminationIntentId: undefined });
      expect(await f.repository.start(ref.bucket, ref.sessionId, new Date().toISOString()))
        .toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 8 });
    } finally { vi.useRealTimers(); }
  });

  it('retains stopping without positive native completion and after a late native failure', async () => {
    vi.useFakeTimers();
    try {
      const { f, native } = await lateStop();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7 });
      native.reject(Error('native destruction failed'));
      await vi.advanceTimersByTimeAsync(0);
      await f.settleWork();
      expect(f.running()).toBe(true);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7 });
      expect(await f.repository.start(ref.bucket, ref.sessionId, new Date().toISOString())).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it.each(['alarm', 'reconstruction'] as const)('reuses durable positive exit after a D1 outage via %s without another native attempt', async recovery => {
    vi.useFakeTimers();
    try {
      const { f, native, instance } = await lateStop();
      f.failConfirmation(true);
      native.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await f.settleWork();
      expect(f.running()).toBe(false);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7 });
      f.failConfirmation(false);
      f.forbidNative();
      if (recovery === 'alarm') await f.reconcile(instance);
      else await f.coordinator();
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
    } finally { vi.useRealTimers(); }
  });

  it('retains positive exit and propagates terminal alarm failure for reconstruction recovery', async () => {
    vi.useFakeTimers();
    try {
      const { f, native } = await lateStop();
      f.failConfirmation(true);
      f.failSchedule(true);
      native.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await f.settleWork();
      expect(f.workFailures.some(error => error instanceof Error && error.message === 'exit reconciliation alarm unavailable')).toBe(true);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7 });
      f.failSchedule(false);
      f.failConfirmation(false);
      f.forbidNative();
      await f.coordinator();
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
    } finally { vi.useRealTimers(); }
  });

  it.each(['generation', 'intent', 'other-owner'] as const)('does not release replacement %s authority from late native success', async replacement => {
    vi.useFakeTimers();
    try {
      const { f, native } = await lateStop();
      const otherKey = `session:other-owner:${ref.sessionId}`;
      f.kv._set(otherKey, { id: ref.sessionId, status: 'stopping', lifecycleGeneration: 7,
        terminationIntentId: 'other-intent', terminationGeneration: 7 });
      if (replacement !== 'other-owner') {
        f.kv._set(f.key, { id: ref.sessionId, status: replacement === 'generation' ? 'running' : 'stopping',
          lifecycleGeneration: replacement === 'generation' ? 8 : 7,
          ...(replacement === 'intent' ? { terminationIntentId: 'replacement-intent', terminationGeneration: 7 } : {}) });
      }
      const before = await f.read();
      const otherBefore = await f.repository.getSession('other-owner', ref.sessionId);
      native.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await f.settleWork();
      if (replacement !== 'other-owner') expect(await f.read()).toEqual(before);
      else expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
      expect(await f.repository.getSession('other-owner', ref.sessionId)).toEqual(otherBefore);
    } finally { vi.useRealTimers(); }
  });

  it('keeps positive exit pending until Protected Action cancellation is confirmed', async () => {
    vi.useFakeTimers();
    try {
      const { f, native, instance } = await lateStop();
      const retained = await f.kv.get(f.key, 'json') as Record<string, unknown>;
      f.kv._set(f.key, { ...retained, boundaryActivityId: 'pending-activity' });
      native.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await f.settleWork();
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', boundaryActivityId: 'pending-activity' });
      f.env.OPERATOR_ACTIVITY = { getByName: () => ({
        getBoundaryStartBinding: async () => ({ session: ref }),
        cancelBoundaryStart: async () => ({ ok: true }),
      }) } as unknown as Env['OPERATOR_ACTIVITY'];
      f.forbidNative();
      await f.reconcile(instance);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', boundaryActivityId: undefined });
    } finally { vi.useRealTimers(); }
  });
});
