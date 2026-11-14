import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { encryptForKV, decryptFromKV, getOrImportKey } from '../../lib/kv-crypto';
import { resolveProspectiveRenovateRepository } from '../../operators/renovate-prospective';
import type { Env } from '../../types';
import { createOwnerRawCaptureStorage, createRawCapture, readRawCapture, verifyRawCapture, discoverRawCaptures, exportRawCapture, captureRawInteraction, captureRawTransaction,
  type RawCaptureBinding, type RawCaptureScope, type RawCaptureStorage, type RawCapture, type RawCaptureReceipt } from '../../operators/raw-capture-storage';

// Synthetic values only. The native boundary retains ciphertext, never a console facsimile.
const CANARY = 'SYNTHETIC_RAW_PRIVATE_CANARY_秘密_🦊';
const KEY = Buffer.alloc(32, 17).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 23).toString('base64');
const binding: RawCaptureBinding = { ownerKey: 'owner@example.test',
  installationId: 'installation-1', releaseId: 'release-1', captureId: 'capture-1',
  scope: { kind: 'observation', observationId: 'observation-1' } };

function boundary(options: { ambiguous?: boolean; replay?: boolean; rejectWrite?: (key: string) => boolean } = {}) {
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
    async list<T>(options: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> {
      accesses.push(options.prefix ?? '');
      const result = new Map([...objects].filter(([key]) => key.startsWith(options.prefix ?? '')
        && (!options.startAfter || key > options.startAfter)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .slice(0, options.limit ?? objects.size).map(([key, value]) => [key, value as T]));
      completeIo();
      return result;
    },
    transaction<T>(closure: (tx: DurableObjectTransaction) => Promise<T>): Promise<T> {
      const work = transactions.then(async () => {
        const staged = new Map(objects);
        const written: string[] = [];
        const tx = {
          async get<V>(key: string): Promise<V | undefined> { accesses.push(key); return staged.get(key) as V | undefined; },
          async put(key: string, value: string) {
            if (options.rejectWrite?.(key)) throw new Error('Synthetic native write failure');
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
const scopeOf = (value: RawCaptureBinding): RawCaptureScope => ({ ownerKey: value.ownerKey, scope: value.scope });
const scope = scopeOf(binding);
const undiscoverable = { status: 'incomplete', bindings: [], cursor: null };
const discover = (f: ReturnType<typeof boundary>, target = scope, cursor?: string) => discoverRawCaptures({
  scope: target, storage: f.storage, cursor,
  authorize: async requested => {
    if (requested.ownerKey !== binding.ownerKey || JSON.stringify(requested.scope) !== JSON.stringify(target.scope))
      throw new Error('Synthetic owner/scope denied');
  },
});
async function saved(f = boundary(), scope = binding) {
  const capture = f.create(scope);
  capture.record('observed', () => ({ authorization: `Bearer ${CANARY}`, text: 'visible', bytes: [0, 255, 128] }));
  expect((await capture.finish('eof')).status).toBe('complete');
  return f;
}

it('immediate parent finalization retains the refused HTTP body through its delayed EOF', async () => {
  const f = boundary();
  const capture = f.create();
  const prefix = new TextEncoder().encode(`${CANARY}:prefix 漢🎉`);
  const tail = new TextEncoder().encode(`${CANARY}:delayed tail`);
  let first = true;
  const gate: { release?: () => void } = {};
  const delayed = new Promise<void>(resolve => { gate.release = resolve; });
  const response = new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) { first = false; controller.enqueue(prefix); return; }
      await delayed; controller.enqueue(tail); controller.close();
    },
  }, { highWaterMark: 0 }), { status: 403 });
  try {
    await expect(resolveProspectiveRenovateRepository({ env: {} as Env,
      exports: { GitHubInterceptor: () => ({ fetch: async () => response,
        connect: () => { throw Error('No sockets'); } }) },
      repository: 'acme/updates', human: { email: 'owner@example.test' }, bucket: 'owner',
      current: async () => true, capture,
    })).rejects.toThrow('Incomplete Renovate scan');
    const finished = capture.finish('failed');
    gate.release?.();
    expect((await finished).status).toBe('complete');
    const archive = await read(f);
    expect(archive.status).toBe('complete');
    const chunks = archive.records.filter(record => record.stage === 'discovery-response-chunk')
      .map(record => record.value as { offset: number; bytes: number[] }).sort((a, b) => a.offset - b.offset);
    expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.bytes)))).toEqual(Buffer.concat([prefix, tail]));
    expect(archive.records).toContainEqual({ stage: 'discovery-response-eof',
      value: expect.objectContaining({ offset: prefix.length + tail.length }) });
    expect([...f.objects.values()].join('')).not.toContain(CANARY);
  } finally { gate.release?.(); }
});

it('retains complete interaction inputs/results/original errors before projections, with no private truncation', async () => {
  const f = boundary();
  const capture = f.create();
  let deep: unknown = { secret: CANARY };
  for (let index = 0; index < 80; index++) deep = { child: deep };
  const request = { token: CANARY.repeat(12000), deep, values: Array.from({ length: 1500 }, (_, index) => ({ index, text: CANARY })) };
  const response = { ...request, result: 'original result' };
  const original = new Error(CANARY, { cause: new Error(`Cause ${CANARY}`) });
  expect(await captureRawInteraction(capture, 'success', () => request, async () => response)).toBe(response);
  await expect(captureRawInteraction(capture, 'failure', () => request, async () => { throw original; })).rejects.toBe(original);
  expect((await capture.finish('failed')).status).toBe('complete');
  const archive = await read(f);
  expect(archive.status).toBe('complete');
  expect(archive.records).toContainEqual({ stage: 'success-request', value: request });
  expect(archive.records).toContainEqual({ stage: 'success-response', value: response });
  expect(archive.records).toContainEqual({ stage: 'failure-request', value: request });
  expect(archive.records.find(record => record.stage === 'failure-error')?.value).toMatchObject({
    message: CANARY, stack: original.stack, cause: { message: `Cause ${CANARY}`, stack: original.cause instanceof Error ? original.cause.stack : undefined },
  });
  expect([...f.objects.values()].join('')).not.toContain(CANARY);
});

it('OFF never evaluates interaction suppliers and diagnostic failure preserves results and identical throws', async () => {
  const f = boundary();
  const off = f.create(binding, { enabled: false });
  const supplier = () => { throw Error('Optional supplier must not execute'); };
  const result = { original: true };
  expect(await captureRawInteraction(off, 'off', supplier, async () => result)).toBe(result);
  expect(await captureRawInteraction(undefined, 'absent', supplier, async () => result)).toBe(result);
  expect((await off.finish('complete')).status).toBe('disabled');
  expect(f.objects.size).toBe(0);
  const failed = boundary({ rejectWrite: () => true }).create();
  const original = Error(CANARY);
  expect(await captureRawInteraction(failed, 'success', () => result, async () => result)).toBe(result);
  await expect(captureRawInteraction(failed, 'failure', () => result, async () => { throw original; })).rejects.toBe(original);
  expect((await failed.finish('failed')).status).toBe('incomplete');
});

it('captures business transaction reads and computed writes without entering its capture sink before commit', async () => {
  const f = boundary();
  let businessTransactionOpen = false;
  const capture = f.create(binding, { storage: async () => {
    if (businessTransactionOpen) throw Error('Capture cannot nest its transaction in the business transaction');
    return f.storage;
  } });
  const original = { secret: CANARY, revision: 1 };
  const updated = { ...original, revision: 2 };
  expect(await captureRawTransaction(capture, async trace => {
    businessTransactionOpen = true;
    try {
      trace?.record('read', () => original);
      trace?.record('write', () => updated);
      return updated;
    } finally { businessTransactionOpen = false; }
  })).toBe(updated);
  expect((await capture.finish('complete')).status).toBe('complete');
  expect((await read(f)).records).toEqual([{ stage: 'read', value: original }, { stage: 'write', value: updated }]);
});

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
  it('flush durably writes the private v1 frame before accepting another diagnostic chunk', async () => {
    const f = boundary();
    const capture = f.create();
    capture.record('first-chunk', () => CANARY);
    await capture.flush();
    // Private v1 codec contract: the committed frame must exist before a final receipt.
    const ciphertext = [...f.objects].find(([name]) => name.endsWith('/segment-0-0-0'))?.[1];
    expect(ciphertext).toBeDefined();
    const key = (await getOrImportKey({ ENCRYPTION_KEY: KEY }))!;
    const encoded = await decryptFromKV(ciphertext!.slice(3), key, aad(binding, 0, { record: 0, part: 0 }));
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual([{ stage: 'first-chunk', value: CANARY }]);
    expect(await read(f)).toEqual(incomplete);
    capture.record('second-chunk', () => `${CANARY}-second`);
    await capture.flush();
    expect((await capture.finish('eof')).status).toBe('complete');
    expect((await read(f)).records).toEqual([
      { stage: 'first-chunk', value: CANARY }, { stage: 'second-chunk', value: `${CANARY}-second` },
    ]);
  });

  it.each(['write failure', 'authority revoked'] as const)('flush cannot acknowledge persistence after %s', async fault => {
    const f = boundary({ rejectWrite: () => fault === 'write failure' });
    const capture = f.create();
    capture.record('private-chunk', () => CANARY);
    if (fault === 'authority revoked') f.revoke();
    await expect(capture.flush()).rejects.toThrow('Private raw capture unavailable');
    expect((await capture.finish('eof')).status).toBe('incomplete');
    expect(await read(f)).toEqual(incomplete);
  });

  it('incrementally verifies every large private record without changing collecting readback', async () => {
    const f = boundary();
    const capture = f.create();
    const expected = Array.from({ length: 8 }, (_, index) => ({ stage: 'sdk-chunk',
      value: { index, password: CANARY, unicode: '漢🦊'.repeat(10_000) } }));
    for (const record of expected) {
      capture.record(record.stage, () => record.value);
      await capture.flush();
    }
    const receipt = await capture.finish('eof');
    expect(receipt.status).toBe('complete');
    expect(receipt.bytes).toBeGreaterThan(256 * 1024);
    const recovered: Array<{ stage: string; value: unknown }> = [];
    expect(await verifyRawCapture({ binding, storage: f.storage }, record => { recovered.push(record); }))
      .toEqual({ status: 'complete', receipt });
    expect(recovered).toEqual(expected);
    expect(await read(f)).toEqual({ status: 'complete', receipt, records: expected });
  });

  it('incremental verification refuses a missing tail or rejected record consumer', async () => {
    const f = await saved();
    await expect(verifyRawCapture({ binding, storage: f.storage }, () => { throw new Error('Synthetic invalid record'); }))
      .resolves.toEqual({ status: 'incomplete', receipt: null });
    await rewriteManifest(f, manifest => { manifest.receipt.records++; });
    expect(await verifyRawCapture({ binding, storage: f.storage }, () => {}))
      .toEqual({ status: 'incomplete', receipt: null });
    expect(await read(f)).toEqual(incomplete);
  });

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
      expect(key).toMatch(/^(?:operator-raw:v1:[a-f0-9]{64}\/(?:receipt|segment-\d+-\d+-\d+)|operator-raw-index:v1:[a-f0-9]{64}\/capture-[a-f0-9]{64})$/);
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
    off.defer?.(async () => forbidden('producer'));
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

  it('seals parent admission immediately while retaining only already admitted producer writes through finalization', async () => {
    const f = boundary();
    const capture = f.create();
    const gate: { release?: () => void } = {};
    const ready = new Promise<void>(resolve => { gate.release = resolve; });
    const state: { producer?: Pick<RawCapture, 'record' | 'flush'> } = {};
    capture.defer?.(async writer => {
      state.producer = writer;
      await ready;
      writer.record('admitted-tail', () => CANARY);
      await writer.flush?.();
    });
    const finished = capture.finish('failed');
    capture.record('late-parent', () => { throw Error('Sealed parent supplier executed'); });
    capture.defer?.(async () => { throw Error('Late producer executed'); });
    gate.release?.();
    expect(await finished).toMatchObject({ status: 'complete', records: 1 });
    state.producer?.record('late-producer', () => { throw Error('Settled producer supplier executed'); });
    expect(capture.finish('complete')).toBe(finished);
    expect((await read(f)).records).toEqual([{ stage: 'admitted-tail', value: CANARY }]);
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
      const path = paths.find(path => fault.includes('receipt') ? path.endsWith('/receipt') : path.endsWith('/segment-0-0-0'))!;
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
    const path = [...f.objects.keys()].find(path => path.endsWith('/segment-1-1-0'))!; f.objects.delete(path);
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

// Private export NDJSON wire contract: record order and a final verified receipt,
// independent of how UTF-8 bytes or JSON lines are chunked by the stream.
type ExportFrame = { type: 'record'; stage: string; value: unknown } | { type: 'complete'; receipt: RawCaptureReceipt };
async function* exportFrames(response: Response): AsyncGenerator<ExportFrame> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        yield JSON.parse(line) as ExportFrame;
      }
      if (done) {
        expect(pending).toBe('');
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

describe('REQ-OPERATOR-091 AC6/7: bounded private raw READ export', () => {
  it('exports ordered multi-batch >256 KiB original stages, deep Unicode, binary and full error causes/stacks without private redaction', async () => {
    const f = boundary();
    const capture = f.create();
    let deep: unknown = { token: CANARY, literal: '[REDACTED]', placeholder: 'CF_TOKEN' };
    for (let index = 0; index < 80; index++) deep = { child: deep };
    let error = new Error(`${CANARY}-root`);
    let errorValue: unknown = { name: error.name, message: error.message, stack: error.stack };
    for (let index = 0; index < 24; index++) {
      error = new Error(`${CANARY}-cause-${index}`, { cause: error });
      errorValue = { name: error.name, message: error.message, stack: error.stack, cause: errorValue };
    }
    const records = [
      { stage: 'pre-admission\n秘密🦊', value: { deep, authorization: `Bearer ${CANARY}`, unicode: '漢🦊é'.repeat(40_000) } },
      { stage: 'delivered-binary', value: { bytes: Array.from({ length: 90_000 }, (_, index) => index % 256) } },
      { stage: 'original-error', value: errorValue },
      { stage: 'eof', value: { original: true, password: CANARY } },
    ];
    for (const record of records) {
      capture.record(record.stage, () => record.stage === 'original-error' ? error : record.value);
      await capture.flush();
    }
    const receipt = await capture.finish('failed');
    expect(receipt.status).toBe('complete');
    expect(receipt.bytes).toBeGreaterThan(256 * 1024);
    const encrypted = new Map(f.objects);
    const response = await exportRawCapture({ binding, storage: f.storage });
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const frames: ExportFrame[] = [];
    for await (const frame of exportFrames(response)) frames.push(frame);
    // Named wire contract: exact full reconstruction followed by the sole completion frame.
    expect(frames).toEqual([...records.map(record => ({ type: 'record', ...record })), { type: 'complete', receipt }]);
    expect(await read(f)).toEqual({ status: 'complete', receipt, records });
    expect(f.objects).toEqual(encrypted);
    expect([...f.objects.values()].every(value => value.startsWith('v1:') && !value.includes(CANARY))).toBe(true);
  });

  it.each(['missing receipt', 'missing frame', 'corrupt receipt', 'corrupt ciphertext', 'invalid manifest', 'storage failure', 'revoked authority'] as const)(
    'refuses %s during full preflight before returning a successful data response', async fault => {
      const f = boundary(); const capture = f.create();
      for (let index = 0; index < 3; index++) {
        capture.record('observed', () => ({ index, token: CANARY }));
        await capture.flush();
      }
      expect((await capture.finish('eof')).status).toBe('complete');
      if (fault === 'invalid manifest') await rewriteManifest(f, manifest => { manifest.receipt.records++; });
      if (fault.startsWith('missing') || fault.startsWith('corrupt')) {
        const path = [...f.objects.keys()].find(path => fault.includes('receipt')
          ? path.endsWith('/receipt') : /\/segment-\d+-2-0$/.test(path))!;
        if (fault.startsWith('missing')) f.objects.delete(path);
        else {
          const value = f.objects.get(path)!;
          f.objects.set(path, `${value.slice(0, 10)}${value[10] === 'A' ? 'B' : 'A'}${value.slice(11)}`);
        }
      }
      if (fault === 'storage failure') f.native.get = async () => { throw new Error(`Private storage failure ${CANARY}`); };
      if (fault === 'revoked authority') f.revoke();
      const response = await exportRawCapture({ binding, storage: f.storage });
      expect(response.ok).toBe(false);
      const body = await response.text();
      expect(body).not.toContain(CANARY);
      expect(body).not.toContain(binding.ownerKey);
      expect(body).not.toContain(binding.captureId);
      expect(body).not.toContain('Private storage failure');
      expect(body).not.toContain('"type":"complete"');
    });

  it('backpressures separate persisted batches instead of prebuffering the full export before consumer demand', async () => {
    const f = boundary(); const capture = f.create();
    const records = Array.from({ length: 6 }, (_, index) => ({ stage: 'sdk-event',
      value: { index, unicode: '秘密🦊'.repeat(12_000), token: CANARY } }));
    for (const record of records) { capture.record(record.stage, () => record.value); await capture.flush(); }
    expect((await capture.finish('eof')).status).toBe('complete');
    const response = await exportRawCapture({ binding, storage: f.storage });
    expect(response.status).toBe(200);
    const frames = exportFrames(response);
    try {
      expect(await frames.next()).toEqual({ done: false, value: { type: 'record', ...records[0] } });
      // The consumer pauses after one record. A far-future persisted batch must
      // still be needed, not already collected into a whole-archive data response.
      const tail = [...f.objects.keys()].find(path => /\/segment-\d+-5-0$/.test(path))!;
      f.objects.delete(tail);
      const delivered: ExportFrame[] = [];
      let failed = false;
      try { for await (const frame of frames) delivered.push(frame); } catch { failed = true; }
      expect(failed).toBe(true);
      expect(delivered.some(frame => frame.type === 'complete')).toBe(false);
    } finally { await frames.return(undefined); }
  });

  it.each(['storage failure', 'authority revoked', 'key rotated'] as const)(
    'errors the second-pass stream without completion after %s despite HTTP 200 and an authenticated prefix', async fault => {
      const f = boundary(); const capture = f.create();
      for (let index = 0; index < 6; index++) {
        capture.record('observed', () => ({ index, token: CANARY }));
        await capture.flush();
      }
      expect((await capture.finish('eof')).status).toBe('complete');
      const response = await exportRawCapture({ binding, storage: f.storage });
      expect(response.status).toBe(200);
      const frames = exportFrames(response);
      try {
        expect(await frames.next()).toEqual({ done: false,
          value: { type: 'record', stage: 'observed', value: { index: 0, token: CANARY } } });
        if (fault === 'storage failure') f.native.get = async () => { throw new Error(`Private read failed ${CANARY}`); };
        if (fault === 'authority revoked') f.revoke();
        if (fault === 'key rotated') f.rotate();
        const delivered: ExportFrame[] = [];
        let failed = false;
        try { for await (const frame of frames) delivered.push(frame); } catch { failed = true; }
        expect(failed).toBe(true);
        expect(delivered.some(frame => frame.type === 'complete')).toBe(false);
      } finally { await frames.return(undefined); }
    });

  it('denies an initially invalid live session before private export even while local read authority remains valid', async () => {
    const f = await saved();
    f.storage.authorizePass = async () => { throw new Error(`Private session expired ${CANARY}`); };
    const response = await exportRawCapture({ binding, storage: f.storage });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain(CANARY);
    expect(body).not.toContain(binding.ownerKey);
    expect(body).not.toContain('Private session expired');
    expect(body).not.toContain('"type":"record"');
    expect(body).not.toContain('"type":"complete"');
    expect((await read(f)).status).toBe('complete');
  });

  it.each(['after preflight', 'after the first exported record'] as const)(
    'withholds completion when the live session is revoked %s despite continued local read authority', async timing => {
      const f = boundary(); const capture = f.create();
      for (let index = 0; index < 3; index++) {
        capture.record('observed', () => ({ index, token: CANARY }));
        await capture.flush();
      }
      const receipt = await capture.finish('eof');
      expect(receipt.status).toBe('complete');
      let live = true;
      f.storage.authorizePass = async () => {
        if (!live) throw new Error(`Private session revoked ${CANARY}`);
      };
      if (timing === 'after preflight') {
        const get = f.native.get.bind(f.native);
        f.native.get = (async (key: string) => {
          const value = await get<unknown>(key);
          // Private v1 wire contract: revoke after the preflight's final native read.
          if (key.endsWith('/segment-3-3-0')) live = false;
          return value;
        }) as typeof f.native.get;
      }
      const response = await exportRawCapture({ binding, storage: f.storage });
      expect(response.status).toBe(200);
      const frames = exportFrames(response);
      const delivered: ExportFrame[] = [];
      try {
        if (timing === 'after the first exported record') {
          expect(await frames.next()).toEqual({ done: false,
            value: { type: 'record', stage: 'observed', value: { index: 0, token: CANARY } } });
          live = false;
        }
        let failed = false;
        try { for await (const frame of frames) delivered.push(frame); } catch { failed = true; }
        expect(failed).toBe(true);
        expect(delivered.some(frame => frame.type === 'complete')).toBe(false);
        if (timing === 'after preflight') expect(delivered).toEqual([]);
      } finally { await frames.return(undefined); }
      expect((await read(f)).receipt).toEqual(receipt);
    });

  it('denies a live-session revocation while verified completion is waiting for consumer demand', async () => {
    const f = await saved();
    let live = true;
    f.storage.authorizePass = async () => {
      if (!live) throw new Error(`Private session revoked ${CANARY}`);
    };
    const response = await exportRawCapture({ binding, storage: f.storage });
    expect(response.status).toBe(200);
    const frames = exportFrames(response);
    try {
      expect(await frames.next()).toEqual({ done: false, value: { type: 'record', stage: 'observed',
        value: { authorization: `Bearer ${CANARY}`, text: 'visible', bytes: [0, 255, 128] } } });
      // Remaining in-memory absence/role checks settle in microtasks. Yield a
      // turn without demanding the footer, then revoke the live session.
      await new Promise<void>(resolve => { setTimeout(resolve, 0); });
      live = false;
      const delivered: ExportFrame[] = [];
      let failed = false;
      try { for await (const frame of frames) delivered.push(frame); } catch { failed = true; }
      expect(failed).toBe(true);
      expect(delivered.some(frame => frame.type === 'complete')).toBe(false);
      expect((await read(f)).status).toBe('complete');
    } finally { await frames.return(undefined); }
  });

  it('rechecks authority at the final second-pass storage boundary before emitting a completion receipt', async () => {
    const f = await saved();
    const response = await exportRawCapture({ binding, storage: f.storage });
    expect(response.status).toBe(200);
    const get = f.native.get.bind(f.native);
    f.native.get = (async (key: string) => {
      const value = await get<unknown>(key);
      // Private v1 wire contract: absence of the next batch is the final read.
      if (key.endsWith('/segment-1-1-0')) f.revoke();
      return value;
    }) as typeof f.native.get;
    const delivered: ExportFrame[] = [];
    let failed = false;
    try { for await (const frame of exportFrames(response)) delivered.push(frame); } catch { failed = true; }
    expect(failed).toBe(true);
    expect(delivered.some(frame => frame.type === 'complete')).toBe(false);
  });

  it('allows consumer interruption without delivering completion or mutating the retained archive', async () => {
    const f = boundary(); const capture = f.create();
    for (let index = 0; index < 6; index++) {
      capture.record('observed', () => ({ index, token: CANARY }));
      await capture.flush();
    }
    const receipt = await capture.finish('eof');
    expect(receipt.status).toBe('complete');
    const encrypted = new Map(f.objects);
    const response = await exportRawCapture({ binding, storage: f.storage });
    const frames = exportFrames(response);
    expect(await frames.next()).toEqual({ done: false,
      value: { type: 'record', stage: 'observed', value: { index: 0, token: CANARY } } });
    // Returning the reader cancels its body rather than draining/acknowledging it.
    await frames.return(undefined);
    expect(response.body!.locked).toBe(false);
    const cancelled = response.body!.getReader();
    try { expect(await cancelled.read()).toEqual({ done: true, value: undefined }); }
    finally { cancelled.releaseLock(); }
    expect(f.objects).toEqual(encrypted);
    expect((await read(f)).receipt).toEqual(receipt);
  });

  it('exports a verified zero-record completed archive as completion, not missing evidence', async () => {
    const f = boundary();
    const receipt = await f.create().finish('eof');
    expect(receipt).toMatchObject({ status: 'complete', records: 0, segments: 0, bytes: 0 });
    const response = await exportRawCapture({ binding, storage: f.storage });
    expect(response.status).toBe(200);
    const frames: ExportFrame[] = [];
    for await (const frame of exportFrames(response)) frames.push(frame);
    expect(frames).toEqual([{ type: 'complete', receipt }]);
  });

  it('OFF never manufactures a capture or completion when the private read surface is requested', async () => {
    const f = boundary();
    const off = f.create(binding, { enabled: false });
    off.record('must-not-exist', () => { throw new Error('OFF supplier evaluated'); });
    expect((await off.finish('eof')).status).toBe('disabled');
    const response = await exportRawCapture({ binding, storage: f.storage });
    expect(response.ok).toBe(false);
    expect(await response.text()).not.toContain(CANARY);
    expect(f.objects.size).toBe(0);
    expect(await discover(f)).toEqual({ status: 'complete', bindings: [], cursor: null });
  });
});

describe('REQ-OPERATOR-090/091: scope-discoverable private capture recovery', () => {
  it.each(['observation', 'activity'] as const)('recovers %s evidence without the producer ID, receipt or console', async kind => {
    const f = boundary();
    const known: RawCaptureScope = { ownerKey: binding.ownerKey, scope: kind === 'observation'
      ? binding.scope : { kind: 'activity', activityId: 'activity-1', generation: 7 } };
    await (async () => {
      const capture = f.create({ ...binding, ...known, captureId: crypto.randomUUID() });
      capture.record('private', () => ({ authorization: `Bearer ${CANARY}`, password: CANARY, bytes: [0, 255] }));
      expect((await capture.finish('eof')).status).toBe('complete');
    })(); // Producer-local capture ID, capture and receipt are now gone.
    const page = await discover(f, known);
    expect(page).toMatchObject({ status: 'complete', cursor: null });
    expect(page.bindings).toHaveLength(1);
    expect(await readRawCapture({ binding: page.bindings[0], storage: f.storage })).toMatchObject({
      status: 'complete', records: [{ stage: 'private', value: { authorization: `Bearer ${CANARY}`, password: CANARY, bytes: [0, 255] } }],
    });
    for (const [key, value] of f.objects) {
      expect(key).not.toContain(binding.ownerKey);
      expect(key).not.toContain(page.bindings[0].captureId);
      expect(value.startsWith('v1:')).toBe(true);
      expect(value).not.toContain(CANARY);
      expect(value).not.toContain(page.bindings[0].captureId);
    }
  });

  it('retains concurrent captures and pages immutable locators without losing an append', async () => {
    const f = boundary();
    const bindings = Array.from({ length: 103 }, () => ({ ...binding, captureId: crypto.randomUUID() }));
    const receipts = await Promise.all(bindings.map(async (binding, index) => {
      const capture = f.create(binding); capture.record('event', () => index); return capture.finish('eof');
    }));
    expect(receipts.every(receipt => receipt.status === 'complete')).toBe(true);
    const first = await discover(f);
    expect(first.status).toBe('complete');
    expect(first.bindings.length).toBeGreaterThan(0);
    expect(first.bindings.length).toBeLessThan(bindings.length);
    expect(first.cursor).not.toBeNull();
    // A new capture cannot overwrite any previously stored locator.
    const late = f.create({ ...binding, captureId: crypto.randomUUID() });
    late.record('late', () => CANARY);
    expect((await late.finish('eof')).status).toBe('complete');
    const found = [...first.bindings];
    let cursor = first.cursor;
    while (cursor) {
      const page = await discover(f, scope, cursor);
      expect(page.status).toBe('complete');
      found.push(...page.bindings); cursor = page.cursor;
    }
    expect(new Set(found.map(binding => binding.captureId)).size).toBe(found.length);
    for (const binding of bindings) expect(found).toContainEqual(binding);
    // A fresh traversal also finds a concurrent insert that sorted before the previous cursor.
    const all: RawCaptureBinding[] = []; cursor = null;
    do {
      const page = await discover(f, scope, cursor ?? undefined);
      expect(page.status).toBe('complete'); all.push(...page.bindings); cursor = page.cursor;
    } while (cursor);
    expect(all).toHaveLength(104);
    const records = (await Promise.all(all.map(binding => readRawCapture({ binding, storage: f.storage })))).flatMap(result => result.records);
    expect(records).toContainEqual({ stage: 'late', value: CANARY });
  });

  it.each(['write rejected', 'read rejected', 'missing readback', 'corrupt readback', 'authority revoked'] as const)(
    'cannot acknowledge complete when the durable locator has %s', async fault => {
      const f = boundary({ rejectWrite: key => fault === 'write rejected' && key.startsWith('operator-raw-index:') });
      f.afterCommit(keys => {
        const path = keys.find(key => key.startsWith('operator-raw-index:'));
        if (!path) return;
        if (fault === 'read rejected') f.native.get = async () => { throw new Error('Locator read failed'); };
        if (fault === 'missing readback') f.objects.delete(path);
        if (fault === 'corrupt readback') f.objects.set(path, 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        if (fault === 'authority revoked') f.revoke();
      });
      const capture = f.create(); capture.record('private', () => CANARY);
      expect((await capture.finish('eof')).status).toBe('incomplete');
      if (fault === 'write rejected' || fault === 'missing readback')
        expect(await discover(f)).toEqual({ status: 'complete', bindings: [], cursor: null });
      if (fault === 'corrupt readback' || fault === 'authority revoked') expect(await discover(f)).toEqual(undiscoverable);
    });

  it('never publishes a locator for unfinished or invalid archives', async () => {
    const f = boundary(); const capture = f.create(); capture.record('private', () => CANARY);
    await Promise.all(f.pending);
    expect(await discover(f)).toEqual({ status: 'complete', bindings: [], cursor: null });
    f.afterCommit(keys => {
      if (keys.some(key => key.endsWith('/receipt'))) {
        const path = [...f.objects.keys()].find(key => key.endsWith('/segment-0-0-0'))!;
        f.objects.delete(path);
      }
    });
    expect((await capture.finish('eof')).status).toBe('incomplete');
    expect(await discover(f)).toEqual({ status: 'complete', bindings: [], cursor: null });
  });

  it.each(['owner', 'activity', 'generation', 'observation', 'scope kind'] as const)(
    'denies unauthorized %s discovery before protected I/O', async field => {
      const allowed: RawCaptureScope = field === 'activity' || field === 'generation'
        ? { ownerKey: binding.ownerKey, scope: { kind: 'activity', activityId: 'activity-1', generation: 1 } } : scope;
      const f = await saved(boundary(), { ...binding, ...allowed }); f.accesses.length = 0;
      const foreign = structuredClone(allowed);
      if (field === 'owner') foreign.ownerKey = 'foreign-owner';
      if (field === 'observation') foreign.scope = { kind: 'observation', observationId: 'foreign-observation' };
      if (field === 'activity') foreign.scope = { kind: 'activity', activityId: 'foreign-activity', generation: 1 };
      if (field === 'scope kind') foreign.scope = { kind: 'activity', activityId: 'observation-1', generation: 1 };
      if (field === 'generation') foreign.scope = { kind: 'activity', activityId: 'activity-1', generation: 2 };
      expect(await discoverRawCaptures({ scope: foreign, storage: f.storage, authorize: async requested => {
        if (JSON.stringify(requested) !== JSON.stringify(allowed)) throw new Error('Scope denied');
      } })).toEqual(undiscoverable);
      expect(f.accesses).toEqual([]);
    });

  it('isolates activity generations even when the caller is authorized to inspect both', async () => {
    const f = boundary();
    const current: RawCaptureBinding = { ...binding, scope: { kind: 'activity', activityId: 'activity-1', generation: 1 } };
    await saved(f, current);
    expect((await discover(f, scopeOf(current))).bindings).toEqual([current]);
    expect(await discover(f, { ...scopeOf(current), scope: { kind: 'activity', activityId: 'activity-1', generation: 2 } }))
      .toEqual({ status: 'complete', bindings: [], cursor: null });
  });

  it.each(['ciphertext', 'locator substitution', 'foreign owner', 'foreign generation'] as const)(
    'fails closed with no locators on %s tampering', async fault => {
      const f = await saved();
      const path = [...f.objects.keys()].find(key => key.startsWith('operator-raw-index:'))!;
      let target = scope;
      if (fault === 'ciphertext') f.objects.set(path, 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      if (fault === 'locator substitution') {
        f.objects.set(`${path.slice(0, -64)}${'a'.repeat(64)}`, f.objects.get(path)!); f.objects.delete(path);
      }
      if (fault === 'foreign owner') target = { ...scope, ownerKey: 'foreign-owner' };
      if (fault === 'foreign generation') target = { ownerKey: scope.ownerKey, scope: { kind: 'activity', activityId: 'activity-1', generation: 2 } };
      const storage = fault.startsWith('foreign') ? { ...f.storage, storage: { ...f.native,
        list: async <T>(options: { prefix: string }) => new Map([[`${options.prefix}capture-${path.slice(-64)}`, f.objects.get(path) as T]]),
      } as unknown as RawCaptureStorage['storage'] } : f.storage;
      expect(await discoverRawCaptures({ scope: target, storage, authorize: async () => {} })).toEqual(undiscoverable);
    });

  it.each(['owner', 'scope', 'capture', 'installation', 'release'] as const)(
    'rejects an authenticated locator containing a mismatched %s binding without releasing earlier locators', async field => {
      const f = await saved();
      const second = f.create({ ...binding, captureId: 'capture-2' }); second.record('second', () => CANARY);
      expect((await second.finish('eof')).status).toBe('complete');
      const path = [...f.objects.keys()].filter(key => key.startsWith('operator-raw-index:')).sort().at(-1)!;
      const name = path.split('/').at(-1)!;
      // Private index v1 wire contract: authenticated but inconsistent bindings must still fail closed.
      const context = JSON.stringify(['codeflare-operator-raw-index-v1', binding.ownerKey, 'observation', 'observation-1']);
      const additionalData = JSON.stringify([context, name, null, null]);
      const key = (await getOrImportKey({ ENCRYPTION_KEY: KEY }))!;
      const locator = JSON.parse(await decryptFromKV(f.objects.get(path)!.slice(3), key, additionalData)) as { binding: RawCaptureBinding };
      if (field === 'owner') locator.binding.ownerKey = 'foreign-owner';
      if (field === 'scope') locator.binding.scope = { kind: 'observation', observationId: 'foreign-observation' };
      if (field === 'capture') locator.binding.captureId = 'foreign-capture';
      if (field === 'installation') locator.binding.installationId = 'foreign-installation';
      if (field === 'release') locator.binding.releaseId = 'foreign-release';
      f.objects.set(path, await encryptForKV(JSON.stringify(locator), key, additionalData));
      expect(await discover(f)).toEqual(undiscoverable);
    });

  it.each(['revocation', 'key rotation', 'list failure'] as const)('withholds discovery after %s at the list boundary', async fault => {
    const f = await saved();
    if (fault === 'list failure') f.native.list = async () => { throw new Error('List failed'); };
    else f.afterIo(fault === 'revocation' ? f.revoke : f.rotate);
    expect(await discover(f)).toEqual(undiscoverable);
  });

  it('rejects malformed discovery scope and cursors without protected reads', async () => {
    const f = boundary();
    expect(await discover(f, { ownerKey: binding.ownerKey, scope: { kind: 'activity', activityId: 'a', generation: 0 } })).toEqual(undiscoverable);
    expect(await discover(f, scope, 'foreign-prefix/capture-id')).toEqual(undiscoverable);
    expect(f.accesses).toEqual([]);
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
