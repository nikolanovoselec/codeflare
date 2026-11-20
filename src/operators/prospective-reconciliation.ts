import { createHash } from 'node:crypto';
import { z } from 'zod';
import { captureRawValue } from '../../host/src/operator-raw-logging';
import type { RawCapture } from './raw-capture-storage';
import type { ManagementAdmissionReceipt, ProspectiveAdmission } from './registry';

/** Root-private authoritative reads. Only a successful null is proven ledger absence. */
export type ProspectiveReconciliationAuthority = {
  original: ProspectiveAdmission | null;
  ledger: { ok: true; receipt: ManagementAdmissionReceipt | null } | { ok: false; error: unknown };
};

// Use the raw archive's NDJSON record convention and chunked writes. Unlike an
// archive export, this live exchange must also bound a single historical record.
// Parts are ordinary records in the existing owner archive, not another store.
const TEXT = 4096;
const LINE = 64 * 1024;
const partSchema = z.strictObject({ type: z.literal('record'), sequence: z.number().int().nonnegative().safe(),
  part: z.number().int().nonnegative().safe(), text: z.string().max(TEXT), last: z.boolean(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).optional() }).refine(value => value.last === (value.digest !== undefined));
const resultSchema = z.strictObject({ type: z.literal('result'), value: z.unknown(), evidenceComplete: z.boolean(), records: z.number().int().nonnegative().safe() });

/** Serialize only an inert captureRawValue snapshot; never build whole-record JSON. */
function* json(value: unknown): Generator<string> {
  if (typeof value === 'string') {
    yield '"';
    for (let at = 0; at < value.length;) {
      let end = Math.min(at + TEXT / 2, value.length);
      // Do not change a surrogate pair into two escaped lone surrogates.
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
      yield JSON.stringify(value.slice(at, end)).slice(1, -1); at = end;
    }
    yield '"';
  } else if (value === null || typeof value !== 'object') yield JSON.stringify(value) ?? 'null';
  else if (Array.isArray(value)) {
    yield '[';
    for (let at = 0; at < value.length; at++) { if (at) yield ','; yield* json(value[at]); }
    yield ']';
  } else {
    yield '{'; let first = true;
    for (const key of Object.keys(value)) {
      if (!first) yield ','; first = false;
      yield* json(key); yield ':'; yield* json((value as Record<string, unknown>)[key]);
    }
    yield '}';
  }
}

/** No capabilities/callbacks cross RPC. Writes await consumer demand, including
 * within the Activity's atomic effect scan; the consumer persists in Registry. */
export function prospectiveReconciliationStream<T>(enabled: boolean,
  work: (raw: RawCapture | undefined) => Promise<T>): ReadableStream<Uint8Array> {
  // Native byte pumping does not re-enter the Actor's parent input gate while
  // a storage transaction holds its critical section; backpressure stays intact.
  const stream = new IdentityTransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  let queue = Promise.resolve(); let sequence = 0; let failed = false;
  const write = (frame: unknown) => writer.write(encoder.encode(`${JSON.stringify(frame)}\n`));
  const raw: RawCapture = {
    record(stage, lazy) {
      if (failed) return;
      try {
        const snapshot = { stage, value: captureRawValue(lazy()) };
        const ordinal = sequence++;
        queue = queue.then(async () => {
          let part = 0; let pending = '';
          const hash = createHash('sha256');
          for (const token of json(snapshot)) {
            for (let at = 0; at < token.length;) {
              const size = Math.min(TEXT - pending.length, token.length - at);
              pending += token.slice(at, at + size); at += size;
              if (pending.length === TEXT) {
                // Hash the original UTF-8, not replacement characters from a
                // surrogate pair split across independently encoded parts.
                const carry = /[\uD800-\uDBFF]/.test(pending.at(-1)!) ? pending.slice(-1) : '';
                const text = carry ? pending.slice(0, -1) : pending;
                hash.update(text);
                await write({ type: 'record', sequence: ordinal, part: part++, text, last: false }); pending = carry;
              }
            }
          }
          hash.update(pending);
          await write({ type: 'record', sequence: ordinal, part, text: pending, last: true, digest: hash.digest('hex') });
        }).catch(() => { failed = true; });
      } catch { failed = true; }
    },
    flush: async () => { await queue; if (failed) throw Error('RECONCILIATION_EVIDENCE_INCOMPLETE'); },
    finish: async termination => {
      await queue;
      return { status: failed ? 'incomplete' : 'complete', captureId: '', records: sequence, segments: 0, bytes: 0, termination };
    },
  };
  void writer.closed.catch(() => { failed = true; });
  void (async () => {
    try {
      const value = await work(enabled ? raw : undefined);
      await queue;
      await write({ type: 'result', value, evidenceComplete: !failed, records: sequence });
      await writer.close();
    } catch { await writer.abort(Error('RECONCILIATION_UNAVAILABLE')).catch(() => {}); }
    finally { writer.releaseLock(); }
  })().catch(() => {});
  return stream.readable;
}

/** Persist bounded parts without reconstructing records. Optional storage failure
 * cannot hide a business result: drain through the result AND EOF regardless.
 * No result is trusted after malformed/truncated transport. The owner must not
 * seal its capture as complete unless this returns evidenceComplete=true. */
export async function consumeProspectiveReconciliation<T>(stream: ReadableStream<Uint8Array>,
  parse: (value: unknown) => T, capture?: RawCapture): Promise<{ value: T; evidenceComplete: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let pending = ''; let sequence = 0; let part = 0;
  let hash = createHash('sha256');
  let result: { value: T; evidenceComplete: boolean } | undefined;
  let storageFailed = false;
  const line = async (text: string) => {
    if (result) throw Error('RECONCILIATION_TRAILING_DATA');
    const frame: unknown = JSON.parse(text);
    const record = partSchema.safeParse(frame);
    if (record.success) {
      const value = record.data;
      if (value.sequence !== sequence || value.part !== part) throw Error('RECONCILIATION_PART_ORDER');
      hash.update(value.text);
      if (value.last && hash.digest('hex') !== value.digest) throw Error('RECONCILIATION_RECORD_INVALID');
      if (capture && !storageFailed) try {
        capture.record('reconciliation-record-part', () => value); await capture.flush?.();
      } catch { storageFailed = true; }
      if (value.last) { sequence++; part = 0; hash = createHash('sha256'); } else part++;
    } else {
      const final = resultSchema.parse(frame);
      if (part || final.records !== sequence) throw Error('RECONCILIATION_PARTIAL_RECORD');
      result = { value: parse(final.value), evidenceComplete: final.evidenceComplete };
    }
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      // A transport chunk need not align with a line. Process bounded slices,
      // never concatenate an arbitrary platform chunk or an entire record.
      for (let at = 0; at < next.value.length; at += TEXT) {
        pending += decoder.decode(next.value.subarray(at, at + TEXT), { stream: true });
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          if (end > LINE) throw Error('RECONCILIATION_FRAME_INVALID');
          await line(pending.slice(0, end)); pending = pending.slice(end + 1);
        }
        if (pending.length > LINE) throw Error('RECONCILIATION_FRAME_INVALID');
      }
    }
    pending += decoder.decode();
    if (pending || part || !result) throw Error('RECONCILIATION_INTERRUPTED');
    return { ...result, evidenceComplete: result.evidenceComplete && !storageFailed };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
