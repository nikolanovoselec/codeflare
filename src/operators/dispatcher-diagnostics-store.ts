import { z } from 'zod';
import { bindingSchema, counter, digestSchema, eventSchema, errorSchema, correlationSchema, gaps,
  diagnosticBytes, type DiagnosticBinding, type DiagnosticEvent, type RuntimeEnvelope, type Correlation,
  type ErrorMetadata, type ReasonCode } from './dispatcher-diagnostics-wire';

export const DIAGNOSTIC_INDEX = 'dispatcher:diagnostics:index';
const HEALTH_KEY = 'dispatcher:diagnostics:health';
export const eventKey = (sequence: number): string => `dispatcher:diagnostics:event:${String(sequence).padStart(16, '0')}`;
export const capsuleKey = (id: string): string => `dispatcher:diagnostics:capsule:${id}`;
const eventId = z.string().regex(/^e-[1-9][0-9]*$/);
const unique = (ids: string[]) => new Set(ids).size === ids.length;
export const indexSchema = z.strictObject({ version: z.literal(1), ...bindingSchema.shape, nextSequence: counter.min(1),
  firstSequence: counter.min(1), epoch: counter, routineIds: z.array(eventId).max(1536).refine(unique),
  failureIds: z.array(z.string().regex(/^f-[1-9][0-9]*$/)).max(64).refine(unique),
  terminalIds: z.array(z.string().regex(/^t-[0-9]+$/)).max(64).refine(unique),
  pinnedEventIds: z.array(eventId).max(128).refine(unique), evictedRoutine: counter, droppedFailure: counter,
  droppedTerminal: counter, oversized: counter, rejected: counter,
  sdkImport: z.enum(['host-persisted', 'pending', 'unavailable', 'legacy'])
}).refine(index => index.firstSequence <= index.nextSequence
  && [...index.routineIds, ...index.pinnedEventIds].every(id => Number(id.slice(2)) < index.nextSequence));
export type DiagnosticIndex = z.infer<typeof indexSchema>;
const healthSchema = z.strictObject({ version: z.literal(1), captureIds: z.array(digestSchema).max(64),
  sdkThrough: counter, sdkLocalThrough: counter, sdkDropped: counter, pendingSequences: z.array(counter.min(1)).max(64).optional(),
  gaps: z.array(z.enum(gaps)).max(gaps.length),
  lastFailureId: eventId.optional(), lastConfirmedId: eventId.optional(), lastRecoveredId: eventId.optional()
}).refine(health => health.sdkThrough <= health.sdkLocalThrough && new Set(health.captureIds).size === health.captureIds.length
  && new Set(health.pendingSequences ?? []).size === (health.pendingSequences ?? []).length
  && (health.pendingSequences ?? []).every(sequence => sequence > health.sdkThrough && sequence <= health.sdkLocalThrough));
type Health = z.infer<typeof healthSchema>;
const capsuleSdkSchema = z.strictObject({ rootDigest: digestSchema.optional(), submissionDigest: digestSchema.optional(),
  attemptDigest: digestSchema.optional(), batchSequence: counter.optional(), producerEpoch: counter.optional(),
  producerSequence: counter.optional(), recordIndex: counter.optional(), settlement: z.enum(['reserved', 'canonical', 'finalized', 'unknown']) });
export const capsuleSchema = z.strictObject({ id: z.string().regex(/^(f-[1-9][0-9]*|t-[0-9]+)$/), kind: z.enum(['failure', 'terminal']),
  binding: bindingSchema, eventId: eventId.nullable(), code: z.enum(['none', 'unclassified', 'artifact-unavailable', 'artifact-mismatch',
    'admission-denied', 'authority-expired', 'authority-denied', 'stale-drive', 'startup-failed', 'submission-failed',
    'sse-json-invalid', 'provider-failed', 'stream-failed', 'response-unusable', 'canonical-append-failed', 'tool-failed',
    'effect-unknown', 'settlement-failed', 'continuation-not-ready', 'cancelled', 'deadline-expired', 'cleanup-failed',
    'capacity-exhausted', 'recorder-unavailable', 'platform-evidence-required']), error: errorSchema.nullable(),
  lastHostPersistedId: eventId.nullable(), sdk: capsuleSdkSchema.nullable(), affectedOperations: z.array(z.strictObject({
    operationDigest: digestSchema, effect: z.enum(['read', 'write', 'none', 'unknown']), status: z.enum(['completed', 'unknown', 'unavailable']) })).max(8),
  affectedOperationsOmitted: counter.nullable(), loss: z.array(z.enum(gaps)).max(gaps.length),
  uncertainty: z.enum(['none-observed', 'prior-effect-uncertain', 'evidence-incomplete']) });
export type DiagnosticCapsule = z.infer<typeof capsuleSchema>;
export type DiagnosticTx = Pick<DurableObjectTransaction, 'get' | 'put' | 'delete'>;
export function sameBinding(a: DiagnosticBinding, b: DiagnosticBinding): boolean {
  return a.generation === b.generation && a.artifactDigest === b.artifactDigest && a.inputDigest === b.inputDigest;
}
export function emptyIndex(binding: DiagnosticBinding, sdkCapable: boolean): DiagnosticIndex {
  return { version: 1, generation: binding.generation, artifactDigest: binding.artifactDigest, inputDigest: binding.inputDigest,
    nextSequence: 1, firstSequence: 1, epoch: 0, routineIds: [], failureIds: [], terminalIds: [],
    pinnedEventIds: [], evictedRoutine: 0, droppedFailure: 0, droppedTerminal: 0, oversized: 0, rejected: 0,
    sdkImport: sdkCapable ? 'pending' : 'legacy' };
}
const emptyHealth = (): Health => ({ version: 1, captureIds: [], sdkThrough: 0, sdkLocalThrough: 0, sdkDropped: 0, gaps: [] });
export async function initializeDiagnostics(tx: DiagnosticTx, binding: DiagnosticBinding, sdkCapable: boolean): Promise<void> {
  const existing = await tx.get(DIAGNOSTIC_INDEX);
  if (existing !== undefined) {
    const index = indexSchema.parse(existing);
    const health = healthSchema.parse(await tx.get(HEALTH_KEY));
    if (!sameBinding(index, binding)) {
      // Only admission of the next authorized lease calls initialization. The
      // Activity's admitted code/input never changes across a continuation.
      if (binding.generation !== index.generation + 1 || binding.artifactDigest !== index.artifactDigest
        || binding.inputDigest !== index.inputDigest) throw new Error('Diagnostic binding changed');
      if (index.sdkImport !== 'legacy') health.gaps = [...new Set([...health.gaps, 'sdk-import-incomplete' as const])];
      Object.assign(index, { generation: binding.generation, epoch: index.epoch + 1, sdkImport: sdkCapable ? 'pending' : 'legacy' });
      // A replacement child has a new outbox. Observed watermarks are not a
      // closure witness for its predecessor and cannot be joined across leases.
      Object.assign(health, { captureIds: [], sdkThrough: 0, sdkLocalThrough: 0, sdkDropped: 0, pendingSequences: [] });
      await retainHealth(tx, health);
    }
    await retainIndex(tx, index);
    return;
  }
  await retainIndex(tx, emptyIndex(binding, sdkCapable));
  await tx.put(HEALTH_KEY, emptyHealth());
}
async function readIndex(tx: DiagnosticTx, binding: DiagnosticBinding): Promise<DiagnosticIndex> {
  const index = indexSchema.parse(await tx.get(DIAGNOSTIC_INDEX));
  if (!sameBinding(index, binding)) throw new Error('Diagnostic binding changed');
  return index;
}
async function readHealth(tx: DiagnosticTx): Promise<Health> {
  return healthSchema.parse(await tx.get(HEALTH_KEY));
}
const retainHealth = async (tx: DiagnosticTx, value: Health) => {
  if (diagnosticBytes(value) > 8192) throw new Error('Diagnostic health limit');
  await tx.put(HEALTH_KEY, value);
};
async function retainIndex(tx: DiagnosticTx, index: DiagnosticIndex): Promise<void> {
  const updateFirst = () => {
    const retained = [...index.routineIds, ...index.pinnedEventIds].map(id => Number(id.slice(2)));
    index.firstSequence = retained.length ? Math.min(...retained) : index.nextSequence;
  };
  updateFirst();
  // Each value, including this index, is capped at 8192 bytes. Count is a
  // ceiling, not a promise that every variable-width ID fits simultaneously.
  while (index.routineIds.length > 1536 || diagnosticBytes(index) > 8192) {
    const oldest = index.routineIds.shift();
    if (!oldest) throw new Error('Diagnostic index limit');
    if (!index.pinnedEventIds.includes(oldest)) await tx.delete(eventKey(Number(oldest.slice(2))));
    index.evictedRoutine++; index.epoch++;
    updateFirst();
  }
  indexSchema.parse(index);
  await tx.put(DIAGNOSTIC_INDEX, index);
}
export async function diagnosticLoss(tx: DiagnosticTx, binding: DiagnosticBinding, reason: 'rejected' | 'oversized'): Promise<void> {
  const index = await readIndex(tx, binding);
  index[reason]++;
  await retainIndex(tx, index);
}
export async function observeOutbox(tx: DiagnosticTx, binding: DiagnosticBinding,
  outbox: { through: number; dropped: number; status: 'available' | 'loss' | 'unavailable' }): Promise<void> {
  const index = await readIndex(tx, binding);
  const health = await readHealth(tx);
  health.sdkLocalThrough = Math.max(health.sdkLocalThrough, outbox.through);
  health.sdkDropped = Math.max(health.sdkDropped, outbox.dropped);
  if (outbox.dropped || outbox.status !== 'available') health.gaps = [...new Set([...health.gaps, 'sdk-import-incomplete' as const])];
  if (health.sdkThrough < health.sdkLocalThrough) index.sdkImport = 'pending';
  else if (index.sdkImport !== 'legacy') index.sdkImport = outbox.status === 'unavailable' ? 'unavailable' : 'host-persisted';
  await retainHealth(tx, health); await retainIndex(tx, index);
}
export type EventObservation = Omit<DiagnosticEvent, 'kind' | 'id' | 'sequence' | 'generation' | 'capsuleId'>;
/** All optional evidence is one independent transaction, never part of an execution authorization. */
export async function appendDiagnostic(tx: DiagnosticTx, binding: DiagnosticBinding, observation: EventObservation,
  options: { terminalGeneration?: number; captureId?: string; runtime?: RuntimeEnvelope;
    affectedOperations?: DiagnosticCapsule['affectedOperations']; affectedOperationsOmitted?: number | null } = {}): Promise<void> {
  const index = await readIndex(tx, binding);
  const health = await readHealth(tx);
  if (options.captureId && health.captureIds.includes(options.captureId)) return;
  const sequence = index.nextSequence;
  if (!Number.isSafeInteger(sequence + 1)) throw new Error('Diagnostic sequence exhausted');
  const record: DiagnosticEvent = eventSchema.parse({ ...observation, kind: 'event', id: `e-${sequence}`, sequence, generation: binding.generation });
  const terminal = options.terminalGeneration !== undefined;
  const failure = observation.outcome === 'failed' || observation.code === 'effect-unknown';
  const list = terminal ? index.terminalIds : index.failureIds;
  let capsule: DiagnosticCapsule | undefined;
  if (terminal || failure) {
    if (list.length >= 64) { if (terminal) index.droppedTerminal++; else index.droppedFailure++; }
    else {
      const id = terminal ? `t-${options.terminalGeneration}` : `f-${sequence}`;
      if (!list.includes(id)) {
        const correlation = correlationSchema.parse(observation.correlation);
        capsule = { id, kind: terminal ? 'terminal' : 'failure',
          binding: { generation: binding.generation, artifactDigest: binding.artifactDigest, inputDigest: binding.inputDigest }, eventId: record.id,
          code: record.code, error: record.error ?? null, lastHostPersistedId: lastRetainedId(index),
          sdk: options.runtime?.sdk ? sdkCoordinates(correlation, options.runtime.sdk.settlement ?? 'unknown') : null,
          affectedOperations: options.affectedOperations ?? [], affectedOperationsOmitted: options.affectedOperationsOmitted ?? null,
          loss: options.runtime?.local.status === 'loss' || options.runtime?.local.dropped ? ['sdk-import-incomplete'] : [],
          uncertainty: record.code === 'effect-unknown' ? 'prior-effect-uncertain' : 'evidence-incomplete' };
        record.capsuleId = id;
      }
    }
  }
  if (diagnosticBytes(record) > 4096 || capsule && diagnosticBytes(capsule) > 8192) {
    index.oversized++;
    if (options.runtime) {
      health.sdkLocalThrough = Math.max(health.sdkLocalThrough, options.runtime.local.through);
      index.sdkImport = 'pending';
      if (options.captureId) { health.captureIds.push(options.captureId); if (health.captureIds.length > 64) health.captureIds.shift(); }
      await retainHealth(tx, health);
    }
    await retainIndex(tx, index); return;
  }
  if (capsule) { list.push(capsule.id); index.pinnedEventIds.push(record.id); await tx.put(capsuleKey(capsule.id), capsule); }
  index.routineIds.push(record.id); index.nextSequence++;
  if (options.captureId) { health.captureIds.push(options.captureId); if (health.captureIds.length > 64) health.captureIds.shift(); }
  if (options.runtime) {
    if (options.runtime.sequence > health.sdkThrough) {
      const pending = new Set(health.pendingSequences ?? []);
      pending.add(options.runtime.sequence);
      while (pending.has(health.sdkThrough + 1)) { pending.delete(++health.sdkThrough); }
      if (pending.size > 64) {
        health.gaps = [...new Set([...health.gaps, 'sdk-import-incomplete' as const])];
        // Do not turn out-of-order/window loss into a fabricated contiguous import watermark.
        pending.delete(options.runtime.sequence);
      }
      health.pendingSequences = [...pending].sort((a, b) => a - b);
    }
    health.sdkLocalThrough = Math.max(health.sdkLocalThrough, options.runtime.local.through);
    health.sdkDropped = Math.max(health.sdkDropped, options.runtime.local.dropped);
    if (options.runtime.local.status !== 'captured' || health.sdkDropped) health.gaps = [...new Set([...health.gaps, 'sdk-import-incomplete' as const])];
    index.sdkImport = health.sdkThrough >= health.sdkLocalThrough ? 'host-persisted' : 'pending';
  }
  if (record.error?.loss.length) health.gaps = [...new Set([...health.gaps, 'error-truncated' as const])];
  if (record.outcome === 'failed' || record.code === 'effect-unknown') health.lastFailureId = record.id;
  if (['accepted', 'applied', 'committed', 'completed', 'released'].includes(record.outcome)) health.lastConfirmedId = record.id;
  if (record.outcome === 'recovered') health.lastRecoveredId = record.id;
  await tx.put(eventKey(sequence), record);
  await retainHealth(tx, health);
  await retainIndex(tx, index);
}
function lastRetainedId(index: DiagnosticIndex): string | null {
  const ids = [...index.routineIds, ...index.pinnedEventIds];
  return ids.length ? `e-${Math.max(...ids.map(id => Number(id.slice(2))))}` : null;
}
function sdkCoordinates(c: Correlation, settlement: 'reserved' | 'canonical' | 'finalized' | 'unknown'): NonNullable<DiagnosticCapsule['sdk']> {
  return { settlement, ...(c.rootDigest ? { rootDigest: c.rootDigest } : {}), ...(c.submissionDigest ? { submissionDigest: c.submissionDigest } : {}),
    ...(c.sdkAttemptDigest ? { attemptDigest: c.sdkAttemptDigest } : {}), ...(c.sdkBatchSequence === undefined ? {} : { batchSequence: c.sdkBatchSequence }),
    ...(c.sdkProducerEpoch === undefined ? {} : { producerEpoch: c.sdkProducerEpoch }), ...(c.sdkProducerSequence === undefined ? {} : { producerSequence: c.sdkProducerSequence }),
    ...(c.sdkRecordIndex === undefined ? {} : { recordIndex: c.sdkRecordIndex }) };
}
export async function diagnosticPointers(storage: Pick<DurableObjectStorage, 'get'>): Promise<string[]> {
  const raw = await storage.get(HEALTH_KEY);
  const health = healthSchema.parse(raw);
  return [health.lastFailureId, health.lastConfirmedId, health.lastRecoveredId].filter((id): id is string => id !== undefined);
}
export async function readDiagnosticHealth(storage: Pick<DurableObjectStorage, 'get'>, index: DiagnosticIndex): Promise<Array<typeof gaps[number]>> {
  const raw = await storage.get(HEALTH_KEY);
  const parsed = healthSchema.parse(raw);
  const loss = new Set(parsed.gaps);
  if (index.evictedRoutine) loss.add('routine-evicted');
  if (index.droppedFailure) loss.add('failure-overflow');
  if (index.droppedTerminal) loss.add('terminal-overflow');
  if (index.oversized) loss.add('oversized-record');
  if (index.rejected) loss.add('invalid-record');
  if (index.sdkImport === 'pending') loss.add('sdk-import-incomplete');
  if (index.sdkImport === 'legacy') loss.add('legacy-uncaptured');
  return [...loss];
}
export interface FenceReason { generation: number; timestamp: number; boundary: DiagnosticEvent['boundary']; code: ReasonCode; uncertain: boolean }
export interface FailureObservation { boundary: DiagnosticEvent['boundary']; code: ReasonCode; error?: ErrorMetadata }
