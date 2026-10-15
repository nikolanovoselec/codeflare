import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { DispatcherBundle } from './distribution';
import { producerCodes } from './dispatcher-diagnostic-wire';

export const boundaries = ['artifact', 'admission', 'construction', 'submission', 'scheduling', 'delivery', 'model',
  'inference-response', 'canonical-commit', 'tool', 'effect', 'recovery', 'settlement', 'continuation', 'fence',
  'release', 'platform', 'recorder'] as const;
export const reasonCodes = ['none', 'unclassified', 'artifact-unavailable', 'artifact-mismatch', 'admission-denied',
  'authority-expired', 'authority-denied', 'stale-drive', 'startup-failed', 'submission-failed', 'sse-json-invalid',
  'provider-failed', 'stream-failed', 'response-unusable', 'canonical-append-failed', 'tool-failed', 'effect-unknown',
  'settlement-failed', 'continuation-not-ready', 'cancelled', 'deadline-expired', 'cleanup-failed',
  'capacity-exhausted', 'recorder-unavailable', 'platform-evidence-required'] as const;
export const gaps = ['legacy-uncaptured', 'sdk-import-incomplete', 'platform-evidence-required', 'routine-evicted',
  'failure-overflow', 'terminal-overflow', 'oversized-record', 'invalid-record', 'error-truncated',
  'recorder-unavailable', 'source-unverified', 'logging-disabled'] as const;
export const errorLoss = ['cause-cycle', 'cause-depth', 'message-truncated', 'stack-truncated', 'unsafe-error-access', 'uninspectable-throw'] as const;
export const kinds = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ValidationError', 'TransportDenied', 'DefiniteEffectFailure', 'other'] as const;
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const counter = z.number().int().nonnegative().safe();
export const bindingSchema = z.strictObject({ generation: counter, artifactDigest: digestSchema, inputDigest: digestSchema });
export const sourceFrameSchema = z.strictObject({ repository: z.enum(['nikolanovoselec/codeflare',
  'nikolanovoselec/codeflare-operator-dispatcher', 'withastro/flue', 'cloudflare/agents']),
  commit: z.string().regex(/^[a-f0-9]{40}$/), path: z.string().min(1).max(512).regex(/^[A-Za-z0-9_@./~-]+$/)
    .refine(path => !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..')),
  line: counter.min(1), column: counter, kind: z.enum(['originating', 'catching', 'patch-boundary']) });
export const sourceSchema = z.strictObject({ package: z.enum(['codeflare', '@codeflare/operator-dispatcher', '@flue/runtime', 'agents', 'cloudflare']),
  boundary: z.enum(boundaries), baseVersion: z.string().max(128).nullable(), patchSetDigest: digestSchema.nullable(),
  status: z.enum(['verified', 'partial', 'unavailable']), frames: z.array(sourceFrameSchema).max(4) });
const causeSchema = z.strictObject({ kind: z.enum(kinds), messageDigest: digestSchema.nullable(), stackDigest: digestSchema.nullable() });
export const errorSchema = z.strictObject({ ...causeSchema.shape,
  publicCode: z.enum(producerCodes).nullable(), causes: z.array(causeSchema).max(3), loss: z.array(z.enum(errorLoss)).max(6),
  fingerprintScope: z.enum(['full', 'bounded', 'unavailable']) });
export const correlationSchema = z.strictObject({ logicalOrdinal: counter.optional(), hostAttemptIndex: counter.optional(),
  chargedOrdinal: counter.optional(), sdkAttemptDigest: digestSchema.optional(), submissionDigest: digestSchema.optional(),
  deliveryDigest: digestSchema.optional(), requestDigest: digestSchema.optional(), responseDigest: digestSchema.optional(),
  rootDigest: digestSchema.optional(), streamIncarnationDigest: digestSchema.optional(), sdkBatchSequence: counter.optional(),
  sdkProducerEpoch: counter.optional(), sdkProducerSequence: counter.optional(), sdkRecordIndex: counter.optional() });
export const recordTypes = ['assistant_message_started', 'assistant_tool_call', 'assistant_message_completed', 'tool_outcome',
  'tool_results_committed', 'agent_start_run', 'agent_finish_cycle', 'message_data_write', 'submission_settled',
  'tool_step_settled', 'signal', 'state_write'] as const;
const privateId = z.string().min(1).max(512);
export const runtimeSchema = z.strictObject({ version: z.literal(1), captureId: digestSchema, sequence: counter.min(1), timestamp: counter,
  boundary: z.enum(boundaries), outcome: z.enum(['started', 'accepted', 'applied', 'committed', 'completed', 'failed', 'recovered', 'unknown', 'released', 'suppressed']),
  code: z.enum(reasonCodes), origin: z.enum(['originating', 'catching', 'state-transition']), source: sourceSchema,
  error: errorSchema.optional(), sdk: z.strictObject({ rootUid: privateId.optional(), submissionId: privateId.optional(),
    attemptId: privateId.optional(), streamIncarnation: privateId.optional(), batchSequence: counter.optional(),
    producerEpoch: counter.optional(), producerSequence: counter.optional(), recordIndex: counter.optional(),
    recordType: z.enum(recordTypes).optional(), inputApplied: z.boolean().optional(),
    settlement: z.enum(['reserved', 'canonical', 'finalized', 'unknown']).optional() }).optional(),
  local: z.strictObject({ through: counter, dropped: counter, status: z.enum(['captured', 'loss', 'unavailable']) })
}).refine(record => record.boundary === record.source.boundary && record.local.through >= record.sequence);
export const eventSchema = z.strictObject({ kind: z.literal('event'), id: z.string().regex(/^e-[1-9][0-9]*$/), sequence: counter.min(1),
  generation: counter, timestamp: counter, owner: z.enum(['host', 'sdk', 'producer', 'platform', 'recorder']),
  boundary: z.enum(boundaries), outcome: z.enum(['started', 'accepted', 'applied', 'committed', 'completed', 'failed', 'recovered', 'unknown', 'released', 'suppressed']),
  code: z.enum(reasonCodes), evidence: z.enum(['observed', 'unavailable']), origin: z.enum(['originating', 'catching', 'state-transition']),
  correlation: correlationSchema, source: sourceSchema, error: errorSchema.optional(), capsuleId: z.string().regex(/^(f-[1-9][0-9]*|t-[0-9]+)$/).optional()
}).refine(record => record.id === `e-${record.sequence}` && record.boundary === record.source.boundary);
export type RuntimeEnvelope = z.infer<typeof runtimeSchema>;
export type DiagnosticEvent = z.infer<typeof eventSchema>;
export type DiagnosticBinding = z.infer<typeof bindingSchema>;
export type ErrorMetadata = z.infer<typeof errorSchema>;
export type Boundary = typeof boundaries[number];
export type ReasonCode = typeof reasonCodes[number];
export type Correlation = z.infer<typeof correlationSchema>;
export type DiagnosticSource = z.infer<typeof sourceSchema>;
export const hashDiagnostic = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const canonicalDiagnostic = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const diagnosticBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
export function encodeOpaque(value: string): string { return Buffer.from(value, 'utf8').toString('base64url'); }
export function decodeOpaque(value: string, limit: number): string {
  if (!value || value.length > limit || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error('Invalid encoding');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const headerSchema = z.strictObject({ version: z.literal(1), records: z.array(runtimeSchema).max(64),
  outbox: z.strictObject({ through: counter, dropped: counter, status: z.enum(['available', 'loss', 'unavailable']) }) });
export function readSdkDiagnosticHeader(response: Response): z.infer<typeof headerSchema> | null {
  try {
    const value = JSON.parse(decodeOpaque(response.headers.get('x-codeflare-sdk-diagnostics') ?? '', 16384));
    const parsed = headerSchema.parse(value);
    if (parsed.records.some(record => diagnosticBytes(record) > 8192)) return null;
    return parsed;
  } catch { return null; }
}

/** Snapshot only own data descriptors. Never call arbitrary toString, message/stack/cause getters. */
function captureDiagnosticErrorInternal(original: unknown): ErrorMetadata {
  const loss = new Set<typeof errorLoss[number]>();
  const seen = new Set<object>();
  const descriptor = (value: object, key: string): unknown => {
    try { const field = Object.getOwnPropertyDescriptor(value, key);
      if (field && !('value' in field)) loss.add('unsafe-error-access');
      return field && 'value' in field ? field.value : undefined;
    } catch { loss.add('unsafe-error-access'); return undefined; }
  };
  const fingerprint = (value: unknown, field: 'message' | 'stack'): string | null => {
    if (typeof value !== 'string') return null;
    // Slice before encoding: allocation/CPU is bounded even for enormous strings.
    const bytes = Buffer.from(value.slice(0, 8192), 'utf8');
    if (bytes.length > 8192 || value.length > 8192) loss.add(`${field}-truncated`);
    return hashDiagnostic(bytes.subarray(0, 8192));
  };
  const inspect = (value: unknown): z.infer<typeof causeSchema> => {
    let kind: ErrorMetadata['kind'] = 'other';
    try {
      kind = value instanceof TypeError ? 'TypeError' : value instanceof RangeError ? 'RangeError'
        : value instanceof SyntaxError ? 'SyntaxError' : value instanceof Error ? 'Error' : 'other';
    } catch { loss.add('unsafe-error-access'); }
    if (value !== null && typeof value === 'object') {
      const name = descriptor(value, 'name');
      if (kind === 'Error' && kinds.includes(name as typeof kinds[number])) kind = name as typeof kinds[number];
      return { kind, messageDigest: fingerprint(descriptor(value, 'message'), 'message'), stackDigest: fingerprint(descriptor(value, 'stack'), 'stack') };
    }
    if (typeof value === 'bigint' && (value > 18446744073709551615n || value < -18446744073709551615n)) {
      loss.add('uninspectable-throw'); return { kind, messageDigest: null, stackDigest: null };
    }
    if (['string', 'number', 'boolean', 'undefined', 'bigint'].includes(typeof value) || value === null) {
      return { kind, messageDigest: fingerprint(String(value), 'message'), stackDigest: null };
    }
    loss.add('uninspectable-throw'); return { kind, messageDigest: null, stackDigest: null };
  };
  const root = inspect(original);
  const causes: ErrorMetadata['causes'] = [];
  let value = original;
  if (value !== null && typeof value === 'object') seen.add(value);
  for (let index = 0; value !== null && typeof value === 'object'; index++) {
    const cause = descriptor(value, 'cause');
    if (cause === undefined) break;
    if (cause !== null && typeof cause === 'object' && seen.has(cause)) { loss.add('cause-cycle'); break; }
    if (index === 3) { loss.add('cause-depth'); break; }
    causes.push(inspect(cause)); value = cause;
    if (value !== null && typeof value === 'object') seen.add(value);
  }
  return { ...root, publicCode: null, causes, loss: [...loss], fingerprintScope:
    root.messageDigest === null && root.stackDigest === null ? 'unavailable' : loss.size ? 'bounded' : 'full' };
}

/** Source callbacks cannot throw a replacement error, including sanitizer/hash/access failures. */
export function captureError(original: unknown): ErrorMetadata {
  try { return captureDiagnosticErrorInternal(original); }
  catch { return { kind: 'other', publicCode: null, messageDigest: null, stackDigest: null, causes: [],
    loss: ['unsafe-error-access', 'uninspectable-throw'], fingerprintScope: 'unavailable' }; }
}

const mappedSource = z.strictObject({ repository: sourceFrameSchema.shape.repository, commit: sourceFrameSchema.shape.commit,
  path: sourceFrameSchema.shape.path, sha256: digestSchema });
const provenanceSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('codeflare-sdk-diagnostics'),
  capabilities: z.array(z.enum(['origin-error-v1', 'strict-sse-v1', 'sdk-attempt-v1', 'canonical-commit-v1',
    'settlement-finalization-v1', 'cleanup-error-v1', 'local-outbox-v1'])).max(7),
  basePackages: z.array(z.strictObject({ name: z.enum(['@flue/runtime', 'agents']), version: z.string().max(128),
    integrity: z.string().max(256), tarballSha256: digestSchema })).max(2),
  targets: z.array(z.strictObject({ package: z.enum(['@flue/runtime', 'agents']), version: z.string().max(128),
    path: z.string().max(512), originalSha256: digestSchema, transformedSha256: digestSchema })).max(64),
  sources: z.array(mappedSource).max(128), patches: z.array(z.strictObject({ path: z.string().max(512), sha256: digestSchema })).max(32),
  applicatorSha256: digestSchema, patchSetDigest: digestSchema });
export type SdkProvenance = z.infer<typeof provenanceSchema>;
export function readSdkProvenance(bundle: DispatcherBundle): SdkProvenance | null {
  try {
    const module = bundle.modules['codeflare/sdk-diagnostics-provenance.json'];
    if (!module || !('text' in module) || Buffer.byteLength(module.text) > 65536) return null;
    const parsed = provenanceSchema.parse(JSON.parse(module.text));
    const { patchSetDigest, ...manifest } = parsed;
    if (hashDiagnostic(canonicalDiagnostic(manifest)) !== patchSetDigest
      || !parsed.basePackages.some(pkg => pkg.name === '@flue/runtime' && pkg.version === bundle.versions.runtime)
      || !parsed.basePackages.some(pkg => pkg.name === 'agents' && pkg.version === bundle.versions.agents)) return null;
    return parsed;
  } catch { return null; }
}
export function sourceMatches(source: DiagnosticSource, provenance: SdkProvenance): boolean {
  if (source.patchSetDigest !== provenance.patchSetDigest) return false;
  if (source.package === '@flue/runtime' || source.package === 'agents') {
    if (!provenance.basePackages.some(pkg => pkg.name === source.package && pkg.version === source.baseVersion)) return false;
  } else if (source.baseVersion !== null || source.package === 'cloudflare') return false;
  return source.frames.every(frame => provenance.sources.some(mapping => mapping.repository === frame.repository
    && mapping.commit === frame.commit && mapping.path === frame.path));
}
export const hostSource = (boundary: Boundary): DiagnosticSource => ({ package: 'codeflare', boundary,
  baseVersion: null, patchSetDigest: null, status: 'unavailable', frames: [] });
