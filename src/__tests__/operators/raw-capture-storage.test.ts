import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encryptForKV, decryptFromKV, getOrImportKey } from '../../lib/kv-crypto';
import { createOwnerRawCaptureStorage, createRawCapture, readRawCapture,
  type RawCaptureBinding, type RawCaptureStorage, type RawCapture } from '../../operators/raw-capture-storage';

// Synthetic values only. The native boundary retains ciphertext, never a console facsimile.
const CANARY = 'SYNTHETIC_RAW_PRIVATE_CANARY_秘密_🦊';
const KEY = Buffer.alloc(32, 17).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 23).toString('base64');
const binding: RawCaptureBinding = { ownerKey: 'owner@example.test',
  installationId: 'installation-1', releaseId: 'release-1', captureId: 'capture-1',
  scope: { kind: 'observation', observationId: 'observation-1' } };

function boundary(options: { ambiguous?: boolean; replay?: boolean } = {}) {
  const objects = new Map<string, string>();
  const accesses: string[] = [];
  let authorized = true;
  const env = { ENCRYPTION_KEY: KEY };
  let afterIo: (() => void) | undefined;
  let afterCommit: ((keys: string[]) => void) | undefined;
  const completeIo = () => { const action = afterIo; afterIo = undefined; action?.(); };
  let transactions = Promise.resolve();
  const native = {
    async get<T>(key: string): Promise<T | undefined> {
      accesses.push(key);
      const result = objects.get(key);
      completeIo();
      return result as T | undefined;
    },
    transaction<T>(closure: (tx: DurableObjectTransaction) => Promise<T>): Promise<T> {
      const work = transactions.then(async () => {
        const staged = new Map(objects);
        const written: string[] = [];
        const tx = {
          async get<V>(key: string): Promise<V | undefined> { accesses.push(key); return staged.get(key) as V | undefined; },
          async put(key: string, value: string) {
            // Native KV value limit, including the stored string's serialization overhead.
            if (typeof value !== 'string' || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024)
              throw new Error('Native KV value exceeds 128 KiB');
            written.push(key); staged.set(key, value);
          },
        } as unknown as DurableObjectTransaction;
        const result = await closure(tx);
        if (options.replay) await closure(tx);
        objects.clear(); for (const [key, value] of staged) objects.set(key, value);
        afterCommit?.(written);
        completeIo();
        if (options.ambiguous) throw new Error('Synthetic acknowledgement lost after commit');
        return result;
      });
      transactions = work.then(() => undefined, () => undefined);
      return work;
    },
  } as unknown as RawCaptureStorage['storage'];
  const authorize = async () => {
    if (!authorized || env.ENCRYPTION_KEY !== KEY) throw new Error('Synthetic authority or key revoked');
  };
  const storage: RawCaptureStorage = { storage: native, encryptionKey: KEY, authorize };
  const pending: Promise<unknown>[] = [];
  const create = (scope: RawCaptureBinding = binding, overrides: Partial<Parameters<typeof createRawCapture>[0]> = {}) =>
    createRawCapture({ binding: scope, enabled: true, storage: async () => storage,
      schedule: work => { pending.push(work); }, ...overrides });
  return { objects, native, storage, env, authorize, create, pending, accesses,
    revoke: () => { authorized = false; }, rotate: () => { env.ENCRYPTION_KEY = OTHER_KEY; },
    afterIo: (action: () => void) => { afterIo = action; },
    afterCommit: (action: (keys: string[]) => void) => { afterCommit = action; } };
}
const read = (f: ReturnType<typeof boundary>, scope = binding) => readRawCapture({ binding: scope, storage: f.storage });
const incomplete = { status: 'incomplete', receipt: null, records: [] };
async function saved(f = boundary(), scope = binding) {
  const capture = f.create(scope);
  capture.record('observed', () => ({ authorization: `Bearer ${CANARY}`, text: 'visible', bytes: [0, 255, 128] }));
  expect((await capture.finish('eof')).status).toBe('complete');
  return f;
}

// Private v1 codec contract, used to construct authenticated malformed archives, not to bypass the reader.
const aad = (scope: RawCaptureBinding, ordinal: number | 'receipt', frame?: { record: number; part: number }) => {
  const identity = scope.scope.kind === 'observation' ? ['observation', scope.scope.observationId]
    : ['activity', scope.scope.activityId, scope.scope.generation];
  const context = JSON.stringify(['codeflare-operator-raw-v1', scope.ownerKey, scope.installationId,
    scope.releaseId, scope.captureId, ...identity]);
  return JSON.stringify([context, ordinal, frame?.record ?? null, frame?.part ?? null]);
};
type Manifest = { version: number; receipt: { status: string; captureId: string; records: number;
  segments: number; bytes: number; termination: string };
  frames: Array<{ record: number; part: number; bytes: number; digest: string }> };
async function rewriteManifest(f: ReturnType<typeof boundary>, change: (manifest: Manifest) => void | Promise<void>,
  receiptAad = aad(binding, 'receipt')) {
  const key = (await getOrImportKey({ ENCRYPTION_KEY: KEY }))!;
  const path = [...f.objects.keys()].find(key => key.endsWith('/receipt'))!;
  const manifest = JSON.parse(await decryptFromKV(f.objects.get(path)!.slice(3), key, aad(binding, 'receipt'))) as Manifest;
  await change(manifest);
  f.objects.set(path, await encryptForKV(JSON.stringify(manifest), key, receiptAad));
}

describe('REQ-OPERATOR-090/091: encrypted private raw artifact, independent verified readback', () => {
  it('rebuilds >256 KiB binary and Unicode across arbitrary UTF-8 frame boundaries without console truncation', async () => {
    const f = boundary();
    const binary = Array.from({ length: 90_000 }, (_, index) => index % 256);
    const unicode = 'a🦊秘密é'.repeat(40_000);
    const capture = f.create();
    capture.record('request', () => ({ headers: new Headers({ authorization: `Bearer ${CANARY}` }),
      binary, unicode, password: `${CANARY}-password`, token: `${CANARY}-token`,
      thinking: `${CANARY}-private-thinking`, signedUrl: `https://private.test/?token=${CANARY}`,
      nested: { apiKey: `${CANARY}-key`, cookie: `session=${CANARY}` },
      placeholder: 'CF_TOKEN', literal: '[REDACTED]' }));
    capture.record('eof', () => ({ received: binary.length }));
    const receipt = await capture.finish('eof');
    expect(receipt).toMatchObject({ status: 'complete', records: 2, termination: 'eof' });
    expect(receipt.bytes).toBeGreaterThan(256 * 1024);
    expect(receipt.segments).toBeGreaterThan(8);
    const result = await read(f, { ...binding, scope: { observationId: 'observation-1', kind: 'observation' } });
    expect(result).toEqual({ status: 'complete', receipt, records: [
      { stage: 'request', value: { headers: { authorization: `Bearer ${CANARY}` }, binary, unicode,
        password: `${CANARY}-password`, token: `${CANARY}-token`, thinking: `${CANARY}-private-thinking`,
        signedUrl: `https://private.test/?token=${CANARY}`, nested: { apiKey: `${CANARY}-key`, cookie: `session=${CANARY}` },
        placeholder: 'CF_TOKEN', literal: '[REDACTED]' } }, { stage: 'eof', value: { received: binary.length } },
    ] });
    for (const ciphertext of f.objects.values()) {
      expect(ciphertext.startsWith('v1:')).toBe(true);
      expect(ciphertext).not.toContain(CANARY);
      expect(ciphertext).not.toContain('Bearer');
      expect(ciphertext).not.toContain('authorization');
    }
    // Private namespace contract: no owner identity or raw values in native locator keys.
    for (const key of f.objects.keys()) {
      expect(key).toMatch(/^operator-raw:v1:[a-f0-9]{64}\/(?:receipt|segment-\d+-\d+-\d+)$/);
      expect(key).not.toContain(binding.ownerKey);
      expect(key).not.toContain(CANARY);
    }
    expect([...f.objects.values()].every(value => Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024)).toBe(true);
  });

  it('retains every one of 2500 small SDK and parent events in coalesced transport frames', async () => {
    const f = boundary(); const capture = f.create();
    const records = Array.from({ length: 2500 }, (_, index) => ({
      stage: index % 2 ? 'sdk-event' : 'parent-observation', value: { index, token: `${CANARY}-${index}` },
    }));
    for (const record of records) capture.record(record.stage, () => record.value);
    const receipt = await capture.finish('eof');
    expect(receipt).toMatchObject({ status: 'complete', records: records.length });
    expect(receipt.segments).toBeLessThan(records.length);
    expect(await read(f)).toEqual({ status: 'complete', receipt, records });
  });

  it('marks native final-manifest overflow incomplete without silently truncating the observed records', async () => {
    const f = boundary(); const capture = f.create();
    for (let index = 0; index < 1200; index++) {
      capture.record('observed', () => index);
      await Promise.all(f.pending);
    }
    const receipt = await capture.finish('eof');
    expect(receipt).toMatchObject({ status: 'incomplete', records: 1200, segments: 1200 });
    expect(await read(f)).toEqual(incomplete);
    expect([...f.objects.keys()].some(key => key.endsWith('/segment-1199-1199-0'))).toBe(true);
    expect([...f.objects.keys()].some(key => key.endsWith('/receipt'))).toBe(false);
  }, 30_000);

  it('snapshots arrays, typed bytes, deep error causes/stacks, descriptors and literal placeholders at observation time', async () => {
    const f = boundary();
    let getterRan = false; let toJsonRan = false;
    const hostile = Object.defineProperty({ toJSON() { toJsonRan = true; throw new Error('Must not run'); } }, 'value', {
      enumerable: true, get() { getterRan = true; throw new Error('Must not run'); },
    });
    let lineage = new Error(`${CANARY}-root`);
    for (let i = 0; i < 24; i++) lineage = new Error(`${CANARY}-cause-${i}`, { cause: lineage });
    const cause = new Error(`${CANARY}-cause`, { cause: lineage });
    const error = new Error(`${CANARY}-outer`, { cause });
    let deep: unknown = { literal: 'YOUR_API_KEY', values: Array.from({ length: 800 }, (_, index) => index) };
    for (let i = 0; i < 80; i++) deep = { child: deep };
    const bytes = Uint8Array.from([0, 255, 128, 13, 10]);
    const value = { deep, error, hostile, bytes, mutable: ['before'] };
    const capture = f.create();
    capture.record('sdk-observation', () => value);
    value.mutable[0] = 'after'; bytes[1] = 0; cause.message = 'changed';
    await capture.finish('failed');
    const result = await read(f);
    expect(result.status).toBe('complete');
    const observed = result.records[0].value as typeof value;
    expect(observed.mutable).toEqual(['before']);
    expect(observed.bytes).toEqual({ 0: 0, 1: 255, 2: 128, 3: 13, 4: 10 });
    expect(observed.error).toMatchObject({ message: `${CANARY}-outer`, name: 'Error',
      cause: { message: `${CANARY}-cause`, name: 'Error' } });
    expect(observed.error.stack).toContain(`${CANARY}-outer`);
    expect((observed.error.cause as Error).stack).toContain(`${CANARY}-cause`);
    let retained = (observed.error.cause as Error).cause as Error;
    for (let i = 23; i >= 0; i--) {
      expect(retained.message).toBe(`${CANARY}-cause-${i}`);
      expect(retained.stack).toContain(`${CANARY}-cause-${i}`);
      retained = retained.cause as Error;
    }
    expect(retained.message).toBe(`${CANARY}-root`);
    expect(observed.deep).toEqual(deep);
    expect(observed.hostile).toEqual({ toJSON: '[capture unavailable: function]', value: '[capture unavailable: accessor]' });
    expect({ getterRan, toJsonRan }).toEqual({ getterRan: false, toJsonRan: false });
  });

  it('OFF never evaluates supplier, storage or scheduler, and policy is pinned for the session', async () => {
    const f = boundary();
    const evaluated = new Set<string>();
    const forbidden = (name: string): never => { evaluated.add(name); throw new Error('OFF evaluated a forbidden boundary'); };
    const off = f.create(binding, { enabled: false, storage: () => forbidden('storage'), schedule: () => forbidden('schedule') });
    off.record('secret', () => forbidden('supplier'));
    expect(await off.finish('cancelled')).toEqual({ status: 'disabled', captureId: binding.captureId,
      records: 0, segments: 0, bytes: 0, termination: 'cancelled' });
    expect(f.objects.size).toBe(0);
    expect([...evaluated]).toEqual([]);
    const options = { binding: structuredClone(binding), enabled: true, storage: async () => f.storage,
      schedule: (work: Promise<unknown>) => { f.pending.push(work); } };
    const on = createRawCapture(options);
    options.enabled = false;
    options.binding.captureId = 'mutated-parent-identity';
    on.record('still-pinned', () => CANARY);
    expect((await on.finish('complete')).status).toBe('complete');
    expect((await read(f)).records).toEqual([{ stage: 'still-pinned', value: CANARY }]);
  });

  it.each(['complete', 'eof', 'cancelled', 'failed'] as const)('distinguishes functional %s from durable completeness', async termination => {
    const f = boundary();
    const capture = f.create();
    capture.record('actually-delivered', () => [0, 255, 2]);
    const firstFinish = capture.finish(termination);
    capture.record('too-late', () => { throw new Error('Finished capture evaluated supplier'); });
    expect(capture.finish('failed')).toBe(firstFinish);
    expect(await firstFinish).toMatchObject({ status: 'complete', termination, records: 1 });
    expect(await capture.finish('failed')).toEqual(await firstFinish);
    expect((await read(f)).receipt).toEqual(await firstFinish);
  });

  it('an unfinished capture is incomplete, while a verified zero-record finish is explicitly complete', async () => {
    const f = boundary(); const capture = f.create();
    capture.record('observed', () => CANARY);
    await Promise.all(f.pending);
    expect(await read(f)).toEqual(incomplete);
    const empty = boundary();
    expect(await empty.create().finish('eof')).toMatchObject({ status: 'complete', records: 0, segments: 0, bytes: 0 });
    expect(await read(empty)).toMatchObject({ status: 'complete', records: [] });
    expect((await capture.finish('eof')).status).toBe('complete');
  });

  it('accepts an identical transaction replay without changing the artifact', async () => {
    const f = await saved(boundary({ replay: true }));
    expect((await read(f)).records[0].value).toMatchObject({ authorization: `Bearer ${CANARY}` });
  });

  it('fails closed on a rejected transaction even if frame commit acknowledgement was lost', async () => {
    const f = boundary({ ambiguous: true });
    const capture = f.create(); capture.record('private', () => CANARY);
    expect((await capture.finish('eof')).status).toBe('incomplete');
    expect(await read(f)).toEqual(incomplete);
    expect([...f.objects.keys()].some(key => key.endsWith('/segment-0-0-0'))).toBe(true);
  });

  it('rejects conflicting ciphertext without overwriting the original capture', async () => {
    const f = await saved();
    const original = new Map(f.objects);
    const conflict = f.create(); conflict.record('different', () => 'changed');
    expect((await conflict.finish('complete')).status).toBe('incomplete');
    expect(f.objects).toEqual(original);
    expect((await read(f)).records[0].stage).toBe('observed');
  });

  it.each(['missing receipt', 'corrupt receipt', 'missing segment', 'corrupt segment', 'wrong key'])(
    'fails closed with no private partial records for %s', async fault => {
      const f = await saved();
      const paths = [...f.objects.keys()];
      const path = fault.includes('receipt') ? paths[paths.length - 1] : paths[0];
      if (fault.startsWith('missing')) f.objects.delete(path);
      else if (fault.startsWith('corrupt')) {
        const value = f.objects.get(path)!;
        f.objects.set(path, `${value.slice(0, 10)}${value[10] === 'A' ? 'B' : 'A'}${value.slice(11)}`);
      } else f.storage.encryptionKey = OTHER_KEY;
      expect(await read(f)).toEqual(incomplete);
    });

  it.each(['owner', 'observation', 'installation', 'release', 'capture', 'activity generation', 'activity identity', 'scope kind'])(
    'binds %s in AAD even if native storage substitutes original ciphertext under a foreign locator', async field => {
      const original: RawCaptureBinding = field.startsWith('activity ')
        ? { ...binding, scope: { kind: 'activity', activityId: 'activity-1', generation: 3 } } : binding;
      const f = await saved(boundary(), original);
      const foreign = structuredClone(original);
      if (field === 'owner') foreign.ownerKey = 'foreign@example.test';
      if (field === 'observation') foreign.scope = { kind: 'observation', observationId: 'foreign-observation' };
      if (field === 'installation') foreign.installationId = 'foreign-installation';
      if (field === 'release') foreign.releaseId = 'foreign-release';
      if (field === 'capture') foreign.captureId = 'foreign-capture';
      if (field === 'activity generation') foreign.scope = { kind: 'activity', activityId: 'activity-1', generation: 4 };
      if (field === 'activity identity') foreign.scope = { kind: 'activity', activityId: 'foreign-activity', generation: 3 };
      if (field === 'scope kind') foreign.scope = { kind: 'activity', activityId: 'observation-1', generation: 1 };
      const substitutions = new Map([...f.objects].map(([path, body]) => [path.split('/').pop(), body]));
      const storage = { ...f.storage, storage: { ...f.native,
        get: async <T>(key: string) => substitutions.get(key.split('/').pop()) as T | undefined,
      } as unknown as RawCaptureStorage['storage'] };
      expect(await readRawCapture({ binding: foreign, storage })).toEqual(incomplete);
      expect((await read(f, original)).status).toBe('complete');
    });

  it.each(['records', 'segments', 'bytes', 'captureId', 'part', 'record', 'receipt AAD', 'frame AAD'] as const)(
    'rejects an authenticated archive with invalid %s rather than returning false completeness', async fault => {
      const f = await saved();
      await rewriteManifest(f, async manifest => {
        if (fault === 'records' || fault === 'segments' || fault === 'bytes') manifest.receipt[fault]++;
        if (fault === 'captureId') manifest.receipt.captureId = 'foreign-capture';
        if (fault === 'part' || fault === 'record') manifest.frames[0][fault]++;
        if (fault === 'frame AAD') {
          const path = [...f.objects.keys()].find(key => key.endsWith('/segment-0-0-0'))!;
          const key = (await getOrImportKey({ ENCRYPTION_KEY: KEY }))!;
          const plaintext = await decryptFromKV(f.objects.get(path)!.slice(3), key, aad(binding, 0, manifest.frames[0]));
          const ciphertext = await encryptForKV(plaintext, key, 'foreign-frame-AAD');
          f.objects.set(path, ciphertext);
          manifest.frames[0].digest = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ciphertext))).toString('hex');
        }
      }, fault === 'receipt AAD' ? 'foreign-receipt-AAD' : aad(binding, 'receipt'));
      expect(await read(f)).toEqual(incomplete);
    });

  it.each(['segment-1-0-1', 'segment-1-1-0'])('rejects unreceipted trailing parts at %s', async suffix => {
    const f = await saved();
    const path = [...f.objects.keys()].find(key => key.endsWith('/segment-0-0-0'))!;
    f.objects.set(path.replace('segment-0-0-0', suffix), f.objects.get(path)!);
    expect(await read(f)).toEqual(incomplete);
  });

  it('requires exact ciphertext readback after commit before publishing a receipt', async () => {
    const f = boundary(); const capture = f.create();
    f.afterCommit(keys => {
      for (const key of keys) f.objects.set(key, 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    });
    capture.record('private', () => CANARY);
    expect((await capture.finish('eof')).status).toBe('incomplete');
    expect(await read(f)).toEqual(incomplete);
    expect([...f.objects.keys()].some(key => key.endsWith('/receipt'))).toBe(false);
  });

  it('rechecks earlier frames before claiming complete after final receipt commit', async () => {
    const f = boundary(); const capture = f.create();
    f.afterCommit(keys => {
      if (keys.some(key => key.endsWith('/receipt'))) {
        const first = [...f.objects.keys()].find(key => key.endsWith('/segment-0-0-0'))!;
        f.objects.delete(first);
      }
    });
    capture.record('private', () => CANARY);
    expect((await capture.finish('eof')).status).toBe('incomplete');
    expect(await read(f)).toEqual(incomplete);
  });

  it.each([0, -1, 1.5])('rejects invalid native Activity generation %s without persisting evidence', async generation => {
    const f = boundary();
    const invalid: RawCaptureBinding = { ...binding, scope: { kind: 'activity', activityId: 'activity-1', generation } };
    const capture = f.create(invalid); capture.record('private', () => CANARY);
    expect((await capture.finish('eof')).status).toBe('incomplete');
    expect(await read(f, invalid)).toEqual(incomplete);
    expect(f.objects.size).toBe(0);
  });

  it('withholds already authenticated earlier records when the final record is missing', async () => {
    const f = boundary(); const capture = f.create();
    capture.record('first', () => CANARY);
    await Promise.all(f.pending);
    capture.record('last', () => `${CANARY}-tail`);
    expect((await capture.finish('eof')).status).toBe('complete');
    const paths = [...f.objects.keys()]; f.objects.delete(paths[paths.length - 2]);
    expect(await read(f)).toEqual(incomplete);
  });

  it('rejects segment substitution/reordering even when both ciphertext objects are authentic', async () => {
    const f = boundary(); const capture = f.create();
    capture.record('first', () => CANARY.repeat(2_000));
    await capture.finish('eof');
    const [first, second] = [...f.objects.keys()];
    const a = f.objects.get(first)!; f.objects.set(first, f.objects.get(second)!); f.objects.set(second, a);
    expect(await read(f)).toEqual(incomplete);
  });

  it.each(['authority', 'key rotation'] as const)('denies %s races before returning private data or completion', async fault => {
    const f = boundary();
    f.afterIo(fault === 'authority' ? f.revoke : f.rotate);
    const capture = f.create(); capture.record('private', () => CANARY);
    expect((await capture.finish('eof')).status).toBe('incomplete');
    expect(await read(f)).toEqual(incomplete);
    const g = await saved();
    g.afterIo(fault === 'authority' ? g.revoke : g.rotate);
    expect(await read(g)).toEqual(incomplete);
  });

  it('denies revoked authority before protected I/O', async () => {
    const f = boundary(); f.revoke();
    const capture = f.create(); capture.record('private', () => CANARY);
    expect((await capture.finish('complete')).status).toBe('incomplete');
    expect(await read(f)).toEqual(incomplete);
    expect(f.accesses).toEqual([]);
    expect(f.objects.size).toBe(0);
  });

  it.each(['storage', 'scheduler', 'supplier', 'authority', 'key rotation', 'missing encryption', 'bad encryption', 'verification missing', 'transaction failure', 'read failure'])(
    '%s failure cannot replace the original application result/error and never yields a complete artifact', async fault => {
      const f = boundary();
      if (fault === 'authority') f.revoke();
      if (fault === 'key rotation') f.rotate();
      if (fault === 'missing encryption') f.storage.encryptionKey = '';
      if (fault === 'bad encryption') f.storage.encryptionKey = 'invalid';
      if (fault === 'verification missing') {
        function missing<T>(key: string): Promise<T | undefined>;
        function missing<T>(keys: string[]): Promise<Map<string, T>>;
        async function missing<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
          return Array.isArray(key) ? new Map<string, T>() : undefined;
        }
        f.native.get = missing;
      }
      if (fault === 'transaction failure') f.native.transaction = async () => { throw new Error('Native write failed'); };
      if (fault === 'read failure') f.native.get = async () => { throw new Error('Native read failed'); };
      const capture = f.create(binding, fault === 'storage' ? { storage: async () => { throw new Error('Unavailable'); } }
        : fault === 'scheduler' ? { schedule: () => { throw new Error('Scheduler unavailable'); } } : {});
      const original = new Error('Original application error', { cause: CANARY });
      const result = { unchanged: true };
      const observe = (session: RawCapture, lazy: () => unknown) => session.record('application', lazy);
      observe(capture, () => { if (fault === 'supplier') throw original; return original; });
      const execute = () => { observe(capture, () => result); return result; };
      expect(execute()).toBe(result);
      const reject = () => { observe(capture, () => original); throw original; };
      try { reject(); } catch (error) { expect(error).toBe(original); }
      expect((await capture.finish('failed')).status).toBe('incomplete');
      expect(await read(f)).toEqual(incomplete);
    });

});

describe('owner raw storage: existing private DO state and deployment encryption key only', () => {
  it('uses the original native delegate for writer and independent reader without additional configuration', async () => {
    const f = boundary();
    const scope: RawCaptureBinding = { ...binding, scope: { kind: 'activity', activityId: 'activity-1', generation: 7 } };
    const capture = f.create(scope, {
      storage: () => createOwnerRawCaptureStorage(f.env, f.native, f.authorize),
    });
    const value = { token: CANARY, password: `${CANARY}-password`, result: [0, 255, 128] };
    capture.record('sdk-tool-output', () => value);
    const receipt = await capture.finish('eof');
    expect(receipt).toMatchObject({ status: 'complete', records: 1 });
    const storage = await createOwnerRawCaptureStorage(f.env, f.native, f.authorize);
    expect(await readRawCapture({ binding: scope, storage })).toEqual({ status: 'complete', receipt,
      records: [{ stage: 'sdk-tool-output', value }] });
    expect([...f.objects.values()].every(value => value.startsWith('v1:') && !value.includes(CANARY))).toBe(true);
  });

  it('authorizes before any native I/O and fails closed without a deployment key', async () => {
    const f = boundary();
    await expect(createOwnerRawCaptureStorage(f.env, f.native, async () => { throw new Error('Denied'); })).rejects.toThrow();
    await expect(createOwnerRawCaptureStorage({}, f.native, f.authorize)).rejects.toThrow();
    await expect(createOwnerRawCaptureStorage({ ENCRYPTION_KEY: 'invalid' }, f.native, f.authorize)).rejects.toThrow();
    expect(f.accesses).toEqual([]);
    expect(f.objects.size).toBe(0);
  });

  it.each(['key rotation', 'key removal', 'authority revoked'] as const)(
    'rejects a stale descriptor after %s before protected I/O', async fault => {
      const f = boundary();
      let authorized = true;
      const storage = await createOwnerRawCaptureStorage(f.env, f.native, async () => {
        if (!authorized) throw new Error('Revoked');
      });
      if (fault === 'key rotation') f.env.ENCRYPTION_KEY = OTHER_KEY;
      if (fault === 'key removal') f.env.ENCRYPTION_KEY = '';
      if (fault === 'authority revoked') authorized = false;
      const capture = f.create(binding, { storage: async () => storage });
      capture.record('private', () => CANARY);
      expect((await capture.finish('eof')).status).toBe('incomplete');
      expect(await readRawCapture({ binding, storage })).toEqual(incomplete);
      expect(f.accesses).toEqual([]);
      expect(f.objects.size).toBe(0);
    });

  it.each(['key rotation', 'authority revoked'] as const)(
    'rechecks factory authority after native I/O on %s', async fault => {
      const f = boundary();
      let authorized = true;
      const authorize = async () => { if (!authorized) throw new Error('Revoked'); };
      const storage = await createOwnerRawCaptureStorage(f.env, f.native, authorize);
      const capture = f.create(binding, { storage: async () => storage });
      capture.record('observed', () => CANARY);
      expect((await capture.finish('eof')).status).toBe('complete');
      f.afterIo(() => { if (fault === 'key rotation') f.env.ENCRYPTION_KEY = OTHER_KEY; else authorized = false; });
      expect(await readRawCapture({ binding, storage })).toEqual(incomplete);
    });

  it('keeps simultaneous original DO contexts independent even with identical capture bindings', async () => {
    const first = boundary(); const second = boundary();
    const a = first.create(binding, { storage: () => createOwnerRawCaptureStorage(first.env, first.native, first.authorize) });
    const b = second.create(binding, { storage: () => createOwnerRawCaptureStorage(second.env, second.native, second.authorize) });
    a.record('first-parent', () => `${CANARY}-first`);
    b.record('second-parent', () => `${CANARY}-second`);
    expect((await Promise.all([a.finish('eof'), b.finish('failed')])).map(receipt => receipt.status)).toEqual(['complete', 'complete']);
    const storageA = await createOwnerRawCaptureStorage(first.env, first.native, first.authorize);
    const storageB = await createOwnerRawCaptureStorage(second.env, second.native, second.authorize);
    expect((await readRawCapture({ binding, storage: storageA })).records).toEqual([{ stage: 'first-parent', value: `${CANARY}-first` }]);
    expect((await readRawCapture({ binding, storage: storageB })).records).toEqual([{ stage: 'second-parent', value: `${CANARY}-second` }]);
  });
});
