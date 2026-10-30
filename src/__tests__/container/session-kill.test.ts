import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { D1SessionRepository } from '../../lib/session-repository';
import { createMockKV } from '../helpers/mock-kv';
import { createMockSessionD1 } from '../helpers/mock-session-d1';

// Only the platform/SDK boundary is doubled. In SDK 0.3.7 public destroy()
// awaits container.destroy(); stop() signals the native program. Do not replace
// SessionContainer.destroy(): these tests need the real graceful and KILL lanes.
// SDK alarm SQL/interception/monitor bookkeeping is outside this model.
vi.mock('@cloudflare/containers', () => ({
  Container: class {
    constructor(public ctx: DurableObjectState, public env: Env) {}
    async destroy() { await this.ctx.container!.destroy(); }
    async stop(signal: string | number = 'SIGTERM') { this.ctx.container!.signal(signal === 'SIGTERM' ? 15 : Number(signal)); }
    async schedule(delay: number, callback: string, payload?: unknown) {
      return { taskId: crypto.randomUUID(), callback, payload, type: 'delayed',
        time: Math.floor(Date.now() / 1000) + delay, delayInSeconds: delay };
    }
    deleteSchedules() {}
    renewActivityTimeout() {}
  },
}));

import { container as SessionContainer } from '../../container/index';

type Ref = { bucket: string; sessionId: string; generation: number };
type KillContainer = { killSession(input: Ref): Promise<void> };
const ref: Ref = { bucket: 'owner-bucket', sessionId: 'session12345678', generation: 7 };
const cleanupTasks: Array<() => Promise<void>> = [];

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // A disconnect can reject an external I/O gate before its consumer resumes.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function observe<T>(operation: () => Promise<T>) {
  const state: { done: boolean; error?: unknown } = { done: false };
  const settled = (async () => {
    try { await operation(); }
    catch (error) { state.error = error; }
    finally { state.done = true; }
  })();
  return { state, settled };
}
async function rejected(work: ReturnType<typeof observe>) {
  await vi.waitFor(() => expect(work.state.done).toBe(true));
  expect(work.state.error).toBeInstanceOf(Error);
}
async function completed(work: ReturnType<typeof observe>) {
  await vi.waitFor(() => expect(work.state.done).toBe(true));
  expect(work.state.error).toBeUndefined();
}

/**
 * Model actual external effects rather than teardown registrations/call counts.
 * Native destroy can hold/reject/confirm. Its running hint is deliberately
 * independent of program liveness and its generation-pinned exit monitor.
 * Pending external I/O dies on caller loss unless an unsettled DO waitUntil
 * task owns execution. This is a lifetime model, not a hosted-runtime proof.
 */
async function fixture(options: { status?: string; operational?: boolean; intentGeneration?: number } = {}) {
  const kv = createMockKV();
  const key = `session:${ref.bucket}:${ref.sessionId}`;
  const seed = { id: ref.sessionId, userId: ref.bucket, name: 'Retained workspace',
    workspace: 'terminal', terminalMode: 'classic', status: options.status ?? 'running',
    lifecycleGeneration: 7, responseRevision: 4,
    ...(options.status === 'stopping' ? { terminationIntentId: 'retained-intent',
      terminationGeneration: options.intentGeneration ?? 7 } : {}) };
  kv._set(key, seed);
  const storage = new Map<string, unknown>(options.operational === false ? [] : [
    ['bucketName', ref.bucket], ['_sessionId', ref.sessionId], ['lifecycleGeneration', 7],
    ['containerAuthToken', 'old-runtime-token'], ['vaultKey', 'old-vault-key'],
    ['workspaceSyncEnabled', true], ['sleepAfter', '30m'],
    ['review:session-human', { generation: 7 }],
    ['review:boundary-input', { generation: 7 }],
  ]);
  const protectedWork = new Set<Promise<unknown>>();
  const pendingIO = new Set<ReturnType<typeof deferred>>();
  const checkpoints = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
  const allGates: Array<ReturnType<typeof deferred>> = [];
  let disconnected = false;
  const live = () => {
    if (disconnected && protectedWork.size === 0) throw Error('caller disconnected: unowned I/O');
  };
  const hold = (stage: string) => {
    const point = { entered: deferred(), release: deferred() };
    let entered = false;
    void point.entered.promise.then(() => { entered = true; });
    checkpoints.set(stage, point); allGates.push(point.release);
    return { reached: () => entered, resolve: point.release.resolve, reject: point.release.reject };
  };
  const pause = async (stage: string) => {
    live();
    const point = checkpoints.get(stage);
    if (point) {
      point.entered.resolve(); pendingIO.add(point.release);
      try { await point.release.promise; } finally { pendingIO.delete(point.release); }
    }
    live();
  };
  let databaseUnavailable = false, confirmationUnavailable = false;
  let delaySessionRead = false;
  const db = createMockSessionD1(kv);
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    if (databaseUnavailable) throw Error('D1 unavailable');
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...args: unknown[]) => {
      const bound = bind(...args);
      const first = bound.first.bind(bound);
      bound.first = (async (column?: string) => {
        const value = column === undefined ? await first() : await first(column);
        if (delaySessionRead && /SELECT\s+\*\s+FROM\s+runtime_sessions/i.test(sql)) {
          delaySessionRead = false;
          // D1 has read the row; only delivery of that captured reply is held.
          const snapshot = structuredClone(value);
          await pause('session-read-response');
          return snapshot;
        }
        return value;
      }) as typeof bound.first;
      const run = bound.run.bind(bound);
      bound.run = (async () => {
        if (/SET\s+lifecycle_state='stopping'/.test(sql)) await pause('claim');
        if (/SET\s+lifecycle_state='stopped'/.test(sql)) {
          await pause('confirmation');
          if (confirmationUnavailable) throw Error('D1 confirmation unavailable');
        }
        live(); return run();
      }) as typeof bound.run;
      return bound;
    };
    return statement;
  };
  // Model the S3 endpoint used by production, not an unattached R2 Map. Any
  // attempted DELETE (including bucket deletion) mutates the observed files.
  const files = new Map([['/owner-bucket/workspace/kept.txt', 'persisted before KILL'],
    ['/owner-bucket/Notes/kept.md', 'retained note']]);
  const originalFiles = new Map(files);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname !== 'r2.test') throw Error(`Unexpected external network: ${url.hostname}`);
    if (request.method === 'DELETE') {
      for (const path of files.keys()) if (path === url.pathname || path.startsWith(`${url.pathname}/`)) files.delete(path);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'POST' && url.searchParams.has('delete')) {
      const body = await request.text();
      for (const match of body.matchAll(/<Key>([^<]+)<\/Key>/g)) files.delete(`${url.pathname}/${match[1]}`);
      return new Response('<DeleteResult/>');
    }
    if (request.method === 'PUT') { files.set(url.pathname, await request.text()); return new Response(null); }
    if (url.searchParams.has('list-type')) {
      const prefix = `${url.pathname}/${url.searchParams.get('prefix') ?? ''}`;
      return new Response(`<ListBucketResult>${[...files.keys()].filter(path => path.startsWith(prefix))
        .map(path => `<Contents><Key>${path.slice(url.pathname.length + 1)}</Key><Size>1</Size></Contents>`)
        .join('')}</ListBucketResult>`);
    }
    return files.has(url.pathname) ? new Response(files.get(url.pathname)) : new Response(null, { status: 404 });
  });
  let program = { generation: 7, running: true, gracefulShutdownRequested: false };
  let runningHint = true, destroying = false;
  const monitors = new Map<number, ReturnType<typeof deferred>>([[7, deferred()]]);
  let gracefulTrafficForbidden = true;
  let nativeUnavailable = false;
  const runtime = {
    get running() { return runningHint; },
    getTcpPort: (_port: number) => ({ fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      live();
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === '/health') return Response.json({ status: 'ok' });
      if (path === '/internal/agent-events/drain') {
        if (gracefulTrafficForbidden) { await pause('forbidden-drain'); throw Error('KILL entered final agent drain'); }
        await pause('agent-drain'); return Response.json({ events: [] });
      }
      if (path === '/internal/final-sync') {
        if (gracefulTrafficForbidden) { await pause('forbidden-sync'); throw Error('KILL entered final sync'); }
        await pause('sync'); return Response.json({ synced: true });
      }
      throw Error(`Unexpected container HTTP request: ${path}`);
    } }),
    monitor: () => monitors.get(program.generation)!.promise,
    signal: (_signal: number) => {
      // This is an observable runtime effect, not a spy on a private helper.
      program.gracefulShutdownRequested = true;
    },
    destroy: async () => {
      if (destroying) throw Error('competing native teardown');
      destroying = true;
      const captured = program;
      try {
        await pause('native');
        if (nativeUnavailable) throw Error('native destruction unconfirmed');
        captured.running = false;
        if (program === captured) runningHint = false;
        // Do not resolve monitor here: awaited native destroy must itself suffice.
      } finally { destroying = false; }
    },
  };
  // If KILL accidentally enters graceful work it really blocks, rather than
  // throwing an error the best-effort graceful implementation could swallow.
  hold('forbidden-drain'); hold('forbidden-sync');
  const env = { USAGE_DB: db, KV: kv, R2_ACCOUNT_ID: 'test-account', R2_ENDPOINT: 'https://r2.test',
    R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret',
    CONTAINER: { idFromName: (name: string) => ({ toString: () => name }) } } as unknown as Env;
  const repository = new D1SessionRepository(db);
  async function coordinator() {
    let ready = Promise.resolve();
    const store = {
      get: async (requested: string | string[]) => Array.isArray(requested)
        ? new Map(requested.filter(k => storage.has(k)).map(k => [k, storage.get(k)])) : storage.get(requested),
      put: async (requested: string | Record<string, unknown>, value?: unknown) => {
        live();
        if (typeof requested === 'string') storage.set(requested, value);
        else for (const [k, v] of Object.entries(requested)) storage.set(k, v);
      },
      delete: async (requested: string | string[]) => {
        const keys = Array.isArray(requested) ? requested : [requested];
        if (keys.includes('_sessionId')) await pause('cleanup');
        live(); let deleted = 0;
        for (const k of keys) if (storage.delete(k)) deleted++;
        return Array.isArray(requested) ? deleted : deleted > 0;
      },
      deleteAlarm: async () => {}, setAlarm: async () => {},
      transaction: async <T>(work: (txn: unknown) => Promise<T>): Promise<T> => work(store),
    };
    const ctx = { id: { toString: () => `${ref.bucket}-${ref.sessionId}` }, storage: store, container: runtime,
      blockConcurrencyWhile: (work: () => Promise<void>) => {
        ready = ready.then(work); return ready;
      },
      waitUntil: (task: Promise<unknown>) => {
        protectedWork.add(task);
        void task.then(() => protectedWork.delete(task), () => protectedWork.delete(task));
      },
    };
    const instance = new SessionContainer(ctx as unknown as DurableObjectState<Env>, env);
    await ready;
    return instance;
  }
  const f = { env, kv, key, storage, repository, coordinator, hold, pause,
    read: () => repository.getSession(ref.bucket, ref.sessionId),
    program: () => ({ ...program }),
    files: () => new Map(files), originalFiles,
    hint: (running: boolean) => { runningHint = running; },
    failNative: (fail: boolean) => { nativeUnavailable = fail; },
    failDatabase: (fail: boolean) => { databaseUnavailable = fail; },
    failConfirmation: (fail: boolean) => { confirmationUnavailable = fail; },
    allowGraceful: () => { gracefulTrafficForbidden = false; },
    delayNextSessionRead: () => { delaySessionRead = true; },
    exit: (generation = program.generation) => {
      if (generation === program.generation) { program.running = false; runningHint = false; }
      monitors.get(generation)!.resolve();
    },
    failMonitor: () => { monitors.get(program.generation)!.reject(Error('monitor transport lost')); },
    disconnect: () => {
      disconnected = true;
      if (protectedWork.size === 0) for (const pending of pendingIO) pending.reject(Error('caller disconnected'));
    },
    replacement: () => {
      program = { generation: 8, running: true, gracefulShutdownRequested: false };
      runningHint = true; monitors.set(8, deferred());
    },
  };
  cleanupTasks.push(async () => {
    disconnected = false; databaseUnavailable = false; confirmationUnavailable = false;
    for (const gate of allGates) gate.resolve();
    // Failure cleanup releases old graceful work and advances its bounded poll;
    // no test failure is allowed to strand a Stop or leak a rejected promise.
    await vi.advanceTimersByTimeAsync(150_000);
  });
  return f;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  try { for (const cleanup of cleanupTasks.splice(0)) await cleanup(); }
  finally { vi.unstubAllGlobals(); vi.useRealTimers(); }
});

describe('REQ-SESSION-039 / REQ-SESSION-040: DO-owned native force termination', () => {
  it.each(['starting', 'running', 'unreachable', 'stopping'])(
    'force-kills %s without graceful drain, sync or SIGTERM and retains row and R2 files (REQ-SESSION-039 AC5-AC7 / REQ-SESSION-040 AC1)', async status => {
      const f = await fixture({ status });
      const instance = await f.coordinator();
      const work = observe(() => (instance as unknown as KillContainer).killSession(ref));
      await completed(work);
      expect(f.program()).toMatchObject({ running: false, gracefulShutdownRequested: false });
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7,
        name: 'Retained workspace', workspace: 'terminal', terminationIntentId: undefined });
      expect(f.storage.get('_sessionId')).toBeUndefined();
      expect(f.storage.get('bucketName')).toBeUndefined();
      expect(f.storage.get('containerAuthToken')).toBeUndefined();
      expect(f.storage.get('vaultKey')).toBeUndefined();
      expect(f.storage.get('review:session-human')).toBeUndefined();
      expect(f.storage.get('review:boundary-input')).toBeUndefined();
      expect(f.files()).toEqual(f.originalFiles);
    },
  );

  it('treats already confirmed stopped as idempotent without terminating a runtime (REQ-SESSION-040 AC5)', async () => {
    const f = await fixture({ status: 'stopped' });
    const instance = await f.coordinator(), before = await f.read();
    await completed(observe(() => (instance as unknown as KillContainer).killSession(ref)));
    expect(await f.read()).toEqual(before);
    expect(f.program()).toMatchObject({ running: true, gracefulShutdownRequested: false });
    expect(f.files()).toEqual(f.originalFiles);
  });

  it.each(['claim', 'boundary', 'cleanup', 'native', 'confirmation'])(
    'owns pending %s I/O through caller disconnect and completes D1 confirmation (REQ-SESSION-039 AC3 / REQ-SESSION-040 AC1)', async stage => {
      const f = await fixture();
      if (stage === 'boundary') {
        f.kv._set(f.key, { id: ref.sessionId, name: 'Retained workspace', status: 'running',
          lifecycleGeneration: 7, boundaryActivityId: 'pending-activity' });
        f.env.OPERATOR_ACTIVITY = { getByName: () => ({
          getBoundaryStartBinding: async () => ({ session: ref }),
          cancelBoundaryStart: async () => { await f.pause('boundary'); return { ok: true }; },
        }) } as unknown as Env['OPERATOR_ACTIVITY'];
      }
      const instance = await f.coordinator();
      const gate = f.hold(stage);
      const work = observe(() => (instance as unknown as KillContainer).killSession(ref));
      // Stage readiness is external I/O progress, not waitUntil registration.
      await vi.waitFor(() => expect(gate.reached()).toBe(true));
      f.disconnect(); gate.resolve();
      await completed(work);
      expect(f.program().running).toBe(false);
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7,
        boundaryActivityId: undefined, terminationIntentId: undefined });
      expect(f.files()).toEqual(f.originalFiles);
    },
  );

  it('fences pending Protected Action cancellation before operational cleanup or native termination (REQ-SESSION-039 AC4)', async () => {
    const f = await fixture();
    f.kv._set(f.key, { id: ref.sessionId, status: 'running', lifecycleGeneration: 7,
      boundaryActivityId: 'pending-activity' });
    const gate = f.hold('boundary');
    f.env.OPERATOR_ACTIVITY = { getByName: () => ({
      getBoundaryStartBinding: async () => ({ session: ref }),
      cancelBoundaryStart: async () => { await f.pause('boundary'); return { ok: true }; },
    }) } as unknown as Env['OPERATOR_ACTIVITY'];
    const instance = await f.coordinator();
    const work = observe(() => (instance as unknown as KillContainer).killSession(ref));
    await vi.waitFor(() => expect(gate.reached()).toBe(true));
    expect(f.program()).toMatchObject({ running: true, gracefulShutdownRequested: false });
    expect(f.storage.get('_sessionId')).toBe(ref.sessionId);
    expect(f.storage.get('containerAuthToken')).toBe('old-runtime-token');
    expect((await f.read())?.boundaryActivityId).toBe('pending-activity');
    gate.resolve(); await completed(work);
    expect(f.program().running).toBe(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', boundaryActivityId: undefined });
  });

  it.each(['unavailable', 'wrong-binding', 'unconfirmed'])(
    'retains termination ownership and live runtime when Protected Action cancellation is %s (REQ-SESSION-039 AC4 / REQ-SESSION-040 AC2)', async failure => {
      const f = await fixture();
      f.kv._set(f.key, { id: ref.sessionId, status: 'running', lifecycleGeneration: 7,
        boundaryActivityId: 'pending-activity' });
      if (failure !== 'unavailable') f.env.OPERATOR_ACTIVITY = { getByName: () => ({
        getBoundaryStartBinding: async () => ({ session: { ...ref, generation: failure === 'wrong-binding' ? 6 : 7 } }),
        cancelBoundaryStart: async () => ({ ok: false }),
      }) } as unknown as Env['OPERATOR_ACTIVITY'];
      const instance = await f.coordinator();
      await rejected(observe(() => (instance as unknown as KillContainer).killSession(ref)));
      expect(f.program()).toMatchObject({ running: true, gracefulShutdownRequested: false });
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7,
        terminationGeneration: 7, boundaryActivityId: 'pending-activity' });
      expect((await f.read())?.terminationIntentId).toBeTruthy();
      expect(f.storage.get('_sessionId')).toBe(ref.sessionId);
      expect(f.files()).toEqual(f.originalFiles);
    },
  );

  it.each([false, true])('retries failed native destruction after operational identity erasure; reconstruct=%s (REQ-SESSION-040 AC2-AC3)', async reconstruct => {
    const f = await fixture();
    let instance = await f.coordinator();
    f.failNative(true);
    await rejected(observe(() => (instance as unknown as KillContainer).killSession(ref)));
    const retained = await f.read();
    expect(retained).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7, terminationGeneration: 7 });
    expect(retained?.terminationIntentId).toBeTruthy();
    expect(f.storage.get('_sessionId')).toBeUndefined();
    expect(f.storage.get('bucketName')).toBeUndefined();
    expect(f.program().running).toBe(true);
    expect(f.files()).toEqual(f.originalFiles);
    if (reconstruct) instance = await f.coordinator();
    f.failNative(false);
    const gate = f.hold('native');
    const retry = observe(() => (instance as unknown as KillContainer).killSession(ref));
    await vi.waitFor(() => expect(gate.reached()).toBe(true));
    expect((await f.read())?.terminationIntentId).toBe(retained?.terminationIntentId);
    gate.resolve(); await completed(retry);
    expect(f.program().running).toBe(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
  });

  it('reconstructs a retained same-generation intent without operational keys (REQ-SESSION-040 AC3)', async () => {
    const f = await fixture({ status: 'stopping', operational: false });
    const instance = await f.coordinator(), gate = f.hold('native');
    const work = observe(() => (instance as unknown as KillContainer).killSession(ref));
    await vi.waitFor(() => expect(gate.reached()).toBe(true));
    expect((await f.read())?.terminationIntentId).toBe('retained-intent');
    gate.resolve(); await completed(work);
    expect(f.program().running).toBe(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
  });

  it('coalesces duplicate KILL without competing native teardown (REQ-SESSION-040 AC4-AC5)', async () => {
    const f = await fixture(), instance = await f.coordinator(), gate = f.hold('native');
    const first = observe(() => (instance as unknown as KillContainer).killSession(ref));
    await vi.waitFor(() => expect(gate.reached()).toBe(true));
    const intent = (await f.read())?.terminationIntentId;
    const duplicate = observe(() => (instance as unknown as KillContainer).killSession(ref));
    await vi.advanceTimersByTimeAsync(100);
    expect(first.state.done).toBe(false); expect(duplicate.state.done).toBe(false);
    expect(f.program().running).toBe(true);
    expect((await f.read())?.terminationIntentId).toBe(intent);
    gate.resolve(); await completed(first); await completed(duplicate);
    const stopped = await f.read();
    await completed(observe(() => (instance as unknown as KillContainer).killSession(ref)));
    expect(await f.read()).toEqual(stopped);
    expect(f.program().running).toBe(false);
  });

  it('never infers exit from an old stopping row, false running hint, callback or elapsed time (REQ-SESSION-040 AC1-AC2)', async () => {
    const f = await fixture({ status: 'stopping' });
    f.hint(false);
    const instance = await f.coordinator(), gate = f.hold('native');
    const work = observe(() => (instance as unknown as KillContainer).killSession(ref));
    await vi.waitFor(() => expect(gate.reached()).toBe(true));
    await instance.onStop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.program().running).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7,
      terminationIntentId: 'retained-intent' });
    gate.reject(Error('native destruction unconfirmed'));
    await work.settled;
    expect(work.state.error).toBeDefined();
    expect((await f.read())?.lifecycleState).toBe('stopping');
    expect(f.files()).toEqual(f.originalFiles);
  });

  it('does not treat monitor transport rejection as positive exit while native destruction is unconfirmed (REQ-SESSION-040 AC1-AC2)', async () => {
    const f = await fixture({ status: 'stopping' });
    const instance = await f.coordinator(), gate = f.hold('native');
    const work = observe(() => (instance as unknown as KillContainer).killSession(ref));
    await vi.waitFor(() => expect(gate.reached()).toBe(true));
    f.failMonitor(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.program().running).toBe(true);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7,
      terminationIntentId: 'retained-intent' });
    gate.reject(Error('native destruction unconfirmed')); await rejected(work);
    expect((await f.read())?.lifecycleState).toBe('stopping');
    expect(f.files()).toEqual(f.originalFiles);
  });

  it.each([false, true])('retains stopped-confirmation failure for retry; reconstruct=%s (REQ-SESSION-040 AC2-AC3)', async reconstruct => {
    const f = await fixture(); let instance = await f.coordinator();
    f.failConfirmation(true);
    await rejected(observe(() => (instance as unknown as KillContainer).killSession(ref)));
    expect(f.program().running).toBe(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', lifecycleGeneration: 7 });
    expect((await f.read())?.terminationIntentId).toBeTruthy();
    f.failConfirmation(false);
    if (reconstruct) instance = await f.coordinator();
    await completed(observe(() => (instance as unknown as KillContainer).killSession(ref)));
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7 });
    expect(f.files()).toEqual(f.originalFiles);
  });

  it('fails closed before claiming on a D1 outage and permits retry after recovery (REQ-SESSION-039 AC2)', async () => {
    const f = await fixture(), instance = await f.coordinator();
    f.failDatabase(true);
    await rejected(observe(() => (instance as unknown as KillContainer).killSession(ref)));
    expect(f.program().running).toBe(true);
    expect(f.storage.get('_sessionId')).toBe(ref.sessionId);
    f.failDatabase(false);
    expect(await f.read()).toMatchObject({ lifecycleState: 'running', terminationIntentId: undefined });
    await completed(observe(() => (instance as unknown as KillContainer).killSession(ref)));
    expect((await f.read())?.lifecycleState).toBe('stopped');
  });

  it.each([
    { bucket: 'other-owner' }, { sessionId: 'othersession1234' }, { generation: 6 }, { generation: 8 },
  ])('rejects mismatched captured authority %j without mutating either owner (REQ-SESSION-040 AC6)', async mismatch => {
    const f = await fixture(), instance = await f.coordinator();
    f.kv._set(`session:other-owner:${ref.sessionId}`, { id: ref.sessionId, status: 'running', lifecycleGeneration: 7 });
    const before = await f.read();
    const otherBefore = await f.repository.getSession('other-owner', ref.sessionId);
    await rejected(observe(() => (instance as unknown as KillContainer).killSession({ ...ref, ...mismatch })));
    expect(await f.read()).toEqual(before);
    expect(await f.repository.getSession('other-owner', ref.sessionId)).toEqual(otherBefore);
    expect(f.program()).toMatchObject({ running: true, gracefulShutdownRequested: false });
    expect(f.storage.get('_sessionId')).toBe(ref.sessionId);
    expect(f.files()).toEqual(f.originalFiles);
  });

  it('rejects a retained termination intent from a different generation (REQ-SESSION-040 AC6)', async () => {
    const f = await fixture({ status: 'stopping', intentGeneration: 6 });
    const instance = await f.coordinator(), before = await f.read();
    await rejected(observe(() => (instance as unknown as KillContainer).killSession(ref)));
    expect(await f.read()).toEqual(before);
    expect(f.program().running).toBe(true);
    expect(f.storage.get('_sessionId')).toBe(ref.sessionId);
  });

  it('revalidates intent ownership after asynchronous Protected Action cancellation (REQ-SESSION-039 AC4 / REQ-SESSION-040 AC6)', async () => {
    const f = await fixture();
    f.kv._set(f.key, { id: ref.sessionId, status: 'stopping', lifecycleGeneration: 7,
      terminationIntentId: 'original-intent', terminationGeneration: 7, boundaryActivityId: 'pending-activity' });
    const gate = f.hold('boundary');
    f.env.OPERATOR_ACTIVITY = { getByName: () => ({
      getBoundaryStartBinding: async () => ({ session: ref }),
      cancelBoundaryStart: async () => { await f.pause('boundary'); return { ok: true }; },
    }) } as unknown as Env['OPERATOR_ACTIVITY'];
    const instance = await f.coordinator();
    const work = observe(() => (instance as unknown as KillContainer).killSession(ref));
    await vi.waitFor(() => expect(gate.reached()).toBe(true));
    f.kv._set(f.key, { id: ref.sessionId, status: 'stopping', lifecycleGeneration: 7,
      terminationIntentId: 'different-intent', terminationGeneration: 7 });
    gate.resolve(); await work.settled;
    expect(work.state.error).toBeDefined();
    expect(await f.read()).toMatchObject({ lifecycleState: 'stopping', terminationIntentId: 'different-intent' });
    expect(f.program().running).toBe(true);
    expect(f.storage.get('_sessionId')).toBe(ref.sessionId);
  });

  it('fences Stop whose old D1 ownership reply arrives after KILL and replacement startup (REQ-SESSION-040 AC7)', async () => {
    const f = await fixture(); f.allowGraceful();
    f.kv._set(f.key, { id: ref.sessionId, name: 'Retained workspace', workspace: 'terminal',
      status: 'running', lifecycleGeneration: 7, boundaryActivityId: 'pending-activity' });
    f.env.OPERATOR_ACTIVITY = { getByName: () => ({
      getBoundaryStartBinding: async () => ({ session: ref }),
      cancelBoundaryStart: async () => { f.delayNextSessionRead(); return { ok: true }; },
    }) } as unknown as Env['OPERATOR_ACTIVITY'];
    const instance = await f.coordinator(), reply = f.hold('session-read-response');
    const stop = observe(() => instance.stopSession(ref));
    try {
      await vi.waitFor(() => expect(reply.reached()).toBe(true));
      await completed(observe(() => (instance as unknown as KillContainer).killSession(ref)));
      expect(stop.state.done).toBe(false);
      expect(f.program()).toMatchObject({ generation: 7, running: false });
      expect(await f.repository.start(ref.bucket, ref.sessionId, new Date().toISOString()))
        .toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 8 });
      f.replacement();
      await instance.setBucketName(ref.bucket, { sessionId: ref.sessionId, workspaceSyncEnabled: true });
      await instance.onStart();
      const replacementKeys = new Map(['bucketName', '_sessionId', 'containerAuthToken',
        'workspaceSyncEnabled', 'lifecycleGeneration', 'containerStartedAt'].map(key => [key, f.storage.get(key)]));
      expect(replacementKeys.get('lifecycleGeneration')).toBe(8);
      expect(replacementKeys.get('containerAuthToken')).toBeTruthy();
      reply.resolve();
      await vi.advanceTimersByTimeAsync(150_000);
      expect(stop.state.done).toBe(true);
      expect(f.program()).toEqual({ generation: 8, running: true, gracefulShutdownRequested: false });
      expect(await f.read()).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 8,
        terminationIntentId: undefined });
      for (const [key, value] of replacementKeys) expect(f.storage.get(key), key).toEqual(value);
      expect(f.storage.get('shutdownRequested')).toBeUndefined();
      expect(f.files()).toEqual(f.originalFiles);
    } finally { reply.resolve(); }
  });

  it.each(['agent-drain', 'sync'])('preempts real Stop blocked on %s, then fences its late continuation from replacement generation 8 (REQ-SESSION-039 AC6-AC7 / REQ-SESSION-040 AC1/AC3/AC7)', async stage => {
    const f = await fixture(); f.allowGraceful();
    const instance = await f.coordinator(), sync = f.hold(stage);
    const stop = observe(() => instance.stopSession(ref));
    try {
      await vi.waitFor(() => expect(sync.reached()).toBe(true));
      const retainedIntent = (await f.read())?.terminationIntentId;
      expect(retainedIntent).toBeTruthy();
      const native = f.hold('native');
      const kill = observe(() => (instance as unknown as KillContainer).killSession(ref));
      await vi.waitFor(() => expect(native.reached()).toBe(true));
      expect((await f.read())?.terminationIntentId).toBe(retainedIntent);
      native.resolve();
      // No clock advance to the sync/teardown deadline and no sync release:
      // KILL must finish while the original graceful Stop is still blocked.
      await completed(kill);
      expect(stop.state.done).toBe(false);
      expect(f.program()).toMatchObject({ generation: 7, running: false, gracefulShutdownRequested: false });
      expect(await f.read()).toMatchObject({ lifecycleState: 'stopped', lifecycleGeneration: 7,
        name: 'Retained workspace' });
      expect(f.files()).toEqual(f.originalFiles);
      expect(await f.repository.start(ref.bucket, ref.sessionId, new Date().toISOString()))
        .toMatchObject({ lifecycleState: 'starting', lifecycleGeneration: 8 });
      f.replacement();
      await instance.setBucketName(ref.bucket, { sessionId: ref.sessionId, workspaceSyncEnabled: true });
      await instance.onStart();
      const replacementKeys = new Map(['bucketName', '_sessionId', 'containerAuthToken',
        'workspaceSyncEnabled', 'lifecycleGeneration', 'containerStartedAt'].map(key => [key, f.storage.get(key)]));
      expect(replacementKeys.get('lifecycleGeneration')).toBe(8);
      expect(replacementKeys.get('containerAuthToken')).toBeTruthy();
      sync.resolve();
      await vi.advanceTimersByTimeAsync(150_000);
      expect(stop.state.done).toBe(true); // supersession may resolve or reject the old caller
      expect(f.program()).toEqual({ generation: 8, running: true, gracefulShutdownRequested: false });
      expect(await f.read()).toMatchObject({ lifecycleState: 'running', lifecycleGeneration: 8,
        terminationIntentId: undefined });
      for (const [key, value] of replacementKeys) expect(f.storage.get(key), key).toEqual(value);
      expect(f.storage.get('shutdownRequested')).toBeUndefined();
      // A stale native monitor completion must not stop the replacement either.
      f.exit(7); await vi.advanceTimersByTimeAsync(1);
      expect((await f.read())?.lifecycleState).toBe('running');
      expect(f.files()).toEqual(f.originalFiles);
    } finally { sync.resolve(); }
  });

  it('ordinary Stop still drains and syncs before native exit when no KILL supersedes it (REQ-SESSION-038 AC7)', async () => {
    const f = await fixture(); f.allowGraceful();
    const instance = await f.coordinator(), sync = f.hold('sync');
    const stop = observe(() => instance.stopSession(ref));
    await vi.waitFor(() => expect(sync.reached()).toBe(true));
    expect(f.program()).toMatchObject({ running: true, gracefulShutdownRequested: false });
    expect((await f.read())?.lifecycleState).toBe('stopping');
    sync.resolve(); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.program().gracefulShutdownRequested).toBe(true);
    f.exit(7);
    await vi.advanceTimersByTimeAsync(1_000); await completed(stop);
    expect((await f.read())?.lifecycleState).toBe('stopped');
    expect(f.files()).toEqual(f.originalFiles);
  });
});
