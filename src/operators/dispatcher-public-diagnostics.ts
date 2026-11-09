import { z } from 'zod';
import { counter, digestSchema, errorSchema, eventSchema, hashDiagnostic, publicSdkMetadataSchema,
  type Boundary, type Correlation, type DiagnosticEvent, type PublicSdkMetadata, type ReasonCode } from './dispatcher-diagnostics-wire';
import { DIAGNOSTIC_INDEX, indexSchema, eventKey, sameBinding, type EventObservation } from './dispatcher-diagnostics-store';
import { sdkUnavailable, type DispatcherSdkDiagnostics } from './dispatcher-runtime-diagnostics';

const identity = z.string().min(1).max(512);
export const publicSdkReportSchema = z.strictObject({ version: z.literal(2), captureId: digestSchema,
  timestamp: counter, records: z.array(z.strictObject({ submissionId: identity.optional(), rootUid: identity.optional(),
    metadata: publicSdkMetadataSchema, error: errorSchema.refine(value => value.publicCode === null
      && !value.sdkService && !value.journal && !value.admissionType).optional() })).min(1).max(64) });
type PublicSdkReport = z.infer<typeof publicSdkReportSchema>;
export interface PublicSdkSnapshot {
  format: 'flue-public-v3';
  receipt: { submissionDigest: string; rootDigest: string; acceptedAt: string };
  submission: { status: 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'unknown'; attemptCount: number | null; maxAttempts: number | null };
  observations: Array<{ sequence: number; capturedAt: number; correlation: Correlation;
    metadata: PublicSdkMetadata; error?: z.infer<typeof errorSchema> }>;
  coverage: { complete: false; gaps: string[] };
}

/** Parent context comes from the admitted package and actual original receipts, never report fields. */
export function projectPublicSdkRecords(report: PublicSdkReport, context: {
  sdkVersion: string; rootUid?: string; submissionIds: readonly string[];
}): Array<{ captureId: string; observation: EventObservation }> {
  if (context.sdkVersion !== '2.3.0') throw new Error('Public SDK binding unavailable');
  return report.records.map((record, index) => {
    if (record.rootUid !== undefined && record.rootUid !== context.rootUid) throw new Error('Public SDK binding mismatch');
    const known = record.submissionId !== undefined && context.submissionIds.includes(record.submissionId);
    // Historical public messages may belong to another submission in this exact
    // incarnation. They never borrow the current submission or native attempt.
    if (record.submissionId && !known && (record.metadata.kind === 'event' || !record.rootUid)) {
      throw new Error('Public SDK submission binding mismatch');
    }
    const correlation: Correlation = {};
    if (record.submissionId && (known || record.rootUid === context.rootUid)) {
      correlation.submissionDigest = hashDiagnostic(record.submissionId);
      if (context.rootUid) correlation.rootDigest = hashDiagnostic(context.rootUid);
    }
    const metadata = record.metadata;
    let boundary: Boundary = 'canonical-commit';
    let outcome: EventObservation['outcome'] = 'committed';
    let code: ReasonCode = 'none';
    if (metadata.kind === 'event') {
      switch (metadata.eventType) {
        case 'submission_queued': boundary = 'submission'; outcome = 'accepted'; break;
        case 'submission_running': boundary = 'delivery'; outcome = 'started'; break;
        case 'submission_recovery': boundary = 'recovery'; outcome = 'unknown'; code = 'unclassified'; break;
        case 'submission_settled': boundary = 'settlement'; outcome = metadata.outcome === 'completed' ? 'completed' : 'failed';
          code = metadata.outcome === 'aborted' ? 'cancelled' : metadata.outcome === 'failed' ? 'settlement-failed' : 'none'; break;
        case 'turn_start': case 'turn_request': boundary = 'model'; outcome = 'started'; break;
        case 'turn': boundary = 'model'; outcome = metadata.errorPresent ? 'failed' : 'completed';
          code = metadata.errorPresent ? 'provider-failed' : 'none'; break;
        case 'tool_start': boundary = 'tool'; outcome = 'started'; break;
        case 'tool': boundary = 'tool'; outcome = metadata.errorPresent ? 'failed' : 'completed';
          code = metadata.errorPresent ? 'tool-failed' : 'none'; break;
        case 'turn_messages': break; // Documented post-tool-batch commit witness, not SQL coordinates.
      }
    } else if (metadata.kind === 'settlement') {
      boundary = 'settlement'; outcome = metadata.outcome === 'completed' ? 'completed' : 'failed';
      code = metadata.outcome === 'aborted' ? 'cancelled' : metadata.outcome === 'failed' ? 'settlement-failed' : 'none';
    } else if (metadata.kind === 'message' && (metadata.role === 'user' || metadata.purpose === 'dispatch')) {
      boundary = 'delivery'; outcome = 'applied';
    }
    return { captureId: hashDiagnostic(`${report.captureId}:${index}`), observation: {
      timestamp: report.timestamp, owner: 'sdk', boundary, outcome, code, evidence: 'observed', origin: 'state-transition',
      source: { package: '@flue/runtime', boundary, baseVersion: context.sdkVersion, patchSetDigest: null, status: 'partial', frames: [] },
      correlation, publicSdk: metadata, ...(record.error ? { error: record.error } : {}),
    } };
  });
}

export function publicSdkSourceMatches(record: DiagnosticEvent, version: string | undefined): boolean {
  return !!record.publicSdk && version === '2.3.0' && record.owner === 'sdk'
    && record.source.package === '@flue/runtime' && record.source.baseVersion === version
    && record.source.patchSetDigest === null && record.source.status === 'partial' && record.source.frames.length === 0
    && record.correlation.sdkAttemptDigest === undefined && record.correlation.sdkBatchSequence === undefined
    && record.correlation.sdkProducerEpoch === undefined && record.correlation.sdkProducerSequence === undefined
    && record.correlation.sdkRecordIndex === undefined;
}

/** Read retained parent records only. No SDK call, recovery, timer renewal or mutation. */
export async function readPublicSdkDiagnostics(storage: { get(key: string): Promise<unknown> },
  binding: { generation: number; artifactDigest: string; inputDigest: string },
  receipt: { submissionId: string; uid: string; acceptedAt: string }, sdkVersion: string,
  deadline: number, loggingEnabled = true): Promise<DispatcherSdkDiagnostics> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async (): Promise<DispatcherSdkDiagnostics> => {
    if (sdkVersion !== '2.3.0') return sdkUnavailable('unsupported-storage');
    const digest = hashDiagnostic(receipt.submissionId);
    const result: PublicSdkSnapshot = { format: 'flue-public-v3', receipt: { submissionDigest: digest,
      rootDigest: hashDiagnostic(receipt.uid), acceptedAt: receipt.acceptedAt },
    submission: { status: 'unknown', attemptCount: null, maxAttempts: null }, observations: [],
    coverage: { complete: false, gaps: ['best-effort-events', ...(!loggingEnabled ? ['logging-disabled'] : [])] } };
    const raw = await storage.get(DIAGNOSTIC_INDEX);
    if (raw === undefined) { result.coverage.gaps.push('not-observed'); return { status: 'available', public: result }; }
    const index = indexSchema.parse(raw);
    if (!sameBinding(index, binding)) return sdkUnavailable('changed-binding');
    const ids = [...new Set([...index.routineIds, ...index.pinnedEventIds])].sort((a, b) => Number(b.slice(2)) - Number(a.slice(2)));
    for (const id of ids) {
      if (Date.now() >= deadline) return sdkUnavailable('read-timeout');
      const record = eventSchema.parse(await storage.get(eventKey(Number(id.slice(2)))));
      if (record.generation !== binding.generation || !record.publicSdk) continue;
      if (!publicSdkSourceMatches(record, sdkVersion)) return sdkUnavailable('invalid-metadata');
      if (result.observations.length === 64) { result.coverage.gaps.push('records-omitted'); break; }
      result.observations.push({ sequence: record.sequence, capturedAt: record.timestamp, correlation: record.correlation,
        metadata: record.publicSdk, ...(record.error ? { error: record.error } : {}) });
    }
    result.observations.reverse();
    if (!result.observations.length) result.coverage.gaps.push('not-observed');
    if (index.evictedRoutine || index.droppedFailure || index.droppedTerminal
      || result.observations.some(record => record.metadata.recordsOmitted)) result.coverage.gaps.push('records-omitted');
    for (const record of result.observations) {
      if (record.correlation.submissionDigest !== digest) continue;
      const metadata = record.metadata;
      if (metadata.eventType === 'submission_queued') result.submission.status = 'queued';
      if (metadata.eventType === 'submission_running') {
        result.submission.status = 'running'; result.submission.attemptCount = metadata.attemptCount ?? null;
        result.submission.maxAttempts = metadata.maxAttempts ?? null;
      }
      if (metadata.kind === 'settlement' || metadata.eventType === 'submission_settled') result.submission.status = metadata.outcome ?? 'unknown';
    }
    result.coverage.gaps = [...new Set(result.coverage.gaps)];
    return { status: 'available', public: result };
  };
  try { return await Promise.race([run(), new Promise<DispatcherSdkDiagnostics>(resolve => {
    timer = setTimeout(() => resolve(sdkUnavailable('read-timeout')), Math.max(0, deadline - Date.now()));
  })]); }
  catch { return sdkUnavailable('invalid-metadata'); }
  finally { clearTimeout(timer); }
}
