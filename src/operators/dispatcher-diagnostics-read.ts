import { z } from 'zod';
import { getOrImportKey, encryptForKV, decryptFromKV } from '../lib/kv-crypto';
import { bindingSchema, counter, digestSchema, diagnosticBytes, canonicalDiagnostic, hashDiagnostic, encodeOpaque, decodeOpaque,
  eventSchema, sourceMatches, boundaries, type DiagnosticBinding, type SdkProvenance, type DiagnosticEvent } from './dispatcher-diagnostics-wire';
import { DIAGNOSTIC_INDEX, indexSchema, eventKey, capsuleKey, capsuleSchema, readDiagnosticHealth, sameBinding,
  diagnosticPointers, type FenceReason } from './dispatcher-diagnostics-store';
import type { DispatcherOperationDiagnostics } from './dispatcher-runtime-diagnostics';

export class DiagnosticReadError extends Error {
  constructor(public readonly status: 400 | 404 | 409 | 503, public readonly code: string) { super(code); }
}
export interface DiagnosticReadState {
  ownerKey?: string; activityId: string; binding: DiagnosticBinding; bindingValid: boolean;
  expectedIndex: boolean; logging: boolean; status?: string; operations: number | null;
  provenance: SdkProvenance | null; rootDigest?: string; submissionId?: string | null; fence?: FenceReason;
  recorderUnavailable?: boolean; sdkRetired?: boolean;
}
export type OperationRecord = DispatcherOperationDiagnostics['records'][number] & {
  kind: 'operation'; id: string; generation: number; availability: 'retained' | 'unavailable';
  association: 'verified' | 'unassociated' | 'changed-binding' | 'legacy' | 'unavailable';
};
type PublicRecord = DiagnosticEvent | OperationRecord;
const cursorSchema = z.strictObject({ version: z.literal(1), ownerScope: digestSchema, activityId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  binding: bindingSchema, highWater: z.strictObject({ events: counter.nullable(), operations: counter.nullable() }), epoch: counter,
  segment: z.enum(['events', 'operations', 'legacy', 'complete']), lastSequence: counter, position: z.string().max(1024).nullable(),
  legacyMarker: digestSchema.nullable() });
type Cursor = z.infer<typeof cursorSchema>;
type DiagnosticReadView = 'summary' | 'history' | 'detail' | 'export';
export interface DiagnosticReadOptions { view: DiagnosticReadView; cursor?: string; recordId?: string }
export async function readActivityDiagnostics(input: {
  storage: DurableObjectStorage; env: { ENCRYPTION_KEY?: string }; ownerKey: string;
  state: () => Promise<DiagnosticReadState | null>;
  projectOperation: (id: string, raw: unknown, legacy: boolean, state: DiagnosticReadState, generation: number) => Promise<OperationRecord>;
}, options: DiagnosticReadOptions): Promise<Record<string, unknown> | null> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ensureLive = () => { if (timedOut) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE'); };
  const run = async (): Promise<Record<string, unknown> | null> => {
    const before = await input.state(); ensureLive();
    if (!before || before.ownerKey !== input.ownerKey) return null;
    if (!before.bindingValid) throw new DiagnosticReadError(409, 'DIAGNOSTICS_BINDING_CHANGED');
    const rawIndex = await input.storage.get(DIAGNOSTIC_INDEX); ensureLive();
    const parsedIndex = indexSchema.safeParse(rawIndex);
    let index = parsedIndex.success && diagnosticBytes(parsedIndex.data) <= 8192
      && sameBinding(parsedIndex.data, before.binding) ? parsedIndex.data : null;
    let unavailable = before.expectedIndex && !index;
    // Reads never repair a missing/corrupt recorder, migrate legacy entries or create a cursor secret.
    let gapList: string[];
    try { gapList = unavailable ? ['recorder-unavailable'] : index ? await readDiagnosticHealth(input.storage, index) : ['legacy-uncaptured']; }
    catch { index = null; unavailable = true; gapList = ['recorder-unavailable']; }
    if (before.recorderUnavailable && !gapList.includes('recorder-unavailable')) gapList.push('recorder-unavailable');
    if (!before.logging && !gapList.includes('logging-disabled')) gapList.push('logging-disabled');
    if ((['unknown', 'failed', 'cancel-requested'].includes(before.status ?? '') && !before.fence
      || before.fence?.code === 'platform-evidence-required') && !gapList.includes('platform-evidence-required')) gapList.push('platform-evidence-required');
    // Retirement is not an outbox closure witness: cleanup may capture a later
    // child record after the last execution-owned watermark observation.
    const retiredSdk = before.sdkRetired && before.logging && !!before.provenance;
    const retirementTailUnwitnessed = retiredSdk && index?.sdkImport === 'host-persisted' && gapList.length === 0;
    if (retiredSdk && index && index.sdkImport !== 'legacy' && !gapList.includes('sdk-import-incomplete')) gapList.push('sdk-import-incomplete');
    const knownLoss = !!index && (index.evictedRoutine > 0 || index.droppedFailure > 0 || index.droppedTerminal > 0
      || index.oversized > 0 || index.rejected > 0 || gapList.some(gap => !['legacy-uncaptured', 'logging-disabled'].includes(gap)));
    const health = { status: knownLoss ? 'loss' : unavailable ? 'unavailable' : 'available',
      sdkImport: unavailable ? 'unavailable' : retiredSdk && index?.sdkImport === 'host-persisted' ? 'pending' : index?.sdkImport ?? 'legacy',
      gaps: gapList, ...(retirementTailUnwitnessed ? { sdkImportReason: 'retirement-tail-unwitnessed' as const } : {}) };
    const retention = { epoch: index?.epoch ?? null, firstSequence: index?.firstSequence ?? null,
      lastSequence: index ? index.nextSequence - 1 : null, routineLimit: 1536, failureLimit: 64, terminalLimit: 64,
      evictedRoutine: index?.evictedRoutine ?? null, droppedFailure: index?.droppedFailure ?? null,
      droppedTerminal: index?.droppedTerminal ?? null, oversized: index?.oversized ?? null, rejected: index?.rejected ?? null };
    const legacyRaw = options.view === 'summary' ? undefined : await input.storage.get<Record<string, unknown>>('dispatcher:operations'); ensureLive();
    const legacy = legacyRaw && typeof legacyRaw === 'object' && !Array.isArray(legacyRaw) ? legacyRaw : null;
    // Current execution writers migrate/delete the entire legacy map before writing
    // keyed entries. Its immutable key set is a separate snapshot segment, not an ordinal counter.
    const legacyIds = legacy ? Object.keys(legacy).sort() : [];
    const legacyMarker = legacy ? hashDiagnostic(canonicalDiagnostic(legacyIds)) : null;
    let highWater = { events: index ? index.nextSequence - 1 : null, operations: before.operations };
    const ownerScope = hashDiagnostic(input.ownerKey);
    const aad = `operator-diagnostics-v2:${ownerScope}:${before.activityId}`;
    let cryptoKey: CryptoKey | null = null;
    let cursor: Cursor = { version: 1, ownerScope, activityId: before.activityId, binding: before.binding,
      highWater, epoch: index?.epoch ?? 0, segment: 'events', lastSequence: 0, position: null, legacyMarker };
    if (options.view === 'history' || options.view === 'export') {
      try { cryptoKey = await getOrImportKey(input.env); } catch { throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE'); }
      if (!cryptoKey) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
    }
    if (options.cursor) {
      try {
        const sealed = decodeOpaque(options.cursor, 4096);
        if (!sealed.startsWith('v1:')) throw new Error('Invalid cursor');
        const plaintext = await decryptFromKV(sealed.slice(3), cryptoKey!, aad);
        cursor = cursorSchema.parse(JSON.parse(plaintext));
        if (canonicalDiagnostic(cursor) !== plaintext) throw new Error('Noncanonical cursor');
        if (cursor.ownerScope !== ownerScope || cursor.activityId !== before.activityId) throw new Error('Foreign cursor');
      } catch { throw new DiagnosticReadError(400, 'INVALID_DIAGNOSTICS_CURSOR'); }
      if (!sameBinding(cursor.binding, before.binding) || cursor.epoch !== (index?.epoch ?? 0)
        || cursor.legacyMarker !== legacyMarker) throw new DiagnosticReadError(409, 'DIAGNOSTICS_BINDING_CHANGED');
      if (cursor.highWater.events !== null && (highWater.events === null || cursor.highWater.events > highWater.events)
        || cursor.highWater.events === null && highWater.events !== null || cursor.highWater.operations !== null
        && (highWater.operations === null || cursor.highWater.operations > highWater.operations)) throw new DiagnosticReadError(409, 'DIAGNOSTICS_BINDING_CHANGED');
      highWater = cursor.highWater;
    }
    const common = () => ({ version: 2, activityId: before.activityId, capturedAt: Date.now(), consistency: 'stable-binding',
      binding: before.binding, highWater, health, retention });
    const readEvent = async (id: string): Promise<DiagnosticEvent> => {
      const record = eventSchema.parse(await input.storage.get(eventKey(Number(id.slice(2))))); ensureLive();
      if (record.id !== id || record.generation > before.binding.generation || diagnosticBytes(record) > 4096
        || (record.owner === 'sdk' || record.source.frames.length > 0)
          && (!before.provenance || !sourceMatches(record.source, before.provenance))) {
        throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
      }
      return record;
    };
    const eventIds = index ? [...new Set([...index.routineIds, ...index.pinnedEventIds])]
      .filter(id => Number(id.slice(2)) <= (highWater.events ?? 0)).sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))) : [];
    let response: Record<string, unknown>;
    if (options.view === 'summary') {
      let failure: DiagnosticEvent | undefined;
      let confirmed: DiagnosticEvent | undefined;
      const recoveries: DiagnosticEvent[] = [];
      // Finite retained-index bound; read only metadata, not the child/journal/cache.
      const pointers = index && !unavailable ? await diagnosticPointers(input.storage) : [];
      const selected = [...new Set([...pointers.filter(id => eventIds.includes(id)), ...eventIds.slice(-29)])]
        .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));
      for (const id of selected) {
        const record = await readEvent(id);
        if (record.outcome === 'failed' || record.code === 'effect-unknown') failure = record;
        if (['accepted', 'applied', 'committed', 'completed', 'released'].includes(record.outcome)) confirmed = record;
        if (record.outcome === 'recovered') recoveries.push(record);
      }
      const fenced = before.fence;
      const incomplete = unavailable || before.recorderUnavailable || health.status === 'loss' || !before.logging
        || !index || ['unknown', 'failed', 'cancel-requested'].includes(before.status ?? '') && !fenced;
      const sameOperation = (a: DiagnosticEvent, b: DiagnosticEvent) => a.generation === b.generation
        && (a.correlation.logicalOrdinal !== undefined && a.correlation.logicalOrdinal === b.correlation.logicalOrdinal
          || a.correlation.sdkAttemptDigest !== undefined && a.correlation.sdkAttemptDigest === b.correlation.sdkAttemptDigest)
        && (['logicalOrdinal', 'sdkAttemptDigest', 'submissionDigest', 'requestDigest'] as const).every(key =>
          a.correlation[key] === undefined || b.correlation[key] === undefined || a.correlation[key] === b.correlation[key]);
      const recoveredFailure = failure && !fenced && (recoveries.some(record => !!failure && record.sequence > failure.sequence && sameOperation(failure, record))
        || confirmed && failure.boundary === 'release' && failure.code === 'cleanup-failed'
          && confirmed.boundary === 'release' && confirmed.outcome === 'completed'
          && confirmed.sequence > failure.sequence && confirmed.generation === failure.generation);
      // A retained failure can outlive its routine recovery observation. Loss is not
      // proof that the old failure is still terminal, nor that later unrelated work recovered it.
      const recoveryUnretained = failure && index && index.evictedRoutine > 0
        && pointers.some(id => !!failure && Number(id.slice(2)) > failure.sequence && !eventIds.includes(id));
      const state = unavailable || fenced?.code === 'platform-evidence-required' ? 'evidence-incomplete' : fenced ? 'observed-failure'
        : recoveredFailure ? 'recovered-failure' : recoveryUnretained ? 'evidence-incomplete'
          : failure ? 'observed-failure' : incomplete ? 'evidence-incomplete' : 'no-failure-observed';
      response = { ...common(), capture: unavailable ? 'unavailable' : !before.logging ? 'disabled' : index ? 'enabled' : 'legacy',
        provenance: { hostRevision: null, sdkBaseRuntime: before.provenance?.basePackages.find(pkg => pkg.name === '@flue/runtime')?.version ?? null,
          sdkBaseAgents: before.provenance?.basePackages.find(pkg => pkg.name === 'agents')?.version ?? null, patchSetDigest: before.provenance?.patchSetDigest ?? null },
        capabilities: boundaries.map(boundary => ({ boundary, availability: boundary === 'platform' ? 'platform-required'
          : ['canonical-commit', 'delivery', 'submission', 'release', 'model', 'recovery', 'settlement'].includes(boundary) && !before.provenance ? 'legacy'
            : before.logging ? 'supported' : 'unavailable', persistence: unavailable || !before.logging ? 'unavailable'
              : before.provenance && health.sdkImport === 'pending' ? 'pending' : 'host-persisted' })),
        sdkBinding: before.rootDigest && before.submissionId ? { status: 'available', rootDigest: before.rootDigest,
          submissionDigest: hashDiagnostic(before.submissionId) } : { status: 'unavailable', reason: 'unbound' },
        fence: fenced ?? null, diagnosis: { state, code: fenced?.code ?? failure?.code ?? 'none',
          lastConfirmedId: confirmed?.id ?? null, failedId: failure?.id ?? null,
          nextCheck: fenced?.code === 'platform-evidence-required' ? 'inspect-platform-events'
            : fenced || failure && !recoveredFailure && !recoveryUnretained ? 'inspect-failure' : gapList.includes('sdk-import-incomplete') ? 'inspect-sdk-import'
            : gapList.includes('platform-evidence-required') ? 'inspect-platform-events' : incomplete ? 'inspect-retention-gap' : 'none' } };
    } else {
      if (unavailable || before.recorderUnavailable) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
      const prefix = 'dispatcher:operation:';
      let inspected = 0;
      let pages = 0;
      let probe: { position: string | undefined; entries: Map<string, unknown> } | undefined;
      const operationPage = async (position?: string, limit = 32) => {
        if (probe && probe.position === position) { const entries = probe.entries; probe = undefined; return entries; }
        if (pages >= 32 || inspected >= 1024) return null;
        const entries = await input.storage.list<unknown>({ prefix, limit: Math.min(limit, 1024 - inspected),
          ...(position ? { startAfter: position } : {}) }); ensureLive();
        pages++; inspected += entries.size;
        return entries;
      };
      // Probe once for the passive read boundary, then consume that same page rather
      // than enumerating/counting it again. Both segments share the 1024-entry/32-page budget.
      const probePosition = cursor.segment === 'operations' ? cursor.position ?? undefined : undefined;
      const probeEntries = await operationPage(probePosition);
      if (probeEntries) probe = { position: probePosition, entries: probeEntries };
      const operationIdentity = (key: string, raw: unknown, old: boolean) => {
        const stored = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as { generation?: unknown } : null;
        const match = old ? null : /^dispatcher:operation:(0|[1-9][0-9]*):(.+)$/.exec(key);
        const generation = old ? stored?.generation : match ? Number(match[1]) : NaN;
        if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0
          || generation > before.binding.generation || stored?.generation !== generation || !old && !match) {
          throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
        }
        const operationId = old ? key : match![2];
        return { operationId, generation, id: `o-${generation}-${hashDiagnostic(operationId)}` };
      };
      const project = async (key: string, raw: unknown, old: boolean) => {
        const identity = operationIdentity(key, raw, old);
        const record = await input.projectOperation(identity.operationId, raw, old, before, identity.generation); ensureLive();
        if (record.id !== identity.id || record.generation !== identity.generation) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
        if (diagnosticBytes(record) > 4096) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
        return record;
      };
      if (options.view === 'detail') {
        const id = options.recordId ?? '';
        let record: PublicRecord | undefined;
        if (/^e-[1-9][0-9]*$/.test(id) && eventIds.includes(id)) record = await readEvent(id);
        else if (/^o-(0|[1-9][0-9]*)-[a-f0-9]{64}$/.test(id)) {
          let position: string | undefined;
          let exhausted = false;
          while (!record) {
            const entries = await operationPage(position);
            if (!entries) break;
            for (const [key, raw] of entries) {
              position = key;
              if (operationIdentity(key, raw, false).id === id) { record = await project(key, raw, false); break; }
            }
            if (entries.size < 32) { exhausted = true; break; }
          }
          if (!record && legacy) {
            let legacyInspected = 0;
            for (const key of legacyIds) {
              if (inspected >= 1024) break;
              inspected++; legacyInspected++;
              if (operationIdentity(key, legacy[key], true).id === id) { record = await project(key, legacy[key], true); break; }
            }
            exhausted = exhausted && legacyInspected === legacyIds.length;
          }
          if (!record && !exhausted) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
        }
        if (!record) throw new DiagnosticReadError(404, 'DIAGNOSTICS_RECORD_NOT_FOUND');
        let capsule;
        if (record.kind === 'event' && record.capsuleId) {
          capsule = capsuleSchema.parse(await input.storage.get(capsuleKey(record.capsuleId))); ensureLive();
          if (capsule.id !== record.capsuleId || capsule.binding.generation !== record.generation
            || capsule.binding.artifactDigest !== before.binding.artifactDigest || capsule.binding.inputDigest !== before.binding.inputDigest
            || capsule.kind === 'terminal' && capsule.id !== `t-${record.generation}`
            || capsule.eventId !== record.id || diagnosticBytes(capsule) > 8192) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
        }
        response = { ...common(), record, ...(capsule ? { capsule } : {}) };
      } else {
        const records: PublicRecord[] = [];
        let usedBytes = 0;
        const accept = (record: PublicRecord) => {
          const bytes = diagnosticBytes(record);
          if (records.length >= 32 || usedBytes + bytes > 65536 - 8192) return false;
          records.push(record); usedBytes += bytes; return true;
        };
        if (cursor.segment === 'events') {
          for (const id of eventIds) {
            if (Number(id.slice(2)) <= cursor.lastSequence) continue;
            if (records.length >= 32) break;
            const record = await readEvent(id);
            if (!accept(record)) break;
            cursor.lastSequence = record.sequence;
          }
          if (!eventIds.some(id => Number(id.slice(2)) > cursor.lastSequence)) { cursor.segment = 'operations'; cursor.position = null; }
        }
        if (cursor.segment === 'operations') {
          let stop = false;
          while (!stop && records.length < 32) {
            const entries = await operationPage(cursor.position ?? undefined);
            if (!entries) break;
            for (const [key, raw] of entries) {
              if (records.length >= 32) { stop = true; break; }
              const record = await project(key, raw, false);
              if (record.generation < before.binding.generation || highWater.operations === null || record.ordinal === null || record.ordinal < highWater.operations) {
                if (!accept(record)) { stop = true; break; }
              }
              cursor.position = key;
            }
            if (!stop && entries.size < 32) { cursor.segment = 'legacy'; cursor.position = null; break; }
          }
        }
        if (cursor.segment === 'legacy') {
          const ids = legacyIds.filter(id => cursor.position === null || id > cursor.position);
          let exhausted = true;
          for (const id of ids) {
            if (records.length >= 32 || inspected >= 1024) { exhausted = false; break; }
            inspected++;
            const record = await project(id, legacy![id], true);
            if (!accept(record)) { exhausted = false; break; }
            cursor.position = id;
          }
          if (exhausted) cursor.segment = 'complete';
        }
        const complete = cursor.segment === 'complete';
        let nextCursor: string | null = null;
        if (!complete) {
          try { nextCursor = encodeOpaque(await encryptForKV(canonicalDiagnostic(cursor), cryptoKey!, aad)); }
          catch { throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE'); }
          if (nextCursor.length > 4096) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
        }
        const retainedStatus = health.status === 'loss' ? 'loss' : health.status === 'unavailable' ? 'unavailable' : 'complete';
        response = { ...common(), records, nextCursor, pageStatus: complete ? 'complete' : 'more', retainedStatus,
          sourceOrder: 'diagnostic-sequence-then-operation-storage-key' };
        if (options.view === 'export') {
          const snapshot = { binding: before.binding, highWater, epoch: retention.epoch };
          response.snapshotDigest = hashDiagnostic(canonicalDiagnostic(snapshot));
          response.partDigest = hashDiagnostic(canonicalDiagnostic({ ...snapshot, records, pageStatus: response.pageStatus, retainedStatus }));
        }
      }
    }
    const after = await input.state(); ensureLive();
    if (!after || after.ownerKey !== input.ownerKey || after.activityId !== before.activityId) return null;
    if (!after.bindingValid || !sameBinding(after.binding, before.binding)) throw new DiagnosticReadError(409, 'DIAGNOSTICS_BINDING_CHANGED');
    // Do not return a pre-retirement completeness claim if cleanup raced this
    // read. The same binding/cursor remains usable on the next passive request.
    if (after.sdkRetired && !before.sdkRetired && before.logging && before.provenance) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
    if (options.view !== 'summary') {
      const finalLegacy = await input.storage.get<Record<string, unknown>>('dispatcher:operations'); ensureLive();
      const finalMarker = finalLegacy && typeof finalLegacy === 'object' && !Array.isArray(finalLegacy)
        ? hashDiagnostic(canonicalDiagnostic(Object.keys(finalLegacy).sort())) : null;
      if (finalMarker !== legacyMarker) throw new DiagnosticReadError(409, 'DIAGNOSTICS_BINDING_CHANGED');
    }
    const finalIndexRaw = await input.storage.get(DIAGNOSTIC_INDEX); ensureLive();
    const finalIndex = indexSchema.safeParse(finalIndexRaw);
    if (index && (!finalIndex.success || !sameBinding(finalIndex.data, index) || finalIndex.data.epoch !== index.epoch)) throw new DiagnosticReadError(409, 'DIAGNOSTICS_BINDING_CHANGED');
    if (diagnosticBytes(response) > 65536) throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
    return response;
  };
  try {
    return await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { timedOut = true; reject(new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE')); }, 10000);
    })]);
  } catch (error) {
    if (error instanceof DiagnosticReadError) throw error;
    throw new DiagnosticReadError(503, 'DIAGNOSTICS_UNAVAILABLE');
  } finally { clearTimeout(timer); }
}
