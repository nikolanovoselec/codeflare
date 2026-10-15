import { z } from 'zod';

// REQ-OPERATOR-081 AC6: closed public metadata contract, deliberately independent
// of the private runtime envelope and backend's Zod instance.
const integer = z.number().int().nonnegative().safe();
const positive = integer.positive();
const timestamp = z.number().int().safe().min(-8_640_000_000_000_000).max(8_640_000_000_000_000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const activityId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const eventId = z.string().max(18).regex(/^e-[1-9][0-9]*$/)
  .refine(value => Number.isSafeInteger(Number(value.slice(2))));
const operationId = z.string().max(83).regex(/^o-(?:0|[1-9][0-9]*)-[a-f0-9]{64}$/)
  .refine(value => Number.isSafeInteger(Number(value.split('-')[1])));
export const diagnosticRecordIdSchema = z.union([eventId, operationId]);
const capsuleId = z.string().max(18).regex(/^(?:f-[1-9][0-9]*|t-(?:0|[1-9][0-9]*))$/)
  .refine(value => Number.isSafeInteger(Number(value.slice(2))));
const withinBytes = (value: unknown, limit: number) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= limit;
export const diagnosticCursorSchema = z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/);
export const diagnosticBoundarySchema = z.enum(['artifact', 'admission', 'construction', 'submission', 'scheduling',
  'delivery', 'model', 'inference-response', 'canonical-commit', 'tool', 'effect', 'recovery', 'settlement',
  'continuation', 'fence', 'release', 'platform', 'recorder']);
const reason = z.enum(['none', 'unclassified', 'artifact-unavailable', 'artifact-mismatch', 'admission-denied',
  'authority-expired', 'authority-denied', 'stale-drive', 'startup-failed', 'submission-failed', 'sse-json-invalid',
  'provider-failed', 'stream-failed', 'response-unusable', 'canonical-append-failed', 'tool-failed', 'effect-unknown',
  'settlement-failed', 'continuation-not-ready', 'cancelled', 'deadline-expired', 'cleanup-failed', 'capacity-exhausted',
  'recorder-unavailable', 'platform-evidence-required']);
const gap = z.enum(['legacy-uncaptured', 'sdk-import-incomplete', 'platform-evidence-required', 'routine-evicted',
  'failure-overflow', 'terminal-overflow', 'oversized-record', 'invalid-record', 'error-truncated',
  'recorder-unavailable', 'source-unverified', 'logging-disabled']);
const errorLoss = z.enum(['cause-cycle', 'cause-depth', 'message-truncated', 'stack-truncated',
  'unsafe-error-access', 'uninspectable-throw']);
const errorKind = z.enum(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ValidationError', 'TransportDenied',
  'DefiniteEffectFailure', 'other']);
// Existing public producer/domain codes, not arbitrary Error.message values.
const publicCode = z.enum(['none', 'unknown', 'schema-validation', 'target-admission', 'persisted-target',
  'repository-scope', 'immutable-ref', 'discovery-incomplete', 'source-incomplete', 'source-http', 'source-redirect',
  'source-transport', 'source-format', 'source-secret', 'source-provenance', 'decision-missing', 'decision-conflict',
  'already-sealed', 'not-sealed', 'citation-provenance', 'upgrade-evidence', 'decisions-incomplete', 'receipt-unavailable',
  'capacity', 'result-size', 'merge-decision', 'comment-receipt', 'results-incomplete', 'effect-unknown',
  'effect-denied', 'provider-token-bound', 'provider-fetch', 'provider-http', 'runtime-shape']);
export const diagnosticErrorSchema = z.strictObject({ kind: errorKind, publicCode: publicCode.nullable(),
  messageDigest: digest.nullable(), stackDigest: digest.nullable(),
  causes: z.array(z.strictObject({ kind: errorKind, messageDigest: digest.nullable(), stackDigest: digest.nullable() })).max(3),
  loss: z.array(errorLoss).max(6), fingerprintScope: z.enum(['full', 'bounded', 'unavailable']) });
export const diagnosticBindingSchema = z.strictObject({ generation: integer, artifactDigest: digest, inputDigest: digest });
const repository = z.enum(['nikolanovoselec/codeflare', 'nikolanovoselec/codeflare-operator-dispatcher',
  'withastro/flue', 'cloudflare/agents']);
const frameKind = z.enum(['originating', 'catching', 'patch-boundary']);
// Only public source trees, never absolute/stack paths, URLs, dot segments,
// percent encodings, credentials, generated payload files or caller URL text.
const publicPath = z.string().max(512).regex(/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.(?:ts|tsx|js|jsx|mjs|cjs)$/)
  .refine(path => path.split('/').every(part => part !== '.' && part !== '..' && part.length > 0));
const frame = z.strictObject({ repository, commit, path: publicPath, line: positive, column: integer, kind: frameKind })
  .refine(value => {
    const prefixes: Record<z.infer<typeof repository>, readonly string[]> = {
      'nikolanovoselec/codeflare': ['src/', 'host/src/', 'preseed/'],
      'nikolanovoselec/codeflare-operator-dispatcher': ['src/'],
      'withastro/flue': ['packages/runtime/src/'],
      'cloudflare/agents': ['src/'],
    };
    return prefixes[value.repository].some(prefix => value.path.startsWith(prefix));
  }, 'Untrusted public source path');
const source = z.strictObject({ package: z.enum(['codeflare', '@codeflare/operator-dispatcher', '@flue/runtime', 'agents', 'cloudflare']),
  boundary: diagnosticBoundarySchema, baseVersion: z.string().max(128).regex(/^[A-Za-z0-9.+_-]+$/).nullable(),
  patchSetDigest: digest.nullable(), status: z.enum(['verified', 'partial', 'unavailable']), frames: z.array(frame).max(4) });
const correlation = z.strictObject({
  logicalOrdinal: integer.nullable().optional(), hostAttemptIndex: integer.nullable().optional(),
  chargedOrdinal: integer.nullable().optional(), sdkAttemptDigest: digest.nullable().optional(),
  submissionDigest: digest.nullable().optional(), deliveryDigest: digest.nullable().optional(),
  requestDigest: digest.nullable().optional(), responseDigest: digest.nullable().optional(),
  rootDigest: digest.nullable().optional(), streamIncarnationDigest: digest.nullable().optional(),
  sdkBatchSequence: integer.nullable().optional(), sdkProducerEpoch: integer.nullable().optional(),
  sdkProducerSequence: integer.nullable().optional(), sdkRecordIndex: integer.nullable().optional(),
});
const event = z.strictObject({ kind: z.literal('event'), id: eventId, sequence: positive, generation: integer,
  timestamp, owner: z.enum(['host', 'sdk', 'producer', 'platform', 'recorder']), boundary: diagnosticBoundarySchema,
  outcome: z.enum(['started', 'accepted', 'applied', 'committed', 'completed', 'failed', 'recovered', 'unknown', 'released', 'suppressed']),
  code: reason, evidence: z.enum(['observed', 'unavailable']), origin: z.enum(['originating', 'catching', 'state-transition']),
  correlation, source, error: diagnosticErrorSchema.optional(), capsuleId: capsuleId.optional(),
}).refine(value => withinBytes(value, 4096) && value.id === `e-${value.sequence}` && value.source.boundary === value.boundary,
  'Contradictory event identity');
const operation = z.strictObject({ kind: z.literal('operation'), id: operationId,
  generation: integer, operationDigest: digest, ordinal: integer.nullable(), status: z.enum(['reserved', 'completed', 'unknown']),
  requestDigest: digest.nullable(), responseDigest: digest.nullable(),
  binding: z.strictObject({ scope: z.enum(['requested', 'other']), submissionDigest: digest, deliveryDigest: digest,
    phase: z.enum(['discovery', 'target', 'final']), phaseIndex: integer.nullable(),
    resource: z.enum(['inference', 'source', 'comment', 'merge', 'pull-request', 'files', 'checks', 'release-notes',
      'upstream-guide', 'changed-compose', 'open-pull-requests', 'unknown']) }).nullable(),
  hostInference: z.strictObject({ index: integer, ordinal: integer, status: z.enum(['ready', 'in-flight', 'completed', 'unknown']),
    classification: z.enum(['usable', 'final-error', 'retryable', 'permanent', 'transport', 'unknown']), responseDigest: digest.nullable() }).nullable(),
  availability: z.enum(['retained', 'unavailable']), association: z.enum(['verified', 'unassociated', 'changed-binding', 'legacy', 'unavailable']),
}).refine(value => withinBytes(value, 4096) && value.id === `o-${value.generation}-${value.operationDigest}`, 'Contradictory operation identity');
export const diagnosticRecordSchema = z.discriminatedUnion('kind', [event, operation]);
const capsule = z.strictObject({ id: capsuleId, kind: z.enum(['failure', 'terminal']), binding: diagnosticBindingSchema,
  eventId: eventId.nullable(), code: reason, error: diagnosticErrorSchema.nullable(), lastHostPersistedId: eventId.nullable(),
  sdk: z.strictObject({ rootDigest: digest.optional(), submissionDigest: digest.optional(), attemptDigest: digest.optional(),
    batchSequence: integer.optional(), producerEpoch: integer.optional(), producerSequence: integer.optional(), recordIndex: integer.optional(),
    settlement: z.enum(['reserved', 'canonical', 'finalized', 'unknown']) }).nullable(),
  affectedOperations: z.array(z.strictObject({ operationDigest: digest, effect: z.enum(['read', 'write', 'none', 'unknown']),
    status: z.enum(['completed', 'unknown', 'unavailable']) })).max(8), affectedOperationsOmitted: integer.nullable(),
  loss: z.array(gap).max(12), uncertainty: z.enum(['none-observed', 'prior-effect-uncertain', 'evidence-incomplete']),
}).refine(value => withinBytes(value, 8192), 'Oversized diagnostic capsule');
const common = {
  version: z.literal(2), activityId, capturedAt: timestamp, consistency: z.literal('stable-binding'), binding: diagnosticBindingSchema,
  highWater: z.strictObject({ events: integer.nullable(), operations: integer.nullable() }),
  health: z.strictObject({ status: z.enum(['available', 'loss', 'unavailable']),
    sdkImport: z.enum(['host-persisted', 'pending', 'unavailable', 'legacy']),
    sdkImportReason: z.literal('retirement-tail-unwitnessed').optional(), gaps: z.array(gap).max(12) }),
  retention: z.strictObject({ epoch: integer.nullable(), firstSequence: integer.nullable(), lastSequence: integer.nullable(),
    routineLimit: z.literal(1536), failureLimit: z.literal(64), terminalLimit: z.literal(64),
    evictedRoutine: integer.nullable(), droppedFailure: integer.nullable(), droppedTerminal: integer.nullable(),
    oversized: integer.nullable(), rejected: integer.nullable() }),
};
const sdkBinding = z.strictObject({ status: z.enum(['available', 'unavailable']), rootDigest: digest.optional(),
  submissionDigest: digest.optional(), attemptDigest: digest.optional(),
  reason: z.enum(['unbound', 'legacy', 'unavailable', 'pending', 'not-dispatcher', 'retired', 'runtime-unavailable',
    'submission-missing', 'binding-mismatch', 'unsupported-storage', 'invalid-metadata', 'read-failed', 'read-timeout',
    'changed-binding', 'response-limit', 'legacy-uncaptured', 'sdk-import-incomplete', 'logging-disabled']).optional() });
export const diagnosticSummarySchema = z.strictObject({ ...common,
  capture: z.enum(['enabled', 'disabled', 'legacy', 'unavailable']),
  provenance: z.strictObject({ hostRevision: commit.nullable(), sdkBaseRuntime: z.string().max(128).regex(/^[A-Za-z0-9.+_-]+$/).nullable(),
    sdkBaseAgents: z.string().max(128).regex(/^[A-Za-z0-9.+_-]+$/).nullable(), patchSetDigest: digest.nullable() }),
  capabilities: z.array(z.strictObject({ boundary: diagnosticBoundarySchema,
    availability: z.enum(['supported', 'legacy', 'platform-required', 'unavailable']),
    persistence: z.enum(['host-persisted', 'pending', 'unavailable']) })).max(18), sdkBinding,
  fence: z.strictObject({ generation: integer, timestamp, boundary: diagnosticBoundarySchema, code: reason, uncertain: z.boolean() }).nullable(),
  diagnosis: z.strictObject({ state: z.enum(['observed-failure', 'evidence-incomplete', 'no-failure-observed', 'recovered-failure']),
    code: reason, lastConfirmedId: diagnosticRecordIdSchema.nullable(), failedId: diagnosticRecordIdSchema.nullable(),
    nextCheck: z.enum(['inspect-failure', 'inspect-sdk-import', 'inspect-platform-events', 'inspect-retention-gap',
      'inspect-original-binding', 'inspect-pending-handoff', 'none']) }),
}).refine(value => withinBytes(value, 65536) && new Set(value.capabilities.map(row => row.boundary)).size === value.capabilities.length
  && (!value.fence || value.fence.generation <= value.binding.generation), 'Contradictory summary binding');
const pageShape = { ...common, records: z.array(diagnosticRecordSchema).max(32), nextCursor: diagnosticCursorSchema.nullable(),
  pageStatus: z.enum(['more', 'complete', 'unavailable']), retainedStatus: z.enum(['complete', 'loss', 'unavailable']),
  sourceOrder: z.literal('diagnostic-sequence-then-operation-storage-key') };
export type DiagnosticSummary = z.infer<typeof diagnosticSummarySchema>;
export type DiagnosticRecord = z.infer<typeof diagnosticRecordSchema>;
export type DiagnosticEvent = Extract<DiagnosticRecord, { kind: 'event' }>;
export type DiagnosticErrorMetadata = z.infer<typeof diagnosticErrorSchema>;
export type DiagnosticBinding = z.infer<typeof diagnosticBindingSchema>;
export function sameDiagnosticBinding(left: DiagnosticBinding, right: DiagnosticBinding): boolean {
  return left.generation === right.generation && left.artifactDigest === right.artifactDigest && left.inputDigest === right.inputDigest;
}
function validPage(value: z.infer<z.ZodObject<typeof pageShape>>): boolean {
  let lastSequence = 0;
  let operationsStarted = false;
  return withinBytes(value, 65536) && (value.pageStatus === 'more' ? value.nextCursor !== null : value.nextCursor === null)
    && new Set(value.records.map(row => row.id)).size === value.records.length
    && value.records.every(row => {
      if (row.generation > value.binding.generation) return false;
      if (row.kind === 'operation') { operationsStarted = true; return true; }
      if (operationsStarted || row.sequence <= lastSequence
        || value.highWater.events === null || row.sequence > value.highWater.events) return false;
      lastSequence = row.sequence;
      return true;
    });
}
export const diagnosticHistorySchema = z.strictObject(pageShape).refine(validPage, 'Contradictory diagnostic traversal');
export const diagnosticExportSchema = z.strictObject({ ...pageShape, snapshotDigest: digest, partDigest: digest })
  .refine(validPage, 'Contradictory export traversal');
export const diagnosticDetailSchema = z.strictObject({ ...common, record: diagnosticRecordSchema, capsule: capsule.optional() })
  .refine(value => withinBytes(value, 65536) && value.record.generation <= value.binding.generation && (!value.capsule
    || value.capsule.binding.generation === value.record.generation
      && value.capsule.binding.artifactDigest === value.binding.artifactDigest
      && value.capsule.binding.inputDigest === value.binding.inputDigest
      && value.record.kind === 'event' && value.record.capsuleId === value.capsule.id
      && (value.capsule.kind === 'failure' ? value.capsule.id === `f-${value.record.sequence}` : value.capsule.id === `t-${value.record.generation}`)
      && (value.capsule.eventId === null || value.capsule.eventId === value.record.id)), 'Contradictory record capsule');
export type DiagnosticHistory = z.infer<typeof diagnosticHistorySchema>;
export type DiagnosticExport = z.infer<typeof diagnosticExportSchema>;
export type DiagnosticDetail = z.infer<typeof diagnosticDetailSchema>;
export type DiagnosticSnapshot = Pick<DiagnosticSummary, 'activityId' | 'binding' | 'highWater' | 'retention'>;

export function verifiedDiagnosticSourceUrl(source: DiagnosticEvent['source'], coordinate: DiagnosticEvent['source']['frames'][number]): string | null {
  if (source.status !== 'verified' || !frame.safeParse(coordinate).success) return null;
  return `https://github.com/${coordinate.repository}/blob/${coordinate.commit}/${coordinate.path}#L${coordinate.line}`;
}
