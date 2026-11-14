import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { Env } from '../types';
import { captureRawValue } from '../../host/src/operator-raw-logging';
import { getOrImportKey, encryptForKV, decryptFromKV } from '../lib/kv-crypto';

const FRAME = 64 * 1024; // Transport framing only; no record or capture length limit.
const identity = z.string().min(1);
const count = z.number().int().nonnegative().safe();
const scopeSchema = z.strictObject({ ownerKey: identity,
  scope: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('observation'), observationId: identity }),
    z.strictObject({ kind: z.literal('activity'), activityId: identity, generation: count.min(1) })]) });
const bindingSchema = scopeSchema.extend({ installationId: identity, releaseId: identity, captureId: identity });
const locatorSchema = z.strictObject({ version: z.literal(1), binding: bindingSchema });
const terminationSchema = z.enum(['complete', 'eof', 'cancelled', 'failed']);
const receiptSchema = z.strictObject({ status: z.literal('complete'), captureId: identity,
  records: count, segments: count, bytes: count, termination: terminationSchema });
const frameSchema = z.strictObject({ record: count, part: count, bytes: z.number().int().min(1).max(FRAME),
  digest: z.string().regex(/^[a-f0-9]{64}$/) });
const manifestSchema = z.strictObject({ version: z.literal(1), receipt: receiptSchema, frames: z.array(frameSchema) });
export type RawCaptureBinding = z.infer<typeof bindingSchema>;
export type RawCaptureScope = z.infer<typeof scopeSchema>;
export interface RawCaptureStorage {
  storage: Pick<DurableObjectStorage, 'get' | 'transaction' | 'list'>;
  encryptionKey: string;
  authorize: () => Promise<void>;
}
type Termination = z.infer<typeof terminationSchema>;
export type RawCaptureReceipt = Omit<z.infer<typeof receiptSchema>, 'status'> & { status: 'complete' | 'incomplete' | 'disabled' };
export interface RawCapture {
  record(stage: string, lazy: () => unknown): void;
  finish(termination: Termination): Promise<RawCaptureReceipt>;
  /** Optional backpressure for local writers and data-only Root RPC relays. */
  flush?(): Promise<void>;
}
type Frame = z.infer<typeof frameSchema>;
// Preserve authenticated frame coordinates in locators even without a final receipt.
const frameName = (ordinal: number, frame: Pick<Frame, 'record' | 'part'>) => `segment-${ordinal}-${frame.record}-${frame.part}`;
const denied = (): never => { throw new Error('Private raw capture unavailable'); };
async function digest(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('hex');
}

const scopeIdentity = (binding: RawCaptureScope) => binding.scope.kind === 'observation'
  ? ['observation', binding.scope.observationId] : ['activity', binding.scope.activityId, binding.scope.generation];
const captureContext = (binding: RawCaptureBinding) => JSON.stringify(['codeflare-operator-raw-v1', binding.ownerKey,
  binding.installationId, binding.releaseId, binding.captureId, ...scopeIdentity(binding)]);
const indexContext = (scope: RawCaptureScope) => JSON.stringify(['codeflare-operator-raw-index-v1', scope.ownerKey, ...scopeIdentity(scope)]);
const locatorName = async (binding: RawCaptureBinding) => `capture-${await digest(captureContext(binding))}`;

/** Private parent DO state only: no exported diagnostics, file namespace or new authority. */
async function openNamespace(context: string, namespace: string, source: RawCaptureStorage) {
  const native = source.storage;
  const encryptionKey = source.encryptionKey;
  const authorize = source.authorize;
  const guard = async () => {
    await authorize();
    if (source.encryptionKey !== encryptionKey || source.storage !== native) denied();
  };
  await guard();
  const key = await getOrImportKey({ ENCRYPTION_KEY: encryptionKey }) ?? denied();
  await guard();
  const prefix = `${namespace}:v1:${await digest(context)}/`;
  const aad = (ordinal: number | string, frame?: Pick<Frame, 'record' | 'part'>) =>
    JSON.stringify([context, ordinal, frame?.record ?? null, frame?.part ?? null]);
  const get = async (name: string) => {
    await guard();
    const ciphertext = await native.get<unknown>(`${prefix}${name}`);
    await guard();
    if (typeof ciphertext !== 'string' || !/^v1:[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) denied();
    return ciphertext as string;
  };
  const absent = async (name: string) => {
    await guard();
    const value = await native.get<unknown>(`${prefix}${name}`);
    await guard();
    if (value !== undefined) denied();
  };
  const put = async (name: string, plaintext: string, additionalData: string) => {
    const ciphertext = await encryptForKV(plaintext, key, additionalData);
    await guard();
    // Guard the transaction as one I/O boundary; authorize may itself read parent DO state.
    // The original caller's transaction owns immutability, never a global writer/cache.
    await native.transaction(async tx => {
      const existing = await tx.get<unknown>(`${prefix}${name}`);
      if (existing === undefined) await tx.put(`${prefix}${name}`, ciphertext);
      else if (existing !== ciphertext) denied();
    });
    await guard();
    const received = await get(name);
    if (received !== ciphertext || await digest(received) !== await digest(ciphertext)) denied();
    return digest(ciphertext);
  };
  const decrypt = (ciphertext: string, additionalData: string) => {
    if (typeof ciphertext !== 'string' || !/^v1:[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) denied();
    return decryptFromKV(ciphertext.slice(3), key, additionalData);
  };
  const list = async (cursor?: string) => {
    await guard();
    const entries = await native.list<unknown>({ prefix, limit: 100, ...(cursor ? { startAfter: `${prefix}capture-${cursor}` } : {}) });
    await guard();
    return new Map([...entries].map(([path, value]) => {
      if (!path.startsWith(prefix) || !/^capture-[a-f0-9]{64}$/.test(path.slice(prefix.length))) denied();
      return [path.slice(prefix.length), value] as const;
    }));
  };
  return { get, absent, put, decrypt, guard, aad, list };
}

function open(binding: RawCaptureBinding, source: RawCaptureStorage) {
  return openNamespace(captureContext(binding), 'operator-raw', source);
}
function openIndex(scope: RawCaptureScope, source: RawCaptureStorage) {
  return openNamespace(indexContext(scope), 'operator-raw-index', source);
}

async function readLocator(index: Awaited<ReturnType<typeof openIndex>>, scope: RawCaptureScope, name: string, ciphertext: unknown) {
  if (typeof ciphertext !== 'string') return denied();
  const { binding } = locatorSchema.parse(JSON.parse(await index.decrypt(ciphertext, index.aad(name))));
  if (indexContext(binding) !== indexContext(scope) || await locatorName(binding) !== name) denied();
  return binding;
}

/** Caller owns this namespace's existing DO lifecycle, including deleteAll. */
export async function createOwnerRawCaptureStorage(env: Pick<Env, 'ENCRYPTION_KEY'>,
  storage: RawCaptureStorage['storage'],
  authorize: () => Promise<void>): Promise<RawCaptureStorage> {
  await authorize();
  const encryptionKey = env.ENCRYPTION_KEY ?? '';
  if (!await getOrImportKey({ ENCRYPTION_KEY: encryptionKey })) denied();
  const guard = async () => {
    await authorize();
    if ((env.ENCRYPTION_KEY ?? '') !== encryptionKey) denied();
  };
  await guard();
  return { storage, encryptionKey, authorize: guard };
}

/** Retain the full interaction without changing its result or original thrown value.
 * Suppliers are never evaluated without a capture; flushing uses the existing framed sink. */
export async function captureRawInteraction<T>(capture: RawCapture | undefined, stage: string,
  request: () => unknown, work: () => Promise<T>, ownerSnapshot?: (value: T) => unknown): Promise<T> {
  if (!capture) return work();
  const record = async (suffix: string, value: () => unknown) => {
    try { capture?.record(`${stage}-${suffix}`, value); await capture?.flush?.(); }
    catch { /* Evidence delivery cannot replace business I/O. */ }
  };
  try { capture.record(`${stage}-request`, request); } catch { /* Preserve business I/O. */ }
  try {
    const result = await work();
    await record('response', () => ownerSnapshot ? ownerSnapshot(result) : result);
    return result;
  } catch (error) {
    await record('error', () => error);
    throw error;
  }
}

/** A native business transaction must not await capture transactions in the same DO.
 * Snapshot only that transaction's already-consulted inputs, then drain after it closes.
 * No retries, detached request payloads, or additional business reads are retained. */
export async function captureRawTransaction<T>(capture: RawCapture | undefined,
  work: (transactionCapture: RawCapture | undefined) => Promise<T>): Promise<T> {
  if (!capture) return work(undefined);
  const records: Array<{ stage: string; value: unknown }> = [];
  const pending: RawCapture = { record: (stage, lazy) => {
    try { records.push({ stage, value: captureRawValue(lazy()) }); } catch { /* Preserve transaction. */ }
  }, finish: termination => capture.finish(termination) };
  try { return await work(pending); }
  finally {
    for (const record of records) try { capture.record(record.stage, () => record.value); await capture.flush?.(); }
    catch { /* Retention cannot replace commit, rollback, or its original error. */ }
  }
}

/** Snapshots synchronously, persists only on the caller-local scheduled queue. */
export function createRawCapture(input: { binding: RawCaptureBinding; enabled: boolean;
  storage: () => Promise<RawCaptureStorage>; schedule: (work: Promise<unknown>) => void }): RawCapture & { flush(): Promise<void> } {
  const enabled = input.enabled === true;
  const resolveStorage = input.storage;
  const schedule = input.schedule;
  let failed = false;
  let records = 0; let segments = 0; let bytes = 0;
  let queue = Promise.resolve();
  let finished: Promise<RawCaptureReceipt> | undefined;
  let io: ReturnType<typeof open> | undefined;
  let source: Promise<RawCaptureStorage> | undefined;
  let binding = input.binding;
  if (enabled) {
    try { binding = bindingSchema.parse(input.binding); } catch { failed = true; }
  }
  const frames: Frame[] = [];
  const pending: string[] = [];
  let batches = 0;
  const storageSource = () => source ??= resolveStorage();
  const storage = () => io ??= storageSource().then(value => open(binding, value));
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(async () => { if (!failed) await work(); }).catch(() => { failed = true; });
    try { schedule(queue); } catch { failed = true; }
  };
  const receipt = (termination: Termination, status: RawCaptureReceipt['status']): RawCaptureReceipt =>
    ({ status, captureId: binding.captureId, records, segments, bytes, termination });
  return {
    record(stage, lazy) {
      if (!enabled || finished || failed) return;
      try {
        if (typeof stage !== 'string') denied();
        // Only inert snapshot data reaches JSON serialization, never application toJSON/getters.
        pending.push(JSON.stringify({ stage, value: captureRawValue(lazy()) }));
        records++;
        enqueue(async () => {
          const sink = await storage();
          if (!pending.length) return;
          // Coalesce available records without dropping small events or imposing an event budget.
          const encoded = new TextEncoder().encode(`[${pending.splice(0).join(',')}]`);
          const record = batches++;
          bytes += encoded.length;
          segments += Math.ceil(encoded.length / FRAME);
          for (let offset = 0, part = 0; offset < encoded.length; offset += FRAME, part++) {
            if (failed) denied();
            const chunk = encoded.subarray(offset, offset + FRAME);
            const frame = { record, part, bytes: chunk.length };
            const ordinal = frames.length;
            const checksum = await sink.put(frameName(ordinal, frame), Buffer.from(chunk).toString('base64'), sink.aad(ordinal, frame));
            frames.push({ ...frame, digest: checksum });
          }
        });
      } catch { failed = true; }
    },
    async flush() {
      await queue;
      if (failed) denied();
    },
    finish(termination) {
      if (finished) return finished;
      if (!enabled) return finished = Promise.resolve(receipt(termination, 'disabled'));
      enqueue(async () => {
        const sink = await storage();
        if (frames.length !== segments || pending.length || failed) denied();
        await sink.put('receipt', JSON.stringify({ version: 1, receipt: receipt(termination, 'complete'), frames }), sink.aad('receipt'));
        // Revalidate all earlier frames as well as the final receipt, not just the last write.
        const verified = await walkArchive(sink, binding);
        if (verified.receipt.records !== records || verified.receipt.segments !== segments
          || verified.receipt.bytes !== bytes || verified.receipt.termination !== termination) denied();
        // One immutable encrypted locator per capture: concurrent finishes cannot lose an append.
        // Its namespace needs only the known owner/run, never the producer-local random ID.
        const index = await openIndex(binding, await storageSource());
        const name = await locatorName(binding);
        await index.put(name, JSON.stringify({ version: 1, binding }), index.aad(name));
        const recovered = await readLocator(index, binding, name, await index.get(name));
        if (captureContext(recovered) !== captureContext(binding)) denied();
        await sink.guard();
      });
      finished = queue.then(() => receipt(termination, failed ? 'incomplete' : 'complete'), () => receipt(termination, 'incomplete'));
      return finished;
    },
  };
}

async function walkArchive(io: Awaited<ReturnType<typeof open>>, binding: RawCaptureBinding,
  onRecord?: (record: { stage: string; value: unknown }) => void) {
  const manifest = manifestSchema.parse(JSON.parse(await io.decrypt(await io.get('receipt'), io.aad('receipt'))));
  const receipt = manifest.receipt;
  if (receipt.captureId !== binding.captureId || receipt.segments !== manifest.frames.length) denied();
  let records = 0;
  let chunks: Uint8Array[] = []; let length = 0; let total = 0; let part = 0; let batch = 0;
  for (const [ordinal, frame] of manifest.frames.entries()) {
    if (frame.record !== batch || frame.part !== part++) denied();
    const ciphertext = await io.get(frameName(ordinal, frame));
    if (await digest(ciphertext) !== frame.digest) denied();
    const plaintext = await io.decrypt(ciphertext, io.aad(ordinal, frame));
    const chunk = Buffer.from(plaintext, 'base64');
    if (chunk.toString('base64') !== plaintext || chunk.length !== frame.bytes) denied();
    chunks.push(chunk); length += chunk.length; total += chunk.length;
    const next = manifest.frames[ordinal + 1];
    if (!next || next.record !== frame.record) {
      const encoded = Buffer.concat(chunks, length);
      const decoded = z.array(z.strictObject({ stage: z.string(), value: z.unknown() })).min(1).parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(encoded)));
      for (const record of decoded) {
        if (!Object.hasOwn(record, 'value')) denied();
        records++;
        onRecord?.({ stage: record.stage, value: record.value });
      }
      chunks = []; length = 0; part = 0; batch++;
    }
  }
  if (records !== receipt.records || total !== receipt.bytes) denied();
  // A valid append has only two possible next coordinates: a continuation or the next batch.
  const last = manifest.frames.at(-1);
  if (last) await io.absent(frameName(receipt.segments, { record: last.record, part: last.part + 1 }));
  await io.absent(frameName(receipt.segments, { record: batch, part: 0 }));
  await io.guard();
  return { receipt };
}

/** Private owner-DO discovery only, not a browser/SDK endpoint. The caller must authorize the
 * requested owner AND activity/generation or observation before any protected I/O. A complete
 * page authenticates locators; readRawCapture still verifies each archive before releasing data.
 * Pagination uses immutable native keys, not a shared manifest; concurrent inserts before a
 * cursor are visible on a fresh traversal. No capture ID, installation or release is required. */
export async function discoverRawCaptures(input: { scope: RawCaptureScope; storage: RawCaptureStorage;
  authorize: (scope: RawCaptureScope) => Promise<void>; cursor?: string }):
Promise<{ status: 'complete' | 'incomplete'; bindings: RawCaptureBinding[]; cursor: string | null }> {
  try {
    const scope = scopeSchema.parse(input.scope);
    const cursor = input.cursor === undefined ? undefined : z.string().regex(/^[a-f0-9]{64}$/).parse(input.cursor);
    const original = input.storage;
    const authorize = input.authorize;
    const storage: RawCaptureStorage = { ...original, authorize: async () => {
      await authorize(scopeSchema.parse(scope));
      await original.authorize();
      if (original.storage !== storage.storage || original.encryptionKey !== storage.encryptionKey) denied();
    } };
    const index = await openIndex(scope, storage);
    const entries = await index.list(cursor);
    const bindings: RawCaptureBinding[] = [];
    for (const [name, ciphertext] of entries) bindings.push(await readLocator(index, scope, name, ciphertext));
    await index.guard();
    return { status: 'complete', bindings, cursor: entries.size === 100 ? [...entries.keys()].at(-1)!.slice('capture-'.length) : null };
  } catch { return { status: 'incomplete', bindings: [], cursor: null }; }
}

/** Root-only incremental consumer: intermediate records are not a complete verdict.
 * The caller must withhold its acknowledgement until the entire archive authenticates. */
export async function verifyRawCapture(input: { binding: RawCaptureBinding; storage: RawCaptureStorage },
  onRecord: (record: { stage: string; value: unknown }) => void):
Promise<{ status: 'complete' | 'incomplete'; receipt: RawCaptureReceipt | null }> {
  try {
    const binding = bindingSchema.parse(input.binding);
    const archive = await walkArchive(await open(binding, input.storage), binding, onRecord);
    return { status: 'complete', ...archive };
  } catch { return { status: 'incomplete', receipt: null }; }
}

/** No private partial records escape until the entire archive authenticates. */
export async function readRawCapture(input: { binding: RawCaptureBinding; storage: RawCaptureStorage }):
Promise<{ status: 'complete' | 'incomplete'; receipt: RawCaptureReceipt | null; records: Array<{ stage: string; value: unknown }> }> {
  const records: Array<{ stage: string; value: unknown }> = [];
  const result = await verifyRawCapture(input, record => { records.push(record); });
  return { ...result, records: result.status === 'complete' ? records : [] };
}
