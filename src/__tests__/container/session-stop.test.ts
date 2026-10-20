import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';
import { D1SessionRepository } from '../../lib/session-repository';

vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(public ctx: unknown, public env: unknown) {}
    async destroy() {}
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
  const prepare = db.prepare.bind(db);
  db.prepare = (sql: string) => {
    if (databaseUnavailable) throw Error('D1 unavailable');
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values);
      const run = bound.run.bind(bound);
      bound.run = (async () => {
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
  const protectedWork = new Set<Promise<unknown>>();
  async function coordinator() {
    const storage = new Map<string, unknown>(); // operational identity is deliberately absent
    let ready: Promise<unknown> = Promise.resolve();
    const ctx = {
      id: { toString: () => `${ref.bucket}-${ref.sessionId}` },
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => { ready = fn(); },
      waitUntil: (task: Promise<unknown>) => {
        protectedWork.add(task);
        void task.finally(() => protectedWork.delete(task)).catch(() => {});
      },
      storage: { get: async (key: string) => storage.get(key) },
    };
    const instance = new SessionContainer(ctx as unknown as DurableObjectState<Env>, env);
    await ready;
    vi.spyOn(instance, 'destroy').mockImplementation(async () => {
      if (draining) throw Error('duplicate concurrent teardown');
      draining = true;
      try {
        await teardownGate?.promise;
        running = false; // positive destruction confirmation, including idempotent repeat
      } finally { draining = false; }
    });
    return instance as unknown as { stopSession(input: StopRef): Promise<void> };
  }
  return { env, kv, key, repository, coordinator,
    read: () => repository.getSession(ref.bucket, ref.sessionId),
    running: () => running,
    holdTeardown: () => { teardownGate = deferred(); return teardownGate; },
    disconnect: () => { if (!protectedWork.size) teardownGate?.reject(Error('caller disconnected')); },
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

  it('retains the same intent while retrying a reconstructed stopping generation', async () => {
    const f = await fixture('stopping');
    const instance = await f.coordinator();
    const gate = f.holdTeardown();
    const stop = instance.stopSession(ref);
    await vi.waitFor(async () => expect((await f.read())?.terminationIntentId).toBe('retained-intent'));
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
