import { z } from 'zod';

/** Owner-only lifecycle metadata. This interface is separate from result collection. */
export interface DispatcherActivityDiagnostics {
  version: 1;
  activityId: string;
  capturedAt: string;
  consistency: 'stable-binding' | 'changed-binding';
  parent: {
    admissionPhase: 'prepared' | 'admitting' | 'queued' | 'cancelled';
    driveGeneration: number | null;
    executionStatus: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancel-requested' | 'unknown';
    updatedAt: number | null;
    checkpointPresent: boolean;
    resultPresent: boolean;
    lease: null | {
      generation: number; status: 'admitting' | 'running' | 'settled' | 'unknown';
      artifactDigest: string; inputDigest: string; expiresAt: number; expired: boolean;
      sdkReleased: boolean; projectionPresent: boolean;
      submissionDigest: string | null; settledSubmissionDigest: string | null;
      phase: 'discovery' | 'target' | 'final' | 'single'; phaseIndex: number | null;
      deliveryDigest: string | null; receiptPresent: boolean;
      previousPhases: number; targetCount: number | null; resultCount: number | null;
    };
    journal: null | { generation: number; count: number; unresolved: number; nextOrdinal: number };
    operations: DispatcherOperationDiagnostics;
    reconciliationInFlight: boolean;
    facetCachePresent: boolean;
  };
  sdk: DispatcherSdkDiagnostics;
}
/** A bounded logical-operation tail, not an inference-attempt or response-body history. */
export interface DispatcherOperationDiagnostics {
  status: 'available' | 'unavailable';
  reason?: 'not-dispatcher' | 'no-journal' | 'binding-mismatch' | 'read-failed' | 'read-timeout' | 'changed-binding';
  generation: number | null;
  selection: 'highest-logical-ordinals';
  scan: 'complete' | 'bounded' | 'unavailable';
  inspectedEntries: number;
  omittedEntries: boolean;
  records: Array<{
    operationDigest: string; ordinal: number | null; status: 'reserved' | 'completed' | 'unknown';
    requestDigest: string | null; responseDigest: string | null;
    binding: null | {
      scope: 'requested' | 'other'; submissionDigest: string; deliveryDigest: string;
      phase: 'discovery' | 'target' | 'final'; phaseIndex: number | null;
      resource: 'inference' | 'source' | 'comment' | 'merge' | 'pull-request' | 'files' | 'checks'
        | 'release-notes' | 'upstream-guide' | 'changed-compose' | 'open-pull-requests' | 'unknown';
    };
    /** Current retained host attempt only. This index/ordinal is never an SDK attempt identity. */
    hostInference: null | {
      index: number; ordinal: number; status: 'ready' | 'in-flight' | 'completed' | 'unknown';
      classification: 'usable' | 'final-error' | 'retryable' | 'permanent' | 'transport' | 'unknown';
      responseDigest: string | null;
    };
  }>;
}
export interface DispatcherSdkDiagnostics {
  status: 'available' | 'unavailable';
  reason?: 'not-dispatcher' | 'unbound' | 'retired' | 'runtime-unavailable' | 'submission-missing'
    | 'binding-mismatch' | 'unsupported-storage' | 'invalid-metadata' | 'read-failed' | 'read-timeout'
    | 'changed-binding' | 'response-limit';
  submission?: {
    status: 'queued' | 'running' | 'terminalizing' | 'settled' | 'joining' | 'joined' | 'unknown';
    sequence: number; attemptCount: number; maxAttempts: number;
    acceptedAt: number | null; canonicalReadyAt: number | null; inputAppliedAt: number | null;
    abortRequestedAt: number | null; startedAt: number | null; settledAt: number | null;
    timeoutAt: number | null; leaseExpiresAt: number | null;
    attemptDigest: string | null; ownerPresent: boolean; joinedIntoDigest: string | null;
    errorPresent: boolean; settlementRecordPresent: boolean;
    settlementOutcome: 'completed' | 'failed' | 'aborted' | 'unknown';
  };
  stream?: { nextOffset: number; producerEpoch: number; nextProducerSequence: number; producerPresent: boolean };
  canonical?: {
    scope: 'latest-instance-batches'; contentRecordsExcluded: true;
    olderBatchesOmitted: boolean; recordLimitReached: boolean; inlineMetadataComplete: boolean;
    batches: Array<{ sequence: number; submissionDigest: string | null; attemptDigest: string | null; inline: boolean }>;
    records: Array<{
      sequence: number; index: number; type: typeof RECORD_TYPES[number] | 'unknown'; timestamp: string | null;
      scope: 'requested' | 'other' | 'unassociated';
      recordDigest: string | null; submissionDigest: string | null; attemptDigest: string | null;
      messageDigest: string | null; toolCallDigest: string | null; nameDigest: string | null;
      error: boolean; terminate: boolean; dataPresent: boolean;
      stopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | 'unknown';
      outcome: 'completed' | 'failed' | 'aborted' | 'unknown';
    }>;
  };
}

export interface DispatcherSqlFacet {
  sql(strings: readonly string[], ...values: (string | number | boolean | null)[]): Promise<unknown>;
}
const RECORD_TYPES = ['assistant_message_started', 'assistant_tool_call', 'assistant_message_completed',
  'tool_outcome', 'tool_results_committed', 'agent_start_run', 'agent_finish_cycle',
  'message_data_write', 'submission_settled', 'tool_step_settled', 'signal', 'state_write'] as const;
const SUBMISSION_STATUSES = ['queued', 'running', 'terminalizing', 'settled', 'joining', 'joined'] as const;
const OUTCOMES = ['completed', 'failed', 'aborted'] as const;
const STOP_REASONS = ['stop', 'length', 'toolUse', 'error', 'aborted'] as const;
const text = z.string().max(512).nullable();
const number = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const rowSchema = z.strictObject({ tag: z.enum(['submission', 'stream', 'batch', 'record']),
  seq: z.number().int().min(0).safe(), record_index: z.number().int().min(0).safe(), metadata: z.string().max(8192) });
const submissionSchema = z.strictObject({ status: text, sequence: number, attempt_count: number, max_attempts: number,
  accepted_at: number, canonical_ready_at: number, input_applied_at: number, abort_requested_at: number,
  started_at: number, settled_at: number, timeout_at: number, lease_expires_at: number,
  attempt_id: text, owner_present: z.number().int().min(0).max(1), joined_into: text,
  error_present: z.number().int().min(0).max(1), settlement_present: z.number().int().min(0).max(1), outcome: text });
const streamSchema = z.strictObject({ next_offset: number, producer_epoch: number,
  next_producer_sequence: number, producer_present: z.number().int().min(0).max(1) });
const batchSchema = z.strictObject({ submission_id: text, attempt_id: text, inline: z.number().int().min(0).max(1) });
const recordSchema = z.strictObject({ type: text, timestamp: text, id: text, submission_id: text, attempt_id: text,
  message_id: text, tool_call_id: text, name: text, is_error: z.number().int().min(0).max(1),
  terminate: z.number().int().min(0).max(1), data_present: z.number().int().min(0).max(1), stop_reason: text, outcome: text });

// A single atomic SELECT against the original owned facet. Neither SQL nor field
// paths come from the caller. No payload, content, arguments, state values or raw
// error is selected. Chunked/corrupt batches are reported as gaps, not reconstructed.
const SNAPSHOT_SQL = `WITH
  requested AS (SELECT * FROM flue_agent_submissions WHERE submission_id = ? LIMIT 1),
  lane AS (SELECT CASE WHEN substr(session_key, 1, 14) = 'agent-session:'
    AND json_valid(substr(session_key, 15)) THEN substr(session_key, 15) ELSE '[]' END AS identity FROM requested),
  stream AS (SELECT s.* FROM flue_conversation_streams s, lane
    WHERE json_extract(s.identity_json, '$.agentName') = json_extract(lane.identity, '$[0]')
      AND json_extract(s.identity_json, '$.instanceId') = json_extract(lane.identity, '$[1]')
      AND EXISTS (SELECT 1 FROM flue_conversation_stream_batches birth,
        json_each(CASE WHEN json_valid(birth.data) THEN CASE WHEN json_type(birth.data) = 'array'
          THEN birth.data ELSE '[]' END ELSE '[]' END) e
        WHERE birth.path = s.path AND birth.seq = 0
          AND json_extract(e.value, '$.type') = 'conversation_created'
          AND json_extract(e.value, '$.kind') = 'root'
          AND json_extract(e.value, '$.uid') = ?) LIMIT 2),
  tail AS (SELECT b.seq, b.data, b.submission_id, b.attempt_id FROM flue_conversation_stream_batches b
    JOIN stream s ON s.path = b.path ORDER BY b.seq DESC LIMIT 33),
  events AS (SELECT b.seq, e.key AS record_index, e.value AS event FROM
    (SELECT * FROM tail ORDER BY seq DESC LIMIT 32) b,
    json_each(CASE WHEN json_valid(b.data) THEN CASE WHEN json_type(b.data) = 'array'
      THEN b.data ELSE '[]' END ELSE '[]' END) e
    WHERE json_extract(e.value, '$.type') IN ('assistant_message_started', 'assistant_tool_call',
      'assistant_message_completed', 'tool_outcome', 'tool_results_committed', 'agent_start_run',
      'agent_finish_cycle', 'message_data_write', 'submission_settled', 'tool_step_settled', 'signal', 'state_write')
    ORDER BY b.seq DESC, e.key DESC LIMIT 65)
SELECT 'submission' AS tag, 0 AS seq, 0 AS record_index, json_object(
  'status', status, 'sequence', sequence, 'attempt_count', attempt_count, 'max_attempts', max_attempts,
  'accepted_at', accepted_at, 'canonical_ready_at', canonical_ready_at, 'input_applied_at', input_applied_at,
  'abort_requested_at', abort_requested_at, 'started_at', started_at, 'settled_at', settled_at,
  'timeout_at', timeout_at, 'lease_expires_at', lease_expires_at, 'attempt_id', attempt_id,
  'owner_present', owner_id IS NOT NULL, 'joined_into', joined_into, 'error_present', error IS NOT NULL,
  'settlement_present', settlement_record_id IS NOT NULL,
  'outcome', CASE WHEN json_valid(settlement_record) THEN json_extract(settlement_record, '$.outcome') ELSE NULL END
) AS metadata FROM requested
UNION ALL SELECT 'stream', 0, 0, json_object('next_offset', next_offset, 'producer_epoch', producer_epoch,
  'next_producer_sequence', next_producer_sequence, 'producer_present', producer_id IS NOT NULL) FROM stream
UNION ALL SELECT 'batch', seq, 0, json_object('submission_id', submission_id, 'attempt_id', attempt_id,
  'inline', CASE WHEN json_valid(data) THEN json_type(data) = 'array' ELSE 0 END) FROM tail
UNION ALL SELECT 'record', seq, record_index, json_object(
  'type', json_extract(event, '$.type'), 'timestamp', json_extract(event, '$.timestamp'),
  'id', json_extract(event, '$.id'), 'submission_id', json_extract(event, '$.submissionId'),
  'attempt_id', json_extract(event, '$.attemptId'),
  'message_id', coalesce(json_extract(event, '$.assistantMessageId'), json_extract(event, '$.messageId')),
  'tool_call_id', json_extract(event, '$.toolCallId'),
  'name', coalesce(json_extract(event, '$.toolName'), json_extract(event, '$.name')),
  'is_error', CASE WHEN json_extract(event, '$.isError') = 1 OR json_type(event, '$.error') NOT IN ('null') THEN 1 ELSE 0 END,
  'terminate', CASE WHEN json_extract(event, '$.terminate') = 1 THEN 1 ELSE 0 END,
  'data_present', CASE WHEN json_type(event, '$.data') IS NOT NULL OR json_type(event, '$.output') IS NOT NULL THEN 1 ELSE 0 END,
  'stop_reason', json_extract(event, '$.stopReason'), 'outcome', json_extract(event, '$.outcome')) FROM events`;

function known<T extends readonly string[]>(value: unknown, values: T): T[number] | 'unknown' {
  return typeof value === 'string' && values.includes(value) ? value : 'unknown';
}
export const sdkUnavailable = (reason: NonNullable<DispatcherSdkDiagnostics['reason']>): DispatcherSdkDiagnostics =>
  ({ status: 'unavailable', reason });
export const operationsUnavailable = (reason: NonNullable<DispatcherOperationDiagnostics['reason']>,
  generation: number | null = null): DispatcherOperationDiagnostics => ({ status: 'unavailable', reason, generation,
  selection: 'highest-logical-ordinals', scan: 'unavailable', inspectedEntries: 0, omittedEntries: true, records: [] });

/** No initialization, fetch, fiber inspection, or recovery method is called here. */
export async function readDispatcherSdkDiagnostics(facet: DispatcherSqlFacet, submissionId: string, instanceUid: string,
  hash: (value: string) => Promise<string>): Promise<DispatcherSdkDiagnostics> {
  try {
    // The receipt UID belongs to the root birth record, not the stream incarnation.
    // Agents.sql accepts template segments, inserting its own bound placeholders.
    const raw = await facet.sql(SNAPSHOT_SQL.split('?'), submissionId, instanceUid);
    const rows = z.array(rowSchema).max(101).parse(raw);
    if (new TextEncoder().encode(JSON.stringify(rows)).byteLength > 256 * 1024) return sdkUnavailable('response-limit');
    const submissions = rows.filter(row => row.tag === 'submission');
    if (submissions.length !== 1) return sdkUnavailable('submission-missing');
    const streams = rows.filter(row => row.tag === 'stream');
    if (streams.length !== 1) return sdkUnavailable('binding-mismatch');
    const s = submissionSchema.parse(JSON.parse(submissions[0].metadata));
    const m = streamSchema.parse(JSON.parse(streams[0].metadata));
    if (s.sequence === null || s.attempt_count === null || s.max_attempts === null
      || m.next_offset === null || m.producer_epoch === null || m.next_producer_sequence === null) {
      return sdkUnavailable('invalid-metadata');
    }
    const digest = (value: string | null) => value === null ? Promise.resolve(null) : hash(value);
    const batches = rows.filter(row => row.tag === 'batch').sort((a, b) => b.seq - a.seq);
    const records = rows.filter(row => row.tag === 'record').sort((a, b) => b.seq - a.seq || b.record_index - a.record_index);
    const batchProjection = await Promise.all(batches.slice(0, 32).reverse().map(async row => {
      const b = batchSchema.parse(JSON.parse(row.metadata));
      return { sequence: row.seq, submissionDigest: await digest(b.submission_id),
        attemptDigest: await digest(b.attempt_id), inline: b.inline === 1 };
    }));
    const recordProjection = await Promise.all(records.slice(0, 64).reverse().map(async row => {
      const e = recordSchema.parse(JSON.parse(row.metadata));
      return { sequence: row.seq, index: row.record_index, type: known(e.type, RECORD_TYPES),
        timestamp: z.iso.datetime().safeParse(e.timestamp).success ? e.timestamp : null,
        scope: e.submission_id === submissionId ? 'requested' as const
          : e.submission_id === null ? 'unassociated' as const : 'other' as const,
        recordDigest: await digest(e.id), submissionDigest: await digest(e.submission_id),
        attemptDigest: await digest(e.attempt_id), messageDigest: await digest(e.message_id),
        toolCallDigest: await digest(e.tool_call_id), nameDigest: await digest(e.name),
        error: e.is_error === 1, terminate: e.terminate === 1, dataPresent: e.data_present === 1,
        stopReason: known(e.stop_reason, STOP_REASONS), outcome: known(e.outcome, OUTCOMES) };
    }));
    return { status: 'available', submission: {
      status: known(s.status, SUBMISSION_STATUSES), sequence: s.sequence, attemptCount: s.attempt_count, maxAttempts: s.max_attempts,
      acceptedAt: s.accepted_at, canonicalReadyAt: s.canonical_ready_at, inputAppliedAt: s.input_applied_at,
      abortRequestedAt: s.abort_requested_at, startedAt: s.started_at, settledAt: s.settled_at,
      timeoutAt: s.timeout_at, leaseExpiresAt: s.lease_expires_at, attemptDigest: await digest(s.attempt_id),
      ownerPresent: s.owner_present === 1, joinedIntoDigest: await digest(s.joined_into),
      errorPresent: s.error_present === 1, settlementRecordPresent: s.settlement_present === 1,
      settlementOutcome: known(s.outcome, OUTCOMES),
    }, stream: { nextOffset: m.next_offset, producerEpoch: m.producer_epoch,
      nextProducerSequence: m.next_producer_sequence, producerPresent: m.producer_present === 1 }, canonical: {
      scope: 'latest-instance-batches', contentRecordsExcluded: true,
      olderBatchesOmitted: batches.length > 32, recordLimitReached: records.length > 64,
      inlineMetadataComplete: batches.length <= 32 && records.length <= 64 && batchProjection.every(b => b.inline)
        && batchProjection.length === m.next_offset && batchProjection.every((b, index) => b.sequence === index),
      batches: batchProjection, records: recordProjection,
    } };
  } catch (error) {
    return sdkUnavailable(error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid-metadata' : 'read-failed');
  }
}
