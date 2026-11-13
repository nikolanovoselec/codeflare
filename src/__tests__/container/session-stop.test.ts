import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { D1SessionRepository } from '../../lib/session-repository';

const nativeDestroyByContext = vi.hoisted(() => new WeakMap<object, () => Promise<void>>());
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
async function fixture(initial: 'running' | 'stopping' | 'unreachable' = 'running') {
  const kv = createMockKV();
  const key = `session:${ref.bucket}:${ref.sessionId}`;
  kv._set(key, { id: ref.sessionId, userId: ref.bucket, name: 'Retained workspace',
    status: initial, lifecycleGeneration: ref.generation, responseRevision: 4,
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
  let running = true;
  let draining = false;
  let teardownGate: ReturnType<typeof deferred> | undefined;
  let teardownEntered = deferred();
  const protectedWork = new Set<Promise<unknown>>();
  const workFailures: unknown[] = [];
  const storage = new Map<string, unknown>([['lifecycleGeneration', ref.generation]]);
  const schedules = new Map<string, unknown>();
  let scheduleUnavailable = false;
  let nativeForbidden = false;
  async function coordinator() {
    // Lifecycle proof survives reconstruction; operational identity remains absent.
    let ready: Promise<unknown> = Promise.resolve();
    const ctx = {
      id: { toString: () => `${ref.bucket}-${ref.sessionId}` },
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
      waitUntil: (task: Promise<unknown>) => {
        protectedWork.add(task);
        void task.finally(() => protectedWork.delete(task)).catch(error => { workFailures.push(error); });
      },
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) => { if (key === 'finalSyncAudit') await pause('audit'); storage.set(key, value); },
        delete: async (key: string | string[]) => typeof key === 'string'
          ? storage.delete(key)
          : key.reduce((count, name) => count + Number(storage.delete(name)), 0),
      },
    };
    Object.assign(ctx.storage, { transaction: async (work: (txn: typeof ctx.storage) => Promise<unknown>) => work(ctx.storage) });
    schedulesByContext.set(ctx, schedules);
    scheduleFailureByContext.set(ctx, () => scheduleUnavailable);
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
    return instance as unknown as { stopSession(input: StopRef): Promise<void>; collectMetrics(pin?: StopRef): Promise<void> };
  }
  return { env, kv, key, repository, coordinator, workFailures,
    forbidNative: () => { nativeForbidden = true; },
    failSchedule: (fail: boolean) => { scheduleUnavailable = fail; },
    reconcile: async (instance: Awaited<ReturnType<typeof coordinator>>) => {
      const payload = schedules.get('collectMetrics');
      if (!payload) throw Error('no exit reconciliation scheduled');
      schedules.delete('collectMetrics');
      await instance.collectMetrics(payload as StopRef);
    },
    settleWork: async () => { while (protectedWork.size) await Promise.allSettled([...protectedWork]); },
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
      teardownGate?.reject(Error('caller disconnected'));
      for (const io of pendingIO) io.reject(Error('caller disconnected'));
    },
    failConfirmation: (fail: boolean) => { confirmationUnavailable = fail; },
    failDatabase: (fail: boolean) => { databaseUnavailable = fail; },
  };
}

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
