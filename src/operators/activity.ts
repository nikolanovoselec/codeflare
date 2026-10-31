/**
 * Durable execution owner
 * Admission intent and receipt reconciliation come first; drive/checkpoint transitions follow.
 * Only the authenticated parent calls this object. Registry ordering and local token consumption
 * are separate transactions. Generation fences reject stale work but do not prove compute cleanup.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { readBoundedResponse } from '../lib/bounded-stream';
import { readDispatcherSdkConfiguration, dispatcherSdkCredentials, forwardDispatcherSdkHttp } from './dispatcher-sdk-services';
import { dispatcherSdkOwnerContext } from './dispatcher-owner-inference';
import { openOperatorSecret } from './protected-secrets';
import { discoverDispatcherOwnerProfile, forwardDispatcherOwnerInference, type ConfiguredDispatcherInference } from './dispatcher-owner-inference';
import { captureError, hashDiagnostic, hostSource, readSdkProvenance, readSdkDiagnosticHeader, runtimeSchema, sourceMatches, sdkAdmissionTypes,
  type SdkProvenance, type Boundary, type ReasonCode, type Correlation, type RuntimeEnvelope, type DiagnosticBinding, type ErrorMetadata, type DiagnosticPreparation } from './dispatcher-diagnostics-wire';
import { appendDiagnostic, initializeDiagnostics, diagnosticLoss, observeOutbox,
  type FailureObservation, type FenceReason, type EventObservation, type DiagnosticCapsule } from './dispatcher-diagnostics-store';
import { readActivityDiagnostics, DiagnosticReadError, type DiagnosticReadOptions, type DiagnosticReadState,
  type OperationRecord } from './dispatcher-diagnostics-read';
import { Agent, type RetryOptions, type Schedule, type ScheduleCriteria } from 'agents';
import { DISPATCHER_SCHEDULE_CALLBACK, childScheduleRow, dispatcherScheduleEnvelope,
  dispatcherSchedulePath, migrateDispatcherSchedules, parseDispatcherSchedule, projectChildSchedule } from './dispatcher-scheduler';
import type { Env as AppEnv } from '../types';
import { parseDispatcherBundle, type DispatcherBundle } from './distribution';
import { loadOperatorDispatcherClass } from './loader';
import { DEFAULT_SOURCE_RESPONSE_BYTES, sourceResponseBytes } from './dispatcher-source-limits';
import { producerDiagnosticSchema, sdkPublicReasonCode, type ProducerDiagnostic } from './dispatcher-diagnostic-wire';
import { DispatcherRefusal, dispatcherRefusal, dispatcherRefusalBody, type DispatcherRefusalReason } from './dispatcher-refusal';
import { submissionAttemptLimit } from './dispatcher-submission-limits';
import { inferenceRequestBytes, inferenceAttemptLimit } from './dispatcher-inference-limits';
import { dispatcherCapacities, type DispatcherCapacityPolicy } from './dispatcher-capacity-limits';
import { classifyDispatcherInference, inferenceAttemptKey, inferenceRetryDelay,
  type DispatcherInferenceAttempt, type DispatcherInferenceChain, type DispatcherInferenceResponse } from './dispatcher-inference-recovery';
import { DEFAULT_DISPATCHER_OPERATION_LIMIT, dispatcherOperationLimit } from './dispatcher-operation-limits';
import { authorizeDispatcherPlan, createDispatcherOperation, parseDispatcherOperation,
  readDispatcherBody, dispatcherGithubApiOrigin, dispatcherWireRules, prepareDispatcherNative, type DispatcherAdmittedTarget,
  type DispatcherInferenceCountObservation, type DispatcherBodyOverflowObservation } from './operator-runtime-capability';
import { z } from 'zod';
import { readDispatcherUpdates, type DispatcherResultProjection } from './dispatcher-result';
import { readDispatcherSdkDiagnostics, sdkUnavailable, operationsUnavailable, type DispatcherActivityDiagnostics,
  type DispatcherOperationDiagnostics, type DispatcherSqlFacet } from './dispatcher-runtime-diagnostics';
import { createDispatcherPhaseState, dispatcherPhaseWire, bindDispatcherPhaseReceipt, dispatcherPhaseContext,
  advanceDispatcherPhase, collectDispatcherFinal, sameDispatcherPhaseValue, DISPATCHER_JOURNEY_RESULT_BYTES,
  bindNormalDispatcherPhaseReceipt, type DispatcherPhaseState, type DispatcherPhaseAuthority, type DispatcherPhaseReply } from './dispatcher-phases';
import type { OperatorAdmissionRequest, OperatorAdmissionReceipt, ManagementAdmissionReceipt } from './registry';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { AppError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import { inferenceDiagnostic, inferenceResponseObservation, type InferenceDiagnosticContext } from '../lib/inference-diagnostics';
import { emitRaw } from '../../host/src/operator-raw-logging';
import { canInvokeOperator, operatorAccessSessionCurrent, requireOperatorHumanContext, resolveOperatorGroupIdentity, resolveBucketName } from '../lib/access';
import { D1SessionRepository } from '../lib/session-repository';
import { parsePublishableAssessment, renovateGithub } from './renovate-publication';
import { openOperatorExecutionAccess, projectOperatorExecution, reauthenticateOperatorExecution,
  type OperatorExecutionContext, type OperatorExecutionProjection } from './execution-context';
import { operatorOwnerKey, type OperatorBrowserSummary } from './browser-activity';
import { parseOperatorContainerProfile } from '../container/operator-context';
import type { OwnedOperatorSessionState } from './owned-session';
import { parseOperatorPackageResourceProjection, type OperatorPackageResourceProjection } from './package-resources';
import { parseOperatorAttachmentProjection, projectOperatorAttachments } from './attachments';
import { prospectiveRenovateRetryProof, type ProspectiveRenovateRetryProof } from './renovate-retry-proof';
import { parseNativeOperatorInference, type NativeOperatorInference } from './inference-selection';
import type { NativePiBinding } from './native-pi-profile';
import { safePiAuthFailure, PiAuthRequiredError, type SafePiAuthFailure } from './pi-auth-failure';
import { inspectNativeRequest, commitNativeResponse, nativeResponse, nativeDigest,
  type DispatcherNativeResponse, type DispatcherNativeOperation } from './dispatcher-native';

/** Parent-authorized admission intent; raw capabilities/credentials are not stored. */
export type OperatorActivityPreparation = (OperatorAdmissionRequest | {
  operatorId: string; installationId: string; activityId: string; intentDigest: string;
  expectedRevision: number; expectedInstallationRevision: number; expectedControlsRevision: number; deadline: number;
}) & { startVerifier: string; startExpiresAt: number };

export type ActivityAdmissionResult = { ok: true; phase: 'prepared' | 'queued' } | {
  ok: false;
  reason: 'already-prepared' | 'not-prepared' | 'invalid-capability' | 'capability-expired'
    | 'authority-expired' | 'already-started' | 'admission-denied' | 'admission-uncertain';
};

export interface ActivityAdmissionProjection {
  activityId: string;
  phase: 'prepared' | 'admitting' | 'queued' | 'cancelled';
  receipt: OperatorAdmissionReceipt | ManagementAdmissionReceipt | null;
}

interface OperatorDriveState {
  generation: number;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancel-requested' | 'unknown';
  checkpoint: unknown;
  result: unknown;
}

export type OperatorDriveResult = { ok: true; state: OperatorDriveState } | {
  ok: false;
  reason: 'not-admitted' | 'authority-expired' | 'drive-active' | 'drive-settled' | 'stale-drive' | 'invalid-update';
};

type DispatcherFacetPath = readonly Readonly<{ className: string; name: string }>[];
type DispatcherFacet = Fetcher & {
  _cf_initAsFacet(name: string, parentPath: Array<{ className: string; name: string }>, identityName: string): Promise<void>;
  _cf_dispatchScheduledCallback(ownerPath: DispatcherFacetPath, row: unknown): Promise<boolean>;
  _cf_checkRunFibersForFacet(ownerPath: DispatcherFacetPath): Promise<number>;
};
type DispatcherConnection = Pick<DispatcherFacet, 'fetch' | '_cf_dispatchScheduledCallback' | '_cf_checkRunFibersForFacet'>;
/** Only the pinned SDK's exact status/type pairs prove refusal of unchanged admission. */
class DispatcherPhaseAdmissionError extends Error {
  constructor(readonly transportStatus: number, readonly admissionType?: typeof sdkAdmissionTypes[number]) {
    super(`Dispatcher phase admission unavailable (HTTP ${transportStatus}${admissionType ? `, ${admissionType}` : ''})`);
  }
  get definitive(): boolean {
    switch (this.transportStatus) {
      case 400: return this.admissionType === 'invalid_request' || this.admissionType === 'invalid_json';
      case 415: return this.admissionType === 'unsupported_media_type';
      case 404: return this.admissionType === 'agent_instance_not_found';
      case 409: return this.admissionType === 'agent_instance_exists' || this.admissionType === 'submission_conflict';
      case 500: return this.admissionType === 'conversation_record_invariant' || this.admissionType === 'attachment_integrity'
        || this.admissionType === 'persisted_format_version_unsupported';
      default: return false;
    }
  }
}
const dispatcherAdmissionErrorSchema = z.object({ error: z.object({ type: z.enum(sdkAdmissionTypes) }) });

/** Registry-only deployment connection. Never populated from a job or callback body. */
const normalDispatcherConnectionSchema = z.object({
  installationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), releaseId: z.string().min(1).max(128),
  connectionRevision: z.number().int().positive().safe(), workerName: z.string().min(1).max(128),
  workerVersionId: z.string().min(1).max(128), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  compilerCommit: z.string().regex(/^[a-f0-9]{40}$/), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bundleDigest: z.string().regex(/^[a-f0-9]{64}$/), connectionSecretCiphertext: z.string().startsWith('v1:'),
  controlOrigin: z.string().refine(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password
      && !url.port && url.origin === value && url.hostname.includes('.'); } catch { return false; }
  }),
});
type NormalDispatcherConnection = z.infer<typeof normalDispatcherConnectionSchema>;
type NormalDispatcherDeployment = Omit<NormalDispatcherConnection, 'connectionSecretCiphertext'>;
const normalDispatcherReceiptSchema = z.strictObject({ submissionId: z.string().min(1).max(128),
  uid: z.string().min(1).max(512), acceptedAt: z.string().max(128).refine(value => Number.isFinite(Date.parse(value))),
  deduplicated: z.literal(true).optional() });
type NormalDispatcherReceipt = z.infer<typeof normalDispatcherReceiptSchema>;
interface NormalDispatcherWire {
  id: string; installationId: string; activityId: string; generation: number;
  releaseId: string; connectionRevision: number; workerVersionId: string;
  idempotencyKey: string; message: unknown; initialData?: unknown; uid?: string;
}
class NormalDispatcherObservationUnavailable extends Error {}

type InstalledDispatcherEnv = Pick<AppEnv, 'OPERATOR_REGISTRY' | 'ENCRYPTION_KEY'>;

export async function installedDispatcherConnection(env: InstalledDispatcherEnv, installationId: string): Promise<NormalDispatcherConnection> {
  if (!env.OPERATOR_REGISTRY) throw new Error('Dispatcher installation unavailable');
  // Narrow internal RPC seam until Registry's generated stub type includes its getter.
  const registry: { getManagementDispatcherConnection(id: string): Promise<unknown> } =
    env.OPERATOR_REGISTRY.getByName('registry');
  const connection = normalDispatcherConnectionSchema.parse(await registry.getManagementDispatcherConnection(installationId));
  if (connection.installationId !== installationId) throw new Error('Dispatcher installation mismatch');
  return connection;
}

/** Authenticate before input-dependent Activity lookup; identifiers alone never grant authority. */
async function authenticateInstalledDispatcher(env: InstalledDispatcherEnv, request: Request) {
  const url = new URL(request.url);
  if (url.origin !== 'https://operator.internal' || url.search || url.hash || request.method !== 'POST'
    || !url.pathname.startsWith('/v1/dispatcher/')) throw new Error('Dispatcher callback denied');
  const installationId = request.headers.get('x-codeflare-operator-installation') ?? '';
  const activityId = request.headers.get('x-codeflare-operator-activity') ?? '';
  const generationText = request.headers.get('x-codeflare-operator-generation') ?? '';
  if (![installationId, activityId].every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value))
    || !/^[1-9][0-9]{0,15}$/.test(generationText) || !Number.isSafeInteger(Number(generationText))) {
    throw new Error('Dispatcher callback denied');
  }
  const revisionText = request.headers.get('x-codeflare-operator-connection-revision') ?? '';
  if (!/^[1-9][0-9]{0,15}$/.test(revisionText) || !Number.isSafeInteger(Number(revisionText))) throw new Error('Dispatcher callback denied');
  const connection = ['/v1/dispatcher/abort-authority', '/v1/dispatcher/logging-policy'].includes(url.pathname)
    ? normalDispatcherConnectionSchema.parse(await env.OPERATOR_REGISTRY!.getByName('registry')
      .getManagementDispatcherAbortConnection(installationId, Number(revisionText)))
    : await installedDispatcherConnection(env, installationId);
  if (connection.installationId !== installationId) throw new Error('Dispatcher callback denied');
  if (request.headers.get('x-codeflare-operator-worker-version') !== connection.workerVersionId
    || request.headers.get('x-codeflare-operator-release') !== connection.releaseId
    || request.headers.get('x-codeflare-operator-connection-revision') !== String(connection.connectionRevision)) {
    throw new Error('Dispatcher callback denied');
  }
  const supplied = request.headers.get('authorization') ?? '';
  if (supplied.length > 8192) throw new Error('Dispatcher callback denied');
  const secret = await openOperatorSecret(connection.connectionSecretCiphertext, env,
    { purpose: 'connection', recordId: installationId });
  const encode = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode.encode(supplied)),
    crypto.subtle.digest('SHA-256', encode.encode(`Bearer ${secret}`)),
  ]);
  if (!crypto.subtle.timingSafeEqual(actual, expected)) throw new Error('Dispatcher callback denied');
  return { activityId, generation: Number(generationText), connection };
}

interface DispatcherLease {
  generation: number; artifactDigest: string; inputDigest: string; expiresAt: number;
  /** Future normal admissions only. Original wire precedes I/O; receipt is actual SDK acknowledgement. */
  hosting?: 'normal'; deployment?: NormalDispatcherDeployment; wire?: NormalDispatcherWire;
  /** Original installation envelope, parent-only; rotation cannot redirect or prevent original abort. */
  connectionSecretCiphertext?: string;
  receipt?: NormalDispatcherReceipt; abortIntentRecorded?: boolean;
  submissionId: string | null; settledSubmissionId?: string; sdkReleased?: boolean;
  rootDigest?: string;
  sdkProvenance?: SdkProvenance;
  projection?: DispatcherResultProjection;
  /** Future intent4 admission only; never inferred from a historical lease. */
  serial?: DispatcherPhaseState;
  terminalAt?: number;
  inferenceRecovery?: { version: 1; attemptLimit: number };
  inferenceSelection?: NativeOperatorInference;
  configuredSelection?: ConfiguredDispatcherInference;
  inferenceSource?: 'managed' | 'pi-native';
  status: 'admitting' | 'running' | 'settled' | 'unknown';
}
interface DispatcherOperationRecord {
  generation: number; requestDigest: string; phase: 'reserved' | 'completed' | 'unknown';
  request?: { method: 'GET' | 'POST' | 'PUT'; url: string };
  phaseBinding?: { submissionId: string; deliveryToken: string;
    phase: DispatcherPhaseState['current']['phase']; resource: string };
  responseDigest?: string;
  ordinal?: number;
  resolution?: { readbacks: Array<{ operationId: string; requestDigest: string; responseDigest: string }> };
  response?: { status: number; contentType: string; body: string };
  inference?: DispatcherInferenceChain;
  native?: DispatcherNativeOperation;
  sdkHttp?: { permitId: string; expiresAt: number; selection: ConfiguredDispatcherInference;
    ownerScope: { bucket: string; email: string };
    phase: 'ready' | 'sending' | 'completed' | 'unknown'; requestDigest?: string; responseKey?: string; attempts: number };
}
const DISPATCHER_PROFILE_LEASE = 'dispatcher:profile-lease';
const DISPATCHER_LEASE = 'dispatcher:lease';
const DISPATCHER_OPERATIONS = 'dispatcher:operations';
const DISPATCHER_JOURNAL = 'dispatcher:journal';
interface DispatcherJournal { generation: number; count: number; nextOrdinal: number; unresolved: number }
interface RetiredEffectItem {
  ordinal: number; operationDigest: string; requestDigest?: string; responseDigest?: string;
  journalPhase: 'reserved' | 'completed' | 'unknown'; binding: 'verified' | 'unresolved';
  method: 'POST' | 'PUT'; effect: 'comment' | 'merge'; phaseIndex?: number;
  submissionDigest?: string; deliveryDigest?: string;
  target?: { repository: string; pullRequest: number; headSha: string };
  observedResponse?: { kind: 'comment'; status: 201; commentId: number; responseBodyDigest: string }
    | { kind: 'merge'; status: 200; merged: true; mergeSha: string };
}
export interface RetiredEffectReceipts {
  version: 1; activityId: string; generation?: number; inputDigest?: string; artifactDigest?: string; admissionDigest?: string;
  scan: 'complete' | 'partial' | 'unavailable'; pageStatus: 'complete' | 'more' | 'partial' | 'unavailable';
  journalCount: number | null; inspectedEntries: number; unresolvedJournalEntries: number | null;
  unclassifiedEntries: number; nextAfterOrdinal: number | null; items: RetiredEffectItem[];
}
type DispatcherJournalTx = Pick<DurableObjectTransaction, 'get' | 'put' | 'delete'>;
const dispatcherEntryKey = (journal: DispatcherJournal, operationId: string) =>
  `dispatcher:operation:${journal.generation}:${operationId}`;

/** Migrate the bounded legacy aggregate atomically; never discard uncertain entries. */
async function loadDispatcherJournal(tx: DispatcherJournalTx, generation: number): Promise<DispatcherJournal> {
  const current = await tx.get<DispatcherJournal>(DISPATCHER_JOURNAL);
  if (current && current.generation !== generation) throw new Error('Stale Dispatcher journal');
  const legacy = await tx.get<Record<string, DispatcherOperationRecord>>(DISPATCHER_OPERATIONS);
  if (legacy !== undefined) {
    const entries = Object.entries(legacy);
    if (entries.length && current?.count) throw new Error('Conflicting Dispatcher journals');
    const journal = entries.length || !current
      ? { generation, count: entries.length, nextOrdinal: entries.reduce((next, [, entry]) =>
        Math.max(next, entry.ordinal === undefined ? 0 : entry.ordinal + 1), entries.length),
      unresolved: entries.filter(([, entry]) => entry.phase !== 'completed').length }
      : current;
    for (const [id, entry] of entries) await tx.put(dispatcherEntryKey(journal, id), entry);
    await tx.put(DISPATCHER_JOURNAL, journal);
    await tx.delete(DISPATCHER_OPERATIONS);
    return journal;
  }
  if (current) return current;
  const journal = { generation, count: 0, nextOrdinal: 0, unresolved: 0 };
  await tx.put(DISPATCHER_JOURNAL, journal);
  return journal;
}

/** Entry, capacity and unresolved-state changes belong to the caller's fenced transaction. */
async function putDispatcherEntry(tx: DispatcherJournalTx, journal: DispatcherJournal, id: string,
  prior: DispatcherOperationRecord | undefined, next: DispatcherOperationRecord, additionalReservations = 0): Promise<void> {
  await tx.put(dispatcherEntryKey(journal, id), next);
  await tx.put(DISPATCHER_JOURNAL, { ...journal,
    count: journal.count + (prior ? 0 : 1) + additionalReservations,
    nextOrdinal: prior ? journal.nextOrdinal + additionalReservations : Math.max(journal.nextOrdinal, (next.ordinal ?? journal.nextOrdinal) + 1),
    unresolved: journal.unresolved + (next.phase === 'completed' ? 0 : 1) - (prior && prior.phase !== 'completed' ? 1 : 0),
  });
}
const admittedDispatcherResultSchema = (limits = dispatcherCapacities()) => z.strictObject({ repository: z.string(),
  results: z.tuple([z.strictObject({ pullRequest: z.number().safe().int().positive(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/), decision: z.enum(['MERGE', 'DO_NOT_MERGE']),
    comment: z.string().min(1).max(limits.targetCommentChars), outcome: z.enum(['MERGED', 'NOT_MERGED', 'EXECUTION_FAILED']) })]) });

/** Intent-3 output contract: one exact admitted result, never a replacement or aggregate target set. */
function admittedDispatcherResultMatches(value: unknown, target: DispatcherAdmittedTarget, policy?: DispatcherCapacityPolicy): boolean {
  const limits = dispatcherCapacities(policy);
  const result = admittedDispatcherResultSchema(limits).safeParse(value);
  if (!result.success || new TextEncoder().encode(JSON.stringify(value)).byteLength > limits.assessmentBytes) return false;
  const item = result.data.results[0];
  return result.data.repository === target.repository && item.pullRequest === target.pullRequest
    && item.headSha === target.headSha && (item.outcome !== 'MERGED' || item.decision === 'MERGE');
}
const RENOVATE_PUBLICATION = 'renovate:publication';
type RenovateEffect = 'comment' | 'approval' | 'merge';
interface RenovatePublication {
  ownerKey: string; bucket: string; sessionId: string; sessionGeneration: number;
  activityGeneration: number; assessmentDigest: string; operationId: string;
  effects: Partial<Record<RenovateEffect, { phase: 'reserved' | 'unknown' | 'completed'; receiptId?: number;
    mergeSha?: string; remoteMerged?: boolean }>>;
}
const dispatcherLog = createLogger('dispatcher-settlement');
const dispatcherTailLog = createLogger('dispatcher-inference-tail');
const dispatcherReportLog = createLogger('dispatcher-inference-report');
type DispatcherDiagnostic = { stage: 'fetch-rejected' } | { stage: 'http-rejected'; status: number } | ProducerDiagnostic;

async function readDispatcherDiagnostic(request: Request): Promise<DispatcherDiagnostic | null> {
  if (request.method !== 'POST' || request.headers.get('content-type') !== 'application/json' || !request.body) return null;
  const sizeHeader = request.headers.get('content-length');
  if (sizeHeader && (!/^\d{1,4}$/.test(sizeHeader) || Number(sizeHeader) > 2048)) return null;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<Uint8Array> => {
      const parts: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2048) throw new Error('Diagnostic body limit');
        parts.push(chunk.value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
      return body;
    };
    const bytes = await Promise.race([read(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Diagnostic read deadline')), 250);
    })]);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    if (data.stage === 'producer') {
      const parsed = producerDiagnosticSchema.safeParse(data);
      return parsed.success ? parsed.data : null;
    }
    if (bytes.length > 256) return null;
    if (Object.keys(data).length === 1 && data.stage === 'fetch-rejected') return { stage: 'fetch-rejected' };
    if (Object.keys(data).length === 2 && data.stage === 'http-rejected' && typeof data.status === 'number'
      && Number.isInteger(data.status) && data.status >= 300 && data.status <= 599) {
      return { stage: 'http-rejected', status: data.status };
    }
    return null;
  } catch { return null; }
  finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* an expired read can still be pending */ }
  }
}

const DISPATCHER_SDK_METHODS = [
  '_cf_scheduleForFacet', '_cf_scheduleEveryForFacet', '_cf_getScheduleForFacet',
  '_cf_listSchedulesForFacet', '_cf_cancelScheduleForFacet', '_cf_acquireFacetKeepAlive',
  '_cf_releaseFacetKeepAlive', '_cf_registerFacetRun', '_cf_unregisterFacetRun',
  '_cf_broadcastToSubAgent', '_cf_subAgentConnectionMetas',
] as const;
type DispatcherSdkMethod = typeof DISPATCHER_SDK_METHODS[number];

interface ApprovedPacketRecord {
  preparationId: string; lane: string;
  attachment: { name: string; mediaType: string; size: number; sha256: string; locator: string };
  claim: { contextDigest: string; runId: number; runAttempt: number; head: string; base: string;
    mergeBase: string; workflowSha: string; sessionGeneration: number };
}

function sameApprovedPacketAttachment(a: ApprovedPacketRecord['attachment'], b: ApprovedPacketRecord['attachment']): boolean {
  return a.name === b.name && a.mediaType === b.mediaType && a.locator === b.locator
    && a.size === b.size && a.sha256 === b.sha256;
}

interface OperatorSyncState {
  operationId: string;
  sessionId: string;
  requestDigest: string;
  policyDigest: string;
  prefix: string;
  keys: string[];
  deadline: number;
  phase: 'prepared' | 'uploaded' | 'verified';
  manifestDigest: string | null;
  evidence: { filesVerified: number; bytesVerified: number } | null;
}

export type OperatorSyncResult = { ok: true; phase: OperatorSyncState['phase'] } | { ok: false; reason:
  'not-admitted' | 'invalid-scope' | 'conflict' | 'operation-limit' | 'authority-expired'
    | 'not-prepared' | 'sealed' | 'evidence-mismatch' };
export type WebhookStartResult = { ok: true; phase: 'queued'; readCapability: string } | AdmissionFailure;
export type WebhookReadResult = { ok: true; terminal: boolean; status: string; generation: number; result?: unknown } | {
  ok: false; reason: 'invalid-capability' | 'capability-expired' | 'not-ready' | 'consumed' | 'not-prepared' };
export type WebhookContinueResult = { ok: true; phase: 'queued' }
  | Extract<WebhookReadResult, { ok: false }>
  | { ok: false; reason: 'stale-publication' | 'stale-generation' | 'already-started' };

interface DispatcherOwnerSource {
  bucket: string; sessionId: string; sessionGeneration: number;
}

export interface OperatorRuntimePlan {
  activityId: string;
  /** Parent-validated manual source only; prospective sources come from the original Registry proof. */
  ownerSource?: DispatcherOwnerSource;
  deadline: number;
  invocationJson: string;
  receipt: OperatorAdmissionReceipt | ManagementAdmissionReceipt;
  executionContext: OperatorExecutionContext;
  prospectiveAdmissionId?: string;
  inferenceSelection?: NativeOperatorInference;
  configuredSelection?: ConfiguredDispatcherInference;
  authFailure?: SafePiAuthFailure;
}

export interface OperatorReviewState {
  generation: number;
  repositoryId: number;
  pullRequest: number;
  head: string;
  releaseDigest: string;
  packageDigest: string;
  resourceDigest: string;
  packetDigest: string;
  requiredLanes: string[];
  lanes: Record<string, { resultDigest: string }>;
  sealedSyncOperationId: string | null;
  publication: null | {
    operationId: string;
    requestDigest: string;
    phase: 'reserved' | 'completed' | 'unknown';
    receipt?: { checkId: number; recordId: number };
  };
}

export type OperatorReviewResult = { ok: true; state: OperatorReviewState } | { ok: false; reason:
  'not-admitted' | 'invalid' | 'conflict' | 'stale-generation' | 'incomplete' | 'not-verified' | 'unknown' };

export interface BoundaryActivityBinding {
  repositoryId: number; pullRequest: number; contextDigest: string;
  session: { bucket: string; sessionId: string; generation: number };
}

const boundaryBindingSchema = z.strictObject({
  repositoryId: z.number().int().positive().safe(), pullRequest: z.number().int().positive().safe(),
  contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
  session: z.strictObject({ bucket: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), generation: z.number().int().positive().safe() }),
});

interface AdmissionState {
  intent: OperatorActivityPreparation;
  boundary?: BoundaryActivityBinding;
  phase: ActivityAdmissionProjection['phase'];
  receipt: OperatorAdmissionReceipt | ManagementAdmissionReceipt | null;
  executionContext?: OperatorExecutionContext;
  ownerSource?: DispatcherOwnerSource;
  invocationJson?: string;
  inferenceRecoveryVersion?: 1;
  inferenceSelection?: NativeOperatorInference;
  configuredSelection?: ConfiguredDispatcherInference;
  authFailure?: SafePiAuthFailure;
  diagnosticsVersion?: 1;
  diagnosticBinding?: DiagnosticBinding;
  diagnosticFence?: FenceReason;
  diagnosticRecorderUnavailable?: boolean;
  drive?: OperatorDriveState;
  syncOperations?: Record<string, OperatorSyncState>;
  approvedPackets?: Record<string, ApprovedPacketRecord>;
  review?: OperatorReviewState;
  webhook?: { readVerifier: string; expiresAt: number; consumed: boolean; continuedGeneration?: number };
  ownerKey?: string;
  browserCollectionConsumed?: boolean;
  updatedAt?: number;
}

const syncIdentity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const syncDigest = z.string().regex(/^[0-9a-f]{64}$/);
const approvedPacketSchema = z.strictObject({
  preparationId: syncIdentity, driveGeneration: z.number().int().positive().safe(),
  lane: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/),
  locator: syncIdentity, size: z.number().int().positive().max(8 * 1024 * 1024), sha256: syncDigest,
  bytes: z.instanceof(Uint8Array),
});
const syncPreparationSchema = z.strictObject({
  operationId: syncIdentity, sessionId: syncIdentity, requestDigest: syncDigest, policyDigest: syncDigest,
  prefix: z.string().min(2).max(2048),
  keys: z.array(z.string().min(1).max(4096)).min(1).max(128),
  deadline: z.number().finite().positive(),
});

function canonicalSyncPrefix(value: string, operationId: string): boolean {
  return value.endsWith(`/${operationId}/`) && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.slice(0, -1).split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function canonicalSyncKey(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

const reviewLaneIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const reviewPreparationStateSchema = z.strictObject({
  generation: z.number().int().positive().safe(), repositoryId: z.number().int().positive().safe(),
  pullRequest: z.number().int().positive().safe(), head: z.string().regex(/^[0-9a-f]{40}$/),
  releaseDigest: syncDigest, packageDigest: syncDigest, resourceDigest: syncDigest, packetDigest: syncDigest,
  requiredLanes: z.array(reviewLaneIdentity).min(1).max(64),
});

const driveUpdateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(['waiting', 'completed', 'failed']),
  checkpoint: z.json(),
  result: z.json().optional(),
});

type AdmissionFailure = Extract<ActivityAdmissionResult, { ok: false }>;

function isManagementReceipt(receipt: OperatorAdmissionReceipt | ManagementAdmissionReceipt): receipt is ManagementAdmissionReceipt {
  return 'selection' in receipt;
}

function executionLoggingEnabled(receipt: OperatorAdmissionReceipt | ManagementAdmissionReceipt | null | undefined): boolean {
  return !receipt || !isManagementReceipt(receipt) || receipt.selection.operator.policy.loggingEnabled !== false;
}

async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function capabilityVerifier(capability: string): Promise<string> {
  return sha256(capability);
}

/** Bind the exact persisted invocation semantics to its server-generated activity identity. */
export async function createOperatorIntentDigest(operatorId: string, activityId: string,
  invocationJson: string): Promise<string> {
  const invocation = JSON.parse(invocationJson) as unknown;
  if (!z.json().safeParse(invocation).success) throw new Error('Invalid invocation');
  return sha256(JSON.stringify({ schemaVersion: 1, operatorId, activityId, invocation }));
}
function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function checkStart(state: AdmissionState, verifier: string): AdmissionFailure | null {
  if (state.phase === 'cancelled') return { ok: false, reason: 'admission-denied' };
  if (state.phase === 'queued') return { ok: false, reason: 'already-started' };
  if (state.intent.startVerifier !== verifier) return { ok: false, reason: 'invalid-capability' };
  const now = Date.now();
  if (!Number.isFinite(state.intent.deadline) || state.intent.deadline <= now) {
    return { ok: false, reason: 'authority-expired' };
  }
  if (!Number.isFinite(state.intent.startExpiresAt) || state.intent.startExpiresAt <= now) {
    return { ok: false, reason: 'capability-expired' };
  }
  return null;
}

/**
 * REQ-OPERATOR-016/017: Activity-owned admission and drive state. The authorized parent prepares
 * validated intent and a SHA-256 start verifier, with deadlines bounded by the
 * actual human authority. Neither raw capabilities nor human credentials enter
 * this ordering record. This binding must never be exposed to child Workers.
 * Registry RPC is outside local transactions. An uncertain response preserves
 * pending intent for same-ID reconciliation; it never creates a new execution.
 * Queued state is the durable execution intent, not proof that work has run.
 */
export class OperatorActivity extends Agent {
  #appEnv: AppEnv & { OPERATOR_REGISTRY: NonNullable<AppEnv['OPERATOR_REGISTRY']> };
  #dispatcher?: { generation: number; facet: Promise<DispatcherConnection> };
  #diagnosticReportGeneration?: number;
  #diagnosticReports = 0;
  #producerReports = 0;
  #producerFailureReports = 0;
  #reconciling?: Promise<void>;
  #dispatcherTerminalWake = false;
  #nativeBindings = new Map<number, NativePiBinding>();
  #sdkHttpControllers = new Set<AbortController>();
  #nativeFlights = new Map<string, { digest: string; controller: AbortController; result: Promise<DispatcherNativeResponse> }>();
  #inferenceOwner?: { generation: number; epoch: Promise<number> };
  #inferenceFlights = new Map<string, { digest: string; controller: AbortController; result: Promise<DispatcherInferenceResponse> }>();
  #phaseAdmissions = new Map<string, Promise<void>>();
  #coldDispatcherLease?: DispatcherLease;
  #diagnosticQueue: Promise<void> = Promise.resolve();
  #dispatcherScheduleQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: AppEnv) {
    migrateDispatcherSchedules(ctx.storage, () => {
      const record = ctx.storage.kv.get<AdmissionState>('admission');
      const lease = ctx.storage.kv.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!record?.receipt || !lease || record.drive?.generation !== lease.generation
        || lease.inputDigest !== record.receipt.intentDigest
        || lease.artifactDigest !== record.executionContext?.artifactDigest) {
        throw new Error('Legacy schedule generation ownership is unproven');
      }
      return { activityId: record.intent.activityId, generation: lease.generation,
        inputDigest: lease.inputDigest, artifactDigest: lease.artifactDigest };
    });
    super(ctx, env as unknown as Env);
    this.#appEnv = env as AppEnv & { OPERATOR_REGISTRY: NonNullable<AppEnv['OPERATOR_REGISTRY']> };
    // A diagnostics-only cold wake must not enter admission recovery or cleanup.
    ctx.blockConcurrencyWhile(async () => {
      this.#coldDispatcherLease = await ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    });
  }

  /** Optional recorder work is isolated from every execution outcome and authorization. */
  #enqueueDiagnostic(run: () => Promise<void>): void {
    const next = this.#diagnosticQueue.then(run).catch(async () => {
      try {
        await this.ctx.storage.transaction(async tx => {
          const state = await tx.get<AdmissionState>('admission');
          if (state?.diagnosticsVersion === 1 && !state.diagnosticRecorderUnavailable) {
            await tx.put('admission', { ...state, diagnosticRecorderUnavailable: true });
          }
        });
      } catch { /* Recorder failure cannot replace execution, even if loss-marker persistence fails. */ }
    });
    this.#diagnosticQueue = next;
    this.ctx.waitUntil(next);
  }

  #recordDiagnostic(generation: number, boundary: Boundary, outcome: EventObservation['outcome'], code: ReasonCode = 'none',
    error?: unknown, correlation: Correlation = {}, owner: EventObservation['owner'] = 'host', terminalGeneration?: number,
    capturedError?: ErrorMetadata, affectedOperations?: DiagnosticCapsule['affectedOperations'],
    capturedErrorOrigin: EventObservation['origin'] = 'catching', preparation?: DiagnosticPreparation): void {
    // Capture the original value now, before any transformation/await. It never enters the queued closure.
    const metadata = capturedError ?? (error === undefined ? undefined : captureError(error));
    const observation: EventObservation = { timestamp: Date.now(), boundary, outcome, code, owner,
      evidence: 'observed', origin: metadata ? capturedErrorOrigin : 'state-transition', source: hostSource(boundary),
      correlation, ...(metadata ? { error: metadata } : {}), ...(preparation ? { preparation } : {}) };
    this.#enqueueDiagnostic(async () => {
      await this.ctx.storage.transaction(async tx => {
        const state = await tx.get<AdmissionState>('admission');
        const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        const binding = lease ?? state?.diagnosticBinding;
        if (!state || !binding || binding.generation !== generation || state.diagnosticsVersion !== 1
          || !executionLoggingEnabled(state.receipt)) return;
        let affected = affectedOperations;
        let omitted: number | null = null;
        if (terminalGeneration !== undefined && !affected) {
          affected = [];
          const prefix = `dispatcher:operation:${generation}:`;
          const entries = await tx.list<DispatcherOperationRecord>({ prefix, limit: 32 });
          for (const [key, entry] of entries) {
            if (entry.generation !== generation || entry.phase === 'completed' || affected.length >= 8) continue;
            affected.push({ operationDigest: hashDiagnostic(key.slice(prefix.length)),
              effect: entry.request?.method === 'GET' ? 'read' : entry.request ? 'write'
                : entry.inference || entry.native ? 'none' : ['comment', 'merge'].includes(entry.phaseBinding?.resource ?? '') ? 'write' : 'unknown',
              status: 'unknown' });
          }
          const journal = await tx.get<DispatcherJournal>(DISPATCHER_JOURNAL);
          if (journal?.generation === generation && Number.isSafeInteger(journal.unresolved) && journal.unresolved >= affected.length) {
            omitted = journal.unresolved - affected.length;
          }
        }
        // Preparation can finish after phase advancement. Compare only captured digests;
        // never borrow the successor's coordinates or retain a raw delivery token.
        let retained = observation;
        if (preparation && (lease?.serial || correlation.deliveryDigest || correlation.submissionDigest)) {
          if (!this.#leaseMatches(state, lease, generation) || !lease?.serial || !lease.submissionId
            || lease.status !== 'running' || lease.serial.current.receipt?.submissionId !== lease.submissionId
            || hashDiagnostic(lease.serial.current.deliveryToken) !== correlation.deliveryDigest
            || hashDiagnostic(lease.submissionId) !== correlation.submissionDigest) {
            retained = { ...observation, correlation: {} };
          }
        }
        await appendDiagnostic(tx, binding, retained, { ...(terminalGeneration === undefined ? {} : { terminalGeneration }),
          ...(affected ? { affectedOperations: affected, affectedOperationsOmitted: omitted } : {}) });
      });
    });
  }

  /** Original cold recovery, once on an ordinary entry; never awaited by a child callback. */
  #resumeDispatcherOnEntry(reconciliationStarting = false, expectedGeneration?: number): void {
    const lease = this.#coldDispatcherLease;
    this.#coldDispatcherLease = undefined;
    if (lease?.status === 'admitting') {
      if (!lease.serial && lease.hosting !== 'normal') this.ctx.waitUntil(this.interruptDrive(lease.generation));
      else if (!reconciliationStarting || expectedGeneration !== undefined && expectedGeneration !== lease.generation) {
        this.ctx.waitUntil(this.reconcileDispatcherLease({ generation: lease.generation }));
      }
    } else if (lease && lease.hosting !== 'normal' && lease.status !== 'running' && !lease.sdkReleased) {
      this.ctx.waitUntil(this.#releaseDispatcherSdk());
    }
  }

  // Lifecycle startup also runs for diagnostics-only wakes in Agents 0.28.
  // Recovery stays on ordinary owner entry/alarm, not unconditional onStart.

  override async alarm(): Promise<void> {
    this.#resumeDispatcherOnEntry();
    await super.alarm();
    await this.reconcileDispatcherLease();
  }

  /** Production preparation stores parent-created encrypted human authority. */
  async prepareAuthorized(intent: OperatorActivityPreparation,
    executionContext: OperatorExecutionContext, invocationJson = 'null',
    boundary?: BoundaryActivityBinding): Promise<ActivityAdmissionResult> {
    this.#resumeDispatcherOnEntry();
    if (boundary && !boundaryBindingSchema.safeParse(boundary).success) {
      return { ok: false, reason: 'admission-denied' };
    }
    if (intent.activityId !== executionContext.activityId || intent.operatorId !== executionContext.operatorId) {
      return { ok: false, reason: 'admission-denied' };
    }
    try {
      if (new TextEncoder().encode(invocationJson).byteLength > 64 * 1024
        || intent.intentDigest !== await createOperatorIntentDigest(intent.operatorId, intent.activityId, invocationJson)) {
        return { ok: false, reason: 'admission-denied' };
      }
    } catch { return { ok: false, reason: 'admission-denied' }; }
    if (!Number.isFinite(intent.deadline) || intent.deadline > executionContext.expiresAt * 1000
      || intent.deadline <= Date.now()) return { ok: false, reason: 'authority-expired' };
    const ownerKey = await operatorOwnerKey(executionContext.owner);
    const result = await this.ctx.storage.transaction<ActivityAdmissionResult>(async tx => {
      if (await tx.get('admission')) return { ok: false, reason: 'already-prepared' };
      await tx.put<AdmissionState>('admission', { intent, phase: 'prepared', receipt: null, executionContext,
        invocationJson, ownerKey, inferenceRecoveryVersion: 1,
        ...(boundary ? { boundary: structuredClone(boundary) } : {}), updatedAt: Date.now() });
      return { ok: true, phase: 'prepared' };
    });
    return result;
  }

  /** Parent-only read for a stopping session; contains no human or start credentials. */
  async getBoundaryStartBinding(activityId: string): Promise<BoundaryActivityBinding | null> {
    this.#resumeDispatcherOnEntry();
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state?.intent.activityId === activityId && state.boundary
      ? structuredClone(state.boundary) : null;
  }

  /** Parent-only non-driving terminal metadata; no result bytes, JWT or capability leaves this read. */
  async getBoundaryPublicationState(activityId: string): Promise<{ binding: BoundaryActivityBinding;
    generation: number; status: 'completed' | 'failed'; collected: boolean } | null> {
    this.#resumeDispatcherOnEntry();
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (state?.intent.activityId !== activityId || !state.boundary || !state.drive
      || state.drive.generation < 1 || state.phase !== 'queued'
      || (state.drive.status !== 'completed' && state.drive.status !== 'failed')) return null;
    return { binding: structuredClone(state.boundary), generation: state.drive.generation,
      status: state.drive.status, collected: state.webhook?.consumed === true };
  }

  /** Parent-only frozen publication inputs; never expose result bytes or execution credentials. */
  async getBoundaryPublicationEvidence(activityId: string): Promise<{
    inputDigest: string; packageDigest: string; policyDigest: string; acknowledgedHead: string | null;
    invocationJson: string;
    context: { repositoryId: number; pullRequest: number; head: string; base: string; mergeBase: string };
    resultDigest: string; packets: Array<{ lane: string; name: string; mediaType: string;
      size: number; sha256: string; locator: string }>;
  } | null> {
    this.#resumeDispatcherOnEntry();
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state?.boundary || state.intent.activityId !== activityId || state.phase !== 'queued'
      || !state.webhook?.consumed || !state.drive || !['completed', 'failed'].includes(state.drive.status)
      || !state.receipt || !state.executionContext || !state.invocationJson) return null;
    try {
      const invocation = JSON.parse(state.invocationJson) as { inputDigest: string;
        input: { context: { repositoryId: number; pullRequest: number; head: string; base: string; mergeBase: string };
          acknowledgedHead: string | null } };
      const context = invocation.input.context;
      if (!syncDigest.safeParse(invocation.inputDigest).success
        || context.repositoryId !== state.boundary.repositoryId || context.pullRequest !== state.boundary.pullRequest
        || ![context.head, context.base, context.mergeBase].every(value => /^[0-9a-f]{40}$/.test(value))
        || !(invocation.input.acknowledgedHead === null
          || /^[0-9a-f]{40}$/.test(invocation.input.acknowledgedHead))) return null;
      if (!await this.approvedPacketClaimsCurrent(state)) return null;
      return { inputDigest: invocation.inputDigest, invocationJson: state.invocationJson,
        context: structuredClone(context),
        acknowledgedHead: invocation.input.acknowledgedHead,
        packageDigest: state.executionContext.artifactDigest, policyDigest: state.executionContext.policyDigest,
        resultDigest: await sha256(JSON.stringify(state.drive.result)),
        packets: Object.values(state.approvedPackets ?? {}).map(record => ({ lane: record.lane,
          ...structuredClone(record.attachment) })) };
    } catch { return null; }
  }

  /** Stop's exact binding wins durably over prepared, admitting and queued starts. */
  async cancelBoundaryStart(binding: BoundaryActivityBinding): Promise<{ ok: boolean }> {
    this.#resumeDispatcherOnEntry();
    if (!boundaryBindingSchema.safeParse(binding).success) return { ok: false };
    const result = await this.ctx.storage.transaction(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state?.boundary || JSON.stringify(state.boundary) !== JSON.stringify(binding)) return { ok: false };
      if (state.phase === 'cancelled') return { ok: true };
      const drive = state.drive && (state.drive.status === 'running' || state.drive.status === 'waiting')
        ? { ...state.drive, generation: state.drive.generation + 1, status: 'cancel-requested' as const } : state.drive;
      await tx.put<AdmissionState>('admission', { ...state, phase: 'cancelled', drive,
        intent: { ...state.intent, startVerifier: '' }, updatedAt: Date.now() });
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (lease && lease.status !== 'settled') await tx.put(DISPATCHER_LEASE, { ...lease, status: 'unknown' });
      return { ok: true };
    });
    if (result.ok) {
      for (const flight of this.#inferenceFlights.values()) flight.controller.abort();
      for (const flight of this.#nativeFlights.values()) flight.controller.abort();
      for (const controller of this.#sdkHttpControllers) controller.abort();
      this.#nativeBindings.clear();
      await this.publishBrowserSummary().catch(() => {});
    }
    return result;
  }

  private async boundaryClaimCurrent(state: AdmissionState): Promise<boolean> {
    if (!state.boundary) return true;
    try {
      const guard = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').getBoundaryStartGuard(state.intent.activityId);
      return !!guard?.claimed && guard.repositoryId === state.boundary.repositoryId
        && guard.pullRequest === state.boundary.pullRequest
        && 'contextDigest' in guard && guard.contextDigest === state.boundary.contextDigest
        && JSON.stringify(guard.session) === JSON.stringify(state.boundary.session);
    } catch { return false; }
  }

  private async boundaryCurrent(state: AdmissionState): Promise<boolean> {
    if (!state.boundary) return true;
    if (state.phase === 'cancelled' || !state.executionContext || state.intent.deadline <= Date.now()
      || state.executionContext.expiresAt * 1000 <= Date.now() || !this.#appEnv.USAGE_DB) return false;
    try {
      const { D1SessionRepository } = await import('../lib/session-repository');
      if (!await new D1SessionRepository(this.#appEnv.USAGE_DB).isBoundaryActionStartCurrent(
        state.boundary.session.bucket, state.boundary.session.sessionId, state.boundary.session.generation,
        state.intent.activityId)) return false;
      if (!await this.boundaryClaimCurrent(state)) return false;
      const sealed = await openOperatorExecutionAccess(state.executionContext, this.#appEnv);
      const current = await requireOperatorHumanContext(new Request('https://codeflare.invalid/', {
        headers: { 'cf-access-jwt-assertion': sealed.accessJwt },
      }), this.#appEnv, sealed.human.email);
      if (current.human.subject !== sealed.human.subject || current.human.issuer !== sealed.human.issuer
        || current.human.email.toLowerCase() !== sealed.human.email.toLowerCase()
        || JSON.stringify(current.human.audiences) !== JSON.stringify(sealed.human.audiences)
        || await operatorOwnerKey(current.human) !== state.ownerKey) return false;
      if (!('installationId' in state.intent)) return false;
      const selection = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry')
        .resolveManagementExecution(state.intent.installationId);
      return selection.ok && canInvokeOperator(current.human, selection.value.operator);
    } catch { return false; }
  }

  /** Replace protected authority only through same-owner reauthentication. */
  async reauthenticate(human: VerifiedHumanAccessClaims, accessJwt: string): Promise<OperatorExecutionProjection> {
    this.#resumeDispatcherOnEntry();
    const record = await this.ctx.storage.get<AdmissionState>('admission');
    if (!record?.executionContext) throw new AppError('NOT_FOUND', 404, 'Operator execution context not found');
    const previous = record.executionContext;
    const currentHuman = await resolveOperatorGroupIdentity(human, accessJwt);
    const replacement = await reauthenticateOperatorExecution(previous, currentHuman, accessJwt, this.#appEnv);
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<AdmissionState>('admission');
      if (!current?.executionContext) throw new AppError('NOT_FOUND', 404, 'Operator execution context not found');
      if (current.executionContext.protectedAccessCiphertext !== previous.protectedAccessCiphertext) {
        throw new AppError('CONFLICT', 409, 'Operator authority changed; refresh before retrying');
      }
      await tx.put<AdmissionState>('admission', { ...current, intent: {
        ...current.intent, deadline: Math.min(current.intent.deadline, replacement.expiresAt * 1000),
      }, executionContext: replacement });
    });
    return projectOperatorExecution(replacement);
  }

  /** Authorize the pre-index start gap from the durable owner binding, without exposing prepared state. */
  async ownsPrepared(ownerKey: string): Promise<boolean> {
    this.#resumeDispatcherOnEntry();
    if (!syncDigest.safeParse(ownerKey).success) return false;
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state?.ownerKey === ownerKey && (state.phase === 'prepared' || state.phase === 'admitting');
  }

  /** Parent-safe discriminator used to require live installation authorization at start. */
  async getPreparedInstallationId(): Promise<string | null> {
    this.#resumeDispatcherOnEntry();
    const intent = (await this.ctx.storage.get<AdmissionState>('admission'))?.intent;
    return intent && 'installationId' in intent ? intent.installationId : null;
  }

  /** Parent-safe activity identity read; no credential ciphertext or token. */
  async getExecutionContext(): Promise<OperatorExecutionProjection | null> {
    this.#resumeDispatcherOnEntry();
    const context = (await this.ctx.storage.get<AdmissionState>('admission'))?.executionContext;
    return context ? projectOperatorExecution(context) : null;
  }

  /** Bind the existing Registry reservation before any prospective preparation. */
  async bindProspectiveRenovateAdmission(activityId: string): Promise<boolean> {
    this.#resumeDispatcherOnEntry();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(activityId) || !this.#appEnv.OPERATOR_ACTIVITY
      || this.#appEnv.OPERATOR_ACTIVITY.idFromName(activityId).toString() !== this.ctx.id.toString()) return false;
    const proof = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry')
      .readProspectiveRenovateAdmission(activityId);
    if (!proof || proof.activityId !== activityId) return false;
    return this.ctx.storage.transaction(async tx => {
      const [previous, admission] = await Promise.all([
        tx.get<string>('prospective-admission'), tx.get<AdmissionState>('admission'),
      ]);
      if ((previous && previous !== activityId) || (admission && admission.intent.activityId !== activityId)) return false;
      await tx.put('prospective-admission', activityId);
      return true;
    });
  }

  /** Parent-only source binding after server validation, before admission/start. Never SDK job data. */
  async bindDispatcherOwnerSource(input: DispatcherOwnerSource): Promise<boolean> {
    const parsed = z.strictObject({ bucket: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
      sessionId: syncIdentity, sessionGeneration: z.number().int().positive().safe() }).safeParse(input);
    if (!parsed.success) return false;
    return this.ctx.storage.transaction(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state?.executionContext || state.phase !== 'prepared' || state.receipt || state.drive
        || !('installationId' in state.intent) || await tx.get(DISPATCHER_LEASE)) return false;
      if (state.ownerSource) return sameDispatcherPhaseValue(state.ownerSource, parsed.data);
      await tx.put<AdmissionState>('admission', { ...state, ownerSource: parsed.data });
      return true;
    });
  }

  /** Parent-only runtime input; never returned by browser, webhook, or child capabilities. */
  async getRuntimePlan(): Promise<OperatorRuntimePlan | null> {
    this.#resumeDispatcherOnEntry();
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state?.executionContext || !state.receipt || state.phase !== 'queued'
      || !await this.boundaryCurrent(state)) return null;
    const prospectiveAdmissionId = await this.ctx.storage.get<string>('prospective-admission');
    return { activityId: state.intent.activityId, deadline: state.intent.deadline,
      invocationJson: state.invocationJson ?? 'null', receipt: structuredClone(state.receipt),
      executionContext: structuredClone(state.executionContext),
      ...(state.ownerSource ? { ownerSource: structuredClone(state.ownerSource) } : {}),
      ...(state.inferenceSelection ? { inferenceSelection: structuredClone(state.inferenceSelection) } : {}),
      ...(state.configuredSelection ? { configuredSelection: structuredClone(state.configuredSelection) } : {}),
      ...(state.authFailure ? { authFailure: structuredClone(state.authFailure) } : {}),
      ...(prospectiveAdmissionId ? { prospectiveAdmissionId } : {}) };
  }

  /** Persist only the projection derived from the exact admitted bundle digest. */
  async savePackageResources(input: unknown): Promise<void> {
    this.#resumeDispatcherOnEntry();
    const projection = parseOperatorPackageResourceProjection(input);
    const plan = await this.getRuntimePlan();
    if (!plan) throw new Error('Package resource digest mismatch');
    const digest = isManagementReceipt(plan.receipt)
      ? plan.receipt.selection.release.bundleDigest : plan.receipt.artifactDigest;
    if (projection.artifactDigest !== digest) throw new Error('Package resource digest mismatch');
    await this.ctx.storage.put('packageResources', projection);
  }

  async getPackageResources(): Promise<OperatorPackageResourceProjection | null> {
    this.#resumeDispatcherOnEntry();
    const value = await this.ctx.storage.get<unknown>('packageResources');
    return value == null ? null : structuredClone(parseOperatorPackageResourceProjection(value));
  }

  private async approvedPacketClaimsCurrent(state: AdmissionState): Promise<boolean> {
    if (!state.boundary) return false;
    const records = Object.values(state.approvedPackets ?? {});
    if (!records.length) return true;
    try {
      const guard = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').getBoundaryStartGuard(state.intent.activityId);
      if (!guard?.claimed || !guard.workflowSha) return false;
      const claim = { contextDigest: guard.contextDigest, runId: guard.runId,
        runAttempt: guard.runAttempt, head: guard.head, base: guard.base,
        mergeBase: guard.mergeBase, workflowSha: guard.workflowSha, sessionGeneration: guard.generation };
      return records.every(record => JSON.stringify(record.claim) === JSON.stringify(claim));
    } catch { return false; }
  }

  /** Parent-only accepted packet identity; no candidate bytes are stored in Activity state. */
  async saveApprovedPacketAttachment(input: unknown): Promise<{ ok: true; preparationId: string;
    attachment: ApprovedPacketRecord['attachment'] } | { ok: false }> {
    this.#resumeDispatcherOnEntry();
    const parsed = approvedPacketSchema.safeParse(input);
    if (!parsed.success || parsed.data.bytes.byteLength !== parsed.data.size) return { ok: false };
    const actual = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(parsed.data.bytes))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== parsed.data.sha256) return { ok: false };
    const before = await this.ctx.storage.get<AdmissionState>('admission');
    if (!before?.boundary || before.drive?.generation !== parsed.data.driveGeneration
      || !await this.operatorGenerationCurrent(parsed.data.driveGeneration)) return { ok: false };
    const guard = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').getBoundaryStartGuard(before.intent.activityId);
    if (!guard?.claimed || !guard.workflowSha || guard.contextDigest !== before.boundary.contextDigest
      || JSON.stringify(guard.session) !== JSON.stringify(before.boundary.session)) return { ok: false };
    const claim = { contextDigest: guard.contextDigest, runId: guard.runId, runAttempt: guard.runAttempt,
      head: guard.head, base: guard.base, mergeBase: guard.mergeBase,
      workflowSha: guard.workflowSha, sessionGeneration: guard.generation };
    const { preparationId, lane, name, mediaType, locator, size, sha256 } = parsed.data;
    const attachment = { name, mediaType, locator, size, sha256 };
    return this.ctx.storage.transaction(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state?.boundary || state.phase !== 'queued' || state.intent.activityId !== before.intent.activityId
        || state.drive?.status !== 'running' || state.drive.generation !== before.drive?.generation
        || state.intent.deadline <= Date.now()
        || state.boundary.contextDigest !== guard.contextDigest) return { ok: false } as const;
      const existing = state.approvedPackets ?? {};
      const prior = existing[lane];
      if (!prior && await tx.get('ownedSession')) return { ok: false } as const;
      if (prior) return prior.preparationId === preparationId
        && sameApprovedPacketAttachment(prior.attachment, attachment)
        && JSON.stringify(prior.claim) === JSON.stringify(claim)
        ? { ok: true as const, preparationId, attachment: structuredClone(prior.attachment) }
        : { ok: false as const };
      if (Object.values(existing).some(record => record.preparationId === preparationId
        || record.attachment.locator === locator || record.attachment.name === name)
        || Object.keys(existing).length >= 16
        || Object.values(existing).reduce((total, record) => total + record.attachment.size, size) > 8 * 1024 * 1024) {
        return { ok: false } as const;
      }
      await tx.put<AdmissionState>('admission', { ...state,
        approvedPackets: { ...existing, [lane]: { preparationId, lane, attachment, claim } } });
      return { ok: true as const, preparationId, attachment };
    });
  }

  /** The container receives only descriptors accepted for this still-current boundary. */
  async readApprovedPacketAttachments(): Promise<{ schemaVersion: 1; activityId: string;
    files: ApprovedPacketRecord['attachment'][] }> {
    this.#resumeDispatcherOnEntry();
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state) return { schemaVersion: 1, activityId: '', files: [] };
    if (!state.boundary || !await this.boundaryCurrent(state) || !await this.approvedPacketClaimsCurrent(state)) {
      return { schemaVersion: 1, activityId: state.intent.activityId, files: [] };
    }
    return { schemaVersion: 1, activityId: state.intent.activityId,
      files: Object.values(state.approvedPackets ?? {}).map(record => structuredClone(record.attachment)) };
  }

  /** Activity-owned session state; immutable identity and profile, monotonic finite transitions. */
  async saveOwnedSession(input: unknown): Promise<{ ok: true } | { ok: false; reason: 'invalid' | 'conflict' }> {
    this.#resumeDispatcherOnEntry();
    const value = input as Partial<OwnedOperatorSessionState>;
    const statuses = ['reserved', 'configuring', 'configured', 'starting', 'ready', 'stopping', 'stopped', 'unknown'];
    let profile;
    try {
      const encoded = JSON.stringify(input);
      if (!encoded || new TextEncoder().encode(encoded).byteLength > 64 * 1024) return { ok: false, reason: 'invalid' };
      profile = parseOperatorContainerProfile(value.profile);
    } catch { return { ok: false, reason: 'invalid' }; }
    if (value.schemaVersion !== 1 || !syncIdentity.safeParse(value.requestId).success
      || !syncDigest.safeParse(value.requestDigest).success || !syncIdentity.safeParse(value.activityId).success
      || !syncIdentity.safeParse(value.sessionId).success || typeof value.ownerBucket !== 'string'
      || !/^[A-Za-z0-9._-]{1,128}$/.test(value.ownerBucket) || !statuses.includes(value.status ?? '')
      || profile.activityId !== value.activityId || profile.sessionId !== value.sessionId
      || profile.ownerBucket !== value.ownerBucket) return { ok: false, reason: 'invalid' };
    const candidate = { ...value, profile } as OwnedOperatorSessionState;
    const transitions: Record<OwnedOperatorSessionState['status'], readonly OwnedOperatorSessionState['status'][]> = {
      reserved: ['reserved', 'configuring', 'stopping'],
      configuring: ['configuring', 'configured', 'stopping', 'unknown'],
      configured: ['configured', 'starting', 'stopping'],
      starting: ['starting', 'ready', 'stopping', 'unknown'],
      ready: ['ready', 'stopping'], stopping: ['stopping', 'stopped', 'unknown'],
      stopped: ['stopped'], unknown: ['unknown', 'stopping'],
    };
    const teardown = ['stopping', 'stopped', 'unknown'].includes(candidate.status);
    const before = await this.ctx.storage.get<AdmissionState>('admission');
    if (before?.boundary && !teardown
      && (!await this.boundaryCurrent(before) || !await this.approvedPacketClaimsCurrent(before))) {
      return { ok: false, reason: 'invalid' };
    }
    const saved = await this.ctx.storage.transaction(async tx => {
      const admission = await tx.get<AdmissionState>('admission');
      if (!admission || admission.intent.activityId !== candidate.activityId
        || (admission.phase !== 'queued'
          && !(admission.phase === 'cancelled' && ['stopping', 'stopped', 'unknown'].includes(candidate.status)))) {
        return { ok: false, reason: 'invalid' } as const;
      }
      if (admission.boundary) {
        if (!admission.invocationJson) return { ok: false, reason: 'invalid' } as const;
        if (!teardown && (!before?.boundary || admission.boundary.contextDigest !== before.boundary.contextDigest
          || admission.drive?.generation !== before.drive?.generation
          || admission.drive?.status !== before.drive?.status)) return { ok: false, reason: 'invalid' } as const;
        try {
          const initial = projectOperatorAttachments(JSON.parse(admission.invocationJson));
          const attachments = parseOperatorAttachmentProjection({ schemaVersion: 1,
            activityId: candidate.activityId, files: [...initial.files,
              ...Object.values(admission.approvedPackets ?? {}).map(record => record.attachment)] });
          const initialization = candidate.profile.piProfile.initialization;
          if (Object.keys(admission.approvedPackets ?? {}).length > 0) {
            const checkpoint = admission.drive?.checkpoint as { initialization?: unknown } | null;
            const declared = new Set(initialization?.inputs.filter(item => item.kind === 'attachment')
              .map(item => item.reference) ?? []);
            if (!initialization || !checkpoint
              || JSON.stringify(initialization) !== JSON.stringify(checkpoint.initialization)
              || attachments.files.length !== declared.size
              || attachments.files.some(file => !declared.has(file.name))) {
              return { ok: false, reason: 'conflict' } as const;
            }
          }
          const expected = await sha256(JSON.stringify({ invocationJson: admission.invocationJson, attachments,
            ...(initialization ? { initialization } : {}) }));
          if (candidate.requestDigest !== expected) return { ok: false, reason: 'conflict' } as const;
        } catch { return { ok: false, reason: 'invalid' } as const; }
      }
      const existing = await tx.get<OwnedOperatorSessionState>('ownedSession');
      if (existing) {
        const same = existing.requestId === candidate.requestId && existing.requestDigest === candidate.requestDigest
          && existing.activityId === candidate.activityId && existing.ownerBucket === candidate.ownerBucket
          && existing.sessionId === candidate.sessionId && JSON.stringify(existing.profile) === JSON.stringify(candidate.profile);
        if (!same || !transitions[existing.status].includes(candidate.status)) return { ok: false, reason: 'conflict' } as const;
      } else if (candidate.status !== 'reserved') return { ok: false, reason: 'conflict' } as const;
      await tx.put('ownedSession', candidate);
      return { ok: true } as const;
    });
    if (saved.ok && before?.boundary && !teardown) {
      const after = await this.ctx.storage.get<AdmissionState>('admission');
      if (!after || !await this.boundaryCurrent(after) || !await this.approvedPacketClaimsCurrent(after)) {
        return { ok: false, reason: 'invalid' };
      }
    }
    return saved;
  }

  async getOwnedSession(): Promise<OwnedOperatorSessionState | null> {
    this.#resumeDispatcherOnEntry();
    const state = await this.ctx.storage.get<OwnedOperatorSessionState>('ownedSession');
    return state ? structuredClone(state) : null;
  }

  async prepare(intent: OperatorActivityPreparation): Promise<ActivityAdmissionResult> {
    this.#resumeDispatcherOnEntry();
    return this.ctx.storage.transaction<ActivityAdmissionResult>(async tx => {
      if (await tx.get('admission')) return { ok: false, reason: 'already-prepared' };
      await tx.put<AdmissionState>('admission', { intent, phase: 'prepared', receipt: null });
      return { ok: true, phase: 'prepared' };
    });
  }

  /** Validate before registry I/O; consume and queue together only after receipt. */
  async start(capability: string): Promise<ActivityAdmissionResult> {
    this.#resumeDispatcherOnEntry();
    return this.consumeStart(capability, false);
  }

  /** External start winner receives a distinct read capability exactly once. */
  async startWebhook(capability: string): Promise<WebhookStartResult> {
    this.#resumeDispatcherOnEntry();
    return this.consumeStart(capability, true) as Promise<WebhookStartResult>;
  }

  private async consumeStart(capability: string, issueRead: boolean): Promise<ActivityAdmissionResult | WebhookStartResult> {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(capability)) return { ok: false, reason: 'invalid-capability' };
    const verifier = await capabilityVerifier(capability);
    const pending = await this.ctx.storage.transaction<AdmissionFailure | { ok: true; intent: OperatorActivityPreparation }>(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state) return { ok: false, reason: 'not-prepared' };
      const denied = checkStart(state, verifier);
      if (denied) return denied;
      if (state.boundary && !issueRead) return { ok: false, reason: 'admission-denied' };
      if (state.boundary) {
        if (!await this.boundaryClaimCurrent(state) || !await this.boundaryCurrent(state)) {
          return { ok: false, reason: 'admission-denied' };
        }
      }
      await tx.put<AdmissionState>('admission', { ...state, phase: 'admitting' });
      return { ok: true, intent: state.intent };
    });
    if (!pending.ok) return pending;
    const { activityId, operatorId, intentDigest, expectedRevision, deadline } = pending.intent;
    let receipt: OperatorAdmissionReceipt | ManagementAdmissionReceipt;
    try {
      const admitted = 'installationId' in pending.intent
        ? await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').admitManagement({
          installationId: pending.intent.installationId, activityId, intentDigest,
          expectedInstallationRevision: pending.intent.expectedInstallationRevision,
          expectedOperatorRevision: expectedRevision,
          expectedControlsRevision: pending.intent.expectedControlsRevision, deadline,
        })
        : await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').admit({
          activityId, operatorId, intentDigest, expectedRevision, deadline,
        });
      if (!admitted.ok) return { ok: false, reason: 'admission-denied' };
      receipt = admitted.value;
    } catch {
      return { ok: false, reason: 'admission-uncertain' };
    }
    const managementReceipt = isManagementReceipt(receipt) ? receipt : null;
    const legacyReceipt = isManagementReceipt(receipt) ? null : receipt;
    const receiptPolicyJson = legacyReceipt?.policyJson ?? null;
    const receiptPolicyDigest = receiptPolicyJson
      ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(receiptPolicyJson))))
        .map(byte => byte.toString(16).padStart(2, '0')).join('')
      : null;
    const readCapability = issueRead ? randomCapability() : null;
    const readVerifier = readCapability ? await capabilityVerifier(readCapability) : null;
    const queued = await this.ctx.storage.transaction<ActivityAdmissionResult | WebhookStartResult>(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state) return { ok: false, reason: 'not-prepared' };
      const denied = checkStart(state, verifier);
      if (denied) return denied;
      if (state.boundary && (!issueRead || !await this.boundaryClaimCurrent(state)
        || !await this.boundaryCurrent(state))) return { ok: false, reason: 'admission-denied' };
      const intent = state.intent;
      const managementValid = 'installationId' in intent && managementReceipt !== null
        && managementReceipt.installationId === intent.installationId
        && managementReceipt.expectedInstallationRevision === intent.expectedInstallationRevision
        && managementReceipt.expectedOperatorRevision === intent.expectedRevision
        && managementReceipt.expectedControlsRevision === intent.expectedControlsRevision
        && managementReceipt.selection.operator.operatorId === intent.operatorId
        && (!state.executionContext || (managementReceipt.selection.release.bundleDigest === state.executionContext.artifactDigest
          && await sha256(JSON.stringify(managementReceipt.selection.installation.policy)) === state.executionContext.policyDigest));
      const legacyValid = !('installationId' in intent) && legacyReceipt !== null
        && legacyReceipt.operatorId === intent.operatorId && legacyReceipt.expectedRevision === intent.expectedRevision
        && (!state.executionContext || (legacyReceipt.artifactDigest === state.executionContext.artifactDigest
          && receiptPolicyDigest === state.executionContext.policyDigest));
      if (receipt.activityId !== intent.activityId || receipt.intentDigest !== intent.intentDigest
        || receipt.deadline !== intent.deadline || (!managementValid && !legacyValid)) {
        return { ok: false, reason: 'admission-denied' };
      }
      let inferenceSelection: NativeOperatorInference | undefined;
      if (managementReceipt?.selection.operator.profile === 'conductor') {
        try {
          const inference = JSON.parse(state.invocationJson ?? 'null')?.resources?.inference;
          if (inference?.source === 'pi-native') inferenceSelection = parseNativeOperatorInference(inference);
        } catch { return { ok: false, reason: 'admission-denied' }; }
      }
      await tx.put<AdmissionState>('admission', {
        ...state, intent: { ...intent, startVerifier: '' }, phase: 'queued', receipt,
        ...(inferenceSelection ? { inferenceSelection } : {}),
        ...(readVerifier ? { webhook: { readVerifier, expiresAt: intent.deadline + 2 * 60 * 60 * 1000,
          consumed: false } } : {}), updatedAt: Date.now(),
      });
      return readCapability ? { ok: true, phase: 'queued', readCapability } : { ok: true, phase: 'queued' };
    });
    if (queued.ok) await this.publishBrowserSummary();
    return queued;
  }

  /** Non-consuming status validates the read capability even after execution authority expiry. */
  async getWebhookStatus(capability: string): Promise<WebhookReadResult> {
    this.#resumeDispatcherOnEntry();
    const checked = await this.readWebhook(capability);
    if (!checked.ok) return checked;
    return { ok: true, terminal: checked.terminal, status: checked.status, generation: checked.generation,
      ...(checked.terminal ? { result: checked.result } : {}) };
  }

  /** Claim one observed waiting generation; a read or delayed callback never drives a later one. */
  async continueWebhook(capability: string, expectedGeneration: number): Promise<WebhookContinueResult> {
    this.#resumeDispatcherOnEntry();
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) return { ok: false, reason: 'invalid-capability' };
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
      return { ok: false, reason: 'stale-generation' };
    }
    const verifier = await capabilityVerifier(capability);
    return this.ctx.storage.transaction<WebhookContinueResult>(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      const checked = this.checkWebhookRead(state, verifier);
      if (!checked.ok) return checked;
      if (checked.terminal || state?.drive?.status !== 'waiting') return { ok: false, reason: 'not-ready' };
      if (state.drive.generation !== expectedGeneration) return { ok: false, reason: 'stale-generation' };
      if (state.webhook!.continuedGeneration === expectedGeneration) return { ok: false, reason: 'already-started' };
      await tx.put<AdmissionState>('admission', { ...state, webhook: { ...state.webhook!,
        continuedGeneration: expectedGeneration } });
      return { ok: true, phase: 'queued' };
    });
  }

  /** A not-ready read is non-consuming; one terminal transaction wins before delivery. */
  async redeemWebhookResult(capability: string): Promise<WebhookReadResult> {
    this.#resumeDispatcherOnEntry();
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) return { ok: false, reason: 'invalid-capability' };
    const verifier = await capabilityVerifier(capability);
    return this.ctx.storage.transaction<WebhookReadResult>(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      // Redemption alone may reread its immutable terminal bytes after lost delivery.
      // Status and continuation retain their single-use consumed fence.
      if (state?.webhook?.readVerifier !== verifier) return { ok: false, reason: state?.webhook
        ? 'invalid-capability' : 'not-prepared' };
      if (Math.min(state.webhook.expiresAt, state.intent.deadline + 2 * 60 * 60 * 1000) <= Date.now()) {
        return { ok: false, reason: 'capability-expired' };
      }
      const checked = this.checkWebhookRead(state.webhook.consumed
        ? { ...state, webhook: { ...state.webhook, consumed: false } } : state, verifier);
      if (!checked.ok) return checked;
      if (!checked.terminal) return { ok: false, reason: 'not-ready' };
      if (!state.webhook.consumed) await tx.put<AdmissionState>('admission', { ...state,
        webhook: { ...state.webhook, consumed: true } });
      return checked;
    });
  }

  private async readWebhook(capability: string): Promise<WebhookReadResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) return { ok: false, reason: 'invalid-capability' };
    return this.checkWebhookRead(await this.ctx.storage.get<AdmissionState>('admission'),
      await capabilityVerifier(capability));
  }

  private checkWebhookRead(state: AdmissionState | undefined, verifier: string): WebhookReadResult {
    if (!state?.webhook) return { ok: false, reason: 'not-prepared' };
    if (state.webhook.readVerifier !== verifier) return { ok: false, reason: 'invalid-capability' };
    if (state.webhook.consumed) return { ok: false, reason: 'consumed' };
    if (Math.min(state.webhook.expiresAt, state.intent.deadline + 2 * 60 * 60 * 1000) <= Date.now()) {
      return { ok: false, reason: 'capability-expired' };
    }
    const driveStatus = state.drive?.status;
    const expired = state.intent.deadline <= Date.now();
    const terminal = expired || driveStatus === 'completed' || driveStatus === 'failed'
      || driveStatus === 'cancel-requested' || driveStatus === 'unknown';
    const status = expired && !driveStatus ? 'expired' : (driveStatus ?? 'queued');
    return { ok: true, terminal, status, generation: state.drive?.generation ?? 0,
      ...(terminal ? { result: state.drive?.result ?? null } : {}) };
  }

  /** Persist a stable parent-authorized upload scope before host-side effects. */
  async prepareSync(input: unknown): Promise<OperatorSyncResult> {
    this.#resumeDispatcherOnEntry();
    const parsed = syncPreparationSchema.safeParse(input);
    if (!parsed.success || !canonicalSyncPrefix(parsed.data.prefix, parsed.data.operationId)
      || new Set(parsed.data.keys).size !== parsed.data.keys.length
      || parsed.data.keys.some(key => !canonicalSyncKey(key) || key.startsWith(parsed.data.prefix))) {
      return { ok: false, reason: 'invalid-scope' };
    }
    const scope = parsed.data;
    return this.ctx.storage.transaction<OperatorSyncResult>(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      if (!record || record.phase !== 'queued' || !record.executionContext) return { ok: false, reason: 'not-admitted' };
      if (scope.policyDigest !== record.executionContext.policyDigest
        || scope.deadline > record.intent.deadline) return { ok: false, reason: 'invalid-scope' };
      if (scope.deadline <= Date.now()) return { ok: false, reason: 'authority-expired' };
      const operations = record.syncOperations ?? {};
      const existing = operations[scope.operationId];
      if (existing) {
        const same = existing.sessionId === scope.sessionId && existing.requestDigest === scope.requestDigest
          && existing.policyDigest === scope.policyDigest && existing.prefix === scope.prefix
          && JSON.stringify(existing.keys) === JSON.stringify(scope.keys) && existing.deadline === scope.deadline;
        return same ? { ok: true, phase: existing.phase } : { ok: false, reason: 'conflict' };
      }
      if (Object.keys(operations).length >= 1024) return { ok: false, reason: 'operation-limit' };
      const next: OperatorSyncState = { ...scope, phase: 'prepared', manifestDigest: null, evidence: null };
      await tx.put<AdmissionState>('admission', { ...record,
        syncOperations: { ...operations, [scope.operationId]: next } });
      return { ok: true, phase: 'prepared' };
    });
  }

  /** The R2 interceptor calls this before each write; uploaded/verified is sealed. */
  async authorizeSyncWrite(operationId: string, key: string): Promise<{ ok: true } | { ok: false; reason: 'not-prepared' | 'sealed' | 'authority-expired' | 'invalid-scope' }> {
    this.#resumeDispatcherOnEntry();
    const record = await this.ctx.storage.get<AdmissionState>('admission');
    const operation = record?.syncOperations?.[operationId];
    if (!operation) return { ok: false, reason: 'not-prepared' };
    if (operation.phase !== 'prepared') return { ok: false, reason: 'sealed' };
    if (operation.deadline <= Date.now()) return { ok: false, reason: 'authority-expired' };
    const privateKey = key.startsWith(operation.prefix) && key !== operation.prefix;
    if ((!privateKey && !operation.keys.includes(key)) || !canonicalSyncPrefix(operation.prefix, operationId)
      || !canonicalSyncKey(key)) return { ok: false, reason: 'invalid-scope' };
    return { ok: true };
  }

  /** Read only independently verified objects declared by this activity. */
  async authorizeSyncRead(key: string, maxBytes: number): Promise<{ ok: true } | { ok: false }> {
    this.#resumeDispatcherOnEntry();
    if (!canonicalSyncKey(key) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) {
      return { ok: false };
    }
    const record = await this.ctx.storage.get<AdmissionState>('admission');
    if (!record || record.phase !== 'queued' || record.intent.deadline <= Date.now()
      || !await this.boundaryCurrent(record)) return { ok: false };
    const allowed = Object.values(record.syncOperations ?? {}).some(operation => operation.phase === 'verified'
      && (key === `${operation.prefix}manifest.json` || operation.keys.includes(key)));
    return allowed ? { ok: true } : { ok: false };
  }

  /** Recording uploaded bytes seals the namespace before independent reads. */
  async recordSyncUploaded(operationId: string, manifestDigest: string): Promise<OperatorSyncResult> {
    this.#resumeDispatcherOnEntry();
    if (!syncIdentity.safeParse(operationId).success || !syncDigest.safeParse(manifestDigest).success) {
      return { ok: false, reason: 'invalid-scope' };
    }
    return this.ctx.storage.transaction<OperatorSyncResult>(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      const operation = record?.syncOperations?.[operationId];
      if (!record || !operation) return { ok: false, reason: 'not-prepared' };
      if (operation.phase !== 'prepared') {
        return operation.manifestDigest === manifestDigest
          ? { ok: true, phase: operation.phase } : { ok: false, reason: 'conflict' };
      }
      if (operation.deadline <= Date.now()) return { ok: false, reason: 'authority-expired' };
      const uploaded: OperatorSyncState = { ...operation, phase: 'uploaded', manifestDigest };
      await tx.put<AdmissionState>('admission', { ...record,
        syncOperations: { ...record.syncOperations, [operationId]: uploaded } });
      return { ok: true, phase: 'uploaded' };
    });
  }

  /** Commit only evidence matching the already sealed manifest identity. */
  async recordSyncVerified(operationId: string,
    evidence: { manifestDigest: string; filesVerified: number; bytesVerified: number }): Promise<OperatorSyncResult> {
    this.#resumeDispatcherOnEntry();
    if (!syncIdentity.safeParse(operationId).success || !syncDigest.safeParse(evidence?.manifestDigest).success
      || !Number.isSafeInteger(evidence?.filesVerified) || evidence.filesVerified < 0 || evidence.filesVerified > 128
      || !Number.isSafeInteger(evidence?.bytesVerified) || evidence.bytesVerified < 0
      || evidence.bytesVerified > 8 * 1024 * 1024) return { ok: false, reason: 'evidence-mismatch' };
    return this.ctx.storage.transaction<OperatorSyncResult>(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      const operation = record?.syncOperations?.[operationId];
      if (!record || !operation) return { ok: false, reason: 'not-prepared' };
      if (operation.manifestDigest !== evidence.manifestDigest) return { ok: false, reason: 'evidence-mismatch' };
      if (operation.phase === 'verified') return { ok: true, phase: 'verified' };
      if (operation.phase !== 'uploaded') return { ok: false, reason: 'not-prepared' };
      const verified: OperatorSyncState = { ...operation, phase: 'verified',
        evidence: { filesVerified: evidence.filesVerified, bytesVerified: evidence.bytesVerified } };
      await tx.put<AdmissionState>('admission', { ...record,
        syncOperations: { ...record.syncOperations, [operationId]: verified } });
      return { ok: true, phase: 'verified' };
    });
  }

  /** Parent-safe durable receipt projection; contains no authority or bucket credentials. */
  async getSync(operationId: string): Promise<OperatorSyncState | null> {
    this.#resumeDispatcherOnEntry();
    if (!syncIdentity.safeParse(operationId).success) return null;
    const operation = (await this.ctx.storage.get<AdmissionState>('admission'))?.syncOperations?.[operationId];
    return operation ? structuredClone(operation) : null;
  }

  /** Bind one admitted Review generation to immutable source, package and packet identities. */
  async prepareReviewState(input: unknown): Promise<OperatorReviewResult> {
    this.#resumeDispatcherOnEntry();
    const parsed = reviewPreparationStateSchema.safeParse(input);
    if (!parsed.success || new Set(parsed.data.requiredLanes).size !== parsed.data.requiredLanes.length) {
      return { ok: false, reason: 'invalid' };
    }
    const candidate: OperatorReviewState = { ...parsed.data, requiredLanes: [...parsed.data.requiredLanes],
      lanes: {}, sealedSyncOperationId: null, publication: null };
    return this.ctx.storage.transaction(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      if (!record?.executionContext || record.phase !== 'queued') return { ok: false, reason: 'not-admitted' } as const;
      if (!await this.boundaryCurrent(record) || record.drive?.status !== 'running'
        || record.drive.generation !== candidate.generation) {
        return { ok: false, reason: 'stale-generation' } as const;
      }
      if (record.executionContext.artifactDigest !== candidate.releaseDigest) return { ok: false, reason: 'invalid' } as const;
      if (record.review) return JSON.stringify(record.review) === JSON.stringify(candidate)
        ? { ok: true, state: structuredClone(record.review) } as const : { ok: false, reason: 'conflict' } as const;
      await tx.put<AdmissionState>('admission', { ...record, review: candidate });
      return { ok: true, state: structuredClone(candidate) } as const;
    });
  }

  /** Accept only a package-declared lane result for the exact current generation and head. */
  async recordReviewLane(generation: number, head: string, lane: string, resultDigest: string): Promise<OperatorReviewResult> {
    this.#resumeDispatcherOnEntry();
    if (!reviewLaneIdentity.safeParse(lane).success || !syncDigest.safeParse(resultDigest).success) {
      return { ok: false, reason: 'invalid' };
    }
    return this.ctx.storage.transaction(async tx => {
      const record = await tx.get<AdmissionState>('admission'); const review = record?.review;
      if (!record || !review) return { ok: false, reason: 'not-admitted' } as const;
      if (record.drive?.status !== 'running' || record.drive.generation !== generation
        || review.generation !== generation || review.head !== head) return { ok: false, reason: 'stale-generation' } as const;
      if (!review.requiredLanes.includes(lane)) return { ok: false, reason: 'invalid' } as const;
      const prior = review.lanes[lane];
      if (prior && prior.resultDigest !== resultDigest) return { ok: false, reason: 'conflict' } as const;
      const next = { ...review, lanes: { ...review.lanes, [lane]: { resultDigest } } };
      await tx.put<AdmissionState>('admission', { ...record, review: next });
      return { ok: true, state: structuredClone(next) } as const;
    });
  }

  /** Seal Review only after every declared lane and the existing sync operation are verified. */
  async sealReview(generation: number, head: string, operationId: string): Promise<OperatorReviewResult> {
    this.#resumeDispatcherOnEntry();
    if (!syncIdentity.safeParse(operationId).success) return { ok: false, reason: 'invalid' };
    return this.ctx.storage.transaction(async tx => {
      const record = await tx.get<AdmissionState>('admission'); const review = record?.review;
      if (!record || !review) return { ok: false, reason: 'not-admitted' } as const;
      if (record.drive?.status !== 'running' || record.drive.generation !== generation
        || review.generation !== generation || review.head !== head) return { ok: false, reason: 'stale-generation' } as const;
      if (review.requiredLanes.some(lane => !review.lanes[lane])) return { ok: false, reason: 'incomplete' } as const;
      if (record.syncOperations?.[operationId]?.phase !== 'verified') return { ok: false, reason: 'not-verified' } as const;
      if (review.sealedSyncOperationId && review.sealedSyncOperationId !== operationId) return { ok: false, reason: 'conflict' } as const;
      const next = { ...review, sealedSyncOperationId: operationId };
      await tx.put<AdmissionState>('admission', { ...record, review: next });
      return { ok: true, state: structuredClone(next) } as const;
    });
  }

  /** Reserve publication before GitHub I/O; changed payloads conflict and unknown work cannot be replayed. */
  async reserveReviewPublication(generation: number, head: string, operationId: string,
    requestDigest: string): Promise<OperatorReviewResult> {
    this.#resumeDispatcherOnEntry();
    if (!syncIdentity.safeParse(operationId).success || !syncDigest.safeParse(requestDigest).success) {
      return { ok: false, reason: 'invalid' };
    }
    return this.ctx.storage.transaction(async tx => {
      const record = await tx.get<AdmissionState>('admission'); const review = record?.review;
      if (!record || !review) return { ok: false, reason: 'not-admitted' } as const;
      if (record.drive?.status !== 'running' || record.drive.generation !== generation
        || review.generation !== generation || review.head !== head) return { ok: false, reason: 'stale-generation' } as const;
      if (!review.sealedSyncOperationId) return { ok: false, reason: 'incomplete' } as const;
      const existing = review.publication;
      if (existing) {
        if (existing.operationId !== operationId || existing.requestDigest !== requestDigest) return { ok: false, reason: 'conflict' } as const;
        if (existing.phase === 'unknown') return { ok: false, reason: 'unknown' } as const;
        return { ok: true, state: structuredClone(review) } as const;
      }
      const next = { ...review, publication: { operationId, requestDigest, phase: 'reserved' as const } };
      await tx.put<AdmissionState>('admission', { ...record, review: next });
      return { ok: true, state: structuredClone(next) } as const;
    });
  }

  async markReviewPublicationUnknown(generation: number, head: string, operationId: string,
    requestDigest: string): Promise<OperatorReviewResult> {
    this.#resumeDispatcherOnEntry();
    return this.updateReviewPublication(generation, head, operationId, requestDigest, 'unknown');
  }

  async completeReviewPublication(generation: number, head: string, operationId: string,
    requestDigest: string, receipt: { checkId: number; recordId: number }): Promise<OperatorReviewResult> {
    this.#resumeDispatcherOnEntry();
    if (!Number.isSafeInteger(receipt?.checkId) || receipt.checkId < 1
      || !Number.isSafeInteger(receipt?.recordId) || receipt.recordId < 1) return { ok: false, reason: 'invalid' };
    return this.updateReviewPublication(generation, head, operationId, requestDigest, 'completed', receipt, false);
  }

  /** Complete an unknown write only from an exact external reconciliation receipt. */
  async reconcileReviewPublication(generation: number, head: string, operationId: string,
    requestDigest: string, receipt: { checkId: number; recordId: number }): Promise<OperatorReviewResult> {
    this.#resumeDispatcherOnEntry();
    if (!Number.isSafeInteger(receipt?.checkId) || receipt.checkId < 1
      || !Number.isSafeInteger(receipt?.recordId) || receipt.recordId < 1) return { ok: false, reason: 'invalid' };
    return this.updateReviewPublication(generation, head, operationId, requestDigest, 'completed', receipt, true);
  }

  private async updateReviewPublication(generation: number, head: string, operationId: string, requestDigest: string,
    phase: 'completed' | 'unknown', receipt?: { checkId: number; recordId: number }, reconcileUnknown = false): Promise<OperatorReviewResult> {
    return this.ctx.storage.transaction(async tx => {
      const record = await tx.get<AdmissionState>('admission'); const review = record?.review; const publication = review?.publication;
      if (!record || !review || !publication) return { ok: false, reason: 'not-admitted' } as const;
      if (record.drive?.status !== 'running' || record.drive.generation !== generation
        || review.generation !== generation || review.head !== head) return { ok: false, reason: 'stale-generation' } as const;
      if (publication.operationId !== operationId || publication.requestDigest !== requestDigest) return { ok: false, reason: 'conflict' } as const;
      if (publication.phase === 'unknown' && !reconcileUnknown) return { ok: false, reason: 'unknown' } as const;
      if (publication.phase === 'completed') {
        return receipt && publication.receipt?.checkId === receipt.checkId && publication.receipt.recordId === receipt.recordId
          ? { ok: true, state: structuredClone(review) } as const : { ok: false, reason: 'conflict' } as const;
      }
      const next = { ...review, publication: { ...publication, phase, ...(receipt ? { receipt } : {}) } };
      await tx.put<AdmissionState>('admission', { ...record, review: next });
      return { ok: true, state: structuredClone(next) } as const;
    });
  }

  async getReviewState(): Promise<OperatorReviewState | null> {
    this.#resumeDispatcherOnEntry();
    const review = (await this.ctx.storage.get<AdmissionState>('admission'))?.review;
    return review ? structuredClone(review) : null;
  }

  /**
   * Reserve one durable generation before loading a child. Only waiting work may
   * resume; a running/unknown drive is never replayed based on isolate loss.
   * The parent binds the returned generation to its child capabilities.
   */
  async beginDrive(expectedGeneration?: number): Promise<OperatorDriveResult> {
    this.#resumeDispatcherOnEntry();
    const result = await this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      if (!record || record.phase !== 'queued') return { ok: false, reason: 'not-admitted' };
      if (!Number.isFinite(record.intent.deadline) || record.intent.deadline <= Date.now()
        || !await this.boundaryCurrent(record)) {
        return { ok: false, reason: 'authority-expired' };
      }
      if (record.drive?.status === 'waiting') this.#recordDiagnostic(record.drive.generation, 'continuation', 'started');
      if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration)
        || expectedGeneration < 1 || record.drive?.status !== 'waiting'
        || record.drive.generation !== expectedGeneration
        || record.webhook?.continuedGeneration !== expectedGeneration)) {
        return { ok: false, reason: 'stale-drive' };
      }
      if (record.drive?.status === 'running') return { ok: false, reason: 'drive-active' };
      if (record.drive && record.drive.status !== 'waiting') return { ok: false, reason: 'drive-settled' };
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (lease && (lease.hosting === 'normal' ? !this.#normalSettlementObserved(lease) : !lease.sdkReleased)) return { ok: false, reason: 'drive-active' };
      const state: OperatorDriveState = {
        generation: (record.drive?.generation ?? 0) + 1, status: 'running',
        checkpoint: record.drive?.checkpoint ?? null, result: null,
      };
      await tx.put<AdmissionState>('admission', { ...record, drive: state, updatedAt: Date.now() });
      return { ok: true, state };
    });
    if (result.ok) await this.publishBrowserSummary();
    return result;
  }

  /** Generic child-effect fence for the exact admitted, live generation. */
  async operatorGenerationCurrent(generation: number): Promise<boolean> {
    this.#resumeDispatcherOnEntry();
    if (!Number.isSafeInteger(generation) || generation < 1) return false;
    const record = await this.ctx.storage.get<AdmissionState>('admission');
    return !!record && record.phase === 'queued' && record.intent.deadline > Date.now()
      && record.drive?.status === 'running' && record.drive.generation === generation
      && await this.boundaryCurrent(record);
  }

  /** Parent-only Conductor recovery metadata; does not settle work or revoke owned cleanup. */
  async recordConductorPiAuthFailure(generation: number, profileDigest: string, value: unknown): Promise<boolean> {
    this.#resumeDispatcherOnEntry();
    const failure = safePiAuthFailure(value);
    if (!failure || !Number.isSafeInteger(generation) || generation < 1) return false;
    const recorded = await this.ctx.storage.transaction(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state || state.phase !== 'queued' || state.intent.deadline <= Date.now()
        || state.drive?.status !== 'running' || state.drive.generation !== generation
        || !state.receipt || !isManagementReceipt(state.receipt)
        || state.receipt.selection.operator.profile !== 'conductor'
        || !state.inferenceSelection || state.inferenceSelection.profileDigest !== profileDigest
        || state.inferenceSelection.provider !== failure.provider || !await this.boundaryCurrent(state)) return false;
      if (state.authFailure) return JSON.stringify(state.authFailure) === JSON.stringify(failure);
      await tx.put<AdmissionState>('admission', { ...state, authFailure: failure, updatedAt: Date.now() });
      return true;
    });
    if (recorded) await this.publishBrowserSummary();
    return recorded;
  }

  /** Parent-only checkpoint read for the live generation; browser projections do not grant execution authority. */
  async getCurrentDriveCheckpointJson(generation: number): Promise<string | null> {
    this.#resumeDispatcherOnEntry();
    if (!await this.operatorGenerationCurrent(generation)) return null;
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (state?.drive?.status !== 'running' || state.drive.generation !== generation
      || state.drive.checkpoint === null) return null;
    const encoded = JSON.stringify(state.drive.checkpoint);
    return typeof encoded === 'string' ? encoded : null;
  }

  /** Validate bounded child output before committing the current generation only. */
  async commitDrive(generation: number, update: unknown): Promise<OperatorDriveResult> {
    this.#resumeDispatcherOnEntry();
    let parsed: z.infer<typeof driveUpdateSchema>;
    try {
      const admission = await this.ctx.storage.get<AdmissionState>('admission');
      const receipt = admission?.receipt;
      const dispatcher = receipt && isManagementReceipt(receipt) && receipt.selection.operator.profile === 'dispatcher';
      const limits = dispatcherCapacities(dispatcher ? receipt.selection.operator.policy : undefined);
      const lease = dispatcher ? await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE) : undefined;
      const result = driveUpdateSchema.safeParse(update);
      if (!result.success) return { ok: false, reason: 'invalid-update' };
      parsed = result.data;
      // SDK settlement owns its assessment allowance, not the non-SDK response envelope.
      const sdkSettlement = lease?.generation === generation;
      const json = JSON.stringify(sdkSettlement ? { ...parsed, result: null } : parsed);
      if (new TextEncoder().encode(json).byteLength > (sdkSettlement || !dispatcher ? 64 * 1024 : limits.driveResponseBytes)
        || (sdkSettlement && new TextEncoder().encode(JSON.stringify(parsed.result ?? null)).byteLength > limits.assessmentBytes)) {
        return { ok: false, reason: 'invalid-update' };
      }
    } catch {
      return { ok: false, reason: 'invalid-update' };
    }
    const committed = await this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      if (!record || record.phase !== 'queued') return { ok: false, reason: 'not-admitted' };
      if (!Number.isFinite(record.intent.deadline) || record.intent.deadline <= Date.now()
        || !await this.boundaryCurrent(record)) {
        return { ok: false, reason: 'authority-expired' };
      }
      if (record.drive?.status !== 'running' || record.drive.generation !== generation) {
        return { ok: false, reason: 'stale-drive' };
      }
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (lease && lease.generation === generation) {
        const journal = await loadDispatcherJournal(tx, generation);
        if (lease.status !== 'running' || lease.expiresAt <= Date.now()
          || !lease.submissionId || lease.settledSubmissionId !== lease.submissionId
          || (lease.serial ? !await this.#serialJournalAccounted(tx, lease, parsed.result) : journal.unresolved !== 0)) {
          return { ok: false, reason: 'invalid-update' };
        }
        await tx.put(DISPATCHER_LEASE, { ...lease, status: parsed.status === 'waiting' || parsed.status === 'completed' ? 'settled' : 'unknown',
          ...(lease.serial && parsed.status === 'completed' ? { terminalAt: lease.terminalAt ?? Date.now() } : {}) });
      }
      const state: OperatorDriveState = {
        generation, status: parsed.status, checkpoint: parsed.checkpoint, result: parsed.result ?? null,
      };
      await tx.put<AdmissionState>('admission', { ...record, drive: state, updatedAt: Date.now() });
      return { ok: true, state };
    });
    if (committed.ok) {
      await this.#releaseDispatcherSdk();
      await this.publishBrowserSummary();
    }
    return committed;
  }

  /** Fence future commits, then retire owned intent4 compute without recreating it. */
  async cancelDrive(): Promise<OperatorDriveResult> {
    this.#resumeDispatcherOnEntry();
    let result = await this.fenceDrive('cancel-requested');
    if (!result.ok && result.reason === 'drive-settled') {
      const [record, lease] = await Promise.all([
        this.ctx.storage.get<AdmissionState>('admission'), this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE),
      ]);
      // Historical cleanup can only finish this cancellation. Normal installation abort may
      // additionally stop its exact already-fenced unknown job; neither path resumes work,
      // grants authority, settles a result or acquires a runtime.
      if (record?.phase === 'queued' && (record.drive?.status === 'cancel-requested'
        || record.drive?.status === 'unknown' && lease?.hosting === 'normal')
        && (lease?.serial || lease?.hosting === 'normal') && (lease.status === 'unknown' || lease.status === 'settled')
        && record.drive.generation === lease.generation + 1
        && lease.inputDigest === record.receipt?.intentDigest
        && lease.artifactDigest === record.executionContext?.artifactDigest) {
        result = { ok: true, state: structuredClone(record.drive) };
      }
    }
    if (result.ok) {
      const dispatcher = this.#dispatcher;
      this.#dispatcher = undefined;
      const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (lease?.hosting === 'normal') {
        await this.#abortNormalDispatcher(lease);
        await this.publishBrowserSummary();
        return result;
      }
      // A previous bookkeeping receipt cannot substitute for actual shutdown.
      // cancel-requested cannot begin another drive while this abort completes.
      if (lease?.serial && lease.sdkReleased) this.abortDispatcherFacet('Dispatcher generation retired');
      await this.#releaseDispatcherSdk();
      await this.publishBrowserSummary();
      if (lease && !lease.serial && dispatcher?.generation === lease.generation) {
        // Abort delivery may use the cached connection, never acquire a replacement.
        // Delivery is not proof of stopped compute.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([(async () => {
            const response = await (await dispatcher.facet).fetch(new Request(
              'https://flue.internal/agents/Dispatcher/dispatcher/abort', { method: 'POST' }));
            void response.body?.cancel().catch(() => {});
          })(), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
        } catch { /* generation remains fenced even when abort delivery is unavailable */ }
        finally { clearTimeout(timer); }
      }
    }
    return result;
  }

  /** Parent reports an interrupted drive; its uncertain effects cannot be replayed. */
  async interruptDrive(generation: number, failure?: FailureObservation): Promise<OperatorDriveResult> {
    this.#resumeDispatcherOnEntry();
    const result = await this.fenceDrive('unknown', generation, false, failure);
    if (result.ok) {
      await this.#releaseDispatcherSdk();
      await this.publishBrowserSummary();
    }
    return result;
  }

  /** Fence a queued request whose one attached runtime attempt failed before loading code. */
  async fenceRuntimeFailure(expectedGeneration?: number, failure?: FailureObservation): Promise<OperatorDriveResult> {
    this.#resumeDispatcherOnEntry();
    const result = await this.fenceDrive('unknown', expectedGeneration, true, failure ?? { boundary: 'artifact', code: 'artifact-unavailable' });
    if (result.ok) {
      await this.#releaseDispatcherSdk();
      await this.publishBrowserSummary();
    }
    return result;
  }

  private async fenceDrive(status: 'cancel-requested' | 'unknown', generation?: number,
    allowWaiting = false, failure?: FailureObservation): Promise<OperatorDriveResult> {
    let originalGeneration: number | undefined;
    let reason: FenceReason | undefined;
    const result = await this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      if (!record || record.phase !== 'queued') return { ok: false, reason: 'not-admitted' };
      if (generation !== undefined && (record.drive?.generation !== generation
        || (record.drive.status !== 'running' && !(allowWaiting && record.drive.status === 'waiting')))) {
        return { ok: false, reason: 'stale-drive' };
      }
      if (record.drive && record.drive.status !== 'running' && record.drive.status !== 'waiting') {
        return { ok: false, reason: 'drive-settled' };
      }
      const state: OperatorDriveState = {
        generation: (record.drive?.generation ?? 0) + 1, status,
        checkpoint: record.drive?.checkpoint ?? null, result: record.drive?.result ?? null,
      };
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      originalGeneration = lease?.generation ?? record.drive?.generation ?? 0;
      const expired = record.intent.deadline <= Date.now() || !!lease && lease.expiresAt <= Date.now();
      reason = { generation: originalGeneration, timestamp: Date.now(), boundary: status === 'cancel-requested' || expired ? 'fence'
        : failure?.boundary ?? 'platform', code: status === 'cancel-requested' ? 'cancelled' : expired ? 'deadline-expired'
          : failure?.code ?? 'platform-evidence-required', uncertain: status === 'unknown' };
      // Essential reason shares the authoritative fence transaction, independent of logging/optional ledger.
      const preLeaseBinding = !lease && record.receipt && isManagementReceipt(record.receipt)
        && record.receipt.selection.operator.profile === 'dispatcher' && record.executionContext
        ? { generation: originalGeneration, artifactDigest: record.executionContext.artifactDigest, inputDigest: record.receipt.intentDigest } : undefined;
      await tx.put<AdmissionState>('admission', { ...record, drive: state, diagnosticFence: reason,
        ...(preLeaseBinding ? { diagnosticsVersion: 1, diagnosticBinding: preLeaseBinding } : {}), updatedAt: Date.now() });
      if (lease && lease.status !== 'settled') await tx.put(DISPATCHER_LEASE, { ...lease, status: 'unknown' });
      return { ok: true, state };
    });
    if (result.ok) {
      for (const flight of this.#inferenceFlights.values()) flight.controller.abort();
      for (const flight of this.#nativeFlights.values()) flight.controller.abort();
      for (const controller of this.#sdkHttpControllers) controller.abort();
      this.#nativeBindings.clear();
      if (originalGeneration !== undefined && reason) {
        this.#enqueueDiagnostic(async () => {
          await this.ctx.storage.transaction(async tx => {
            const record = await tx.get<AdmissionState>('admission');
            if (record?.diagnosticBinding && !await tx.get(DISPATCHER_LEASE)) await initializeDiagnostics(tx, record.diagnosticBinding, false);
          });
        });
        if (failure?.error) this.#recordDiagnostic(originalGeneration, failure.boundary, 'failed', failure.code,
          undefined, {}, 'host', undefined, failure.error);
        this.#recordDiagnostic(originalGeneration, reason.boundary, 'unknown', reason.code, undefined, {}, 'host', reason.generation);
      }
    }
    return result;
  }

  /** REQ-OPERATOR-048: bind one already-reserved drive to immutable code/input and one Flue submission. */
  async admitDispatcher(generation: number, bundle: DispatcherBundle, artifactDigest: string,
    invocation: unknown): Promise<OperatorDriveResult> {
    this.#resumeDispatcherOnEntry();
    let trace: InferenceDiagnosticContext | undefined;
    let boundary = 'authority';
    let leaseCommitted = false;
    try {
      const plan = await this.getRuntimePlan();
      if (plan) trace = { activityId: plan.activityId, generation, loggingEnabled: executionLoggingEnabled(plan.receipt) };
      boundary = 'artifact';
      if (!plan || !isManagementReceipt(plan.receipt) || plan.receipt.selection.operator.profile !== 'dispatcher'
        || artifactDigest !== plan.receipt.selection.release.bundleDigest
        || artifactDigest !== plan.executionContext.artifactDigest
        || JSON.stringify(invocation) !== plan.invocationJson) throw new Error('Dispatcher pin mismatch');
      const bytes = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').getManagementBundle(artifactDigest);
      if (!bytes) throw new Error('Dispatcher artifact unavailable');
      const approved = await parseDispatcherBundle(bytes, artifactDigest);
      if (JSON.stringify(approved) !== JSON.stringify(bundle)
        || approved.sourceCommit !== plan.receipt.selection.release.sourceCommit) throw new Error('Dispatcher artifact mismatch');
      boundary = 'authority';
      await authorizeDispatcherPlan(plan, this.#appEnv);
      const descriptor = JSON.parse(plan.receipt.selection.manifestJson);
      const serial = plan.receipt.selection.release.intentVersion === '4'
        && descriptor?.id === 'renovate-dispatcher' && descriptor.profile === 'dispatcher' && descriptor.intentVersion === '4';
      if (serial && (JSON.parse(plan.invocationJson).pullRequest !== undefined
        || dispatcherCapacities(plan.receipt.selection.operator.policy).assessmentBytes < DISPATCHER_JOURNEY_RESULT_BYTES)) {
        // This package reserves48KiB before decisions. Refuse incompatible admission BEFORE
        // any SDK/model/effect; never validate a smaller allowance only after effects.
        throw new Error('Dispatcher phase output allowance incompatible');
      }
      inferenceDiagnostic(trace, { stage: 'drive', outcome: 'observed', boundary });
      inferenceDiagnostic(trace, { stage: 'drive', outcome: 'started', operationLimit: dispatcherOperationLimit(plan.receipt.selection.operator.policy), inferenceRequestBytes: inferenceRequestBytes(plan.receipt.selection.operator.policy) }, () => ({ invocation }));
      const attemptLimit = inferenceAttemptLimit(plan.receipt.selection.operator.policy);
      const sdkProvenance = readSdkProvenance(approved);
      const normal = approved.schemaVersion === 2 && approved.hosting?.kind === 'normal';
      const lease: DispatcherLease = { generation, artifactDigest, inputDigest: plan.receipt.intentDigest,
        expiresAt: Math.floor(plan.deadline / 1000) * 1000,
        submissionId: null, status: 'admitting',
        ...(sdkProvenance ? { sdkProvenance } : {}),
        ...(serial ? { serial: createDispatcherPhaseState('submission', await sha256(JSON.stringify(plan.receipt)),
          { deliveryToken: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }) } : {}) };
      if (normal) {
        lease.hosting = 'normal';
        const connection = await this.#normalDispatcherConnection(lease, plan);
        const { connectionSecretCiphertext: _secret, ...deployment } = connection;
        lease.deployment = deployment;
        lease.connectionSecretCiphertext = connection.connectionSecretCiphertext;
        // Freeze the original deployment before the App resolves its SDK profile. Only
        // bounded config/auth reads may use this envelope; it grants no model authority.
        await this.ctx.storage.transaction(async tx => {
          const state = await tx.get<AdmissionState>('admission');
          const previous = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (state?.phase !== 'queued' || state.drive?.status !== 'running' || state.drive.generation !== generation
            || lease.expiresAt <= Date.now() || (previous && (previous.status !== 'settled' || previous.generation !== generation - 1))) {
            throw new Error('Dispatcher profile owner unavailable');
          }
          await tx.put(DISPATCHER_PROFILE_LEASE, lease);
        });
        // The installed App, not a Host, resolves its public SDK model profile.
        const inference = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (inference.inferencePolicies.every(policy => policy.capabilities.includes('inference'))) {
          const profileInput = { generation, plan, env: this.#appEnv, connection,
            waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise), current: () => this.operatorGenerationCurrent(generation) };
          const selection = await discoverDispatcherOwnerProfile(profileInput);
          if (plan.configuredSelection && !sameDispatcherPhaseValue(plan.configuredSelection, selection)) throw new Error('Normal Dispatcher selection changed');
          lease.configuredSelection = selection;
        }
        const { admittedTarget } = await authorizeDispatcherPlan(plan, this.#appEnv);
        lease.wire = this.#normalDispatcherWire(lease, plan, {
          activityId: plan.activityId, generation, input: JSON.parse(plan.invocationJson),
          settings: { githubApiOrigin: dispatcherGithubApiOrigin(this.#appEnv),
            sourceResponseBytes: sourceResponseBytes(plan.receipt.selection.installation.policy),
            loggingEnabled: executionLoggingEnabled(plan.receipt),
            submissionAttemptLimit: submissionAttemptLimit(plan.receipt.selection.operator.policy),
            assessmentBytes: dispatcherCapacities(plan.receipt.selection.operator.policy).assessmentBytes,
            ...(admittedTarget ? { admittedTarget: JSON.stringify(admittedTarget) } : {}) },
          ...(lease.configuredSelection ? { selection: lease.configuredSelection } : {}),
          run: { deadline: new Date(lease.expiresAt).toISOString(), inputDigest: lease.inputDigest,
            releaseDigest: lease.artifactDigest },
        });
      }
      boundary = 'lease';
      await this.ctx.storage.transaction(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const previous = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (record?.drive?.status !== 'running' || record.drive.generation !== generation
          || lease.expiresAt <= Date.now() || (previous && (previous.status !== 'settled' || previous.generation !== generation - 1))) {
          throw new Error('Dispatcher generation unavailable');
        }
        const journal = await loadDispatcherJournal(tx, previous?.generation ?? generation);
        if (journal.unresolved !== 0) throw new Error('Unresolved Dispatcher journal');
        if (record.inferenceRecoveryVersion === 1) lease.inferenceRecovery = {
          version: 1, attemptLimit,
        };
        await tx.put(DISPATCHER_LEASE, lease);
        await tx.delete(DISPATCHER_PROFILE_LEASE);
        await tx.put('admission', { ...record, diagnosticsVersion: 1,
          ...(lease.hosting === 'normal' && lease.configuredSelection ? { configuredSelection: lease.configuredSelection } : {}) });
        // Old completed entries remain isolated; a continued generation reserves its own reads.
        await tx.put<DispatcherJournal>(DISPATCHER_JOURNAL, { generation, count: 0, nextOrdinal: 0, unresolved: 0 });
      });
      leaseCommitted = true;
      this.#enqueueDiagnostic(async () => {
        await this.ctx.storage.transaction(tx => initializeDiagnostics(tx, lease, !!lease.sdkProvenance));
      });
      this.#recordDiagnostic(generation, 'artifact', 'accepted');
      this.#recordDiagnostic(generation, 'admission', 'accepted');
      // SDK scheduling owns the physical alarm; this is a one-shot deadline, not a new scheduler.
      boundary = 'scheduling';
      await this.schedule(new Date(lease.expiresAt), 'reconcileDispatcherLease', { generation }, { idempotent: true });
      this.#recordDiagnostic(generation, 'scheduling', 'completed');
      if (lease.hosting === 'normal') {
        try { await this.#admitNormalDispatcher(lease); }
        catch (error) {
          // The original key/wire is already durable. A lost ack cannot authorize replacement work.
          this.#recordDiagnostic(generation, 'submission', 'failed', 'submission-failed', error);
        }
        if (!await this.dispatcherGenerationCurrent(generation)) return this.interruptDrive(generation);
        await this.#scheduleDispatcherRecheck(lease);
        const record = await this.ctx.storage.get<AdmissionState>('admission');
        return record?.drive?.generation === generation && record.drive.status === 'running'
          ? { ok: true, state: record.drive } : { ok: false, reason: 'stale-drive' };
      }
      if (lease.serial) {
        // Lost admission acknowledgement leaves THIS persisted identity eligible for reattachment.
        // It neither invents an SDK receipt nor replaces a submission.
        try { await this.#admitDispatcherPhase(generation, lease.serial.current.deliveryToken, approved); }
        catch (error) { this.#recordDiagnostic(generation, 'submission', 'failed', 'submission-failed', error); /* Same keyed recovery, never effects. */ }
        if (!await this.dispatcherGenerationCurrent(generation)) return this.interruptDrive(generation);
        await this.#scheduleDispatcherRecheck(lease);
        const record = await this.ctx.storage.get<AdmissionState>('admission');
        return record?.drive?.generation === generation && record.drive.status === 'running'
          ? { ok: true, state: record.drive } : { ok: false, reason: 'stale-drive' };
      }
      const admitted = await this.#boundedDispatcher(lease, async () => {
        boundary = 'loader';
        const child = await this.#dispatcherFacet(lease, approved);
        inferenceDiagnostic(trace, { stage: 'drive', outcome: 'observed', boundary });
        boundary = 'admission';
        const response = await child.fetch(new Request('https://flue.internal/agents/Dispatcher/dispatcher', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'user', body: plan.invocationJson }),
        }));
        inferenceDiagnostic(trace, { stage: 'drive', outcome: 'observed', boundary, status: response.status });
        if (response.status !== 202) throw new Error('Dispatcher admission failed');
        const value = JSON.parse(await readDispatcherBody(response));
        if (typeof value?.submissionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.submissionId)) {
          throw new Error('Dispatcher admission receipt invalid');
        }
        boundary = 'cursor';
        const offset = response.headers.get('stream-next-offset') ?? value.offset;
        if (typeof offset !== 'string' || !offset || offset.length > 2048) throw new Error('Dispatcher admission cursor invalid');
        return { submissionId: value.submissionId as string, offset, response,
          ...(typeof value.uid === 'string' && value.uid.length > 0 && value.uid.length <= 512 ? { rootUid: value.uid } : {}) };
      });
      boundary = 'commit';
      const result = await this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!this.#leaseMatches(record, current, generation) || current!.status !== 'admitting') {
          return { ok: false, reason: 'stale-drive' };
        }
        await tx.put<DispatcherLease>(DISPATCHER_LEASE, { ...current!, submissionId: admitted.submissionId,
          ...(admitted.rootUid ? { rootDigest: hashDiagnostic(admitted.rootUid) } : {}),
          projection: { offset: admitted.offset, messageIds: [], writes: 0 }, status: 'running' });
        return { ok: true, state: record!.drive! };
      });
      if (!result.ok) return this.interruptDrive(generation);
      inferenceDiagnostic(trace, { stage: 'drive', outcome: 'completed', boundary });
      this.#recordDiagnostic(generation, 'submission', 'accepted');
      this.#observeSdkHeader(generation, admitted.response);
      return result;
    } catch (error) {
      const metadata = captureError(error);
      const family: Boundary = boundary === 'artifact' ? 'artifact' : boundary === 'loader' ? 'construction'
        : boundary === 'scheduling' ? 'scheduling' : ['admission', 'cursor', 'commit'].includes(boundary) ? 'submission' : 'admission';
      const code: ReasonCode = family === 'artifact' ? (error instanceof Error && error.message === 'Dispatcher artifact unavailable'
        ? 'artifact-unavailable' : 'artifact-mismatch') : family === 'construction' ? 'startup-failed'
          : family === 'submission' ? 'submission-failed' : family === 'scheduling' ? 'unclassified' : 'authority-denied';
      // Before a lease commits, fenceDrive initializes the ledger before recording
      // this failure. Keep the existing post-lease observation, even if fencing declines.
      if (leaseCommitted) this.#recordDiagnostic(generation, family, 'failed', code,
        undefined, {}, 'host', undefined, metadata);
      inferenceDiagnostic(trace, { stage: 'drive', outcome: 'failed', boundary }, () => error);
      return this.interruptDrive(generation, { boundary: family, code, error: metadata });
    }
  }

  /** Compare current platform deployment with the admitted release and original connection pins. */
  async #normalDispatcherConnection(lease: DispatcherLease, plan: OperatorRuntimePlan): Promise<NormalDispatcherConnection> {
    if (!isManagementReceipt(plan.receipt) || plan.receipt.selection.operator.profile !== 'dispatcher') {
      throw new Error('Normal Dispatcher installation unavailable');
    }
    const { installation, release } = plan.receipt.selection;
    const connection = await installedDispatcherConnection(this.#appEnv, installation.id);
    if (connection.releaseId !== release.id || installation.releaseId !== release.id
      || connection.bundleDigest !== release.bundleDigest || connection.bundleDigest !== lease.artifactDigest
      || connection.manifestDigest !== release.manifestDigest || connection.sourceCommit !== release.sourceCommit
      || connection.compilerCommit !== release.provenance?.compilerCommit) throw new Error('Normal Dispatcher deployment mismatch');
    const { connectionSecretCiphertext: _secret, ...deployment } = connection;
    if (lease.deployment && (!sameDispatcherPhaseValue(lease.deployment, deployment)
      || lease.connectionSecretCiphertext !== connection.connectionSecretCiphertext)) throw new Error('Normal Dispatcher connection changed');
    return connection;
  }

  #normalDispatcherWire(lease: DispatcherLease, plan: OperatorRuntimePlan, initialData?: unknown): NormalDispatcherWire {
    if (!lease.deployment) throw new Error('Normal Dispatcher deployment missing');
    const serialWire = lease.serial ? dispatcherPhaseWire(lease.serial, this.#phaseAuthority(lease, plan)) : undefined;
    const wire: NormalDispatcherWire = {
      id: `${plan.activityId}-g${lease.generation}`, installationId: lease.deployment.installationId,
      activityId: plan.activityId, generation: lease.generation, releaseId: lease.deployment.releaseId,
      connectionRevision: lease.deployment.connectionRevision, workerVersionId: lease.deployment.workerVersionId,
      idempotencyKey: serialWire?.idempotencyKey ?? crypto.randomUUID(),
      message: serialWire ? { kind: serialWire.kind, type: serialWire.type, body: serialWire.body, attributes: serialWire.attributes }
        : { kind: 'user', body: plan.invocationJson },
    };
    if (serialWire?.uid) wire.uid = serialWire.uid;
    else if (initialData !== undefined) wire.initialData = initialData;
    return wire;
  }

  /** Only application HTTP is used here. Redirects never receive installation authorization. */
  async #normalDispatcherControl(lease: DispatcherLease, plan: OperatorRuntimePlan,
    action: 'dispatch' | 'read' | 'abort'): Promise<{ status: number; value: unknown }> {
    // Live metadata gates new admission/read authority, but never replaces the original transport.
    // Abort exclusively uses the frozen installation connection, even if live rotation is unverified/disabled.
    if (action !== 'abort') await this.#normalDispatcherConnection(lease, plan);
    const connection = normalDispatcherConnectionSchema.parse({ ...lease.deployment,
      connectionSecretCiphertext: lease.connectionSecretCiphertext });
    if (!lease.wire) throw new Error('Normal Dispatcher original wire missing');
    const secret = await openOperatorSecret(connection.connectionSecretCiphertext, this.#appEnv,
      { purpose: 'connection', recordId: connection.installationId });
    const { id, installationId, activityId, generation, releaseId, connectionRevision, workerVersionId } = lease.wire;
    const body = action === 'dispatch' ? lease.wire : { id, installationId, activityId, generation,
      releaseId, connectionRevision, workerVersionId, ...(lease.receipt ? { receipt: lease.receipt } : {}) };
    const policy = isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined;
    const limits = dispatcherCapacities(policy);
    // Abort remains deliverable after the original run fence/expiry; it grants no new work.
    const remaining = action === 'abort' ? 1000 : Math.min(limits.driveTimeoutMs, lease.expiresAt - Date.now());
    if (remaining <= 0) throw new Error('Normal Dispatcher lease expired');
    const signal = AbortSignal.timeout(Math.max(1, remaining));
    const trace = { activityId, generation, loggingEnabled: executionLoggingEnabled(plan.receipt), credentials: [secret] };
    emitRaw(trace, 'dispatcher-control-request', () => ({ action, body }));
    let response: Response;
    try {
      response = await fetch(new Request(`${connection.controlOrigin}/control/${action}`, {
        method: 'POST', redirect: 'manual', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
      }));
    } catch (error) {
      emitRaw(trace, 'dispatcher-control-failure', () => error);
      throw new NormalDispatcherObservationUnavailable('Normal Dispatcher observation unavailable');
    }
    if (action !== 'abort' && response.status >= 500) {
      void response.body?.cancel().catch(() => {});
      throw new NormalDispatcherObservationUnavailable('Normal Dispatcher control acknowledgement unavailable');
    }
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
      || ![200, 202].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Normal Dispatcher control rejected');
    }
    // SDK public reply data is a named-array map. Preserve original bytes until validated;
    // result allowance and the small wire envelope are bounded independently of source/inference.
    let bodyText: string;
    try { bodyText = await readDispatcherBody(response, signal, action === 'read' ? limits.assessmentBytes + 64 * 1024 : 4096); }
    catch (error) {
      emitRaw(trace, 'dispatcher-control-body-failure', () => error);
      if (signal.aborted) throw new NormalDispatcherObservationUnavailable('Normal Dispatcher observation timed out');
      throw error;
    }
    emitRaw(trace, 'dispatcher-control-response', () => ({ status: response.status, headers: response.headers, body: bodyText }));
    return { status: response.status, value: JSON.parse(bodyText) as unknown };
  }

  async #normalDispatcherCurrent(lease: DispatcherLease): Promise<OperatorRuntimePlan> {
    const plan = await this.getRuntimePlan();
    if (!plan || !await this.dispatcherGenerationCurrent(lease.generation)) throw new Error('Normal Dispatcher authority unavailable');
    await authorizeDispatcherPlan(plan, this.#appEnv);
    await this.#normalDispatcherConnection(lease, plan);
    const live = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!await this.dispatcherGenerationCurrent(lease.generation) || live?.hosting !== 'normal'
      || !sameDispatcherPhaseValue(live.wire, lease.wire) || !sameDispatcherPhaseValue(live.receipt, lease.receipt)) {
      throw new Error('Normal Dispatcher authority changed');
    }
    return plan;
  }

  /** Admission/recovery replays only the durable original wire and adopts the actual SDK receipt. */
  async #admitNormalDispatcher(lease: DispatcherLease): Promise<void> {
    if (lease.hosting !== 'normal' || !lease.wire) throw new Error('Normal Dispatcher admission unavailable');
    const key = `normal:${lease.generation}:${lease.wire.idempotencyKey}`;
    const existing = this.#phaseAdmissions.get(key);
    if (existing) return existing;
    const flight = (async () => {
      const current = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (current?.receipt && sameDispatcherPhaseValue(current.wire, lease.wire)) return;
      const plan = await this.#normalDispatcherCurrent(lease);
      const response = await this.#normalDispatcherControl(lease, plan, 'dispatch');
      if (response.status !== 202) throw new Error('Normal Dispatcher admission invalid');
      const receipt = normalDispatcherReceiptSchema.parse(response.value);
      if (lease.wire!.uid !== undefined && receipt.uid !== lease.wire!.uid) throw new Error('Normal Dispatcher incarnation changed');
      await this.#normalDispatcherCurrent(lease);
      await this.ctx.storage.transaction(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!this.#leaseMatches(record, live, lease.generation) || live!.hosting !== 'normal'
          || !sameDispatcherPhaseValue(live!.wire, lease.wire)) throw new Error('Stale normal Dispatcher admission');
        if (live!.receipt) {
          if (!this.#normalReceiptMatches(live!.receipt, receipt)) throw new Error('Normal Dispatcher receipt conflict');
          return;
        }
        const serial = live!.serial ? bindNormalDispatcherPhaseReceipt(live!.serial, this.#phaseAuthority(live!, plan),
          live!.serial.current.deliveryToken, receipt) : undefined;
        await tx.put<DispatcherLease>(DISPATCHER_LEASE, { ...live!, receipt, status: 'running',
          submissionId: receipt.submissionId, rootDigest: hashDiagnostic(receipt.uid), ...(serial ? { serial } : {}) });
      });
      this.#recordDiagnostic(lease.generation, 'submission', 'accepted');
    })().finally(() => { if (this.#phaseAdmissions.get(key) === flight) this.#phaseAdmissions.delete(key); });
    this.#phaseAdmissions.set(key, flight);
    return flight;
  }

  /** Public settlement, not SDK bookkeeping release; committed SDK storage remains retained. */
  #normalSettlementObserved(lease: DispatcherLease): boolean {
    return lease.hosting === 'normal' && lease.status === 'settled' && !!lease.receipt
      && lease.submissionId === lease.receipt.submissionId && lease.settledSubmissionId === lease.submissionId;
  }

  #normalReceiptMatches(expected: NormalDispatcherReceipt, value: NormalDispatcherReceipt): boolean {
    // deduplicated describes this admission delivery, not a different submission/incarnation.
    return expected.submissionId === value.submissionId && expected.uid === value.uid && expected.acceptedAt === value.acceptedAt;
  }

  /** Abort records SDK intent only. Never touch SDK rows, acquire a facet or claim release. */
  async #abortNormalDispatcher(lease: DispatcherLease): Promise<void> {
    if (lease.abortIntentRecorded) return;
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state?.executionContext || !state.receipt || lease.inputDigest !== state.receipt.intentDigest
      || lease.artifactDigest !== state.executionContext.artifactDigest) throw new Error('Normal Dispatcher abort unavailable');
    // Closing authority cannot prevent stopping that exact original job. This read grants no effects,
    // profile resolution, new dispatch or observation settlement, even after human/session expiry.
    const plan: OperatorRuntimePlan = { activityId: state.intent.activityId, deadline: state.intent.deadline,
      invocationJson: state.invocationJson ?? 'null', receipt: state.receipt, executionContext: state.executionContext };
    const response = await this.#normalDispatcherControl(lease, plan, 'abort');
    if (response.status !== 202 || !z.strictObject({ status: z.literal('intent-recorded') }).safeParse(response.value).success) {
      throw new Error('Normal Dispatcher abort unavailable');
    }
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (current?.hosting === 'normal' && current.generation === lease.generation
        && sameDispatcherPhaseValue(current.wire, lease.wire)) await tx.put(DISPATCHER_LEASE, { ...current, abortIntentRecorded: true });
    });
  }

  /** Receiver-side authorization after legitimate same-origin redeploy or connection rotation.
   * An original installation credential can only finish an already fenced original abort, never fence or start work.
   */
  async dispatcherAbortAuthority(generation: number, request: Request): Promise<Response> {
    try {
      const binding = await authenticateInstalledDispatcher(this.#appEnv, request);
      if (new URL(request.url).pathname !== '/v1/dispatcher/abort-authority' || binding.generation !== generation) throw new Error('Denied');
      const raw = JSON.parse(await readDispatcherBody(request, request.signal, 4096));
      const input = z.strictObject({ id: z.string(), installationId: z.string(), activityId: z.string(), generation: z.number(),
        releaseId: z.string(), connectionRevision: z.number(), workerVersionId: z.string(), receipt: normalDispatcherReceiptSchema.optional() }).parse(raw);
      const state = await this.ctx.storage.get<AdmissionState>('admission');
      const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!state?.receipt || !state.executionContext || lease?.hosting !== 'normal' || !lease.wire || !lease.deployment
        || lease.generation !== generation || binding.activityId !== state.intent.activityId
        || !['cancel-requested', 'unknown'].includes(state.drive?.status ?? '') || state.drive?.generation !== generation + 1
        || lease.status !== 'unknown' || lease.artifactDigest !== state.executionContext.artifactDigest
        || lease.inputDigest !== state.receipt.intentDigest || lease.connectionSecretCiphertext !== binding.connection.connectionSecretCiphertext
        || !sameDispatcherPhaseValue(lease.deployment, (({ connectionSecretCiphertext: _secret, ...metadata }) => metadata)(binding.connection))) {
        throw new Error('Denied');
      }
      const { id, installationId, activityId, generation: originalGeneration, releaseId, connectionRevision, workerVersionId } = lease.wire;
      const { receipt: _receipt, ...identity } = input;
      if (!sameDispatcherPhaseValue({ id, installationId, activityId, generation: originalGeneration, releaseId, connectionRevision, workerVersionId },
        identity) || (lease.receipt ? !input.receipt || !this.#normalReceiptMatches(lease.receipt, input.receipt) : input.receipt !== undefined)) {
        throw new Error('Denied');
      }
      return Response.json({ id, ...(lease.receipt ? { uid: lease.receipt.uid } : {}) }, { headers: { 'cache-control': 'no-store' } });
    } catch { return dispatcherRefusal('execution-inactive'); }
  }

  /** Passive retained policy only: no resume, current-authority lookup, SDK read or writes. */
  async dispatcherLoggingPolicy(generation: number, request: Request): Promise<Response> {
    try {
      const binding = await authenticateInstalledDispatcher(this.#appEnv, request);
      if (new URL(request.url).pathname !== '/v1/dispatcher/logging-policy' || request.body !== null
        || binding.generation !== generation) throw new Error('Denied');
      const state = await this.ctx.storage.get<AdmissionState>('admission');
      const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!state?.receipt || !isManagementReceipt(state.receipt) || !state.executionContext
        || lease?.hosting !== 'normal' || !lease.wire || !lease.deployment
        || binding.activityId !== state.intent.activityId || lease.generation !== generation
        || lease.inputDigest !== state.receipt.intentDigest || lease.artifactDigest !== state.executionContext.artifactDigest
        || lease.connectionSecretCiphertext !== binding.connection.connectionSecretCiphertext
        || !sameDispatcherPhaseValue(lease.deployment,
          (({ connectionSecretCiphertext: _secret, ...metadata }) => metadata)(binding.connection))) throw new Error('Denied');
      const { installation, release } = state.receipt.selection;
      const { wire, deployment } = lease;
      if (wire.activityId !== binding.activityId || wire.generation !== generation
        || wire.id !== `${binding.activityId}-g${generation}` || wire.installationId !== installation.id
        || wire.releaseId !== release.id || wire.connectionRevision !== deployment.connectionRevision
        || wire.workerVersionId !== deployment.workerVersionId || wire.installationId !== deployment.installationId
        || wire.releaseId !== deployment.releaseId || deployment.bundleDigest !== lease.artifactDigest
        || deployment.bundleDigest !== release.bundleDigest || deployment.manifestDigest !== release.manifestDigest
        || deployment.sourceCommit !== release.sourceCommit || deployment.compilerCommit !== release.provenance?.compilerCommit
        || installation.releaseId !== release.id) throw new Error('Denied');
      if (lease.receipt) {
        normalDispatcherReceiptSchema.parse(lease.receipt);
        if (lease.submissionId !== lease.receipt.submissionId || lease.rootDigest !== hashDiagnostic(lease.receipt.uid)) throw new Error('Denied');
      } else if (lease.status !== 'admitting' || lease.submissionId !== null) throw new Error('Denied');
      // The immutable admission receipt is the original policy, never the current Registry setting.
      // Serial successor wires omit initialData; when retained, it must agree with that receipt.
      const loggingEnabled = executionLoggingEnabled(state.receipt);
      if (wire.initialData !== undefined) {
        const original = z.object({ settings: z.object({ loggingEnabled: z.boolean() }) }).parse(wire.initialData);
        if (original.settings.loggingEnabled !== loggingEnabled) throw new Error('Denied');
      } else if (!lease.serial) throw new Error('Denied');
      return Response.json({ schemaVersion: 1, loggingEnabled, activityId: wire.activityId, generation,
        deployment: { installationId: wire.installationId, releaseId: wire.releaseId,
          connectionRevision: wire.connectionRevision, workerVersionId: wire.workerVersionId } },
      { headers: { 'cache-control': 'no-store' } });
    } catch { return dispatcherRefusal('execution-inactive'); }
  }

  /** Installation authentication is independent of server-derived original owner/run authority. */
  async dispatcherInstalledCallback(generation: number, request: Request): Promise<Response> {
    try {
      const binding = await authenticateInstalledDispatcher(this.#appEnv, request);
      const state = await this.ctx.storage.get<AdmissionState>('admission');
      const active = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      const profile = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_PROFILE_LEASE);
      const lease = active?.generation === generation ? active : profile;
      if (binding.generation !== generation || state?.intent.activityId !== binding.activityId || lease?.hosting !== 'normal'
        || lease.generation !== generation || lease.deployment?.installationId !== binding.connection.installationId
        || lease.connectionSecretCiphertext !== binding.connection.connectionSecretCiphertext
        || !sameDispatcherPhaseValue(lease.deployment,
          (({ connectionSecretCiphertext: _secret, ...deployment }) => deployment)(binding.connection))) {
        return dispatcherRefusal('execution-inactive');
      }
      const path = new URL(request.url).pathname;
      if (['/v1/dispatcher/pi/config', '/v1/dispatcher/gateway',
        '/v1/dispatcher/pi/credentials', '/v1/dispatcher/model-admission', '/v1/dispatcher/model-fetch'].includes(path)) {
        return await this.#dispatcherSdkCallback(generation, request, lease);
      }
      if (lease !== active) return dispatcherRefusal('execution-inactive');
      // getRuntimePlan reopens only recorded owner context, never an owner/bucket from headers/body.
      const plan = await this.#normalDispatcherCurrent(lease);
      await this.#normalDispatcherConnection(lease, plan);
      const url = new URL(request.url);
      if (url.pathname === '/v1/dispatcher/phase-context') return this.dispatcherPhaseContext(generation, request);
      if (url.pathname === '/v1/dispatcher/diagnostic/runtime') return this.dispatcherRuntimeDiagnostic(generation, request);
      if (url.pathname === '/v1/dispatcher/diagnostic') return this.dispatcherDiagnosticReport(generation, request);
      // Deliberately no native-binding/result, arbitrary outbound or private SDK-method route.
      return await this.dispatcherOperation(generation, request);
    } catch { return dispatcherRefusal('execution-inactive'); }
  }

  /** Read-only profile bootstrap retains original queued-owner authority, never model authority. */
  async #dispatcherSdkCurrent(generation: number, original: DispatcherLease, modelScope: boolean): Promise<boolean> {
    if (modelScope) return this.#dispatcherDeliveryCurrent(generation, undefined, true);
    if (!await this.operatorGenerationCurrent(generation) || original.expiresAt <= Date.now()) return false;
    const plan = await this.getRuntimePlan();
    if (!plan) return false;
    await authorizeDispatcherPlan(plan, this.#appEnv);
    await this.#normalDispatcherConnection(original, plan);
    const active = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    const live = active?.generation === generation ? active
      : await this.ctx.storage.get<DispatcherLease>(DISPATCHER_PROFILE_LEASE);
    return !!live && live.generation === generation && live.expiresAt > Date.now()
      && live.artifactDigest === original.artifactDigest && live.inputDigest === original.inputDigest
      && sameDispatcherPhaseValue(live.deployment, original.deployment)
      && live.connectionSecretCiphertext === original.connectionSecretCiphertext
      && await this.operatorGenerationCurrent(generation);
  }

  /** Private installed SDK services. No provider execution or SDK normalization occurs here. */
  async #dispatcherSdkCallback(generation: number, request: Request, lease: DispatcherLease): Promise<Response> {
    const path = new URL(request.url).pathname;
    const credentials = path === '/v1/dispatcher/pi/credentials';
    const modelScope = path === '/v1/dispatcher/model-admission' || path === '/v1/dispatcher/model-fetch';
    const noStore = { 'cache-control': 'no-store' };
    const conflict = () => dispatcherRefusal('operation-conflict', 409, 'OPERATOR_OPERATION_CONFLICT');
    try {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return dispatcherRefusal('request-invalid');
      }
      // Persist-only credential completion is validated by the owner's bounded lease,
      // not by renewed run authority. All other operations retain original live authority.
      const state = await this.ctx.storage.get<AdmissionState>('admission');
      if (!state?.executionContext || !state.receipt || state.intent.activityId !== request.headers.get('x-codeflare-operator-activity')
        || lease.inputDigest !== state.receipt.intentDigest || lease.artifactDigest !== state.executionContext.artifactDigest) {
        return dispatcherRefusal('execution-inactive');
      }
      const prospectiveAdmissionId = await this.ctx.storage.get<string>('prospective-admission');
      const retainedPlan: OperatorRuntimePlan = { activityId: state.intent.activityId, deadline: state.intent.deadline,
        invocationJson: state.invocationJson ?? 'null', receipt: structuredClone(state.receipt),
        executionContext: structuredClone(state.executionContext),
        ...(state.configuredSelection ? { configuredSelection: state.configuredSelection } : {}),
        ...(state.ownerSource ? { ownerSource: structuredClone(state.ownerSource) } : {}),
        ...(prospectiveAdmissionId ? { prospectiveAdmissionId } : {}) };
      const policy = isManagementReceipt(state.receipt) ? state.receipt.selection.operator.policy : undefined;
      const limits = dispatcherCapacities(policy);
      const body: unknown = JSON.parse(await readDispatcherBody(request, request.signal,
        modelScope ? Math.ceil(inferenceRequestBytes(policy) * 4 / 3) + 64 * 1024 : credentials ? 1024 * 1024 : 4096));
      const persistOnly = credentials && !!body && typeof body === 'object'
        && ['commit', 'abort'].includes(String((body as { operation?: unknown }).operation));
      const current = () => this.#dispatcherSdkCurrent(generation, lease, modelScope);
      if (!persistOnly && (request.signal.aborted || !await current())) return dispatcherRefusal('execution-inactive');
      const plan = persistOnly ? retainedPlan : await this.getRuntimePlan();
      if (!plan) return dispatcherRefusal('execution-inactive');
      const input = { generation, plan, env: this.#appEnv, current, signal: request.signal,
        exports: (this.ctx as unknown as { exports: import('./dispatcher-sdk-services').SdkInput['exports'] }).exports };
      if (credentials) {
        const result = await dispatcherSdkCredentials(input, body);
        if (!persistOnly && (request.signal.aborted || !await current())) return dispatcherRefusal('execution-inactive');
        if (new TextEncoder().encode(JSON.stringify(result) ?? 'null').byteLength > 1024 * 1024) throw new Error('SDK credential envelope too large');
        return (body as { operation?: string }).operation === 'abort'
          ? new Response(null, { status: 204, headers: noStore }) : Response.json(result, { headers: noStore });
      }
      if (!modelScope) {
        z.strictObject({ operation: z.literal('read') }).parse(body);
        const result = await readDispatcherSdkConfiguration(input);
        if (!await current() || request.signal.aborted) return dispatcherRefusal('execution-inactive');
        const serialized = JSON.stringify(path === '/v1/dispatcher/pi/config' && (result as { source?: string }).source === 'managed'
          ? { source: 'managed' } : result);
        if (new TextEncoder().encode(serialized).byteLength > 1024 * 1024) throw new Error('SDK configuration too large');
        return new Response(serialized, { headers: { ...noStore, 'content-type': 'application/json' } });
      }
      if (!lease.configuredSelection || plan.authFailure) return dispatcherRefusal('policy-denied');
      // Reuse the platform's owner/source/complete-grant validation before issuing
      // logical model authority and again immediately around physical egress.
      const owner = await dispatcherSdkOwnerContext(input, lease.configuredSelection);
      const ownerScope = { bucket: owner.bucket, email: owner.email };
      const selection = lease.configuredSelection;
      if (path === '/v1/dispatcher/model-admission') {
        const parsed = z.strictObject({ operationId: syncIdentity,
          context: z.looseObject({ messages: z.array(z.json()).min(1).max(limits.inferenceMessageLimit),
            systemPrompt: z.string().optional(), tools: z.array(z.json()).max(limits.inferenceToolLimit).optional() }),
          options: z.strictObject({ reasoning: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
            maxTokens: z.number().int().positive().max(limits.inferenceTokenLimit).optional(), temperature: z.number().finite().optional(),
            toolChoice: z.json().optional(), thinkingBudgets: z.record(z.string(), z.number().int().nonnegative().max(limits.inferenceTokenLimit)).optional(),
            cacheRetention: z.enum(['none', 'short', 'long']).optional(), sessionId: z.string().min(1).max(512).optional() }),
        }).parse(body);
        if (new TextEncoder().encode(JSON.stringify(body)).byteLength > inferenceRequestBytes(policy)) return dispatcherRefusal('request-invalid');
        const requestDigest = await sha256(JSON.stringify({ context: parsed.context, options: parsed.options, selection, ownerScope }));
        if (!await current()) return dispatcherRefusal('execution-inactive');
        return await this.ctx.storage.transaction(async tx => {
          const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(await tx.get<AdmissionState>('admission'), live, generation)
            || !this.#phaseTokenMatches(live, undefined, true, true)) return dispatcherRefusal('execution-inactive');
          const journal = await loadDispatcherJournal(tx, generation);
          const prior = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, parsed.operationId));
          if (prior) return prior.requestDigest === requestDigest && prior.sdkHttp && prior.sdkHttp.expiresAt > Date.now()
            ? Response.json({ permitId: prior.sdkHttp.permitId, expiresAt: prior.sdkHttp.expiresAt }, { headers: noStore }) : conflict();
          if (journal.count >= dispatcherOperationLimit(policy) || inferenceAttemptLimit(policy) < 1) return conflict();
          const permit = { permitId: crypto.randomUUID(), expiresAt: Math.min(lease.expiresAt, plan.deadline),
            selection, ownerScope, phase: 'ready' as const, attempts: 0 };
          await putDispatcherEntry(tx, journal, parsed.operationId, undefined,
            { generation, requestDigest, phase: 'reserved', ordinal: journal.nextOrdinal, sdkHttp: permit });
          return Response.json({ permitId: permit.permitId, expiresAt: permit.expiresAt }, { headers: noStore });
        });
      }
      const parsed = z.strictObject({ operationId: syncIdentity, permitId: z.string().uuid(),
        request: z.strictObject({ url: z.string().min(1).max(limits.sourceUrlChars), method: z.string().regex(/^[A-Z]+$/).max(16),
          headers: z.array(z.tuple([z.string().max(8192), z.string().max(16384)])).max(128),
          bodyBase64: z.string().max(Math.ceil(inferenceRequestBytes(policy) / 3) * 4).optional() }) }).parse(body);
      const requestDigest = await sha256(JSON.stringify(parsed.request));
      const controller = new AbortController();
      const signal = AbortSignal.any([request.signal, controller.signal,
        AbortSignal.timeout(Math.max(1, Math.min(plan.deadline, lease.expiresAt) - Date.now()))]);
      this.#sdkHttpControllers.add(controller);
      let reserved = false;
      type SdkResponse = { status: number; headers: Record<string, string>; bytes: Uint8Array };
      const responseKey = `dispatcher:response:${generation}:${parsed.operationId}`;
      const reply = (value: SdkResponse) => new Response([204, 205, 304].includes(value.status) ? null : value.bytes.slice(),
        { status: value.status, headers: value.headers });
      try {
        if (signal.aborted || !await current()) return dispatcherRefusal('execution-inactive');
        const claim = await this.ctx.storage.transaction(async tx => {
          const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(await tx.get<AdmissionState>('admission'), live, generation)
            || !this.#phaseTokenMatches(live, undefined, true, true)) return 'denied' as const;
          const journal = await loadDispatcherJournal(tx, generation);
          const record = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, parsed.operationId));
          const permit = record?.sdkHttp;
          if (!record || !permit || permit.permitId !== parsed.permitId || permit.expiresAt <= Date.now()
            || !sameDispatcherPhaseValue(permit.selection, selection)
            || !sameDispatcherPhaseValue(permit.ownerScope, ownerScope)) return 'denied' as const;
          if (permit.phase === 'completed' && record.phase === 'completed' && permit.requestDigest === requestDigest
            && permit.responseKey === responseKey) return 'replay' as const;
          if (permit.phase !== 'ready' || permit.attempts !== 0 || record.phase !== 'reserved') return 'denied' as const;
          // Reserve the single paid send before I/O; only a complete durable receipt can replay.
          await tx.put(dispatcherEntryKey(journal, parsed.operationId), { ...record,
            sdkHttp: { ...permit, phase: 'sending', attempts: 1, requestDigest } });
          return 'send' as const;
        });
        if (claim === 'denied') return conflict();
        const checkScope = async () => {
          if (signal.aborted || Date.now() >= Math.min(plan.deadline, lease.expiresAt)) throw new Error('SDK HTTP aborted');
          const currentOwner = await dispatcherSdkOwnerContext({ ...input, signal }, selection);
          if (currentOwner.bucket !== ownerScope.bucket || currentOwner.email !== ownerScope.email) throw new Error('SDK HTTP owner changed');
          if (signal.aborted || !await current()) throw new Error('SDK HTTP result fenced');
        };
        if (claim === 'replay') {
          const cached = await this.ctx.storage.get<SdkResponse>(responseKey);
          if (!cached || cached.bytes.byteLength > inferenceRequestBytes(policy)) return conflict();
          await checkScope();
          return reply(cached);
        }
        reserved = true;
        await checkScope();
        const { response, transportCredentials } = await forwardDispatcherSdkHttp({ ...input, signal, selection, ownerScope, request: parsed.request });
        const bytes = await readBoundedResponse(response, inferenceRequestBytes(policy), 'SDK HTTP response', signal);
        await checkScope();
        const secrets = [...transportCredentials, ...(selection.source === 'managed' ? [] : parsed.request.headers
          .filter(([name]) => /authorization|api[-_]?key|token|secret|cookie/i.test(name))
          .flatMap(([, value]) => [value, value.replace(/^Bearer\s+/i, '')]).filter(Boolean))];
        const url = new URL(parsed.request.url);
        if (selection.source !== 'managed') for (const [name, value] of url.searchParams) {
          if (/key|token|secret|signature/i.test(name) && value) secrets.push(value);
        }
        // Reject credential echoes rather than persist them or change exact vendor bytes.
        const text = new TextDecoder().decode(bytes);
        if (secrets.some(secret => text.includes(secret))) throw new Error('SDK HTTP credential echo denied');
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          if (!/^(?:connection|keep-alive|transfer-encoding|upgrade|proxy-.*|authorization|authentication-info|set-cookie|cookie|cf-access-.*|cf-aig-.*)$/i.test(name)
            && !/api[-_]?key|token|secret/i.test(name) && !secrets.some(secret => value.includes(secret))) headers[name] = value;
        });
        const receipt: SdkResponse = { status: response.status, headers, bytes };
        const responseDigest = await nativeDigest(bytes);
        await this.ctx.storage.transaction(async tx => {
          const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (signal.aborted || !this.#leaseMatches(await tx.get<AdmissionState>('admission'), live, generation)
            || !this.#phaseTokenMatches(live, undefined, true, true)) throw new Error('SDK HTTP result stale');
          const journal = await loadDispatcherJournal(tx, generation);
          const record = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, parsed.operationId));
          if (record?.sdkHttp?.phase !== 'sending' || record.sdkHttp.requestDigest !== requestDigest) throw new Error('SDK HTTP permit changed');
          await tx.put(responseKey, receipt);
          if (signal.aborted || Date.now() >= Math.min(plan.deadline, lease.expiresAt)) throw new Error('SDK HTTP result fenced');
          await putDispatcherEntry(tx, journal, parsed.operationId, record,
            { ...record, phase: 'completed', responseDigest,
              sdkHttp: { ...record.sdkHttp, phase: 'completed', responseKey } });
          if (signal.aborted || Date.now() >= Math.min(plan.deadline, lease.expiresAt)) throw new Error('SDK HTTP result fenced');
        });
        await checkScope();
        // SDK-owned SSE parsing is unchanged; complete bytes are durable before delivery.
        return reply(receipt);
      } catch (error) {
        if (reserved) await this.ctx.storage.transaction(async tx => {
          const journal = await loadDispatcherJournal(tx, generation);
          const record = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, parsed.operationId));
          if (record?.sdkHttp?.phase === 'sending') await putDispatcherEntry(tx, journal, parsed.operationId, record,
            { ...record, phase: 'unknown', sdkHttp: { ...record.sdkHttp, phase: 'unknown' } });
        });
        throw error;
      } finally {
        this.#sdkHttpControllers.delete(controller); controller.abort();
      }
    } catch (error) {
      if (error instanceof DispatcherRefusal) return dispatcherRefusal(error.reason, error.reason === 'operation-conflict' ? 409 : 403);
      return dispatcherRefusal(error instanceof z.ZodError || error instanceof SyntaxError ? 'request-invalid' : 'execution-inactive');
    }
  }

  /** Public bounded observation never translates timeout/unavailability into abort or new admission. */
  async #reconcileNormalDispatcher(original: DispatcherLease): Promise<void> {
    let lease = original;
    try {
      await this.#normalDispatcherCurrent(lease);
      if (lease.status === 'admitting') {
        try { await this.#admitNormalDispatcher(lease); }
        catch (error) {
          if (error instanceof NormalDispatcherObservationUnavailable) { await this.#scheduleDispatcherRecheck(lease); return; }
          throw error;
        }
        const current = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!current || current.hosting !== 'normal' || current.generation !== lease.generation
          || !sameDispatcherPhaseValue(current.wire, lease.wire)) return;
        lease = current;
      }
      if (lease.status !== 'running' || !lease.receipt || lease.submissionId !== lease.receipt.submissionId) return;
      const plan = await this.#normalDispatcherCurrent(lease);
      const response = await this.#normalDispatcherControl(lease, plan, 'read');
      const receiptEnvelope = z.object({ status: z.enum(['pending', 'completed', 'failed', 'aborted']), receipt: normalDispatcherReceiptSchema }).parse(response.value);
      if (!this.#normalReceiptMatches(lease.receipt, receiptEnvelope.receipt)) throw new Error('Normal Dispatcher foreign receipt');
      await this.#normalDispatcherCurrent(lease);
      if (receiptEnvelope.status === 'pending') {
        if (response.status !== 202 || !z.strictObject({ status: z.literal('pending'), receipt: normalDispatcherReceiptSchema,
          reason: z.literal('observation-timeout') }).safeParse(response.value).success) throw new Error('Normal Dispatcher pending reply invalid');
        await this.#scheduleDispatcherRecheck(lease);
        return;
      }
      if (response.status !== 200) throw new Error('Normal Dispatcher terminal reply invalid');
      let reply: DispatcherPhaseReply;
      if (receiptEnvelope.status === 'completed') {
        const completed = z.strictObject({ status: z.literal('completed'), receipt: normalDispatcherReceiptSchema,
          reply: z.strictObject({ text: z.string(), data: z.record(z.string(), z.array(z.json())),
            metadata: z.record(z.string(), z.json()).optional(), uid: z.string().optional(), submissionId: z.string() }) }).parse(response.value);
        if (completed.reply.uid !== lease.receipt.uid || completed.reply.submissionId !== lease.receipt.submissionId) {
          throw new Error('Normal Dispatcher foreign completed reply');
        }
        reply = { submissionId: completed.reply.submissionId, upToDate: true, outcome: 'completed', data: completed.reply.data };
      } else {
        const terminal = z.strictObject({ status: z.enum(['failed', 'aborted']), receipt: normalDispatcherReceiptSchema,
          submissionId: z.string() }).parse(response.value);
        if (terminal.submissionId !== lease.receipt.submissionId) throw new Error('Normal Dispatcher foreign terminal reply');
        reply = { submissionId: terminal.submissionId, upToDate: true, outcome: terminal.status, data: {} };
      }
      const { admittedTarget } = await authorizeDispatcherPlan(plan, this.#appEnv);
      const policy = isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined;
      const serial = lease.serial;
      let assessment: unknown;
      if (serial) {
        const token = serial.current.deliveryToken;
        if (!await this.#dispatcherDeliveryCurrent(lease.generation, token)) throw new Error('Normal Dispatcher phase retired');
        if (serial.current.phase.kind !== 'final') {
          const journal = await this.ctx.storage.transaction(tx => loadDispatcherJournal(tx, lease.generation));
          if (journal.count >= dispatcherOperationLimit(policy)) throw new Error('Normal Dispatcher capacity exhausted');
          const next = advanceDispatcherPhase(serial, this.#phaseAuthority(lease, plan), token, reply,
            { deliveryToken: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
            admittedTarget ? { pullRequest: admittedTarget.pullRequest, headSha: admittedTarget.headSha } : undefined);
          const nextLease: DispatcherLease = { ...lease, serial: next, receipt: undefined, submissionId: null, status: 'admitting' };
          nextLease.wire = this.#normalDispatcherWire(nextLease, plan);
          const saved = await this.ctx.storage.transaction(async tx => {
            const record = await tx.get<AdmissionState>('admission');
            const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
            if (!this.#leaseMatches(record, live, lease.generation) || !sameDispatcherPhaseValue(live!.wire, lease.wire)
              || !sameDispatcherPhaseValue(live!.receipt, lease.receipt)) return false;
            await tx.put(DISPATCHER_LEASE, nextLease);
            return true;
          });
          if (!saved) return;
          for (const flight of this.#inferenceFlights.values()) flight.controller.abort();
          for (const flight of this.#nativeFlights.values()) flight.controller.abort();
          this.#nativeBindings.clear();
          try { await this.#admitNormalDispatcher(nextLease); }
          catch (error) { this.#recordDiagnostic(lease.generation, 'submission', 'failed', 'submission-failed', error); }
          await this.#scheduleDispatcherRecheck(nextLease);
          return;
        }
        assessment = collectDispatcherFinal(serial, this.#phaseAuthority(lease, plan), token, reply);
      } else {
        const parts = reply.data.assessment;
        if (reply.outcome !== 'completed' || !parts || parts.length !== 1 || !parts[0]
          || typeof parts[0] !== 'object' || Array.isArray(parts[0]) || !z.json().safeParse(parts[0]).success
          || new TextEncoder().encode(JSON.stringify(parts[0])).byteLength > dispatcherCapacities(policy).assessmentBytes
          || admittedTarget && !admittedDispatcherResultMatches(parts[0], admittedTarget, policy)) throw new Error('Normal Dispatcher assessment invalid');
        assessment = parts[0];
      }
      await this.#normalDispatcherCurrent(lease);
      const saved = await this.ctx.storage.transaction(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!this.#leaseMatches(record, live, lease.generation) || !sameDispatcherPhaseValue(live!.wire, lease.wire)
          || !sameDispatcherPhaseValue(live!.receipt, lease.receipt)) return false;
        const prior = await tx.get(`dispatcher:result:${lease.generation}`);
        if (prior !== undefined && !sameDispatcherPhaseValue(prior, assessment)) throw new Error('Normal Dispatcher immutable result changed');
        if (serial) {
          await tx.put(`dispatcher:result:${lease.generation}`, assessment);
          if (!await this.#serialJournalAccounted(tx, live!, assessment)) throw new Error('Normal Dispatcher unresolved journal');
        } else if ((await loadDispatcherJournal(tx, lease.generation)).unresolved !== 0) throw new Error('Normal Dispatcher unresolved journal');
        await tx.put(`dispatcher:result:${lease.generation}`, assessment);
        await tx.put(DISPATCHER_LEASE, { ...live!, settledSubmissionId: lease.submissionId });
        return true;
      });
      if (!saved) return;
      const committed = await this.commitDrive(lease.generation, { schemaVersion: 1, status: 'completed', checkpoint: null, result: assessment });
      if (!committed.ok) throw new Error('Normal Dispatcher commit refused');
    } catch (error) {
      if (error instanceof NormalDispatcherObservationUnavailable) {
        try { await this.#normalDispatcherCurrent(lease); await this.#scheduleDispatcherRecheck(lease); return; }
        catch { /* Original authority or immutable pins no longer hold. */ }
      }
      await this.interruptDrive(lease.generation, { boundary: 'settlement', code: 'settlement-failed', error: captureError(error) });
    }
  }

  #phaseReply(lease: DispatcherLease, value: DispatcherResultProjection): DispatcherPhaseReply {
    if (!lease.submissionId || (value.writes !== 0 && (value.writes !== 1 || value.assessmentWrites !== 1))
      || (value.progressWrites !== undefined && value.progressWrites !== 1)) throw new Error('Dispatcher phase output invalid');
    return { submissionId: lease.submissionId, outcome: value.outcome, upToDate: value.upToDate === true,
      data: { assessment: value.writes ? [value.result] : [],
        'dispatcher-progress': value.progressWrites === 1 ? [value.progress] : [] } };
  }

  #operationPhase(lease: DispatcherLease, resource: string): DispatcherOperationRecord['phaseBinding'] {
    const current = lease.serial?.current;
    return current?.receipt ? { submissionId: current.receipt.submissionId,
      deliveryToken: current.deliveryToken, phase: current.phase, resource } : undefined;
  }

  /** Exact accounting only. Unknown records/counters remain untouched; a final disposition
   * cannot excuse an unbound, foreign or uncovered operation. Legacy leases never opt in. */
  async #serialJournalAccounted(tx: DurableObjectTransaction, lease: DispatcherLease, result: unknown): Promise<boolean> {
    if (!lease.serial || lease.serial.current.phase.kind !== 'final'
      || JSON.stringify(await tx.get(`dispatcher:result:${lease.generation}`)) !== JSON.stringify(result)) return false;
    const assessment = result as { repository: string; results: Array<{ pullRequest: number; headSha: string;
      outcome: string; reason?: string }> };
    const journal = await loadDispatcherJournal(tx, lease.generation);
    let accounted = 0;
    let startAfter: string | undefined;
    for (;;) {
      const page = await tx.list<DispatcherOperationRecord>({ prefix: `dispatcher:operation:${lease.generation}:`, limit: 128,
        ...(startAfter ? { startAfter } : {}) });
      for (const [key, entry] of page) {
        startAfter = key;
        if (entry.phase === 'completed') continue;
        accounted++;
        const binding = entry.phaseBinding;
        if (entry.generation !== lease.generation || !binding || binding.phase.kind !== 'target') return false;
        const target = binding.phase.target;
        const terminal = lease.serial.previous.find(row => row.submissionId === binding.submissionId);
        if (!terminal || JSON.stringify(terminal.phase) !== JSON.stringify(binding.phase)) return false;
        const row = assessment.results[binding.phase.index];
        if (!row || row.pullRequest !== target.pullRequest || row.headSha !== target.headSha || row.outcome !== 'DEFERRED') return false;
        if (binding.resource === 'inference' || entry.request?.method === 'GET') {
          // This accounts for failed target-local read/model work, never an uncertain effect.
          if (terminal.outcome !== 'failed' && !['research-failed', 'decision-failed', 'preflight-failed'].includes(row.reason ?? '')) return false;
        } else {
          if (!entry.request || binding.resource !== 'source') return false;
          const base = `${dispatcherGithubApiOrigin(this.#appEnv)}/repos/${assessment.repository}`;
          const comment = entry.request.method === 'POST' && entry.request.url === `${base}/issues/${target.pullRequest}/comments`;
          const merge = entry.request.method === 'PUT' && entry.request.url === `${base}/pulls/${target.pullRequest}/merge`;
          if ((!comment && !merge) || !(row.reason === (comment ? 'comment-uncertain' : 'merge-uncertain')
            || terminal.outcome === 'failed' && row.reason === 'response-failed')) return false;
        }
      }
      if (page.size < 128) break;
    }
    return accounted === journal.unresolved;
  }

  #phaseAuthority(lease: DispatcherLease, plan: OperatorRuntimePlan): DispatcherPhaseAuthority {
    if (!lease.serial || !isManagementReceipt(plan.receipt)) throw new Error('Dispatcher phase unavailable');
    return { scope: lease.serial.scope, generation: lease.generation, deadline: new Date(lease.expiresAt).toISOString(),
      releaseDigest: lease.artifactDigest, authorityDigest: lease.serial.authorityDigest,
      repositoryJson: plan.invocationJson, assessmentBytes: dispatcherCapacities(plan.receipt.selection.operator.policy).assessmentBytes };
  }

  #phaseTokenMatches(lease: DispatcherLease | undefined, token: string | undefined, admitted = true, modelScope = false): boolean {
    // Normal model authorization is Activity-scoped; protected tools retain exact phase tokens.
    if (modelScope && lease?.hosting === 'normal') return lease.status === 'running' && !!lease.receipt;
    return !!lease && (!lease.serial || (lease.serial.current.deliveryToken === token
      && (!admitted || !!lease.serial.current.receipt
        && lease.serial.current.receipt.submissionId === lease.submissionId && lease.status === 'running')));
  }

  async #dispatcherDeliveryCurrent(generation: number, token: string | undefined, modelScope = false): Promise<boolean> {
    if (!await this.dispatcherGenerationCurrent(generation)) return false;
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!this.#phaseTokenMatches(lease, token, true, modelScope)) return false;
    if (lease?.serial || lease?.hosting === 'normal') {
      try {
        const plan = await this.getRuntimePlan();
        if (!plan) return false;
        await authorizeDispatcherPlan(plan, this.#appEnv);
        if (lease.hosting === 'normal') await this.#normalDispatcherConnection(lease, plan);
      } catch { return false; }
      // All serial runs retain original authority, not just prospective ones. External
      // authorization can race a new phase, cancellation or the original deadline.
      return await this.dispatcherGenerationCurrent(generation)
        && this.#phaseTokenMatches(await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE), token, true, modelScope);
    }
    return true;
  }

  async #scheduleDispatcherRecheck(lease: DispatcherLease, upToDate = true): Promise<void> {
    const remaining = Math.floor((lease.expiresAt - Date.now() - 1_000) / 1_000);
    if (remaining > 0) {
      try {
        await this.schedule(Math.min(upToDate ? 5 : 1, remaining), 'reconcileDispatcherLease', { generation: lease.generation }, { idempotent: true });
        this.#recordDiagnostic(lease.generation, 'scheduling', 'completed');
      } catch (error) {
        this.#recordDiagnostic(lease.generation, 'scheduling', 'failed', 'unclassified', error);
        throw error;
      }
    }
  }

  async #admitDispatcherPhase(generation: number, token: string, approved?: DispatcherBundle): Promise<void> {
    const original = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (original?.hosting === 'normal') {
      if (!this.#phaseTokenMatches(original, token, false)) throw new Error('Stale normal phase');
      return this.#admitNormalDispatcher(original);
    }
    const key = `${generation}:${token}`;
    const pending = this.#phaseAdmissions.get(key);
    if (pending) return pending;
    const admission = (async () => {
      const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!lease?.serial || !this.#phaseTokenMatches(lease, token, false)
        || !await this.dispatcherGenerationCurrent(generation)) throw new Error('Stale Dispatcher phase admission');
      if (lease.serial.current.receipt) return;
      const plan = await this.getRuntimePlan();
      if (!plan) throw new Error('Dispatcher phase plan unavailable');
      await authorizeDispatcherPlan(plan, this.#appEnv);
      const authority = this.#phaseAuthority(lease, plan);
      const wire = dispatcherPhaseWire(lease.serial, authority);
      let admissionResponse: Response | undefined;
      const receipt = await this.#boundedDispatcher(lease, async () => {
        const child = await this.#dispatcherFacet(lease, approved);
        if (!await this.dispatcherGenerationCurrent(generation)
          || !this.#phaseTokenMatches(await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE), token, false)) {
          throw new Error('Stale Dispatcher phase before admission');
        }
        const response = await child.fetch(new Request('https://flue.internal/agents/Dispatcher/dispatcher', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wire),
        }));
        admissionResponse = response;
        if (response.status !== 202) {
          this.#observeSdkHeader(generation, response);
          let admissionType: typeof sdkAdmissionTypes[number] | undefined;
          try {
            const body = await readDispatcherBody(response,
              AbortSignal.timeout(Math.max(1, Math.min(1000, lease.expiresAt - Date.now()))), 4096);
            const parsed = dispatcherAdmissionErrorSchema.safeParse(JSON.parse(body));
            if (parsed.success) admissionType = parsed.data.error.type;
          } catch { /* Missing, oversized, malformed or stalled bodies leave admission uncertain. */ }
          throw new DispatcherPhaseAdmissionError(response.status, admissionType);
        }
        const value = JSON.parse(await readDispatcherBody(response));
        const offset = response.headers.get('stream-next-offset') ?? value.offset;
        return { submissionId: value.submissionId, uid: value.uid, offset,
          ...(value.deduplicated === true ? { deduplicated: true as const } : {}) };
      });
      await authorizeDispatcherPlan(plan, this.#appEnv);
      if (!await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher phase authority changed');
      await this.ctx.storage.transaction(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!this.#leaseMatches(record, current, generation) || !current!.serial
          || !this.#phaseTokenMatches(current, token, false)) throw new Error('Stale Dispatcher phase receipt');
        const serial = bindDispatcherPhaseReceipt(current!.serial, authority, token, receipt);
        // A replay may start at -1 only when the original cursor was never bound. Never rewind
        // a retained projection after eviction or an acknowledgement loss.
        if (!serial.current.receipt || !('offset' in serial.current.receipt)) throw new Error('Historical Dispatcher cursor missing');
        await tx.put<DispatcherLease>(DISPATCHER_LEASE, { ...current!, serial, status: 'running',
          submissionId: serial.current.receipt!.submissionId, rootDigest: hashDiagnostic(serial.current.receipt!.uid),
          projection: current!.projection ?? { offset: serial.current.receipt!.offset, messageIds: [], writes: 0, serialPhase: true } });
      });
      this.#recordDiagnostic(generation, 'submission', 'accepted');
      this.#recordDiagnostic(generation, 'delivery', 'accepted');
      if (admissionResponse) this.#observeSdkHeader(generation, admissionResponse);
    })().catch(error => {
      this.#recordDiagnostic(generation, 'submission', 'failed', 'submission-failed', error);
      throw error;
    }).finally(() => {
      // Every joining caller observes cleanup before rejection. A lost acknowledgement
      // cannot leave an already-rejected flight blocking same-key receipt recovery.
      if (this.#phaseAdmissions.get(key) === admission) this.#phaseAdmissions.delete(key);
    }).catch(error => {
      // Release the admission flight before retiring its owned child. All joining callers
      // observe the fence before rejection; uncertain acknowledgements stay keyed and live.
      if (!(error instanceof DispatcherPhaseAdmissionError && error.definitive)) throw error;
      return this.interruptDrive(generation, { boundary: 'submission', code: 'submission-failed', error: captureError(error) })
        .then(() => { throw error; });
    });
    this.#phaseAdmissions.set(key, admission);
    await admission;
  }

  async #prepareDispatcherNative(lease: DispatcherLease, plan: OperatorRuntimePlan): Promise<NativeOperatorInference | undefined> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (state?.authFailure) throw new PiAuthRequiredError(state.authFailure.provider, state.authFailure.reason);
    if (lease.inferenceSource === 'managed' || !lease.inferenceSelection && lease.status !== 'admitting') return undefined;
    const prepared = await prepareDispatcherNative({ plan: { ...plan, deadline: Math.min(plan.deadline, lease.expiresAt) },
      env: this.#appEnv, selection: lease.inferenceSelection,
      current: () => this.dispatcherGenerationCurrent(lease.generation) });
    const selection = prepared?.selection;
    if (selection && !lease.inferenceRecovery) throw new Error('Dispatcher native inference protocol unavailable');
    await this.ctx.storage.transaction(async tx => {
      const admission = await tx.get<AdmissionState>('admission');
      const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!this.#leaseMatches(admission, live, lease.generation) || admission!.authFailure) throw new Error('Dispatcher selection fenced');
      if (live!.inferenceSource && (live!.inferenceSource !== (selection ? 'pi-native' : 'managed')
        || JSON.stringify(live!.inferenceSelection) !== JSON.stringify(selection))) throw new Error('Dispatcher selection changed');
      await tx.put(DISPATCHER_LEASE, { ...live!, inferenceSource: selection ? 'pi-native' : 'managed',
        ...(selection ? { inferenceSelection: selection } : {}) });
      if (selection) await tx.put('admission', { ...admission!, inferenceSelection: selection });
    });
    return selection;
  }

  /** Durable functional stop, independent of logging. It never settles or renews a phase. */
  async #nativeLoginStop(generation: number, failure: SafePiAuthFailure): Promise<void> {
    this.#nativeBindings.delete(generation);
    await this.ctx.storage.transaction(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!this.#leaseMatches(state, lease, generation) || (lease!.hosting === 'normal' ? lease!.configuredSelection : lease!.inferenceSelection)?.provider !== failure.provider) return;
      if (!state!.authFailure) await tx.put('admission', { ...state!, authFailure: failure, updatedAt: Date.now() });
    });
    await this.publishBrowserSummary();
  }

  async #nativeAuthority(generation: number, token?: string, signal?: AbortSignal) {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!this.#leaseMatches(state, lease, generation) || !lease!.inferenceSelection
      || token !== undefined && !this.#phaseTokenMatches(lease, token)) throw new Error('Dispatcher native authority denied');
    if (state!.authFailure) throw new PiAuthRequiredError(state!.authFailure.provider, state!.authFailure.reason);
    const selection = parseNativeOperatorInference(lease!.inferenceSelection);
    const plan = await this.getRuntimePlan();
    if (!plan) throw new Error('Dispatcher native plan unavailable');
    const prepared = await prepareDispatcherNative({ plan: { ...plan, deadline: Math.min(plan.deadline, lease!.expiresAt) },
      env: this.#appEnv, selection, signal,
      current: () => token === undefined ? this.dispatcherGenerationCurrent(generation) : this.#dispatcherDeliveryCurrent(generation, token) });
    if (!prepared) throw new Error('Dispatcher native source denied');
    return { lease: lease!, plan, prepared, selection };
  }

  /** Trusted EgressController recheck: nonsecret selection only, never a new admission or auth read. */
  async dispatcherNativeEgressCurrent(generation: number, profileDigest: string): Promise<NativeOperatorInference | null> {
    try {
      const current = await this.#nativeAuthority(generation);
      const bound = this.#nativeBindings.get(generation);
      if (!bound || current.selection.profileDigest !== profileDigest) return null;
      if (bound.expiresAt !== null && bound.expiresAt <= Date.now()) {
        await this.#nativeLoginStop(generation, { code: 'PI_LOGIN_REQUIRED', reason: 'expired', provider: current.selection.provider });
        return null;
      }
      return current.selection;
    } catch { return null; }
  }

  async #nativeBinding(generation: number, token?: string, signal?: AbortSignal): Promise<NativePiBinding> {
    const { prepared, selection } = await this.#nativeAuthority(generation, token, signal);
    try {
      let bound = this.#nativeBindings.get(generation);
      if (!bound) bound = await prepared.bind();
      if (bound.expiresAt !== null && bound.expiresAt <= Date.now()) throw new PiAuthRequiredError(selection.provider, 'expired');
      await this.#nativeAuthority(generation, token, signal);
      this.#nativeBindings.set(generation, bound);
      return bound;
    } catch (error) {
      if (error instanceof PiAuthRequiredError) await this.#nativeLoginStop(generation, error.authFailure);
      throw error;
    }
  }

  /** Private native admission/result wire. Handles bind immutable logical operations, never credentials. */
  async dispatcherNative(generation: number, request: Request): Promise<Response> {
    const denied = () => dispatcherRefusal('execution-inactive');
    try {
      const url = new URL(request.url);
      if (url.origin !== 'https://operator.internal') return await this.#dispatcherNativeSend(generation, request);
      if (url.search || url.hash || request.method !== 'POST'
        || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return denied();
      const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!lease || !await this.dispatcherGenerationCurrent(generation)) return denied();
      const value: unknown = JSON.parse(await readDispatcherBody(request,
        AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, lease.expiresAt - Date.now()))]), 2048));
      const digest = z.string().regex(/^[a-f0-9]{64}$/);
      if (url.pathname === '/v1/dispatcher/native-binding') {
        const body = z.strictObject({ profileDigest: digest }).parse(value);
        const { selection } = await this.#nativeAuthority(generation, undefined, request.signal);
        if (body.profileDigest !== selection.profileDigest) return denied();
        return Response.json(await this.#nativeBinding(generation, undefined, request.signal), { headers: { 'cache-control': 'no-store' } });
      }
      const token = request.headers.get('x-codeflare-dispatcher-delivery') ?? undefined;
      if (url.pathname === '/v1/dispatcher/native-admission') {
        const body = z.strictObject({ operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), profileDigest: digest }).parse(value);
        if (!this.#phaseTokenMatches(lease, token)) return denied();
        const { plan, selection } = await this.#nativeAuthority(generation, token, request.signal);
        if (body.profileDigest !== selection.profileDigest) return denied();
        const requestDigest = await sha256(JSON.stringify({ operationId: body.operationId, selection, deliveryToken: token }));
        return await this.ctx.storage.transaction(async tx => {
          const state = await tx.get<AdmissionState>('admission');
          const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(state, live, generation) || state!.authFailure || !this.#phaseTokenMatches(live, token)) return denied();
          const journal = await loadDispatcherJournal(tx, generation);
          const key = dispatcherEntryKey(journal, body.operationId);
          const prior = await tx.get<DispatcherOperationRecord>(key);
          if (prior && (prior.requestDigest !== requestDigest || !prior.native)) return dispatcherRefusal('operation-conflict', 409, 'OPERATOR_OPERATION_CONFLICT');
          if (prior?.phase === 'unknown' || prior?.native?.phase === 'unknown') return dispatcherRefusal('effect-uncertain', 409, 'OPERATOR_OPERATION_UNKNOWN');
          const policy = isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined;
          const successor = prior?.native?.phase === 'committed' && prior.native.outcome === 'failed';
          if (prior && !successor) return Response.json({ handle: prior.native!.handle });
          if (journal.count >= dispatcherOperationLimit(policy)
            || successor && prior.native!.attempt >= live!.inferenceRecovery!.attemptLimit) return dispatcherRefusal('operation-limit');
          const attempt = successor ? prior!.native!.attempt : 0;
          const notBefore = successor ? Date.now() + inferenceRetryDelay(attempt, policy) : Date.now();
          if (notBefore >= live!.expiresAt) return denied();
          const native: DispatcherNativeOperation = { handle: crypto.randomUUID(), profileDigest: selection.profileDigest,
            deliveryToken: token, attempt, notBefore, phase: 'admitted',
            ...(prior?.native?.wireDigest ? { wireDigest: prior.native.wireDigest } : {}) };
          await tx.put(`dispatcher:native-handle:${native.handle}`, { generation, operationId: body.operationId, deliveryToken: token });
          await putDispatcherEntry(tx, journal, body.operationId, prior, { generation, requestDigest, phase: 'reserved',
            ordinal: successor ? journal.nextOrdinal : prior?.ordinal ?? journal.nextOrdinal, native,
            phaseBinding: this.#operationPhase(live!, 'inference') }, successor ? 1 : 0);
          return Response.json({ handle: native.handle });
        });
      }
      if (url.pathname !== '/v1/dispatcher/native-result') return denied();
      const body = z.strictObject({ handle: z.string().min(1).max(128), outcome: z.enum(['completed', 'failed']), authFailure: z.unknown().optional() }).parse(value);
      const reference = await this.ctx.storage.get<{ generation: number; operationId: string; deliveryToken?: string }>(`dispatcher:native-handle:${body.handle}`);
      if (!reference || reference.generation !== generation) return denied();
      const { selection } = await this.#nativeAuthority(generation, reference.deliveryToken, request.signal);
      const authFailure = body.authFailure === undefined ? undefined : safePiAuthFailure(body.authFailure);
      if (body.authFailure !== undefined && (!authFailure || authFailure.provider !== selection.provider || body.outcome !== 'failed')) return denied();
      const result = await this.ctx.storage.transaction(async tx => {
        const state = await tx.get<AdmissionState>('admission');
        const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!this.#leaseMatches(state, live, generation) || state!.authFailure || !this.#phaseTokenMatches(live, reference.deliveryToken)) return denied();
        const journal = await loadDispatcherJournal(tx, generation);
        const prior = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, reference.operationId));
        if (!prior?.native || prior.phase === 'unknown' || prior.native.handle !== body.handle
          || prior.native.phase !== 'committed' || prior.native.outcome && prior.native.outcome !== body.outcome) return denied();
        const attemptKey = inferenceAttemptKey(generation, reference.operationId, prior.native.attempt);
        const attempt = await tx.get<DispatcherInferenceAttempt>(attemptKey);
        if (!attempt || attempt.phase !== 'completed') return denied();
        await tx.put(attemptKey, { ...attempt, classification: body.outcome === 'completed' ? 'usable' : 'retryable' });
        await putDispatcherEntry(tx, journal, reference.operationId, prior, { ...prior, phase: 'completed',
          native: { ...prior.native, outcome: body.outcome } });
        return Response.json({ recorded: true });
      });
      if (result.ok && authFailure) await this.#nativeLoginStop(generation, authFailure);
      return result;
    } catch (error) {
      if (error instanceof PiAuthRequiredError) return Response.json({ authFailure: error.authFailure }, { status: 403, headers: { 'cache-control': 'no-store' } });
      return denied();
    }
  }

  async #dispatcherNativeSend(generation: number, request: Request): Promise<Response> {
    const denied = () => dispatcherRefusal('execution-inactive');
    const handle = request.headers.get('x-codeflare-native-inference');
    if (!handle || !/^[A-Za-z0-9_-]{1,128}$/.test(handle)) return denied();
    const reference = await this.ctx.storage.get<{ generation: number; operationId: string; deliveryToken?: string }>(`dispatcher:native-handle:${handle}`);
    if (!reference || reference.generation !== generation) return denied();
    const { deliveryToken, operationId } = reference;
    const { plan, lease, selection } = await this.#nativeAuthority(generation, deliveryToken, request.signal);
    const bound = await this.#nativeBinding(generation, deliveryToken, request.signal);
    const policy = isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined;
    const limit = inferenceRequestBytes(policy);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, lease.expiresAt - Date.now()))]);
    const inspected = await inspectNativeRequest(request, selection, bound, limit, signal);
    if (!inspected) return dispatcherRefusal('policy-denied');
    const joined = this.#nativeFlights.get(handle);
    if (joined) {
      if (joined.digest !== inspected.digest) return dispatcherRefusal('operation-conflict', 409, 'OPERATOR_OPERATION_CONFLICT');
      return nativeResponse(await joined.result);
    }
    // Register the flight before the first asynchronous reservation so duplicates join it.
    const controller = new AbortController();
    const runSignal = AbortSignal.any([signal, controller.signal]);
    const run = async (): Promise<DispatcherNativeResponse> => {
      let claimed = false;
      try {
        await this.#nativeAuthority(generation, deliveryToken, runSignal);
        const waiting = await this.ctx.storage.get<DispatcherOperationRecord>(`dispatcher:operation:${generation}:${operationId}`);
        const delay = (waiting?.native?.notBefore ?? 0) - Date.now();
        if (delay > 0) await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); runSignal.removeEventListener('abort', abort); reject(new Error('Native send cancelled')); };
          const timer = setTimeout(() => { runSignal.removeEventListener('abort', abort); resolve(); }, delay);
          runSignal.addEventListener('abort', abort, { once: true });
          if (runSignal.aborted) abort();
        });
        const bucket = await resolveBucketName(this.#appEnv, plan.executionContext.owner.email);
        const exports = (this.ctx as unknown as { exports: Parameters<typeof createDispatcherOperation>[0]['exports'] }).exports;
        if (!exports.EgressController) throw new Error('Native egress unavailable');
        const transport = exports.EgressController({ props: { bucket, strict: true,
          operatorDispatcherNative: { activityId: plan.activityId, generation, profileDigest: selection.profileDigest } } });
        const headers = new Headers(request.headers);
        for (const name of headers.keys()) if (name.startsWith('x-codeflare-')
          || ['host', 'content-length', 'connection', 'transfer-encoding', 'cf-access-jwt-assertion'].includes(name)) headers.delete(name);
        await this.#nativeAuthority(generation, deliveryToken, runSignal);
        const reservation = await this.ctx.storage.transaction(async tx => {
          const state = await tx.get<AdmissionState>('admission');
          const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(state, live, generation) || state!.authFailure || !this.#phaseTokenMatches(live, deliveryToken)) throw new Error('Native send fenced');
          const journal = await loadDispatcherJournal(tx, generation);
          const prior = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operationId));
          if (!prior?.native || prior.phase === 'unknown' || prior.native.handle !== handle) throw new Error('Native operation fenced');
          if (prior.native.wireDigest && prior.native.wireDigest !== inspected.digest) return { conflict: true as const };
          const wireKey = `dispatcher:native-wire:${generation}:${deliveryToken}:${inspected.digest}`;
          const canonical = await tx.get<string>(wireKey);
          // A new SDK correlation/turn label cannot buy another operation's send budget
          // for the same immutable phase request. Auth and protected headers are not hashed.
          if (canonical !== undefined && canonical !== operationId) return { conflict: true as const };
          if (prior.native.phase === 'committed') {
            const response = await tx.get<DispatcherNativeResponse>(`dispatcher:native-response:${handle}`);
            if (!response || response.kind !== 'pi-native') throw new Error('Native receipt missing');
            return { response };
          }
          if (prior.native.phase === 'in-flight') {
            await putDispatcherEntry(tx, journal, operationId, prior, { ...prior, phase: 'unknown',
              native: { ...prior.native, phase: 'unknown' } });
            return { unknown: true as const };
          }
          if (prior.native.phase !== 'admitted' || Date.now() < prior.native.notBefore
            || prior.native.attempt >= live!.inferenceRecovery!.attemptLimit) throw new Error('Native attempt unavailable');
          const attempt = prior.native.attempt + 1;
          // The logical reservation owns the first ordinal. Successors receive a
          // separately charged reservation at admission; only this claim starts HTTP.
          await tx.put(wireKey, operationId);
          await tx.put(inferenceAttemptKey(generation, operationId, attempt), {
            index: attempt, ordinal: prior.ordinal!, phase: 'in-flight', notBefore: prior.native.notBefore,
          } satisfies DispatcherInferenceAttempt);
          await tx.put(dispatcherEntryKey(journal, operationId), { ...prior, native: { ...prior.native,
            attempt, wireDigest: inspected.digest, phase: 'in-flight' } });
          return { claimed: true as const };
        });
        if ('conflict' in reservation) throw new DispatcherRefusal('operation-conflict');
        if ('unknown' in reservation) throw new Error('Native response unknown');
        if ('response' in reservation && reservation.response) return reservation.response;
        claimed = true;
        if (bound.expiresAt !== null && bound.expiresAt <= Date.now()) throw new PiAuthRequiredError(selection.provider, 'expired');
        runSignal.throwIfAborted();
        const upstream = await transport.fetch(new Request(request.url, { method: 'POST', headers,
          body: inspected.bytes, redirect: 'manual', signal: runSignal }));
        const response = await commitNativeResponse(upstream, selection, limit, runSignal, bound);
        await this.#nativeAuthority(generation, deliveryToken, runSignal);
        const responseDigest = await nativeDigest(response.bytes);
        await this.ctx.storage.transaction(async tx => {
          const state = await tx.get<AdmissionState>('admission');
          const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(state, live, generation) || state!.authFailure || !this.#phaseTokenMatches(live, deliveryToken)
            || runSignal.aborted) throw new Error('Native commit fenced');
          const journal = await loadDispatcherJournal(tx, generation);
          const prior = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operationId));
          if (prior?.native?.handle !== handle || prior.native.phase !== 'in-flight'
            || prior.native.wireDigest !== inspected.digest) throw new Error('Native commit superseded');
          await tx.put(`dispatcher:native-response:${handle}`, response);
          await tx.put(inferenceAttemptKey(generation, operationId, prior.native.attempt), {
            index: prior.native.attempt, ordinal: prior.ordinal!, phase: 'completed', notBefore: prior.native.notBefore,
            responseKey: `dispatcher:native-response:${handle}`, responseDigest,
          } satisfies DispatcherInferenceAttempt);
          await tx.put(dispatcherEntryKey(journal, operationId), { ...prior, responseDigest,
            native: { ...prior.native, phase: 'committed' } });
        });
        if (response.authFailure) await this.#nativeLoginStop(generation, response.authFailure);
        return response;
      } catch (error) {
        if (claimed) await this.ctx.storage.transaction(async tx => {
          const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (live?.generation !== generation) return;
          const journal = await loadDispatcherJournal(tx, generation);
          const prior = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operationId));
          if (prior?.native?.handle === handle && prior.native.phase === 'in-flight') {
            await putDispatcherEntry(tx, journal, operationId, prior, { ...prior, phase: 'unknown', native: { ...prior.native, phase: 'unknown' } });
          }
        });
        if (error instanceof PiAuthRequiredError) await this.#nativeLoginStop(generation, error.authFailure);
        throw error;
      }
    };
    const result = run().finally(() => { this.#nativeFlights.delete(handle); controller.abort(); });
    this.#nativeFlights.set(handle, { digest: inspected.digest, controller, result });
    try { return nativeResponse(await result); }
    catch (error) {
      if (error instanceof PiAuthRequiredError) throw error;
      return error instanceof DispatcherRefusal && error.reason === 'operation-conflict'
        ? dispatcherRefusal('operation-conflict', 409, 'OPERATOR_OPERATION_CONFLICT')
        : dispatcherRefusal('effect-uncertain', 409, 'OPERATOR_OPERATION_UNKNOWN');
    }
  }

  /** Private binding only. Wait for the original ADMISSION receipt, never for this response's settlement. */
  async dispatcherPhaseContext(generation: number, request: Request): Promise<Response> {
    this.#resumeDispatcherOnEntry();
    const denied = (reason: DispatcherRefusalReason = 'execution-inactive') => dispatcherRefusal(reason);
    let refusalReason: DispatcherRefusalReason = 'request-invalid';
    try {
      const url = new URL(request.url);
      if (url.href !== 'https://operator.internal/v1/dispatcher/phase-context' || request.method !== 'POST'
        || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return denied('request-invalid');
      if (!await this.dispatcherGenerationCurrent(generation)) return denied();
      const { deliveryToken } = z.strictObject({ deliveryToken: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) })
        .parse(JSON.parse(await readDispatcherBody(request, request.signal, 2048)));
      if (request.headers.get('x-codeflare-dispatcher-delivery') !== deliveryToken) return denied();
      refusalReason = 'execution-inactive';
      let lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!lease?.serial || !this.#phaseTokenMatches(lease, deliveryToken, false)) return denied();
      refusalReason = 'receipt-unavailable';
      try { await this.#admitDispatcherPhase(generation, deliveryToken); }
      catch {
        // The SDK may enter while the original202 acknowledgement is being lost.
        // Reattach that same persisted admission once; never await response settlement
        // or deny a live delivery merely because its first receipt was unavailable.
        const original = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!original?.serial || !this.#phaseTokenMatches(original, deliveryToken, false)
          || !await this.dispatcherGenerationCurrent(generation)) return denied();
        await this.#admitDispatcherPhase(generation, deliveryToken);
      }
      const plan = await this.getRuntimePlan();
      if (!plan) return denied();
      refusalReason = 'authority-unverified';
      await authorizeDispatcherPlan(plan, this.#appEnv);
      if (!await this.#dispatcherDeliveryCurrent(generation, deliveryToken)) return denied();
      lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!lease?.serial || !this.#phaseTokenMatches(lease, deliveryToken)) return denied();
      return Response.json(dispatcherPhaseContext(lease.serial, this.#phaseAuthority(lease, plan), deliveryToken),
        { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return denied(error instanceof SyntaxError || error instanceof z.ZodError ? 'request-invalid'
      : error instanceof DispatcherRefusal ? error.reason : refusalReason); }
  }

  #leaseMatches(record: AdmissionState | undefined, lease: DispatcherLease | undefined, generation: number): boolean {
    return !!record?.receipt && !!lease && record.phase === 'queued' && record.drive?.status === 'running'
      && record.drive.generation === generation && lease.generation === generation
      && (lease.status === 'admitting' || lease.status === 'running') && lease.expiresAt > Date.now()
      && record.intent.deadline > Date.now() && lease.inputDigest === record.receipt.intentDigest
      && lease.artifactDigest === record.executionContext?.artifactDigest;
  }

  /** Parent-only local fence checked by the restricted binding before every SDK call and effect. */
  async dispatcherGenerationCurrent(generation: number): Promise<boolean> {
    this.#resumeDispatcherOnEntry();
    if (!Number.isSafeInteger(generation) || generation < 1) return false;
    const [record, lease] = await Promise.all([this.ctx.storage.get<AdmissionState>('admission'),
      this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE)]);
    if (!this.#leaseMatches(record, lease, generation)) return false;
    if (await this.ctx.storage.get<string>('prospective-admission')) {
      try {
        const plan = await this.getRuntimePlan();
        if (!plan) return false;
        await authorizeDispatcherPlan(plan, this.#appEnv);
      } catch { return false; }
      // Authorization involves external services; cancellation can race it.
      const [latest, currentLease] = await Promise.all([
        this.ctx.storage.get<AdmissionState>('admission'), this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE),
      ]);
      return this.#leaseMatches(latest, currentLease, generation);
    }
    return true;
  }

  async #boundedDispatcher<T>(lease: DispatcherLease, run: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (lease.expiresAt <= Date.now()) throw new Error('Dispatcher lease expired');
      return await Promise.race([run(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Dispatcher lease expired')), lease.expiresAt - Date.now());
      })]);
    } finally { clearTimeout(timer); }
  }

  async #dispatcherFacet(lease: DispatcherLease, approved?: DispatcherBundle): Promise<DispatcherConnection> {
    if (this.#dispatcher?.generation === lease.generation) return this.#dispatcher.facet;
    let facet!: Promise<DispatcherConnection>;
    const discard = () => {
      // A late failure on an old connection cannot evict a newer one.
      if (this.#dispatcher?.facet === facet) this.#dispatcher = undefined;
    };
    facet = (async () => {
      const plan = await this.getRuntimePlan();
      const loader = this.#appEnv.LOADER;
      const activities = this.#appEnv.OPERATOR_ACTIVITY;
      if (!plan || !loader || !activities
        || plan.executionContext.artifactDigest !== lease.artifactDigest) throw new Error('Dispatcher host unavailable');
      let bundle = approved;
      if (!bundle) {
        const bytes = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').getManagementBundle(lease.artifactDigest);
        if (!bytes) throw new Error('Dispatcher artifact unavailable');
        bundle = await parseDispatcherBundle(bytes, lease.artifactDigest);
      }
      const context = this.ctx as unknown as { facets: { get(name: string, init: () => unknown): DispatcherFacet } };
      const inferenceSelection = await this.#prepareDispatcherNative(lease, plan);
      const dynamicClass = await this.#dispatcherClass({ ...lease, ...(inferenceSelection ? { inferenceSelection } : {}) }, plan, bundle);
      // Preparation may outlive retirement. Recheck the original generation and
      // exact cached promise before get can instantiate a replacement runtime.
      if (!await this.dispatcherGenerationCurrent(lease.generation)
        || this.#dispatcher?.facet !== facet) throw new Error('Stale Dispatcher facet creation');
      const child = context.facets.get('dispatcher', () => ({ class: dynamicClass,
        id: activities.idFromName('dispatcher') }));
      await child._cf_initAsFacet('dispatcher', [{ className: 'OperatorActivity', name: plan.activityId }], 'dispatcher');
      this.#recordDiagnostic(lease.generation, 'construction', 'completed');
      const invoke = async <T>(run: () => Promise<T>): Promise<T> => {
        try { return await run(); }
        catch (error) { discard(); throw error; }
      };
      // Stub exceptions can permanently break the connection. Preserve this call's
      // result/error; only a later authorized entry may acquire another connection.
      const connection: DispatcherConnection = {
        fetch: (input, init) => invoke(() => child.fetch(input, init)),
        _cf_dispatchScheduledCallback: (ownerPath, row) => invoke(() => child._cf_dispatchScheduledCallback(ownerPath, row)),
        _cf_checkRunFibersForFacet: ownerPath => invoke(() => child._cf_checkRunFibersForFacet(ownerPath)),
      };
      return connection;
    })().catch(error => { discard(); throw error; });
    this.#dispatcher = { generation: lease.generation, facet };
    return facet;
  }

  /** Original class/env binding shared by execution and passive SQL, without acquiring or initializing a facet. */
  async #dispatcherClass(lease: DispatcherLease, plan: OperatorRuntimePlan, bundle: DispatcherBundle): Promise<unknown> {
    const loader = this.#appEnv.LOADER;
    if (!loader) throw new Error('Dispatcher host unavailable');
    const context = this.ctx as unknown as { exports: {
      OperatorDispatcherCapability(options: { props: { activityId: string; generation: number } }): Fetcher;
      OperatorDispatcherTail(options: { props: { activityId: string; generation: number } }): OperatorDispatcherTail;
    } };
    const props = { activityId: plan.activityId, generation: lease.generation,
      ...(executionLoggingEnabled(plan.receipt) ? {} : { loggingEnabled: false }) };
    const capability = context.exports.OperatorDispatcherCapability({ props });
    const tail = context.exports.OperatorDispatcherTail({ props });
    const admittedTarget = plan.prospectiveAdmissionId
      ? (await authorizeDispatcherPlan(plan, this.#appEnv)).admittedTarget : undefined;
    return loadOperatorDispatcherClass(loader, bundle, lease.artifactDigest,
      plan.activityId, lease.generation, capability, tail,
      JSON.parse(plan.invocationJson).pullRequest === undefined ? capability : null,
      JSON.parse(plan.invocationJson).pullRequest === undefined ? dispatcherGithubApiOrigin(this.#appEnv) : undefined,
      isManagementReceipt(plan.receipt) ? sourceResponseBytes(plan.receipt.selection.installation.policy) : undefined,
      admittedTarget ? JSON.stringify(admittedTarget) : undefined, executionLoggingEnabled(plan.receipt),
      isManagementReceipt(plan.receipt) ? submissionAttemptLimit(plan.receipt.selection.operator.policy) : undefined,
      lease.inferenceSelection);
  }

  /** SDK deadline callback and alarm/reconstruction reconciliation. Only exact persisted settlement can wait. */
  async reconcileDispatcherLease(expected?: { generation: number }): Promise<void> {
    this.#resumeDispatcherOnEntry(true, expected?.generation);
    if (this.#reconciling) return this.#reconciling;
    this.#reconciling = (async () => {
      let pendingLease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!pendingLease || (expected && expected.generation !== pendingLease.generation)
        || (pendingLease.status !== 'running' && pendingLease.status !== 'admitting')) return;
      if (!await this.dispatcherGenerationCurrent(pendingLease.generation)) {
        await this.interruptDrive(pendingLease.generation);
        return;
      }
      if (pendingLease.hosting === 'normal') {
        await this.#reconcileNormalDispatcher(pendingLease);
        return;
      }
      if (pendingLease.serial && pendingLease.status === 'admitting') {
        const token = pendingLease.serial.current.deliveryToken;
        try { await this.#admitDispatcherPhase(pendingLease.generation, token); }
        catch (error) {
          if (!(error instanceof DispatcherPhaseAdmissionError && error.definitive)) await this.#scheduleDispatcherRecheck(pendingLease);
          return;
        }
        pendingLease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!pendingLease?.serial || !this.#phaseTokenMatches(pendingLease, token)) return;
      }
      // Historical executions without an admission cursor are never re-read or replayed.
      if (pendingLease.status !== 'running' || !pendingLease.submissionId || !pendingLease.projection) return;
      const lease = pendingLease;
      const admission = await this.ctx.storage.get<AdmissionState>('admission');
      const loggingEnabled = executionLoggingEnabled(admission?.receipt);
      const operationLimit = dispatcherOperationLimit(admission?.receipt && isManagementReceipt(admission.receipt)
        ? admission.receipt.selection.operator.policy : undefined);
      let stage = 'status';
      let statusStep = 'plan';
      let activityId: string | undefined;
      let statusHttpStatus: number | undefined;
      try {
        const plan = await this.getRuntimePlan();
        if (!plan) throw new Error('Dispatcher plan unavailable');
        activityId = plan.activityId;
        const value = await this.#boundedDispatcher(lease, async () => {
          statusStep = 'facet';
          const child = await this.#dispatcherFacet(lease);
          statusStep = 'fetch';
          const url = new URL('https://flue.internal/agents/Dispatcher/dispatcher');
          url.searchParams.set('view', 'updates');
          url.searchParams.set('offset', lease.projection!.offset);
          const response = await child.fetch(new Request(url));
          this.#observeSdkHeader(lease.generation, response);
          statusStep = 'http';
          statusHttpStatus = response.status;
          if (!response.ok) throw new Error('Dispatcher status unavailable');
          statusStep = 'body';
          return readDispatcherUpdates(response, lease.projection!, lease.submissionId!,
            AbortSignal.timeout(Math.max(1, lease.expiresAt - Date.now())),
            isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined,
            envelope => !!lease.sdkProvenance && sourceMatches(envelope.source, lease.sdkProvenance)
              && this.#runtimeCoordinatesBound(lease, envelope), loggingEnabled);
        });
        const projectionSaved = await this.ctx.storage.transaction(async tx => {
          const record = await tx.get<AdmissionState>('admission');
          const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(record, current, lease.generation) || current!.submissionId !== lease.submissionId
            || current!.projection?.offset !== lease.projection!.offset
            || current!.projection?.position?.batch !== lease.projection!.position?.batch
            || current!.projection?.position?.index !== lease.projection!.position?.index) return false;
          await tx.put(DISPATCHER_LEASE, { ...current!, projection: value });
          return true;
        });
        if (!projectionSaved) return;
        const settlement = value.outcome ? { outcome: value.outcome, error: value.error } : null;
        if (settlement) this.#recordDiagnostic(lease.generation, 'settlement', settlement.outcome === 'completed' ? 'completed' : 'failed',
          settlement.outcome === 'completed' ? 'none' : 'settlement-failed', undefined, {}, 'host', undefined,
          value.errorMetadata, undefined, 'state-transition');
        if (!settlement || !value.upToDate) {
          stage = 'recheck';
          inferenceDiagnostic({ activityId: plan.activityId, generation: lease.generation, loggingEnabled }, { stage: 'settlement', outcome: 'pending', boundary: stage });
          // A child may settle just after this snapshot; the deadline alarm cannot
          // read it once the lease expires. Recheck within the original lease.
          await this.#scheduleDispatcherRecheck(lease, value.upToDate);
          return;
        }
        // SDK observations diagnose the producer/collector boundary, never authorize settlement.
        const completionCalls = value.completion?.calls ?? [];
        const trace = { activityId: plan.activityId, generation: lease.generation, loggingEnabled };
        inferenceDiagnostic(trace, { stage: 'settlement', outcome: settlement.outcome, assessmentPresent: value.result !== undefined, completionCalls: completionCalls.length });
        try {
          if (loggingEnabled) dispatcherLog.warn('Dispatcher settlement observed', {
            activityId: plan.activityId, generation: lease.generation, outcome: settlement.outcome,
            projectedWrites: value.writes, assessmentPresent: value.result !== undefined,
            messageCount: value.messageIds.length, completionCalls: completionCalls.length,
            completionSucceeded: completionCalls.filter(call => call.outcome === 'succeeded').length,
            completionFailed: completionCalls.filter(call => call.outcome === 'failed').length,
            completionPending: completionCalls.filter(call => call.outcome === 'pending').length,
            completionTruncated: value.completion?.truncated ?? false,
            unmatchedAssessment: value.unmatchedAssessment ?? false,
            ...(value.readiness ? {
              producerReadinessObserved: value.readiness.latest !== undefined,
              producerReadinessTruncated: value.readiness.truncated,
              ...(value.readiness.latest ? {
                producerCategory: value.readiness.latest.category,
                producerDiscovered: value.readiness.latest.discovered,
                producerSealed: value.readiness.latest.sealed,
                producerTargetCount: value.readiness.latest.targetCount,
                producerDecisionCount: value.readiness.latest.decisionCount,
                producerResultCount: value.readiness.latest.resultCount,
                producerUnknownOperationCount: value.readiness.latest.unknownOperationCount,
              } : {}),
            } : {}),
            ...(value.sealPreflight ? {
              producerSealObserved: value.sealPreflight.latest !== undefined,
              producerSealTruncated: value.sealPreflight.truncated,
              ...(value.sealPreflight.latest ? {
                producerSealCategory: value.sealPreflight.latest.category,
                producerSealTargetCount: value.sealPreflight.latest.targetCount,
                producerSealDecisionCount: value.sealPreflight.latest.decisionCount,
                producerSealSealed: value.sealPreflight.latest.sealed,
                producerSealOperationCount: value.sealPreflight.latest.operationCount,
                producerSealOperationLimit: value.sealPreflight.latest.operationLimit,
                producerSealRequiredOperationCount: value.sealPreflight.latest.requiredOperationCount,
              } : {}),
            } : {}),
          });
        } catch { /* Observability failure cannot prevent settlement or collection. */ }
        stage = 'authorize';
        const { admittedTarget } = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (lease.serial) {
          const token = lease.serial.current.deliveryToken;
          if (!await this.#dispatcherDeliveryCurrent(lease.generation, token)) return;
          const reply = this.#phaseReply(lease, value);
          if (lease.serial.current.phase.kind !== 'final') {
            const journal = await this.ctx.storage.transaction(tx => loadDispatcherJournal(tx, lease!.generation));
            if (journal.count >= dispatcherOperationLimit(isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined)) {
              await this.interruptDrive(lease.generation); return;
            }
            const next = advanceDispatcherPhase(lease.serial, this.#phaseAuthority(lease, plan), token, reply,
              { deliveryToken: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() },
              admittedTarget ? { pullRequest: admittedTarget.pullRequest, headSha: admittedTarget.headSha } : undefined);
            const saved = await this.ctx.storage.transaction(async tx => {
              const record = await tx.get<AdmissionState>('admission');
              const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
              if (!this.#leaseMatches(record, current, lease!.generation) || !this.#phaseTokenMatches(current, token)
                || current!.submissionId !== lease!.submissionId) return false;
              const { projection: _projection, ...retained } = current!;
              await tx.put<DispatcherLease>(DISPATCHER_LEASE, { ...retained, serial: next, status: 'admitting', submissionId: null });
              return true;
            });
            if (!saved) return;
            for (const flight of this.#inferenceFlights.values()) flight.controller.abort();
            for (const flight of this.#nativeFlights.values()) flight.controller.abort();
            this.#nativeBindings.clear();
            try { await this.#admitDispatcherPhase(lease.generation, next.current.deliveryToken); }
            catch (error) {
              if (error instanceof DispatcherPhaseAdmissionError && error.definitive) return;
              // Uncertain admission reattaches only the original durable identity and lease.
            }
            await this.#scheduleDispatcherRecheck(lease);
            return;
          }
          const assessment = collectDispatcherFinal(lease.serial, this.#phaseAuthority(lease, plan), token, reply);
          const saved = await this.ctx.storage.transaction(async tx => {
            const record = await tx.get<AdmissionState>('admission');
            const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
            if (!this.#leaseMatches(record, current, lease!.generation) || !this.#phaseTokenMatches(current, token)) return false;
            await tx.put(`dispatcher:result:${lease!.generation}`, assessment);
            if (!await this.#serialJournalAccounted(tx, current!, assessment)) return false;
            await tx.put<DispatcherLease>(DISPATCHER_LEASE, { ...current!, settledSubmissionId: lease!.submissionId! });
            return true;
          });
          if (!saved) { await this.interruptDrive(lease.generation); return; }
          const committed = await this.commitDrive(lease.generation, { schemaVersion: 1, status: 'completed', checkpoint: null, result: assessment });
          if (!committed.ok) await this.interruptDrive(lease.generation);
          else await this.collectBrowserResult(); // Future automatic attempts retain immutable collected terminal proof.
          return;
        }
        if (settlement.outcome !== 'completed' || !await this.dispatcherGenerationCurrent(lease.generation)) {
          const errorType = settlement.error?.type ?? '';
          const reason = settlement.error?.meta?.reason ?? '';
          const label = settlement.error?.meta?.operation;
          const operation = errorType !== 'operation_failed' ? 'unknown'
            : label === 'prompt' ? 'prompt'
              : label === 'direct' ? 'direct' : 'unknown';
          const failureClass = operation === 'unknown' ? 'unknown'
            : reason === 'Stream ended without finish_reason (retryable_interruption)' ? 'model-completion'
              : reason === 'the session advanced past this input before it completed' ? 'superseded'
                : reason === 'the input could not be persisted' ? 'persistence' : 'unknown';
          inferenceDiagnostic(trace, { stage: 'settlement', outcome: 'failed', failureClass });
          let reasonDigest: string | null = null;
          try { if (loggingEnabled && reason) reasonDigest = await sha256(reason); }
          catch { /* Diagnostic fingerprint failure cannot change failed settlement. */ }
          if (loggingEnabled) dispatcherLog.warn('Dispatcher settlement rejected', { stage: 'outcome',
            activityId: plan.activityId, generation: lease.generation, operation, failureClass,
            outcome: ['failed', 'aborted', 'completed'].includes(settlement.outcome) ? settlement.outcome : 'unrecognized',
            errorType: ['cloudflare_ai_binding_error', 'invalid_request', 'tool_input_validation',
              'tool_output_validation', 'operation_failed', 'submission_timeout', 'submission_aborted',
              'internal_error'].includes(errorType) ? errorType : 'other',
            ...(value.tools ? { sdkToolObservations: value.tools.calls.length,
              sdkToolFailed: value.tools.calls.filter(call => call.outcome === 'failed').length,
              sdkToolsTruncated: value.tools.truncated,
              lastToolRole: value.tools.calls.at(-1)?.role ?? 'none',
              lastToolOutcome: value.tools.calls.at(-1)?.outcome ?? 'none' } : {}),
            ...(value.settlementDiagnostic ?? { reasonAvailable: reason.length > 0, reasonDigest,
            reasonCode: sdkPublicReasonCode(reason), reasonBytes: new TextEncoder().encode(reason).length,
            reasonClass: [
              /\b(model|provider|api key|cloudflare_ai)\b/i.test(reason) ? 'model' : null,
              /\b(facet|rpc|schedule|bridge)\b/i.test(reason) ? 'bridge' : null,
              /\b(fetch|network|gateway|http)\b/i.test(reason) ? 'transport' : null,
              /\b(conversation|stream|persist|storage)\b/i.test(reason) ? 'state' : null,
              /\b(tool|function)\b/i.test(reason) ? 'tool' : null,
              /\b(undefined|not a function|cannot read properties)\b/i.test(reason) ? 'runtime-shape' : null,
            ].filter(Boolean).join(',') || 'none' }) });
          await this.interruptDrive(lease.generation, { boundary: 'settlement', code: 'settlement-failed' }); return;
        }
        stage = 'assessment';
        const assessmentParts = value.writes === 1 ? [{ data: value.result }] : [];
        inferenceDiagnostic(trace, { stage: 'assessment', outcome: 'observed', assessmentPresent: value.result !== undefined });
        if (assessmentParts.length !== 1 || !z.json().safeParse(assessmentParts[0].data).success
          || !assessmentParts[0].data || typeof assessmentParts[0].data !== 'object'
          || Array.isArray(assessmentParts[0].data)
          || new TextEncoder().encode(JSON.stringify(assessmentParts[0].data)).byteLength > dispatcherCapacities(isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined).assessmentBytes
          || (admittedTarget && !admittedDispatcherResultMatches(assessmentParts[0].data, admittedTarget, isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined))) {
          inferenceDiagnostic(trace, { stage: 'assessment', outcome: 'denied', failureClass: 'assessment' });
          if (loggingEnabled) dispatcherLog.warn('Dispatcher settlement rejected', { stage: 'assessment' });
          this.#recordDiagnostic(lease.generation, 'settlement', 'failed', 'settlement-failed');
          await this.interruptDrive(lease.generation, { boundary: 'settlement', code: 'settlement-failed' }); return;
        }
        stage = 'operations';
        // An unsettled protected operation is not a safe checkpoint, even if Flue says completed.
        const journal = await this.ctx.storage.transaction(tx => loadDispatcherJournal(tx, lease.generation));
        if (journal.unresolved !== 0) {
          if (loggingEnabled) dispatcherLog.warn('Dispatcher settlement rejected', { stage: 'operations' });
          this.#recordDiagnostic(lease.generation, 'settlement', 'failed', 'settlement-failed');
          await this.interruptDrive(lease.generation, { boundary: 'settlement', code: 'settlement-failed' }); return;
        }
        await this.ctx.storage.transaction(async tx => {
          const record = await tx.get<AdmissionState>('admission');
          const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(record, current, lease.generation)
            || current!.submissionId !== lease.submissionId) throw new Error('Stale Dispatcher settlement');
          if ((await loadDispatcherJournal(tx, lease.generation)).unresolved !== 0) throw new Error('Unresolved Dispatcher settlement');
          await tx.put(DISPATCHER_LEASE, { ...current!, settledSubmissionId: lease.submissionId });
          await tx.put(`dispatcher:result:${lease.generation}`, assessmentParts[0].data);
        });
        stage = 'commit';
        const legacy = JSON.parse(plan.invocationJson).pullRequest !== undefined;
        const committed = await this.commitDrive(lease.generation, { schemaVersion: 1,
          status: legacy ? 'waiting' : 'completed',
          checkpoint: legacy ? { submissionId: lease.submissionId, inputDigest: lease.inputDigest,
            artifactDigest: lease.artifactDigest } : null,
          result: legacy ? null : assessmentParts[0].data });
        if (!committed.ok) {
          if (loggingEnabled) dispatcherLog.warn('Dispatcher settlement rejected', { stage: 'commit', reason: committed.reason });
          this.#recordDiagnostic(lease.generation, 'settlement', 'failed', 'settlement-failed');
          await this.interruptDrive(lease.generation, { boundary: 'settlement', code: 'settlement-failed' });
        }
      } catch (error) {
        this.#recordDiagnostic(lease.generation, 'settlement', 'failed', 'settlement-failed', error);
        if (stage === 'status' && statusStep === 'fetch' && lease.serial?.current.receipt) {
          try {
            const latest = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
            // A late observation cannot retire a different generation or phase.
            if (latest && (latest.generation !== lease.generation || latest.submissionId !== lease.submissionId
              || latest.serial?.current.deliveryToken !== lease.serial.current.deliveryToken)) return;
            const authorized = await this.#dispatcherDeliveryCurrent(lease.generation, lease.serial.current.deliveryToken);
            const unchanged = authorized && await this.ctx.storage.transaction(async tx => {
              const record = await tx.get<AdmissionState>('admission');
              const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
              if (!this.#leaseMatches(record, current, lease.generation) || current!.status !== 'running'
                || current!.submissionId !== lease.submissionId || current!.expiresAt !== lease.expiresAt
                || current!.inputDigest !== lease.inputDigest || current!.artifactDigest !== lease.artifactDigest
                || !sameDispatcherPhaseValue(current!.serial, lease.serial)
                || !sameDispatcherPhaseValue(current!.projection, lease.projection)) return false;
              const journal = await loadDispatcherJournal(tx, lease.generation);
              if (journal.count >= operationLimit) return false;
              let startAfter: string | undefined;
              for (;;) {
                const page = await tx.list<DispatcherOperationRecord>({ prefix: `dispatcher:operation:${lease.generation}:`, limit: 128,
                  ...(startAfter ? { startAfter } : {}) });
                for (const [key, entry] of page) {
                  startAfter = key;
                  if (entry.phase === 'completed') continue;
                  const binding = entry.phaseBinding;
                  if (entry.generation !== lease.generation || !binding) return false;
                  if (entry.phase !== 'unknown') continue;
                  if (binding.phase.kind !== 'target'
                    || !sameDispatcherPhaseValue(current!.serial?.targets?.[binding.phase.index], binding.phase.target)) return false;
                }
                if (page.size < 128) break;
              }
              return true;
            });
            if (unchanged) { await this.#scheduleDispatcherRecheck(lease); return; }
          } catch { /* An unavailable authority/integrity check still takes the existing fence. */ }
        }
        const message = error instanceof Error ? error.message : '';
        const failureClass = message === 'Dispatcher body exceeds limit' ? 'body-limit'
          : message === 'Dispatcher lease expired' ? 'lease-expired'
            : message === 'Dispatcher status unavailable' ? 'http-rejected'
              : error instanceof SyntaxError ? 'invalid-json'
                : error instanceof TypeError ? 'type-error'
                  : error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'other';
        if (loggingEnabled) dispatcherLog.warn('Dispatcher settlement rejected', { stage, activityId, generation: lease.generation,
          ...(stage === 'status' ? { statusStep, failureClass,
            ...(statusHttpStatus === undefined ? {} : { statusHttpStatus }) } : {}) });
        await this.interruptDrive(lease.generation, { boundary: 'settlement', code: 'settlement-failed', error: captureError(error) });
      }
    })();
    try { await this.#reconciling; } finally {
      this.#reconciling = undefined;
      if (this.#dispatcherTerminalWake) {
        this.#dispatcherTerminalWake = false;
        this.ctx.waitUntil(this.reconcileDispatcherLease(expected));
      }
    }
  }

  /** REQ-OPERATOR-047: durable intent precedes protected I/O; uncertain effects are never replayed. */
  /** Supplemental, non-authorizing child telemetry; never reserves a protected operation. */
  /** Original-bound, diagnostic-only import. Does not resume or authorize work, including after retirement. */
  async dispatcherRuntimeDiagnostic(generation: number, request: Request): Promise<Response> {
    const response = (status: number) => new Response(null, { status, headers: { 'cache-control': 'no-store' } });
    const state = await this.ctx.storage.get<AdmissionState>('admission').catch(() => undefined);
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE).catch(() => undefined);
    if (!state || !lease || !this.#diagnosticBindingValid(state, lease) || lease.generation !== generation) return response(409);
    if (!lease.sdkProvenance) return response(403);
    if (request.method !== 'POST' || new URL(request.url).href !== 'https://operator.internal/v1/dispatcher/diagnostic/runtime'
      || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return response(400);
    let value: unknown;
    try { value = JSON.parse(await readDispatcherBody(request, AbortSignal.timeout(250), 8192)); }
    catch (error) {
      this.#enqueueDiagnostic(() => this.ctx.storage.transaction(tx => diagnosticLoss(tx, lease, 'rejected')));
      return response(error instanceof Error && error.message === 'Dispatcher body exceeds limit' ? 413 : 400);
    }
    const parsed = runtimeSchema.safeParse(value);
    if (!parsed.success) {
      this.#enqueueDiagnostic(() => this.ctx.storage.transaction(tx => diagnosticLoss(tx, lease, 'rejected')));
      return response(400);
    }
    if (!sourceMatches(parsed.data.source, lease.sdkProvenance) || !this.#runtimeCoordinatesBound(lease, parsed.data)) return response(409);
    if (!executionLoggingEnabled(state.receipt)) return response(204);
    try { await this.#diagnosticQueue; await this.#importRuntimeEnvelope(generation, parsed.data); return response(204); }
    catch { return response(503); }
  }

  #diagnosticBindingValid(state: AdmissionState, lease: DispatcherLease): boolean {
    return !!state.receipt && isManagementReceipt(state.receipt) && state.receipt.selection.operator.profile === 'dispatcher'
      && state.receipt.intentDigest === lease.inputDigest && state.receipt.selection.release.bundleDigest === lease.artifactDigest
      && state.executionContext?.artifactDigest === lease.artifactDigest;
  }

  #runtimeCoordinatesBound(lease: DispatcherLease, envelope: RuntimeEnvelope): boolean {
    const sdk = envelope.sdk;
    const rootDigest = lease.rootDigest ?? (lease.serial?.uid ? hashDiagnostic(lease.serial.uid) : undefined);
    if (sdk?.rootUid !== undefined && hashDiagnostic(sdk.rootUid) !== rootDigest) return false;
    if (sdk?.submissionId !== undefined && sdk.submissionId !== lease.submissionId
      && !lease.serial?.previous.some(previous => previous.submissionId === sdk.submissionId)) return false;
    return true;
  }

  async #importRuntimeEnvelope(generation: number, envelope: RuntimeEnvelope): Promise<void> {
    await this.ctx.storage.transaction(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!state || !lease || !this.#diagnosticBindingValid(state, lease) || lease.generation !== generation
        || !lease.sdkProvenance || !sourceMatches(envelope.source, lease.sdkProvenance)
        || !this.#runtimeCoordinatesBound(lease, envelope)) throw new Error('Diagnostic binding changed');
      if (!executionLoggingEnabled(state.receipt)) return;
      const sdk = envelope.sdk;
      const correlation: Correlation = {};
      if (sdk?.rootUid) correlation.rootDigest = hashDiagnostic(sdk.rootUid);
      if (sdk?.submissionId) correlation.submissionDigest = hashDiagnostic(sdk.submissionId);
      if (sdk?.attemptId) correlation.sdkAttemptDigest = hashDiagnostic(sdk.attemptId);
      if (sdk?.streamIncarnation) correlation.streamIncarnationDigest = hashDiagnostic(sdk.streamIncarnation);
      if (sdk?.batchSequence !== undefined) correlation.sdkBatchSequence = sdk.batchSequence;
      if (sdk?.producerEpoch !== undefined) correlation.sdkProducerEpoch = sdk.producerEpoch;
      if (sdk?.producerSequence !== undefined) correlation.sdkProducerSequence = sdk.producerSequence;
      if (sdk?.recordIndex !== undefined) correlation.sdkRecordIndex = sdk.recordIndex;
      await appendDiagnostic(tx, lease, { timestamp: envelope.timestamp, boundary: envelope.boundary, outcome: envelope.outcome,
        code: envelope.code, origin: envelope.origin, source: envelope.source, owner: 'sdk', evidence: 'observed', correlation,
        ...(envelope.error ? { error: envelope.error } : {}) }, { captureId: envelope.captureId, runtime: envelope });
    });
  }

  #observeSdkHeader(generation: number, response: Response): void {
    const header = readSdkDiagnosticHeader(response);
    if (!header) return;
    this.#enqueueDiagnostic(async () => {
      for (const envelope of header.records) await this.#importRuntimeEnvelope(generation, envelope);
      await this.ctx.storage.transaction(async tx => {
        const state = await tx.get<AdmissionState>('admission');
        const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (state && lease?.generation === generation && this.#diagnosticBindingValid(state, lease)
          && lease.sdkProvenance && executionLoggingEnabled(state.receipt)) await observeOutbox(tx, lease, header.outbox);
      });
    });
  }

  async dispatcherDiagnosticReport(generation: number, request: Request): Promise<Response> {
    this.#resumeDispatcherOnEntry();
    const denied = () => Response.json({ code: 'OPERATOR_CAPABILITY_DENIED' }, { status: 403 });
    try {
      if (!await this.dispatcherGenerationCurrent(generation)) return denied();
      const diagnostic = await readDispatcherDiagnostic(request);
      if (!diagnostic) return denied();
      const plan = await this.getRuntimePlan();
      if (!plan) return denied();
      await authorizeDispatcherPlan(plan, this.#appEnv);
      if (!await this.dispatcherGenerationCurrent(generation)) return denied();
      if (this.#diagnosticReportGeneration !== generation) {
        this.#diagnosticReportGeneration = generation;
        this.#diagnosticReports = 0;
        this.#producerReports = 0;
        this.#producerFailureReports = 0;
      }
      if (!executionLoggingEnabled(plan.receipt)) return new Response(null, { status: 204 });
      // Informational reports cannot exhaust the separately reserved failure budget.
      // No await between each cap and increment; neither channel reserves an operation.
      if (diagnostic.stage === 'producer') {
        if (diagnostic.outcome === 'failed') {
          if (this.#producerFailureReports >= 64) return new Response(null, { status: 429 });
          this.#producerFailureReports++;
        } else {
          if (this.#producerReports >= 2048) return new Response(null, { status: 429 });
          this.#producerReports++;
        }
        const errorKind = diagnostic.errorKind && diagnostic.errorKind !== 'none' ? diagnostic.errorKind : undefined;
        const hasTransport = diagnostic.transportStatus !== undefined || diagnostic.transportReason !== undefined
          || diagnostic.transportDisposition !== undefined;
        const lineage = errorKind || hasTransport ? {
          kind: errorKind ?? 'other' as const, publicCode: diagnostic.code, messageDigest: diagnostic.errorDigest ?? null,
          stackDigest: diagnostic.errorStackDigest ?? null, causes: (diagnostic.errorCauseDigests ?? []).map(messageDigest =>
            ({ kind: 'other' as const, messageDigest, stackDigest: null })), loss: diagnostic.errorCaptureLoss ?? [],
          fingerprintScope: !diagnostic.errorDigest && !diagnostic.errorStackDigest && !diagnostic.errorCauseDigests?.length
            ? 'unavailable' as const : diagnostic.errorCaptureLoss?.length ? 'bounded' as const : 'full' as const,
          ...(diagnostic.transportStatus === undefined ? {} : { transportStatus: diagnostic.transportStatus }),
          ...(diagnostic.transportReason === undefined ? {} : { transportReason: diagnostic.transportReason }),
          ...(diagnostic.transportDisposition === undefined ? {} : { transportDisposition: diagnostic.transportDisposition }),
        } : undefined;
        const family: Boundary = diagnostic.phase === 'finish' || diagnostic.role === 'finish' ? 'settlement'
          : diagnostic.role === 'provider' ? 'model' : 'tool';
        const code: ReasonCode = diagnostic.outcome === 'failed' ? family === 'model' ? 'provider-failed'
          : family === 'settlement' ? 'settlement-failed' : 'tool-failed' : 'none';
        this.#enqueueDiagnostic(async () => {
          await this.ctx.storage.transaction(async tx => {
            const state = await tx.get<AdmissionState>('admission');
            const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
            if (!state || lease?.generation !== generation || !executionLoggingEnabled(state.receipt)) return;
            await appendDiagnostic(tx, lease, { timestamp: Date.now(), owner: 'producer', boundary: family,
              outcome: diagnostic.outcome === 'unavailable' ? 'unknown' : diagnostic.outcome, code, origin: 'catching',
              evidence: 'observed', source: { ...hostSource(family), package: '@codeflare/operator-dispatcher' }, correlation: {},
              ...(lineage ? { error: lineage } : {}) });
          });
        });
        const observation = { activityId: plan.activityId, generation, ...diagnostic };
        if (diagnostic.outcome === 'failed' || diagnostic.outcome === 'unavailable') {
          dispatcherReportLog.warn('Dispatcher producer diagnostic', observation);
        } else dispatcherReportLog.info('Dispatcher producer diagnostic', observation);
      } else {
        if (this.#diagnosticReports >= 8) return new Response(null, { status: 429 });
        this.#diagnosticReports++;
        dispatcherReportLog.warn('Dispatcher child inference diagnostic', {
          activityId: plan.activityId, generation, stage: diagnostic.stage,
          ...(diagnostic.stage === 'http-rejected' ? { status: diagnostic.status } : {}),
        });
      }
      return new Response(null, { status: 204 });
    } catch { return denied(); }
  }

  async dispatcherOperation(generation: number, request: Request): Promise<Response> {
    this.#resumeDispatcherOnEntry();
    const diagnosticState = await this.ctx.storage.get<AdmissionState>('admission').catch(() => undefined);
    const loggingEnabled = executionLoggingEnabled(diagnosticState?.receipt);
    const trace: InferenceDiagnosticContext | undefined = diagnosticState ? { activityId: diagnosticState.intent.activityId, generation, loggingEnabled } : undefined;
    const began = performance.now();
    const deliveryToken = request.headers.get('x-codeflare-dispatcher-delivery') ?? undefined;
    const modelScope = new URL(request.url).pathname === '/v1/dispatcher/inference';
    const denied = (reason: DispatcherRefusalReason = 'execution-inactive') => {
      inferenceDiagnostic(trace, { stage: 'authority', outcome: 'denied' });
      return dispatcherRefusal(reason);
    };
    const deadline = (lease?: DispatcherLease) => !lease ? 'unavailable'
      : lease.expiresAt <= Date.now() ? 'expired' : 'current';
    const rejected = (stage: 'reservation' | 'effect' | 'authority' | 'upstream' | 'forwarded-upstream' | 'commit',
      resource: 'unparsed' | 'inference' | 'pull-request' | 'files' | 'checks' | 'release-notes' | 'upstream-guide' | 'changed-compose' | 'open-pull-requests' | 'comment' | 'merge' | 'source',
      lease: DispatcherLease | undefined, status: number, upstreamStatus?: number) => {
      if (loggingEnabled) dispatcherLog.warn('Dispatcher operation rejected', { stage, resource, deadline: deadline(lease), status,
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }) });
    };
    if (!await this.#dispatcherDeliveryCurrent(generation, deliveryToken, modelScope)) {
      this.#recordDiagnostic(generation, 'admission', 'failed', 'authority-denied');
      rejected('authority', 'unparsed', await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE).catch(() => undefined), 403);
      return denied();
    }
    let operation: Awaited<ReturnType<typeof parseDispatcherOperation>>;
    let normalInference: { operationId: string; context: { messages: z.infer<ReturnType<typeof z.json>>[] };
      options: Record<string, unknown>;
      requestDigest: string } | undefined;
    let perform: () => Promise<Response>;
    let sourceBytes = DEFAULT_SOURCE_RESPONSE_BYTES;
    let inferenceBytes = inferenceRequestBytes();
    let limits = dispatcherCapacities();
    let operationLimit = DEFAULT_DISPATCHER_OPERATION_LIMIT;
    let lease: DispatcherLease | undefined;
    let effectContext: NonNullable<Parameters<typeof createDispatcherOperation>[0]['effectContext']> | undefined;
    let preparationStep: 'parse' | 'capability' = 'parse';
    let inferenceCountObservation: DispatcherInferenceCountObservation | undefined;
    let bodyOverflow: DispatcherBodyOverflowObservation | undefined;
    let preparationCorrelation: Correlation = {};
    const preparationUrl = new URL(request.url);
    const preparationRoute: DiagnosticPreparation['route'] = preparationUrl.origin !== 'https://operator.internal' ? 'unknown'
      : preparationUrl.pathname === '/v1/dispatcher/inference' ? 'inference'
        : preparationUrl.pathname === '/v1/dispatcher/source' ? 'source'
          : preparationUrl.pathname === '/v1/dispatcher/github/read' ? 'github-read'
            : preparationUrl.pathname === '/v1/dispatcher/github/comment' ? 'github-comment'
              : preparationUrl.pathname === '/v1/dispatcher/github/merge' ? 'github-merge'
                : preparationUrl.pathname === '/v1/dispatcher/receipt' ? 'receipt'
                  : preparationUrl.pathname === '/v1/dispatcher/resolve' ? 'resolve' : 'unknown';
    try {
      lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!lease) {
        rejected('authority', 'unparsed', undefined, 403);
        return denied();
      }
      if (loggingEnabled && lease.generation === generation && lease.serial && lease.submissionId
        && deliveryToken && this.#phaseTokenMatches(lease, deliveryToken, true, modelScope)) {
        preparationCorrelation = { deliveryDigest: hashDiagnostic(deliveryToken), submissionDigest: hashDiagnostic(lease.submissionId) };
      }
      const plan = await this.getRuntimePlan();
      if (!plan) return denied();
      const capacityPolicy = isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined;
      limits = dispatcherCapacities(capacityPolicy);
      inferenceBytes = inferenceRequestBytes(capacityPolicy);
      operationLimit = dispatcherOperationLimit(isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined);
      if (lease.hosting === 'normal' && preparationUrl.pathname === '/v1/dispatcher/inference') {
        if (preparationUrl.href !== 'https://operator.internal/v1/dispatcher/inference' || request.method !== 'POST'
          || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return denied('request-invalid');
        const raw: unknown = JSON.parse(await this.#boundedDispatcher(lease, () => readDispatcherBody(request, request.signal, inferenceBytes)));
        const parsed = z.strictObject({ operationId: syncIdentity,
          context: z.looseObject({ messages: z.array(z.json()).min(1).max(limits.inferenceMessageLimit),
            systemPrompt: z.string().optional(), tools: z.array(z.json()).max(limits.inferenceToolLimit).optional() }),
          options: z.strictObject({ reasoning: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
            maxTokens: z.number().int().positive().max(limits.inferenceTokenLimit).optional(), temperature: z.number().optional(),
            toolChoice: z.json().optional(), thinkingBudgets: z.record(z.string(), z.number().int().nonnegative().max(limits.inferenceTokenLimit)).optional(),
            cacheRetention: z.enum(['none', 'short', 'long']).optional(), sessionId: z.string().min(1).max(512).optional() }), requestDigest: syncDigest.optional(),
        }).parse(raw);
        // Validate without reordering the original normalized transcript/options before digesting or forwarding.
        const original = raw as typeof parsed;
        const requestDigest = await sha256(JSON.stringify({ context: original.context, options: original.options }));
        if (original.requestDigest !== undefined && original.requestDigest !== requestDigest) return denied('request-invalid');
        normalInference = { ...original, requestDigest };
        operation = { operationId: normalInference.operationId, path: preparationUrl.pathname, body: normalInference, signal: request.signal };
      } else {
        operation = await this.#boundedDispatcher(lease, () => parseDispatcherOperation(request, inferenceBytes, capacityPolicy,
          loggingEnabled ? value => { inferenceCountObservation = value; } : undefined,
          loggingEnabled ? value => { bodyOverflow = value; } : undefined));
        if (operation.path === '/v1/dispatcher/inference' && lease.inferenceSelection) return denied('policy-denied');
      }
      preparationStep = 'capability';
      if (trace) trace.requestDigest = hashDiagnostic(JSON.stringify({ path: operation.path, body: operation.body }));
      if (operation.path === '/v1/dispatcher/source' && isManagementReceipt(plan.receipt)) {
        sourceBytes = sourceResponseBytes(plan.receipt.selection.installation.policy);
      }
      if (operation.path === '/v1/dispatcher/receipt' || operation.path === '/v1/dispatcher/resolve') {
        const { authority, policy } = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (!policy.capabilities.includes('fetch')) return denied('policy-denied');
        if (!await operatorAccessSessionCurrent(authority.human, authority.accessJwt)) return denied('authority-unverified');
        if (JSON.parse(plan.invocationJson).pullRequest !== undefined) return denied('request-invalid');
        const value = operation.body as { operationId: string; requestDigest?: string;
          readbacks?: Array<{ operationId: string; requestDigest: string; responseDigest: string }> };
        return await this.ctx.storage.transaction(async tx => {
          const record = await tx.get<AdmissionState>('admission');
          const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(record, live, generation) || !this.#phaseTokenMatches(live, deliveryToken, true, modelScope)) return denied();
          const journal = await loadDispatcherJournal(tx, generation);
          const original = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, value.operationId));
          if (!original?.request || original.generation !== generation) return denied('receipt-unavailable');
          if (operation.path.endsWith('/receipt')) return Response.json({ operationId: value.operationId,
            generation, requestDigest: original.requestDigest, ...original.request, phase: original.phase,
            operationCount: journal.count, operationLimit,
            ...(original.responseDigest ? { responseDigest: original.responseDigest } : {}) });
          if (original.requestDigest !== value.requestDigest) return dispatcherRefusal('operation-conflict', 409, 'OPERATOR_OPERATION_CONFLICT');
          const readbacks = value.readbacks!;
          if (original.request.method === 'GET' || new Set(readbacks.map(item => item.operationId)).size !== readbacks.length) return denied('request-invalid');
          if (original.resolution) return JSON.stringify(original.resolution.readbacks) === JSON.stringify(readbacks)
            ? Response.json({ resolved: true, operationId: value.operationId, requestDigest: original.requestDigest })
            : dispatcherRefusal('operation-conflict', 409, 'OPERATOR_OPERATION_CONFLICT');
          if (original.phase !== 'unknown') return denied('receipt-unavailable');
          for (const reference of readbacks) {
            const readback = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, reference.operationId));
            if (!readback || readback.generation !== generation || readback.phase !== 'completed'
              || readback.request?.method !== 'GET' || original.ordinal === undefined || readback.ordinal === undefined
              || readback.ordinal <= original.ordinal || readback.requestDigest !== reference.requestDigest
              || readback.responseDigest !== reference.responseDigest) return dispatcherRefusal('effect-uncertain', 409, 'OPERATOR_OPERATION_UNKNOWN');
            const receipt = await tx.get<NonNullable<DispatcherOperationRecord['response']>>(`dispatcher:response:${reference.operationId}`);
            if (!receipt || receipt.status !== 200 || JSON.parse(receipt.body).status < 200
              || JSON.parse(receipt.body).status >= 300) return dispatcherRefusal('effect-uncertain', 409, 'OPERATOR_OPERATION_UNKNOWN');
          }
          const resolved = { resolved: true, operationId: value.operationId, requestDigest: original.requestDigest };
          const response = { status: 200, contentType: 'application/json', body: JSON.stringify(resolved) };
          await tx.put(`dispatcher:response:${value.operationId}`, response);
          await putDispatcherEntry(tx, journal, value.operationId, original, { ...original,
            phase: 'completed', resolution: { readbacks }, responseDigest: await sha256(response.body) });
          return Response.json(resolved);
        });
      }
      effectContext = { reconcileOnly: false, authorize: async () => {
        const { authority } = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (!await operatorAccessSessionCurrent(authority.human, authority.accessJwt)) throw new Error('Dispatcher effect session unavailable');
        const rawUser = await this.#appEnv.KV.get(`user:${authority.human.email.toLowerCase()}`);
        let user: unknown;
        try { user = rawUser ? JSON.parse(rawUser) : null; } catch { throw new Error('Dispatcher effect role unavailable'); }
        if (!user || typeof user !== 'object' || Array.isArray(user) || (user as { role?: unknown }).role !== 'admin'
          || !await this.#dispatcherDeliveryCurrent(generation, deliveryToken, modelScope)) throw new Error('Dispatcher effect authority unavailable');
      } };
      if (operation.path === '/v1/dispatcher/github/comment' || operation.path === '/v1/dispatcher/github/merge') await effectContext.authorize();
      const phaseLease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!this.#phaseTokenMatches(phaseLease, deliveryToken, true, modelScope)) return denied();
      if (normalInference) {
        const { policy } = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (!policy.capabilities.includes('inference') || plan.authFailure || !lease.configuredSelection) return denied('policy-denied');
        const configuredOperation = normalInference;
        const selection = lease.configuredSelection;
        perform = async () => {
          try { return await forwardDispatcherOwnerInference({ plan: { ...plan, deadline: Math.min(plan.deadline, lease!.expiresAt) },
            generation, env: this.#appEnv, operation: configuredOperation, selection, signal: request.signal,
            waitUntil: promise => this.ctx.waitUntil(promise),
            current: () => this.#dispatcherDeliveryCurrent(generation, deliveryToken, modelScope) }); }
          catch (error) { if (error instanceof PiAuthRequiredError) await this.#nativeLoginStop(generation, error.authFailure); throw error; }
        };
      } else perform = await createDispatcherOperation({ plan, env: this.#appEnv, operation, effectContext, diagnosticContext: trace,
        ...(phaseLease?.serial ? { phase: { repository: JSON.parse(plan.invocationJson).repository,
          value: phaseLease.serial.current.phase } } : {}),
        current: () => this.#dispatcherDeliveryCurrent(generation, deliveryToken, modelScope),
        exports: (this.ctx as unknown as { exports: Parameters<typeof createDispatcherOperation>[0]['exports'] }).exports });
    } catch (error) {
      emitRaw(trace, 'operation-preparation-failure', () => error);
      const refusalReason = preparationStep === 'parse' || error instanceof z.ZodError || error instanceof SyntaxError
        ? 'request-invalid' : error instanceof DispatcherRefusal ? error.reason : 'authority-unverified';
      try {
        const failureClass = preparationStep === 'capability' ? 'authority-denied' : bodyOverflow ? 'body-limit'
          : error instanceof SyntaxError ? 'invalid-json' : error instanceof z.ZodError ? 'invalid-wire' : 'request-denied';
        const refusal = dispatcherRefusalBody(refusalReason);
        const metadata: ErrorMetadata = { ...captureError(error), transportStatus: 403,
          transportReason: refusal.reason, transportDisposition: refusal.disposition };
        this.#recordDiagnostic(generation, preparationStep === 'parse' ? 'tool' : 'admission', 'failed',
          preparationStep === 'parse' ? 'tool-failed' : 'authority-denied', undefined,
          { ...preparationCorrelation, ...(trace?.requestDigest ? { requestDigest: trace.requestDigest } : {}) },
          'host', undefined, metadata, undefined, bodyOverflow ? 'originating' : 'catching',
          loggingEnabled ? { step: preparationStep, failureClass, route: preparationRoute, ...bodyOverflow } : undefined);
        // Fixed diagnostic wire only; no diagnostic I/O is awaited before returning the original refusal.
        if (loggingEnabled && diagnosticState) dispatcherLog.warn('Dispatcher operation rejected', {
          stage: 'preparation', preparationStep, failureClass, activityId: diagnosticState.intent.activityId,
          generation, resource: 'unparsed', deadline: deadline(lease), status: 403,
          ...(preparationStep === 'parse' && error instanceof z.ZodError ? { ...dispatcherWireRules(error),
            ...inferenceCountObservation } : {}) });
      } catch { /* Observability cannot replace the original denial. */ }
      return denied(refusalReason);
    }
    const resource = operation.path === '/v1/dispatcher/inference' ? 'inference'
      : operation.path === '/v1/dispatcher/source' ? 'source'
      : operation.path === '/v1/dispatcher/github/comment' ? 'comment'
        : operation.path === '/v1/dispatcher/github/merge' ? 'merge'
          : (operation.body as { resource: 'pull-request' | 'files' | 'checks' | 'release-notes' | 'upstream-guide' | 'changed-compose' | 'open-pull-requests' }).resource;
    const requestDigest = trace?.requestDigest ?? await sha256(JSON.stringify({ path: operation.path, body: operation.body }));
    inferenceDiagnostic(trace, { stage: 'operation-prepared', outcome: 'completed', resource }, () => operation);
    if (!normalInference && resource === 'inference' && lease?.inferenceRecovery?.version === 1) {
      return this.#recoverDispatcherInference(generation, operation, requestDigest, lease, inferenceBytes, operationLimit, trace, deliveryToken);
    }
    const reserved = await this.ctx.storage.transaction(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!this.#leaseMatches(record, lease, generation) || !this.#phaseTokenMatches(lease, deliveryToken, true, modelScope)) return { kind: 'denied', reason: 'lease-mismatch',
        activityId: record?.intent.activityId, lease } as const;
      const journal = await loadDispatcherJournal(tx, generation);
      const prior = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operation.operationId));
      if (prior) {
        if (prior.requestDigest !== requestDigest) return { kind: 'conflict', ordinal: prior.ordinal, operationCount: journal.count } as const;
        if (prior.phase === 'completed') {
          const response = await tx.get<NonNullable<DispatcherOperationRecord['response']>>(`dispatcher:response:${operation.operationId}`);
          if (response) return { kind: 'completed', response, responseDigest: prior.responseDigest, ordinal: prior.ordinal, operationCount: journal.count } as const;
          await putDispatcherEntry(tx, journal, operation.operationId, prior, { ...prior, phase: 'unknown' });
          return { kind: 'unknown', lease: lease!, ordinal: prior.ordinal, operationCount: journal.count } as const;
        }
        await putDispatcherEntry(tx, journal, operation.operationId, prior, { ...prior, phase: 'unknown' });
        return { kind: 'unknown', lease: lease!, ordinal: prior.ordinal, operationCount: journal.count } as const;
      }
      const operationCount = journal.count;
      if (operationCount >= operationLimit) return { kind: 'denied', reason: 'operation-limit',
        activityId: record!.intent.activityId, lease, operationCount } as const;
      await putDispatcherEntry(tx, journal, operation.operationId, undefined, {
        generation, requestDigest, phase: 'reserved', ordinal: journal.nextOrdinal,
        ...(lease!.serial ? { phaseBinding: this.#operationPhase(lease!, resource) } : {}), ...(operation.path === '/v1/dispatcher/source'
          ? { request: { method: (operation.body as { method?: 'GET' | 'POST' | 'PUT' }).method ?? 'GET',
            url: (operation.body as { url: string }).url } } : {}) });
      return { kind: 'reserved', lease: lease!, ordinal: journal.nextOrdinal, operationCount: journal.count + 1 } as const;
    });
    if (reserved.kind === 'denied') {
      this.#recordDiagnostic(generation, 'admission', 'failed', reserved.reason === 'operation-limit' ? 'capacity-exhausted' : 'authority-denied');
      inferenceDiagnostic(trace, { stage: 'journal', outcome: 'denied', resource, operationLimit, ...('operationCount' in reserved ? { operationCount: reserved.operationCount } : {}) });
      try {
        if (loggingEnabled) dispatcherLog.warn('Dispatcher operation rejected', { stage: 'reservation', reason: reserved.reason,
          ...(reserved.activityId === undefined ? {} : { activityId: reserved.activityId }), generation,
          resource, deadline: deadline(reserved.lease), status: 403,
          ...(reserved.reason === 'operation-limit' ? { operationCount: reserved.operationCount, operationLimit } : {}) });
      } catch { /* Observability cannot replace the original denial. */ }
      return denied(reserved.reason === 'operation-limit' ? 'operation-limit' : 'execution-inactive');
    }
    if ('ordinal' in reserved && trace) trace.operationOrdinal = reserved.ordinal;
    const operationCorrelation: Correlation = { requestDigest, ...('ordinal' in reserved && reserved.ordinal !== undefined
      ? { logicalOrdinal: reserved.ordinal } : {}) };
    this.#recordDiagnostic(generation, 'effect', reserved.kind === 'completed' ? 'completed' : reserved.kind === 'unknown' ? 'unknown' : 'started',
      reserved.kind === 'unknown' ? 'effect-unknown' : 'none', undefined, operationCorrelation);
    inferenceDiagnostic(trace, { stage: 'journal', outcome: reserved.kind === 'completed' ? 'cached' : reserved.kind,
      resource, operationLimit, ...('operationCount' in reserved ? { operationCount: reserved.operationCount } : {}),
      ...(reserved.kind === 'completed' ? { ...inferenceResponseObservation(reserved.response), responseDigest: reserved.responseDigest } : {}) });
    if (reserved.kind === 'conflict') {
      rejected('reservation', resource, lease, 409);
      return dispatcherRefusal('operation-conflict', 409, 'OPERATOR_OPERATION_CONFLICT');
    }
    const response = (value: NonNullable<DispatcherOperationRecord['response']>) => new Response(value.body, {
      status: value.status, headers: { 'content-type': value.contentType, 'cache-control': 'no-store' } });
    if (reserved.kind === 'completed') return response(reserved.response);
    const genericMutation = resource === 'source' && ((operation.body as { method?: string }).method ?? 'GET') !== 'GET';
    const readOnly = resource !== 'inference' && resource !== 'comment' && resource !== 'merge' && !genericMutation;
    if (reserved.kind === 'unknown' && genericMutation) return dispatcherRefusal('effect-uncertain', 409, 'OPERATOR_OPERATION_UNKNOWN');
    let stage: 'reservation' | 'effect' | 'authority' | 'upstream' | 'commit' = 'reservation';
    let upstreamStatus: number | undefined;
    let bodyReading = false;
    try {
      if (reserved.kind === 'unknown' && !readOnly) {
        if ((resource !== 'comment' && resource !== 'merge') || !effectContext) throw new Error('Unknown protected operation');
        // Reconciliation observes the original write; it never issues that write again.
        effectContext.reconcileOnly = true;
      }
      // Recheck after asynchronous capability construction/reservation, before external I/O.
      stage = 'authority';
      if (!await this.#dispatcherDeliveryCurrent(generation, deliveryToken, modelScope)) throw new Error('Stale protected operation');
      stage = 'effect';
      const result = await this.#boundedDispatcher(reserved.lease, async () => {
        inferenceDiagnostic(trace, { stage: 'upstream', outcome: 'started', resource });
        const upstream = await perform();
        inferenceDiagnostic(trace, { stage: 'upstream', outcome: upstream.status >= 500 || upstream.status < 200 || (upstream.status >= 300 && upstream.status < 400) ? 'failed' : 'completed', resource, status: upstream.status, elapsedMs: performance.now() - began });
        if (upstream.status >= 500 || upstream.status < 200 || (upstream.status >= 300 && upstream.status < 400)) {
          upstreamStatus = upstream.status;
          stage = 'upstream';
          throw new Error('Protected operation did not complete');
        }
        bodyReading = true;
        return { status: upstream.status, contentType: upstream.headers.get('content-type') ?? 'application/json',
          body: await readDispatcherBody(upstream, undefined,
            resource === 'source' ? sourceBytes : resource === 'inference' ? inferenceBytes : limits.dispatcherRequestBytes) };
      });
      emitRaw(trace, 'operation-response', () => result);
      if (normalInference) {
        if (!await this.#dispatcherDeliveryCurrent(generation, deliveryToken, modelScope)) {
          stage = 'authority'; throw new Error('Configured SDK response authority expired');
        }
        const value = JSON.parse(result.body);
        if (result.status !== 200 || !value || !Array.isArray(value.events) || !value.result
          || typeof value.result !== 'object' || value.result.role !== 'assistant') throw new Error('Configured SDK reply invalid');
      }
      let confirmedEffect = false;
      if (resource === 'comment' || resource === 'merge') {
        const receipt = JSON.parse(result.body);
        const expected = operation.body as { target: { pullRequest: number; headSha: string }; decision: string; comment: string };
        confirmedEffect = result.status === 200 && receipt?.pullRequest === expected.target.pullRequest
          && receipt.headSha === expected.target.headSha && receipt.decision === expected.decision
          && receipt.comment === expected.comment && (resource === 'comment'
            ? receipt.posted === true && Number.isSafeInteger(receipt.commentId) && receipt.commentId > 0
            : receipt.outcome === 'MERGED');
      }
      stage = 'commit';
      let committedResponseDigest: string | undefined;
      const committedResult = await this.ctx.storage.transaction(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        const journal = await loadDispatcherJournal(tx, generation);
        const prior = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operation.operationId));
        if (!this.#leaseMatches(record, lease, generation)
          || !this.#phaseTokenMatches(lease, deliveryToken, true, modelScope) || prior?.generation !== generation || prior.requestDigest !== requestDigest) throw new Error('Stale protected result');
        if (prior.phase === 'completed') {
          const cached = await tx.get<NonNullable<DispatcherOperationRecord['response']>>(`dispatcher:response:${operation.operationId}`);
          if (!cached) throw new Error('Protected receipt unavailable');
          committedResponseDigest = prior.responseDigest;
          return cached;
        }
        if (prior.phase !== 'reserved' && !(prior.phase === 'unknown' && (readOnly || confirmedEffect))) {
          throw new Error('Unresolved protected result');
        }
        await tx.put(`dispatcher:response:${operation.operationId}`, result);
        committedResponseDigest = await sha256(result.body);
        const sourceStatus = genericMutation && lease!.serial ? JSON.parse(result.body).status : undefined;
        const effectUnknown = sourceStatus === 408 || typeof sourceStatus === 'number' && sourceStatus >= 500;
        await putDispatcherEntry(tx, journal, operation.operationId, prior,
          { ...prior, phase: effectUnknown ? 'unknown' : 'completed', responseDigest: committedResponseDigest });
        return result;
      });
      this.#recordDiagnostic(generation, resource === 'inference' ? 'inference-response' : 'effect', 'committed', 'none', undefined,
        { ...operationCorrelation, ...(committedResponseDigest ? { responseDigest: committedResponseDigest } : {}) });
      inferenceDiagnostic(trace, { stage: 'response-commit', outcome: 'completed', resource, status: committedResult.status, ...inferenceResponseObservation(committedResult), responseDigest: committedResponseDigest, elapsedMs: performance.now() - began }, () => committedResult);
      if (committedResult.status >= 400) rejected('forwarded-upstream', resource, lease, committedResult.status);
      return response(committedResult);
    } catch (error) {
      emitRaw(trace, 'operation-failure', () => error);
      this.#recordDiagnostic(generation, resource === 'inference' ? 'model' : 'effect', 'failed',
        resource === 'inference' ? 'provider-failed' : 'effect-unknown', error, operationCorrelation, 'host', undefined, undefined,
        [{ operationDigest: hashDiagnostic(operation.operationId), effect: resource === 'inference' ? 'none'
          : genericMutation || resource === 'comment' || resource === 'merge' ? 'write' : 'read', status: 'unknown' }]);
      await this.ctx.storage.transaction(async tx => {
        const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (live?.generation !== generation || !this.#phaseTokenMatches(live, deliveryToken, false)) return;
        const journal = await loadDispatcherJournal(tx, generation);
        const prior = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operation.operationId));
        if (prior?.generation === generation && prior.requestDigest === requestDigest && prior.phase === 'reserved') {
          await putDispatcherEntry(tx, journal, operation.operationId, prior, { ...prior, phase: 'unknown' });
        }
      });
      // Leave a live write's unknown intent available for read-only reconciliation.
      // Terminal SDK reconciliation still refuses collection while any intent remains unknown.
      const current = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      // Late old-phase callers cannot fence a successor. Current PR read/effect failures
      // remain response-local only while shared authority and capacity still hold.
      if (current?.serial && !this.#phaseTokenMatches(current, deliveryToken, false)) return denied();
      const journal = await this.ctx.storage.transaction(tx => loadDispatcherJournal(tx, generation));
      const local = current?.serial?.current.phase.kind === 'target'
        && await this.#dispatcherDeliveryCurrent(generation, deliveryToken, modelScope) && journal.count < operationLimit;
      if (!local && ((!genericMutation && resource !== 'comment' && resource !== 'merge')
        || !await this.#dispatcherDeliveryCurrent(generation, deliveryToken, modelScope))) await this.interruptDrive(generation,
          { boundary: stage === 'authority' ? 'admission' : resource === 'inference' ? 'model' : 'effect',
            code: stage === 'authority' ? 'authority-denied' : resource === 'inference' ? 'provider-failed' : 'effect-unknown', error: captureError(error) });
      inferenceDiagnostic(trace, { stage: 'response-commit', outcome: 'unknown', resource, failureClass: stage === 'authority' ? 'authority' : stage === 'commit' ? 'commit' : upstreamStatus !== undefined ? 'upstream-status' : bodyReading && error instanceof Error && error.message === 'Dispatcher body exceeds limit' ? 'body-limit' : bodyReading ? 'body-read' : 'unknown', elapsedMs: performance.now() - began });
      rejected(stage, resource, lease, 409, upstreamStatus);
      return dispatcherRefusal(genericMutation || resource === 'comment' || resource === 'merge' ? 'effect-uncertain'
        : error instanceof DispatcherRefusal ? error.reason : stage === 'authority' ? 'execution-inactive' : 'operation-failed',
        409, 'OPERATOR_OPERATION_UNKNOWN');
    }
  }

  /** One logical inference owns its attempts; delivery retries join rather than poisoning its reservation. */
  async #recoverDispatcherInference(generation: number, operation: Awaited<ReturnType<typeof parseDispatcherOperation>>,
    requestDigest: string, lease: DispatcherLease, byteLimit: number, operationLimit: number,
    trace: InferenceDiagnosticContext | undefined, deliveryToken?: string): Promise<Response> {
    const key = `${generation}:${deliveryToken ?? 'legacy'}:${operation.operationId}`;
    let flight = this.#inferenceFlights.get(key);
    if (flight && flight.digest !== requestDigest) return dispatcherRefusal('operation-conflict', 409, 'OPERATOR_OPERATION_CONFLICT');
    if (!flight) {
      const controller = new AbortController();
      // Register synchronously before the first reservation can become visible to another delivery.
      const result = this.#runDispatcherInference(generation, operation, requestDigest, lease, byteLimit, operationLimit, trace, controller, deliveryToken)
        .finally(() => { this.#inferenceFlights.delete(key); controller.abort(); });
      flight = { digest: requestDigest, controller, result };
      this.#inferenceFlights.set(key, flight);
    }
    const value = await flight.result;
    if (lease.serial || value.status < 400) {
      try {
        const plan = await this.getRuntimePlan();
        if (!plan) throw new Error('Dispatcher inference unavailable');
        const { authority } = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (!await operatorAccessSessionCurrent(authority.human, authority.accessJwt)
          || !await this.#dispatcherDeliveryCurrent(generation, deliveryToken)) throw new Error('Dispatcher inference denied');
      } catch (error) { return dispatcherRefusal(error instanceof DispatcherRefusal ? error.reason : 'authority-unverified'); }
    }
    return new Response(value.body, { status: value.status,
      headers: { 'content-type': value.contentType, 'cache-control': 'no-store' } });
  }

  async #runDispatcherInference(generation: number, operation: Awaited<ReturnType<typeof parseDispatcherOperation>>,
    requestDigest: string, lease: DispatcherLease, byteLimit: number, operationLimit: number,
    trace: InferenceDiagnosticContext | undefined, controller: AbortController, deliveryToken?: string): Promise<DispatcherInferenceResponse> {
    const rejected = (code: string, status = 409, reason: DispatcherRefusalReason = code === 'OPERATOR_OPERATION_CONFLICT'
      ? 'operation-conflict' : code === 'OPERATOR_CAPABILITY_DENIED' ? 'execution-inactive' : 'operation-failed'): DispatcherInferenceResponse =>
      ({ status, contentType: 'application/json', body: JSON.stringify(dispatcherRefusalBody(reason, code)) });
    const ownerKey = `dispatcher:inference-owner:${generation}`;
    const attemptLimit = lease.inferenceRecovery!.attemptLimit;
    let epoch: number | undefined;
    let terminalCode = 'OPERATOR_OPERATION_UNKNOWN';
    let exhaustionReason: DispatcherRefusalReason = 'authority-unverified';
    let failureClass = 'commit';
    const live = async (tx: DispatcherJournalTx) => {
      const [record, currentLease, owner] = await Promise.all([tx.get<AdmissionState>('admission'),
        tx.get<DispatcherLease>(DISPATCHER_LEASE), tx.get<number>(ownerKey)]);
      if (!this.#leaseMatches(record, currentLease, generation) || !this.#phaseTokenMatches(currentLease, deliveryToken) || owner !== epoch || controller.signal.aborted
        || currentLease?.inferenceRecovery?.version !== 1 || currentLease.inferenceRecovery.attemptLimit !== attemptLimit) {
        throw new Error('Dispatcher inference fenced');
      }
    };
    try {
      if (!this.#inferenceOwner || this.#inferenceOwner.generation !== generation) {
        this.#inferenceOwner = { generation, epoch: this.ctx.storage.transaction(async tx => {
          const currentLease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(await tx.get<AdmissionState>('admission'), currentLease, generation)
            || !this.#phaseTokenMatches(currentLease, deliveryToken)) {
            throw new Error('Dispatcher inference fenced');
          }
          const next = (await tx.get<number>(ownerKey) ?? 0) + 1;
          if (!Number.isSafeInteger(next)) throw new Error('Dispatcher inference owner exhausted');
          await tx.put(ownerKey, next);
          return next;
        }) };
      }
      epoch = await this.#inferenceOwner.epoch;
      const plan = await this.getRuntimePlan();
      if (!plan) return rejected('OPERATOR_CAPABILITY_DENIED', 403);
      const prepare = async (attemptTrace: InferenceDiagnosticContext | undefined, pin = true) => {
        failureClass = 'authority';
        const { authority } = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (controller.signal.aborted || !await operatorAccessSessionCurrent(authority.human, authority.accessJwt)
          || !await this.#dispatcherDeliveryCurrent(generation, deliveryToken)) throw new Error('Dispatcher inference authority expired');
        return createDispatcherOperation({ plan, env: this.#appEnv, operation: { ...operation, signal: controller.signal },
          current: () => this.#dispatcherDeliveryCurrent(generation, deliveryToken), diagnosticContext: attemptTrace,
          exports: (this.ctx as unknown as { exports: Parameters<typeof createDispatcherOperation>[0]['exports'] }).exports,
          pinInferenceSelection: !pin ? undefined : async selection => this.ctx.storage.transaction(async tx => {
            await live(tx);
            const journal = await loadDispatcherJournal(tx, generation);
            const key = dispatcherEntryKey(journal, operation.operationId);
            const record = await tx.get<DispatcherOperationRecord>(key);
            if (record?.requestDigest !== requestDigest || !record.inference || record.phase === 'unknown') throw new Error('Dispatcher inference identity changed');
            const pinned = record.inference.selection;
            if (pinned && (pinned.routeId !== selection.routeId || pinned.reasoningLevel !== selection.reasoningLevel)) {
              throw new Error('Dispatcher inference route changed');
            }
            if (!pinned) await tx.put(key, { ...record, inference: { ...record.inference, selection } });
          }) });
      };
      for (;;) {
        failureClass = 'commit';
        const next = await this.ctx.storage.transaction(async tx => {
          await live(tx);
          const journal = await loadDispatcherJournal(tx, generation);
          const key = dispatcherEntryKey(journal, operation.operationId);
          const record = await tx.get<DispatcherOperationRecord>(key);
          if (record && record.requestDigest !== requestDigest) return { kind: 'conflict' } as const;
          if (record?.phase === 'completed') {
            const cached = await tx.get<DispatcherInferenceResponse>(`dispatcher:response:${operation.operationId}`);
            if (!cached) throw new Error('Dispatcher inference receipt missing');
            return { kind: 'cached', response: cached, ordinal: record.ordinal, recoverable: record.inference?.version === 1, operationCount: journal.count } as const;
          }
          // Neither an old record nor a terminal unknown record can be upgraded into recovery.
          if (record && (record.phase !== 'reserved' || record.inference?.version !== 1)) throw new Error('Dispatcher inference is not recoverable');
          if (!record) {
            if (journal.count >= operationLimit) return { kind: 'capacity', operationCount: journal.count } as const;
            const attempt: DispatcherInferenceAttempt = { index: 1, ordinal: journal.nextOrdinal, phase: 'ready', notBefore: Date.now() };
            await tx.put(inferenceAttemptKey(generation, operation.operationId, 1), attempt);
            await putDispatcherEntry(tx, journal, operation.operationId, undefined,
              { generation, requestDigest, phase: 'reserved', ordinal: attempt.ordinal, inference: { version: 1, attempt: 1 },
                ...(lease.serial ? { phaseBinding: this.#operationPhase(lease, 'inference') } : {}) });
            return { kind: 'ready', attempt, logicalOrdinal: attempt.ordinal, operationCount: journal.count + 1 } as const;
          }
          const attemptKey = inferenceAttemptKey(generation, operation.operationId, record.inference!.attempt);
          let previous = await tx.get<DispatcherInferenceAttempt>(attemptKey);
          if (!previous) throw new Error('Dispatcher inference attempt missing');
          if (previous.phase === 'ready') return { kind: 'ready', attempt: previous, logicalOrdinal: record.ordinal, operationCount: journal.count } as const;
          if (previous.phase === 'in-flight') {
            if (previous.owner === undefined || previous.owner >= epoch!) throw new Error('Dispatcher inference owner conflict');
            previous = { ...previous, phase: 'unknown', classification: 'transport' };
            await tx.put(attemptKey, previous);
          }
          if (previous.classification !== 'retryable' && previous.classification !== 'transport') throw new Error('Dispatcher inference cannot recover');
          if (previous.index >= attemptLimit || journal.count >= operationLimit) return { kind: 'exhausted', operationCount: journal.count } as const;
          const attempt: DispatcherInferenceAttempt = { index: previous.index + 1, ordinal: journal.nextOrdinal,
            phase: 'ready', notBefore: Date.now() + inferenceRetryDelay(previous.index, isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined) };
          if (attempt.notBefore >= lease.expiresAt) throw new Error('Dispatcher inference deadline reached');
          await tx.put(attemptKey, { ...previous, successor: attempt.index });
          await tx.put(inferenceAttemptKey(generation, operation.operationId, attempt.index), attempt);
          await putDispatcherEntry(tx, journal, operation.operationId, record,
            { ...record, inference: { ...record.inference!, attempt: attempt.index } }, 1);
          return { kind: 'ready', attempt, logicalOrdinal: record.ordinal, operationCount: journal.count + 1 } as const;
        }).catch(async error => this.ctx.storage.transaction(async tx => {
          // A lost allocation acknowledgement is not a second allocation. Only an
          // independently retained, unclaimed reservation (or final cache) reconciles it.
          await live(tx);
          const journal = await loadDispatcherJournal(tx, generation);
          const record = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operation.operationId));
          if (record?.requestDigest !== requestDigest || record.inference?.version !== 1) throw error;
          if (record.phase === 'completed') {
            const cached = await tx.get<DispatcherInferenceResponse>(`dispatcher:response:${operation.operationId}`);
            if (cached) return { kind: 'cached', response: cached, ordinal: record.ordinal, recoverable: true, operationCount: journal.count } as const;
          }
          const attempt = await tx.get<DispatcherInferenceAttempt>(inferenceAttemptKey(generation, operation.operationId, record.inference.attempt));
          if (record.phase !== 'reserved' || attempt?.phase !== 'ready' || attempt.owner !== undefined) throw error;
          return { kind: 'ready', attempt, logicalOrdinal: record.ordinal, operationCount: journal.count } as const;
        }));
        if (next.kind === 'conflict') return rejected('OPERATOR_OPERATION_CONFLICT');
        if (next.kind === 'capacity' || next.kind === 'exhausted') {
          this.#recordDiagnostic(generation, 'admission', 'failed', 'capacity-exhausted');
          inferenceDiagnostic(trace, { stage: 'journal', outcome: 'denied', resource: 'inference',
            operationCount: next.operationCount, operationLimit, inferenceAttemptLimit: attemptLimit });
          if (next.kind === 'capacity') return rejected('OPERATOR_CAPABILITY_DENIED', 403, 'operation-limit');
          exhaustionReason = next.operationCount >= operationLimit ? 'operation-limit' : 'authority-unverified';
          terminalCode = 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED'; throw new Error('Dispatcher inference exhausted');
        }
        if (next.kind === 'cached') {
          await prepare(trace, next.recoverable);
          inferenceDiagnostic(trace ? { ...trace, operationOrdinal: next.ordinal } : undefined, { stage: 'journal', outcome: 'cached', resource: 'inference', operationCount: next.operationCount, operationLimit });
          return next.response;
        }
        const attempt = next.attempt;
        const attemptCorrelation: Correlation = { requestDigest, ...(next.logicalOrdinal === undefined ? {} : { logicalOrdinal: next.logicalOrdinal }),
          hostAttemptIndex: attempt.index, chargedOrdinal: attempt.ordinal };
        const attemptTrace = trace ? { ...trace, operationOrdinal: attempt.ordinal } : undefined;
        if (attempt.notBefore > Date.now()) await this.#boundedDispatcher(lease, () => new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); reject(new Error('Dispatcher inference cancelled')); };
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, attempt.notBefore - Date.now());
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        }));
        const perform = await prepare(attemptTrace);
        failureClass = 'commit';
        const attemptKey = inferenceAttemptKey(generation, operation.operationId, attempt.index);
        await this.ctx.storage.transaction(async tx => {
          await live(tx);
          const current = await tx.get<DispatcherInferenceAttempt>(attemptKey);
          if (current?.phase !== 'ready') throw new Error('Dispatcher inference already claimed');
          await tx.put(attemptKey, { ...current, phase: 'in-flight', owner: epoch });
        });
        this.#recordDiagnostic(generation, 'model', 'started', 'none', undefined, attemptCorrelation);
        inferenceDiagnostic(attemptTrace, { stage: 'inference-attempt', outcome: 'started', resource: 'inference',
          inferenceAttempt: attempt.index, inferenceAttemptLimit: attemptLimit, operationCount: next.operationCount, operationLimit });
        let response: DispatcherInferenceResponse | undefined;
        let classification: NonNullable<DispatcherInferenceAttempt['classification']> = 'transport';
        let responseFailure: string | undefined;
        try {
          response = await this.#boundedDispatcher(lease, async () => {
            const upstream = await perform();
            return { status: upstream.status, contentType: upstream.headers.get('content-type') ?? 'application/json',
              body: upstream.body ? await readDispatcherBody(upstream, controller.signal, byteLimit) : '' };
          });
          emitRaw(attemptTrace, 'inference-attempt-response', () => response);
          classification = classifyDispatcherInference(response, (operation.body as { input: { stream?: boolean } }).input.stream !== false);
        } catch (error) {
          emitRaw(attemptTrace, 'inference-attempt-failure', () => error);
          this.#recordDiagnostic(generation, 'model', 'failed', 'provider-failed', error, attemptCorrelation, 'host', undefined, undefined,
            [{ operationDigest: hashDiagnostic(operation.operationId), effect: 'none', status: 'unavailable' }]);
          responseFailure = error instanceof Error && error.message === 'Dispatcher body exceeds limit' ? 'body-limit' : 'body-read';
          if (error instanceof Error && ['Dispatcher body exceeds limit', 'Dispatcher body encoding invalid'].includes(error.message)) classification = 'permanent';
        }
        // A transport rejection is retryable only while the original full authority and pinned route remain current.
        await prepare(attemptTrace);
        failureClass = 'commit';
        const responseDigest = response ? await sha256(response.body) : undefined;
        await this.ctx.storage.transaction(async tx => {
          await live(tx);
          const journal = await loadDispatcherJournal(tx, generation);
          const key = dispatcherEntryKey(journal, operation.operationId);
          const record = await tx.get<DispatcherOperationRecord>(key);
          const current = await tx.get<DispatcherInferenceAttempt>(attemptKey);
          if (record?.phase !== 'reserved' || record.requestDigest !== requestDigest || record.inference?.attempt !== attempt.index
            || current?.phase !== 'in-flight' || current.owner !== epoch) throw new Error('Dispatcher inference result superseded');
          const final = classification === 'usable' || classification === 'final-error';
          const responseKey = final ? `dispatcher:response:${operation.operationId}` : `${attemptKey}:response`;
          if (response) await tx.put(responseKey, response);
          await tx.put(attemptKey, { ...current, phase: response ? 'completed' : 'unknown', classification,
            ...(response ? { responseKey, responseDigest } : {}) });
          if (final && response) {
            await putDispatcherEntry(tx, journal, operation.operationId, record, { ...record, phase: 'completed', responseDigest });
          }
        });
        this.#recordDiagnostic(generation, classification === 'usable' ? 'inference-response' : 'model',
          classification === 'usable' ? 'completed' : response ? 'failed' : 'unknown', classification === 'usable' ? 'none' : 'response-unusable',
          undefined, { ...attemptCorrelation, ...(responseDigest ? { responseDigest } : {}) });
        if (classification === 'usable' && attempt.index > 1) this.#recordDiagnostic(generation, 'recovery', 'recovered', 'none', undefined, attemptCorrelation);
        inferenceDiagnostic(attemptTrace, { stage: 'inference-attempt', outcome: classification === 'usable' ? 'completed' : response ? 'failed' : 'unknown',
          resource: 'inference', inferenceAttempt: attempt.index, inferenceAttemptLimit: attemptLimit,
          operationCount: next.operationCount, operationLimit, inferenceOutcome: classification,
          ...(responseFailure ? { failureClass: responseFailure } : {}),
          ...(response ? { status: response.status, responseDigest, ...inferenceResponseObservation(response) } : {}) }, () => response);
        if ((classification === 'usable' || classification === 'final-error') && response) return response;
        if (classification === 'permanent') { failureClass = responseFailure ?? 'model-completion'; throw new Error('Dispatcher inference permanent failure'); }
      }
    } catch (error) {
      this.#recordDiagnostic(generation, failureClass === 'authority' ? 'admission' : 'recovery', 'failed',
        failureClass === 'authority' ? 'authority-denied' : terminalCode === 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED' ? 'capacity-exhausted' : 'provider-failed', error, { requestDigest });
      // A replaced owner's late failure cannot fence its successor. Persistence ambiguity never authorizes I/O.
      let owns = false;
      try {
        owns = epoch !== undefined && await this.ctx.storage.get<number>(ownerKey) === epoch;
        if (owns) await this.ctx.storage.transaction(async tx => {
          const currentLease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (currentLease?.generation !== generation || !this.#phaseTokenMatches(currentLease, deliveryToken, false)
            || await tx.get<number>(ownerKey) !== epoch) { owns = false; return; }
          const journal = await loadDispatcherJournal(tx, generation);
          const record = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operation.operationId));
          if (record?.requestDigest === requestDigest && record.phase === 'reserved') {
            await putDispatcherEntry(tx, journal, operation.operationId, record, { ...record, phase: 'unknown' });
          }
        });
        if (owns) {
          const current = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
          const journal = await this.ctx.storage.transaction(tx => loadDispatcherJournal(tx, generation));
          const local = current?.serial?.current.phase.kind === 'target'
            && (terminalCode === 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED' || ['model-completion', 'body-limit', 'body-read'].includes(failureClass))
            && journal.count < operationLimit && await this.#dispatcherDeliveryCurrent(generation, deliveryToken);
          if (local && terminalCode === 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED') exhaustionReason = 'operation-failed';
          if (!local) {
            const fenced = await this.interruptDrive(generation, { boundary: failureClass === 'authority' ? 'admission'
              : terminalCode === 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED' ? 'recovery' : 'model',
              code: failureClass === 'authority' ? 'authority-denied' : terminalCode === 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED' ? 'capacity-exhausted' : 'provider-failed' });
            if (fenced.ok && terminalCode === 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED') {
              exhaustionReason = journal.count >= operationLimit ? 'operation-limit' : 'execution-inactive';
            }
          }
        }
      } catch { /* No fresh inference follows a journal or fence failure. */ }
      inferenceDiagnostic(trace, { stage: 'response-commit', outcome: 'unknown', resource: 'inference', failureClass }, () => error);
      return rejected(terminalCode, 409, error instanceof DispatcherRefusal ? error.reason
        : failureClass === 'authority' ? 'authority-unverified'
          : terminalCode === 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED' ? exhaustionReason : 'operation-failed');
    }
  }

  /** Abort the actual dynamic child key without deleting original durable SDK storage. */
  protected abortDispatcherFacet(reason: string): void {
    (this.ctx as unknown as { facets: { abort(key: string, reason: string): void } }).facets.abort('dispatcher', reason);
    this.#dispatcher = undefined;
  }

  /** SDK-owned bookkeeping is retired before a settled generation can be continued. */
  async #releaseDispatcherSdk(): Promise<void> {
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!lease || lease.hosting === 'normal' || lease.sdkReleased || lease.status === 'running' || lease.status === 'admitting') return;
    const admission = await this.ctx.storage.get<AdmissionState>('admission');
    if (!admission) return;
    const trace = { activityId: admission.intent.activityId, generation: lease.generation, loggingEnabled: executionLoggingEnabled(admission.receipt) };
    inferenceDiagnostic(trace, { stage: 'sdk-release', outcome: 'started' });
    this.#recordDiagnostic(lease.generation, 'release', 'started');
    try {
    // Intent4 only: after the durable generation fence, stop its actual owned child,
    // including descendants. Bookkeeping cleanup alone cannot stop an SDK callback.
    if (lease.serial) this.abortDispatcherFacet('Dispatcher generation retired');
    await this.#serializeDispatcherSchedules(async () => {
      for (const schedule of await this.scheduler.list()) {
        if (schedule.callback !== DISPATCHER_SCHEDULE_CALLBACK) continue;
        const envelope = parseDispatcherSchedule(schedule.payload);
        if (!envelope) throw new Error('Dispatcher schedule cleanup binding invalid');
        if (envelope.activityId === admission.intent.activityId && envelope.generation === lease.generation
          && envelope.inputDigest === lease.inputDigest && envelope.artifactDigest === lease.artifactDigest) {
          await this.scheduler.cancel(schedule.id);
        }
      }
    });
    await super._cf_cleanupFacetPrefix([{ className: 'OperatorActivity', name: admission.intent.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }]);
    const tokens = await this.ctx.storage.get<Record<string, number>>('dispatcher:keepalive') ?? {};
    for (const [token, generation] of Object.entries(tokens)) {
      if (generation === lease.generation) await super._cf_releaseFacetKeepAlive(token);
    }
    const released = await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (current?.generation === lease.generation) {
        await tx.put(DISPATCHER_LEASE, { ...current, sdkReleased: true });
        await tx.delete('dispatcher:keepalive');
        return true;
      }
      return false;
    });
    inferenceDiagnostic(trace, { stage: 'sdk-release', outcome: released ? 'completed' : 'unknown', sdkReleased: released });
    this.#recordDiagnostic(lease.generation, 'release', released ? 'completed' : 'unknown');
    } catch (error) {
      inferenceDiagnostic(trace, { stage: 'sdk-release', outcome: 'failed', failureClass: 'sdk-cleanup' });
      this.#recordDiagnostic(lease.generation, 'release', 'failed', 'cleanup-failed', error);
      throw error;
    }
  }

  async #dispatcherPath(path: unknown): Promise<DispatcherFacetPath> {
    const admission = await this.ctx.storage.get<AdmissionState>('admission');
    if (!admission || !Array.isArray(path) || path.length !== 2
      || path.some(segment => !segment || typeof segment !== 'object' || Array.isArray(segment)
        || Object.keys(segment).length !== 2)
      || path[0].className !== 'OperatorActivity' || path[0].name !== admission.intent.activityId
      || path[1].className !== 'FlueDispatcherAgent' || path[1].name !== 'dispatcher') {
      throw new Error('Dispatcher facet path denied');
    }
    return dispatcherSchedulePath(admission.intent.activityId);
  }

  #serializeDispatcherSchedules<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#dispatcherScheduleQueue.then(run);
    this.#dispatcherScheduleQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async #dispatcherSchedules(generation: number, method: DispatcherSdkMethod, args: unknown[]): Promise<unknown> {
    if (!await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher SDK generation changed');
    const [admission, lease] = await Promise.all([this.ctx.storage.get<AdmissionState>('admission'),
      this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE)]);
    if (!this.#leaseMatches(admission, lease, generation) || !admission || !lease) {
      throw new Error('Dispatcher SDK generation changed');
    }
    const owned = (await this.scheduler.list()).flatMap(schedule => {
      if (schedule.callback !== DISPATCHER_SCHEDULE_CALLBACK) return [];
      const envelope = parseDispatcherSchedule(schedule.payload);
      return envelope?.activityId === admission.intent.activityId && envelope.generation === generation
        && envelope.inputDigest === lease.inputDigest && envelope.artifactDigest === lease.artifactDigest
        ? [{ schedule, envelope }] : [];
    });
    if (!await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher SDK generation changed');
    if (method === '_cf_scheduleForFacet' || method === '_cf_scheduleEveryForFacet') {
      const options = z.strictObject({ idempotent: z.boolean().optional(), _idempotent: z.boolean().optional() })
        .optional().parse(args[4]);
      const when = args[1];
      if (!(when instanceof Date) && typeof when !== 'number') throw new Error('Dispatcher callback denied');
      if (method === '_cf_scheduleEveryForFacet' && typeof when !== 'number') throw new Error('Dispatcher callback denied');
      if (owned.length >= 128) throw new Error('Dispatcher schedule limit');
      const type = method === '_cf_scheduleEveryForFacet' ? 'interval' : when instanceof Date ? 'scheduled' : 'delayed';
      const idempotent = type === 'interval' ? options?._idempotent !== false : options?.idempotent === true;
      const existing = idempotent && owned.find(({ schedule, envelope }) => schedule.type === type
        && envelope.original.payload === null && (type !== 'interval' || schedule.type === 'interval' && schedule.intervalSeconds === when));
      if (existing) return { schedule: projectChildSchedule(existing.schedule, existing.envelope), created: false };
      const envelope = dispatcherScheduleEnvelope({ activityId: admission.intent.activityId, generation,
        inputDigest: lease.inputDigest, artifactDigest: lease.artifactDigest });
      // The child executor retains its own original retry policy. One host attempt
      // avoids multiplying application retries; platform failures still propagate.
      const schedule = type === 'interval' && typeof when === 'number'
        ? await this.scheduler.every(when, DISPATCHER_SCHEDULE_CALLBACK, envelope, { idempotent: false, retry: { maxAttempts: 1 } })
        : await this.scheduler.set(when, DISPATCHER_SCHEDULE_CALLBACK, envelope, { idempotent: false, retry: { maxAttempts: 1 } });
      if (!await this.dispatcherGenerationCurrent(generation)) {
        await this.scheduler.cancel(schedule.id);
        throw new Error('Dispatcher SDK generation changed');
      }
      return { schedule: projectChildSchedule(schedule, envelope, true), created: true };
    }
    if (method === '_cf_getScheduleForFacet' || method === '_cf_cancelScheduleForFacet') {
      const id = z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/).parse(args[1]);
      const entry = owned.find(({ schedule }) => schedule.id === id);
      if (method === '_cf_getScheduleForFacet') return entry && projectChildSchedule(entry.schedule, entry.envelope);
      return entry && await this.scheduler.cancel(id) ? { ok: true, callback: '__flueWakeAgentSubmissions' } : { ok: false };
    }
    if (method === '_cf_listSchedulesForFacet') {
      const criteria = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/).optional(),
        type: z.enum(['scheduled', 'delayed', 'cron', 'interval']).optional(),
        timeRange: z.strictObject({ start: z.date().optional(), end: z.date().optional() }).optional(),
      }).optional().parse(args[1]);
      return owned.map(({ schedule, envelope }) => projectChildSchedule(schedule, envelope)).filter(schedule =>
        (!criteria?.id || schedule.id === criteria.id) && (!criteria?.type || schedule.type === criteria.type)
        && (!criteria?.timeRange?.start || schedule.time >= Math.floor(criteria.timeRange.start.getTime() / 1000))
        && (!criteria?.timeRange?.end || schedule.time <= Math.floor(criteria.timeRange.end.getTime() / 1000)));
    }
    throw new Error('Dispatcher schedule method denied');
  }

  /** Root-owned alarm callback; original generation is checked before any child construction. */
  async dispatchDispatcherSchedule(payload: unknown, schedule: Schedule<unknown>): Promise<void> {
    const envelope = parseDispatcherSchedule(payload);
    if (!envelope || schedule.callback !== DISPATCHER_SCHEDULE_CALLBACK) throw new Error('Dispatcher schedule binding denied');
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!lease || lease.generation !== envelope.generation || lease.inputDigest !== envelope.inputDigest
      || lease.artifactDigest !== envelope.artifactDigest || !await this.dispatcherGenerationCurrent(envelope.generation)) {
      await this.scheduler.cancel(schedule.id);
      return;
    }
    const path = dispatcherSchedulePath(envelope.activityId);
    await this.#dispatcherPath(path);
    const child = await this.#dispatcherFacet(lease);
    if (!await this.dispatcherGenerationCurrent(envelope.generation)) return;
    if (!await child._cf_dispatchScheduledCallback(path, childScheduleRow(schedule, envelope))) {
      throw new Error('Dispatcher scheduled child callback was not handled');
    }
  }

  /** The exact pinned SDK list, never a general RPC reflector. Original generation is rechecked here. */
  async dispatcherBridge(generation: number, method: DispatcherSdkMethod, args: unknown[]): Promise<unknown> {
    const family: Boundary = method === '_cf_releaseFacetKeepAlive' || method === '_cf_unregisterFacetRun' ? 'release' : 'scheduling';
    try {
      const result = await this.#dispatcherBridgeBound(generation, method, args);
      this.#recordDiagnostic(generation, family, 'completed');
      return result;
    } catch (error) {
      this.#recordDiagnostic(generation, family, 'failed', family === 'release' ? 'cleanup-failed' : 'unclassified', error);
      throw error;
    }
  }

  async #dispatcherBridgeBound(generation: number, method: DispatcherSdkMethod, args: unknown[]): Promise<unknown> {
    this.#resumeDispatcherOnEntry();
    if (!DISPATCHER_SDK_METHODS.includes(method) || !Array.isArray(args)
      || new TextEncoder().encode(JSON.stringify(args)).byteLength > 64 * 1024
      || !await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher SDK authority denied');
    if (method === '_cf_releaseFacetKeepAlive') {
      const tokens = await this.ctx.storage.get<Record<string, number>>('dispatcher:keepalive') ?? {};
      if (typeof args[0] !== 'string' || !Object.hasOwn(tokens, args[0]) || tokens[args[0]] !== generation) {
        throw new Error('Dispatcher keepalive denied');
      }
      await super._cf_releaseFacetKeepAlive(args[0]);
      delete tokens[args[0]];
      await this.ctx.storage.put('dispatcher:keepalive', tokens);
      return;
    }
    const ownerPath = await this.#dispatcherPath(args[0]);
    if (method === '_cf_scheduleForFacet' || method === '_cf_scheduleEveryForFacet') {
      const when = args[1];
      const delay = when instanceof Date ? (when.getTime() - Date.now()) / 1000 : when;
      if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 30
        || (method === '_cf_scheduleEveryForFacet' && delay < 1)
        || args[2] !== '__flueWakeAgentSubmissions' || args[3] !== undefined) {
        throw new Error('Dispatcher callback denied');
      }
    }
    if (['_cf_scheduleForFacet', '_cf_scheduleEveryForFacet', '_cf_getScheduleForFacet',
      '_cf_listSchedulesForFacet', '_cf_cancelScheduleForFacet'].includes(method)) {
      return this.#serializeDispatcherSchedules(() => this.#dispatcherSchedules(generation, method, args));
    }
    if (['_cf_registerFacetRun', '_cf_unregisterFacetRun'].includes(method)
      && (typeof args[1] !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(args[1]))) throw new Error('Dispatcher SDK identity denied');
    if (!await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher SDK generation changed');
    // This activity grants no subagent connections. Answer the pinned SDK's
    // connection-free facet protocol without exposing parent connections or data.
    if (method === '_cf_subAgentConnectionMetas') return [];
    if (method === '_cf_broadcastToSubAgent') return;
    if (method === '_cf_acquireFacetKeepAlive') {
      const tokens = await this.ctx.storage.get<Record<string, number>>('dispatcher:keepalive') ?? {};
      if (Object.keys(tokens).length >= 64) throw new Error('Dispatcher keepalive limit');
      const token = await super._cf_acquireFacetKeepAlive(ownerPath);
      try {
        await this.ctx.storage.transaction(async tx => {
          const record = await tx.get<AdmissionState>('admission');
          const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(record, lease, generation)) throw new Error('Dispatcher SDK generation changed');
          const current = await tx.get<Record<string, number>>('dispatcher:keepalive') ?? {};
          await tx.put('dispatcher:keepalive', { ...current, [token]: generation });
        });
        return token;
      } catch (error) { await super._cf_releaseFacetKeepAlive(token); throw error; }
    }
    if (method === '_cf_registerFacetRun') {
      await super._cf_registerFacetRun(ownerPath, z.string().parse(args[1]));
      return;
    }
    if (method === '_cf_unregisterFacetRun') {
      await super._cf_unregisterFacetRun(ownerPath, z.string().parse(args[1]));
      // A real SDK run-finish event wakes the existing owner. It is NOT terminal proof:
      // reconciliation still requires the exact original submission settlement. Retain
      // a wake that arrives during a read, rather than waiting5seconds for every PR.
      if (this.#reconciling) this.#dispatcherTerminalWake = true;
      else this.ctx.waitUntil(this.reconcileDispatcherLease({ generation }));
      return;
    }
    throw new Error('Dispatcher SDK method denied');
  }

  override async _cf_checkRunFibersForFacet(ownerPath: DispatcherFacetPath): Promise<number> {
    this.#resumeDispatcherOnEntry();
    await this.#dispatcherPath(ownerPath);
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!lease || !await this.dispatcherGenerationCurrent(lease.generation)) return 0;
    return (await this.#dispatcherFacet(lease))._cf_checkRunFibersForFacet(ownerPath);
  }

  private browserSummary(state: AdmissionState, lease?: DispatcherLease): OperatorBrowserSummary {
    const executionStatus = state.drive?.status ?? 'queued';
    const terminal = executionStatus === 'completed' || executionStatus === 'failed';
    const released = this.sdkCleanupReleased(state, lease);
    const safeText = (value: unknown, max = 128): string | null =>
      typeof value === 'string' && value.length <= max && /^[\p{L}\p{N} ._/#-]+$/u.test(value) ? value : null;
    let name: string | null = null;
    let version: string | null = null;
    let repository: string | null = null;
    let context: string | null = null;
    try {
      const manifest = state.receipt && (isManagementReceipt(state.receipt)
        ? state.receipt.selection.manifestJson : state.receipt.manifestJson);
      if (manifest) {
        const metadata = JSON.parse(manifest) as { name?: unknown; version?: unknown };
        name = safeText(metadata.name);
        version = typeof metadata.version === 'string' && metadata.version.length <= 128
          && /^[A-Za-z0-9._/+ -]+$/.test(metadata.version) ? metadata.version : null;
      }
    } catch { /* no verified display name */ }
    if (state.receipt && isManagementReceipt(state.receipt)) {
      name ??= safeText(state.receipt.selection.operator.name);
    }
    try {
      const input = JSON.parse(state.invocationJson ?? 'null') as unknown;
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const value = input as Record<string, unknown>;
        const reviewInput = value.input && typeof value.input === 'object' && !Array.isArray(value.input)
          ? (value.input as Record<string, unknown>).context : null;
        const reviewContext = reviewInput && typeof reviewInput === 'object' && !Array.isArray(reviewInput)
          ? reviewInput as Record<string, unknown> : null;
        const source = value.source && typeof value.source === 'object' && !Array.isArray(value.source)
          ? value.source as Record<string, unknown> : null;
        const review = state.boundary && reviewContext?.pullRequest === state.boundary.pullRequest
          && reviewContext?.repositoryId === state.boundary.repositoryId;
        repository = safeText(review && source?.kind === 'session' ? source.reference : value.repository, 256);
        if (repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
          const pr = review ? state.boundary!.pullRequest : value.pullRequest;
          const suffix = typeof pr === 'number' && Number.isSafeInteger(pr) && pr > 0 ? ` · PR #${pr}` : '';
          context = repository.length + suffix.length <= 256 ? repository + suffix
            : `${repository.slice(0, 255 - suffix.length)}…${suffix}`;
        } else if (review) context = `PR #${state.boundary!.pullRequest}`;
      }
    } catch { /* no safe context */ }
    const checkpoint = state.drive?.checkpoint;
    const progress = checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint)
      ? safeText((checkpoint as Record<string, unknown>).stage) : null;
    // Only summarize a complete, admitted-repository report. No body bytes enter the owner index.
    let resultSummary: OperatorBrowserSummary['resultSummary'];
    const result = state.drive?.result;
    if (terminal && repository && result && typeof result === 'object' && !Array.isArray(result)) {
      const report = result as Record<string, unknown>;
      if (report.repository === repository && Array.isArray(report.results) && report.results.length <= 1024
        && report.results.every(item => item && typeof item === 'object' && !Array.isArray(item)
          && Number.isSafeInteger(item.pullRequest) && item.pullRequest > 0 && typeof item.outcome === 'string')) {
        resultSummary = { assessed: report.results.length, merged: 0, notMerged: 0, deferred: 0, unknown: 0 };
        for (const item of report.results) {
          const key = item.outcome === 'MERGED' ? 'merged' : item.outcome === 'NOT_MERGED' ? 'notMerged'
            : item.outcome === 'DEFERRED' ? 'deferred' : 'unknown';
          resultSummary[key]++;
        }
      }
    }
    return { activityId: state.intent.activityId, operatorId: state.intent.operatorId,
      ...(name ? { operatorName: name } : {}), ...(version ? { version } : {}), ...(resultSummary ? { resultSummary } : {}),
      ...(context ? { context } : {}), ...(progress ? { progress } : {}), executionStatus,
      ...(state.inferenceSelection ? { inferenceSelection: { ...state.inferenceSelection,
        ...(state.receipt && isManagementReceipt(state.receipt) ? { reasoningSource:
          state.receipt.selection.installation.piReasoningOverride === undefined ? 'inherited' as const : 'installation' as const } : {}) } } : {}),
      ...(state.configuredSelection ? { inferenceSelection: state.configuredSelection.source === 'managed'
        ? { source: 'managed' as const, routeId: state.configuredSelection.routeId, reasoningLevel: state.configuredSelection.reasoningLevel }
        : { ...state.configuredSelection, reasoningLevel: state.configuredSelection.reasoningLevel!, reasoningSource:
          state.receipt && isManagementReceipt(state.receipt) && state.receipt.selection.installation.piReasoningOverride !== undefined
            ? 'installation' as const : 'inherited' as const } } : {}),
      ...(state.authFailure ? { authFailure: state.authFailure } : {}),
      cleanupStatus: released === true ? 'released' : executionStatus === 'cancel-requested' ? 'stopping'
        : released === false ? 'pending' : terminal ? 'unknown' : 'pending',
      collectionStatus: state.browserCollectionConsumed ? 'consumed' : terminal ? 'ready' : 'unavailable',
      attention: executionStatus === 'failed' || executionStatus === 'unknown' || (terminal && !state.browserCollectionConsumed),
      sessionId: null, source: null, updatedAt: state.updatedAt ?? Date.now() };
  }

  private async publishBrowserSummary(state?: AdmissionState, summary?: OperatorBrowserSummary,
    observed?: OperatorBrowserSummary): Promise<void> {
    state ??= await this.ctx.storage.get<AdmissionState>('admission');
    if (!state?.ownerKey) return;
    try {
      const projection = summary ?? this.browserSummary(state, await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE));
      const registry = this.#appEnv.OPERATOR_REGISTRY.getByName('registry');
      if (observed) await registry.upsertOwnedActivity(state.ownerKey, projection, observed);
      else await registry.upsertOwnedActivity(state.ownerKey, projection);
    } catch { /* execution state remains authoritative; the safe index can reconcile later */ }
  }

  private sdkCleanupReleased(state: AdmissionState, lease?: DispatcherLease): boolean | undefined {
    if (!state.drive || !state.receipt || !isManagementReceipt(state.receipt)
      || state.receipt.selection.operator.profile !== 'dispatcher') return undefined;
    if (lease?.hosting === 'normal') return undefined;
    return !!lease && (lease.generation === state.drive.generation
      || (state.drive.status === 'unknown' || state.drive.status === 'cancel-requested')
        && lease.status === 'unknown' && state.drive.generation === lease.generation + 1)
      && lease.inputDigest === state.receipt.intentDigest
      && lease.artifactDigest === state.receipt.selection.release.bundleDigest && lease.sdkReleased === true;
  }

  async #dispatcherDiagnosticState(): Promise<{ admission?: AdmissionState; lease?: DispatcherLease; journal?: DispatcherJournal }> {
    const values = await this.ctx.storage.get<AdmissionState | DispatcherLease | DispatcherJournal>(
      ['admission', DISPATCHER_LEASE, DISPATCHER_JOURNAL]);
    return { admission: values.get('admission') as AdmissionState | undefined,
      lease: values.get(DISPATCHER_LEASE) as DispatcherLease | undefined,
      journal: values.get(DISPATCHER_JOURNAL) as DispatcherJournal | undefined };
  }

  /** Fixed metadata enumeration only; never open response caches or migrate the legacy journal. */
  async #dispatcherOperationDiagnostics(admission: AdmissionState, lease: DispatcherLease | undefined,
    journal: DispatcherJournal | undefined, inspectionDeadline: number): Promise<DispatcherOperationDiagnostics> {
    const unavailable = (reason: NonNullable<DispatcherOperationDiagnostics['reason']>) =>
      operationsUnavailable(reason, journal?.generation ?? null);
    if (!admission.receipt || !isManagementReceipt(admission.receipt)
      || admission.receipt.selection.operator.profile !== 'dispatcher') return unavailable('not-dispatcher');
    if (!journal) return unavailable('no-journal');
    if (!lease || journal.generation !== lease.generation
      || admission.receipt.intentDigest !== lease.inputDigest
      || admission.receipt.selection.release.bundleDigest !== lease.artifactDigest
      || admission.executionContext?.artifactDigest !== lease.artifactDigest
      || !admission.drive || admission.drive.generation !== lease.generation
        && !(admission.drive.generation === lease.generation + 1 && lease.status === 'unknown'
          && ['unknown', 'cancel-requested'].includes(admission.drive.status))) return unavailable('binding-mismatch');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([(async (): Promise<DispatcherOperationDiagnostics> => {
        const prefix = `dispatcher:operation:${journal.generation}:`;
        const latest: Array<{ key: string; record: DispatcherOperationRecord }> = [];
        let after: string | undefined;
        let inspectedEntries = 0;
        let complete = false;
        for (let page = 0; page < 32; page++) {
          if (Date.now() >= inspectionDeadline) return unavailable('read-timeout');
          const entries = await this.ctx.storage.list<DispatcherOperationRecord>({ prefix, limit: 32,
            ...(after ? { startAfter: after } : {}) });
          for (const [key, record] of entries) {
            if (record.generation !== journal.generation) return unavailable('binding-mismatch');
            inspectedEntries++;
            latest.push({ key, record });
            latest.sort((a, b) => (b.record.ordinal ?? -1) - (a.record.ordinal ?? -1));
            if (latest.length > 8) latest.pop();
            after = key;
          }
          if (entries.size < 32) { complete = true; break; }
        }
        const records: DispatcherOperationDiagnostics['records'] = [];
        const digest = (value: string | undefined) => syncDigest.safeParse(value).success ? value! : null;
        for (const { key, record } of latest) {
          if (Date.now() >= inspectionDeadline) return unavailable('read-timeout');
          const operationId = key.slice(prefix.length);
          const current = record.inference?.version === 1
            ? await this.ctx.storage.get<DispatcherInferenceAttempt>(inferenceAttemptKey(journal.generation,
              operationId, record.inference.attempt)) : undefined;
          const attempt = current?.index === record.inference?.attempt ? current : undefined;
          const phaseBinding = record.phaseBinding;
          records.push({ operationDigest: await sha256(operationId), ordinal: record.ordinal ?? null,
            status: record.phase, requestDigest: digest(record.requestDigest), responseDigest: digest(record.responseDigest),
            binding: phaseBinding ? {
              scope: phaseBinding.submissionId === lease.submissionId ? 'requested' : 'other',
              submissionDigest: await sha256(phaseBinding.submissionId), deliveryDigest: await sha256(phaseBinding.deliveryToken),
              phase: phaseBinding.phase.kind, phaseIndex: phaseBinding.phase.kind === 'target' ? phaseBinding.phase.index : null,
              resource: (['inference', 'source', 'comment', 'merge', 'pull-request', 'files', 'checks',
                'release-notes', 'upstream-guide', 'changed-compose', 'open-pull-requests'] as const)
                .find(resource => resource === phaseBinding.resource) ?? 'unknown',
            } : null,
            hostInference: attempt ? { index: attempt.index, ordinal: attempt.ordinal, status: attempt.phase,
              classification: attempt.classification ?? 'unknown', responseDigest: digest(attempt.responseDigest) } : null });
        }
        // Charged retries increase journal.count without creating logical operation entries.
        return { status: 'available', generation: journal.generation, selection: 'highest-logical-ordinals',
          scan: complete ? 'complete' : 'bounded', inspectedEntries,
          omittedEntries: !complete || inspectedEntries > records.length, records };
      })(), new Promise<DispatcherOperationDiagnostics>(resolve => {
        timer = setTimeout(() => resolve(unavailable('read-timeout')), Math.max(0, inspectionDeadline - Date.now()));
      })]);
    } catch { return unavailable('read-failed'); }
    finally { clearTimeout(timer); }
  }

  /** Owner v2 reads use only original retained parent metadata; never acquire a child or renew authority. */
  async getDispatcherDiagnosticsV2(ownerKey: string, options: DiagnosticReadOptions): Promise<
    { status: 200; value: Record<string, unknown> } | { status: 400 | 404 | 409 | 503; code: string }> {
    if (!syncDigest.safeParse(ownerKey).success) return { status: 404, code: 'NOT_FOUND' };
    try {
      const value = await readActivityDiagnostics({ storage: this.ctx.storage, env: this.#appEnv, ownerKey,
        state: async (): Promise<DiagnosticReadState | null> => {
          await this.#diagnosticQueue;
          const { admission, lease, journal } = await this.#dispatcherDiagnosticState();
          if (!admission || admission.ownerKey !== ownerKey) return null;
          const artifactDigest = lease?.artifactDigest ?? admission.diagnosticBinding?.artifactDigest ?? admission.executionContext?.artifactDigest;
          const inputDigest = lease?.inputDigest ?? admission.diagnosticBinding?.inputDigest ?? admission.receipt?.intentDigest;
          if (!artifactDigest || !inputDigest) return null;
          return { ownerKey: admission.ownerKey, activityId: admission.intent.activityId,
            binding: { generation: lease?.generation ?? admission.diagnosticBinding?.generation ?? admission.drive?.generation ?? 0, artifactDigest, inputDigest },
            bindingValid: lease ? this.#diagnosticBindingValid(admission, lease) : !!admission.diagnosticBinding
              && artifactDigest === admission.executionContext?.artifactDigest && inputDigest === admission.receipt?.intentDigest,
            expectedIndex: admission.diagnosticsVersion === 1,
            logging: executionLoggingEnabled(admission.receipt), status: admission.drive?.status,
            operations: journal?.generation === lease?.generation && typeof journal?.nextOrdinal === 'number'
              && Number.isSafeInteger(journal.nextOrdinal) && journal.nextOrdinal >= 0 ? journal.nextOrdinal : null,
            provenance: lease?.sdkProvenance ?? null, rootDigest: lease?.rootDigest
              ?? (lease?.serial?.current.receipt?.uid ? hashDiagnostic(lease.serial.current.receipt.uid) : undefined),
            submissionId: lease?.submissionId, fence: admission.diagnosticFence,
            recorderUnavailable: admission.diagnosticRecorderUnavailable,
            sdkRetired: !!lease && (lease.sdkReleased === true || lease.status === 'unknown' || lease.status === 'settled'
              || admission.drive?.generation !== lease.generation) };
        },
        projectOperation: async (id, raw, legacy, state, generation): Promise<OperationRecord> => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid operation metadata');
          const entry = raw as DispatcherOperationRecord;
          if (!Number.isSafeInteger(generation) || generation < 0 || generation > state.binding.generation
            || entry.generation !== generation || !['reserved', 'completed', 'unknown'].includes(entry.phase)) throw new Error('Invalid operation binding');
          const safeNumber = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
          const digest = (value: unknown) => syncDigest.safeParse(value).success ? value as string : null;
          const operationDigest = hashDiagnostic(id);
          const phase = entry.phaseBinding;
          let binding: DispatcherOperationDiagnostics['records'][number]['binding'] = null;
          if (phase && typeof phase.submissionId === 'string' && phase.submissionId.length <= 512
            && typeof phase.deliveryToken === 'string' && phase.deliveryToken.length <= 512
            && ['discovery', 'target', 'final'].includes(phase.phase?.kind)) {
            binding = { scope: phase.submissionId === state.submissionId ? 'requested' : 'other',
              submissionDigest: hashDiagnostic(phase.submissionId), deliveryDigest: hashDiagnostic(phase.deliveryToken),
              phase: phase.phase.kind, phaseIndex: phase.phase.kind === 'target' ? safeNumber(phase.phase.index) : null,
              resource: (['inference', 'source', 'comment', 'merge', 'pull-request', 'files', 'checks', 'release-notes',
                'upstream-guide', 'changed-compose', 'open-pull-requests'] as const).find(resource => resource === phase.resource) ?? 'unknown' };
          }
          let hostInference: DispatcherOperationDiagnostics['records'][number]['hostInference'] = null;
          if (entry.inference?.version === 1 && safeNumber(entry.inference.attempt) !== null) {
            const attempt = await this.ctx.storage.get<DispatcherInferenceAttempt>(inferenceAttemptKey(generation, id, entry.inference.attempt));
            if (attempt?.index === entry.inference.attempt && safeNumber(attempt.ordinal) !== null
              && ['ready', 'in-flight', 'completed', 'unknown'].includes(attempt.phase)) hostInference = {
              index: attempt.index, ordinal: attempt.ordinal, status: attempt.phase,
              classification: (['usable', 'final-error', 'retryable', 'permanent', 'transport', 'unknown'] as const)
                .find(value => value === attempt.classification) ?? 'unknown', responseDigest: digest(attempt.responseDigest) };
          }
          return { kind: 'operation', id: `o-${generation}-${operationDigest}`, generation,
            operationDigest, ordinal: safeNumber(entry.ordinal), status: entry.phase, requestDigest: digest(entry.requestDigest),
            responseDigest: digest(entry.responseDigest), binding, hostInference, availability: 'retained',
            association: legacy ? 'legacy' : binding ? 'verified' : 'unassociated' };
        } }, options);
      return value ? { status: 200, value } : { status: 404, code: 'NOT_FOUND' };
    } catch (error) {
      return error instanceof DiagnosticReadError ? { status: error.status, code: error.code }
        : { status: 503, code: 'DIAGNOSTICS_UNAVAILABLE' };
    }
  }

  /** Protected storage snapshot; deliberately not an ordinary execution entrypoint. */
  async getDispatcherDiagnostics(ownerKey: string): Promise<DispatcherActivityDiagnostics | null> {
    if (!syncDigest.safeParse(ownerKey).success) return null;
    const before = await this.#dispatcherDiagnosticState();
    const { admission, lease, journal } = before;
    if (!admission || admission.ownerKey !== ownerKey) return null;
    const inspectionDeadline = Date.now() + 10_000;
    const binding = (state: typeof before) => JSON.stringify([state.admission?.ownerKey,
      state.admission?.intent, state.admission?.phase, state.admission?.receipt?.intentDigest,
      state.admission?.executionContext?.artifactDigest, state.admission?.drive?.generation,
      state.admission?.drive?.status, state.lease, state.journal]);
    const original = binding(before);
    const parent: DispatcherActivityDiagnostics['parent'] = {
      admissionPhase: admission.phase, driveGeneration: admission.drive?.generation ?? null,
      executionStatus: admission.drive?.status ?? 'queued', updatedAt: admission.updatedAt ?? null,
      checkpointPresent: admission.drive?.checkpoint != null, resultPresent: admission.drive?.result != null,
      lease: lease ? { generation: lease.generation, status: lease.status,
        artifactDigest: lease.artifactDigest, inputDigest: lease.inputDigest, expiresAt: lease.expiresAt,
        expired: lease.expiresAt <= Date.now(), sdkReleased: lease.sdkReleased === true,
        projectionPresent: lease.projection !== undefined,
        submissionDigest: lease.submissionId ? await sha256(lease.submissionId) : null,
        settledSubmissionDigest: lease.settledSubmissionId ? await sha256(lease.settledSubmissionId) : null,
        phase: lease.serial?.current.phase.kind ?? 'single',
        phaseIndex: lease.serial?.current.phase.kind === 'target' ? lease.serial.current.phase.index : null,
        deliveryDigest: lease.serial ? await sha256(lease.serial.current.deliveryToken) : null,
        receiptPresent: !!lease.serial?.current.receipt || !!lease.submissionId,
        previousPhases: lease.serial?.previous.length ?? 0, targetCount: lease.serial?.targets?.length ?? null,
        resultCount: lease.serial?.results.length ?? null } : null,
      journal: journal ? { generation: journal.generation, count: journal.count,
        unresolved: journal.unresolved, nextOrdinal: journal.nextOrdinal } : null,
      operations: operationsUnavailable('no-journal', journal?.generation ?? null),
      reconciliationInFlight: this.#reconciling !== undefined,
      facetCachePresent: this.#dispatcher !== undefined,
    };
    const capturedAt = new Date().toISOString();
    parent.operations = await this.#dispatcherOperationDiagnostics(admission, lease, journal, inspectionDeadline);
    let sdk = sdkUnavailable('unbound');
    if (!admission.receipt || !isManagementReceipt(admission.receipt)
      || admission.receipt.selection.operator.profile !== 'dispatcher') sdk = sdkUnavailable('not-dispatcher');
    else if (lease?.hosting === 'normal') sdk = sdkUnavailable('unsupported-storage');
    else if (lease?.sdkReleased || lease && (lease.status === 'unknown' || lease.status === 'settled')
      || lease && admission.drive?.generation !== lease.generation) sdk = sdkUnavailable('retired');
    else if (lease?.status === 'running' && lease.submissionId && lease.serial?.current.receipt
      && admission.executionContext?.artifactDigest === lease.artifactDigest
      && admission.receipt.intentDigest === lease.inputDigest
      && admission.receipt.selection.release.bundleDigest === lease.artifactDigest
      && lease.serial.current.receipt.submissionId === lease.submissionId) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        sdk = await Promise.race([(async () => {
          if (Date.now() >= inspectionDeadline) return sdkUnavailable('read-timeout');
          const activities = this.#appEnv.OPERATOR_ACTIVITY;
          if (!activities || !this.#appEnv.LOADER) return sdkUnavailable('runtime-unavailable');
          const bytes = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').getManagementBundle(lease.artifactDigest);
          if (!bytes) return sdkUnavailable('runtime-unavailable');
          const bundle = await parseDispatcherBundle(bytes, lease.artifactDigest);
          if (bundle.versions.runtime !== '2.2.2' || bundle.versions.agents !== '0.20.1') return sdkUnavailable('unsupported-storage');
          if (Date.now() >= inspectionDeadline) return sdkUnavailable('read-timeout');
          const prospectiveAdmissionId = await this.ctx.storage.get<string>('prospective-admission');
          const plan: OperatorRuntimePlan = { activityId: admission.intent.activityId, deadline: admission.intent.deadline,
            invocationJson: admission.invocationJson ?? 'null', receipt: admission.receipt!,
            executionContext: admission.executionContext!, ...(prospectiveAdmissionId ? { prospectiveAdmissionId } : {}) };
          const dynamicClass = await this.#dispatcherClass(lease, plan, bundle);
          // Retirement while the bundle/class is loading must not reconstruct a retired child.
          if (binding(await this.#dispatcherDiagnosticState()) !== original) return sdkUnavailable('changed-binding');
          if (Date.now() >= inspectionDeadline) return sdkUnavailable('read-timeout');
          const context = this.ctx as unknown as { facets: { get(name: string, init: () => unknown): DispatcherSqlFacet } };
          const child = context.facets.get('dispatcher', () => ({ class: dynamicClass, id: activities.idFromName('dispatcher') }));
          // Agents.sql is a base storage method, not a startup-wrapped custom method.
          // Do not use #dispatcherFacet, fetch, _cf_initAsFacet or fixtureSnapshot here.
          return readDispatcherSdkDiagnostics(child, lease.submissionId!, lease.serial!.current.receipt!.uid, sha256);
        })(), new Promise<ReturnType<typeof sdkUnavailable>>(resolve => {
          timer = setTimeout(() => resolve(sdkUnavailable('read-timeout')), Math.max(0, inspectionDeadline - Date.now()));
        })]);
      } catch { sdk = sdkUnavailable('read-failed'); }
      finally { clearTimeout(timer); }
    }
    const after = await this.#dispatcherDiagnosticState();
    if (after.admission?.ownerKey !== ownerKey || after.admission.intent.activityId !== admission.intent.activityId) return null;
    const consistency = binding(after) === original ? 'stable-binding' : 'changed-binding';
    if (consistency === 'changed-binding') {
      sdk = sdkUnavailable('changed-binding');
      parent.operations = operationsUnavailable('changed-binding', journal?.generation ?? null);
    }
    const snapshot: DispatcherActivityDiagnostics = { version: 1, activityId: admission.intent.activityId,
      capturedAt, consistency, parent, sdk };
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 64 * 1024) snapshot.sdk = sdkUnavailable('response-limit');
    return snapshot;
  }

  async getBrowserSummary(ownerKey: string): Promise<OperatorBrowserSummary | null> {
    this.#resumeDispatcherOnEntry();
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state?.ownerKey || state.ownerKey !== ownerKey) return null;
    return this.browserSummary(state, await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE));
  }

  /** Metadata-only owner inspection; never migrate, replay or change a journal. */
  private async inspectDispatcherJournal(state: AdmissionState): Promise<void> {
    try {
      if (!state.drive || !state.receipt || !isManagementReceipt(state.receipt)
        || state.receipt.selection.operator.profile !== 'dispatcher') return;
      const journal = await this.ctx.storage.get<DispatcherJournal>(DISPATCHER_JOURNAL);
      if (!journal) return;
      const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      let generation = state.drive.generation;
      if (journal.generation !== generation) {
        if (state.drive.status !== 'unknown' || !lease || lease.status !== 'unknown'
          || generation !== lease.generation + 1 || journal.generation !== lease.generation
          || lease.inputDigest !== state.receipt.intentDigest
          || lease.artifactDigest !== state.receipt.selection.release.bundleDigest) return;
        generation = lease.generation;
      }
      if (state.drive.status === 'unknown' && lease?.status === 'unknown' && lease.generation === generation
        && lease.inputDigest === state.receipt.intentDigest
        && lease.artifactDigest === state.receipt.selection.release.bundleDigest
        && lease.submissionId && lease.projection?.outcome === 'failed') {
        const type = lease.projection.error?.type ?? '';
        const sdkErrorType = ['cloudflare_ai_binding_error', 'invalid_request', 'tool_input_validation',
          'tool_output_validation', 'operation_failed', 'submission_timeout', 'submission_aborted',
          'internal_error', 'submission_retry_exhausted'].includes(type) ? type : 'other';
        inferenceDiagnostic({ activityId: state.intent.activityId, generation,
          loggingEnabled: executionLoggingEnabled(state.receipt) },
        { stage: 'journal-inspection', boundary: 'projection', outcome: 'failed', sdkErrorType });
      }
      const prefix = `dispatcher:operation:${generation}:`;
      let after: string | undefined;
      const latest: Array<{ key: string; record: DispatcherOperationRecord }> = [];
      let inspectedEntries = 0;
      for (let page = 0; page < 32; page++) {
        const entries = await this.ctx.storage.list<DispatcherOperationRecord>({ prefix, limit: 32, ...(after ? { startAfter: after } : {}) });
        for (const [key, record] of entries) {
          inspectedEntries++;
          latest.push({ key, record });
          latest.sort((a, b) => (b.record.ordinal ?? -1) - (a.record.ordinal ?? -1));
          if (latest.length > 8) latest.pop();
          after = key;
        }
        if (entries.size < 32) break;
      }
      for (const { key, record } of latest) {
        const trace = { activityId: state.intent.activityId, generation, loggingEnabled: executionLoggingEnabled(state.receipt), operationOrdinal: record.ordinal, requestDigest: record.requestDigest };
        const response = record.phase === 'completed'
          ? await this.ctx.storage.get<NonNullable<DispatcherOperationRecord['response']>>(`dispatcher:response:${key.slice(prefix.length)}`) : undefined;
        const matchingResponse = response && record.responseDigest && await sha256(response.body) === record.responseDigest;
        const observation = matchingResponse ? inferenceResponseObservation(response!) : undefined;
        inferenceDiagnostic(trace, { stage: 'journal-inspection', outcome: response && !matchingResponse ? 'unknown' : 'observed', journalCount: journal.count,
          inspectedEntries, responseDigest: record.responseDigest, ...observation, sampled: inspectedEntries < journal.count || observation?.sampled === true });
      }
    } catch { /* Inspection failure cannot change an authorized owner's status read. */ }
  }

  /** Immutable response observation only. No SDK, authorization renewal, diagnostics or journal mutation. */
  private async retiredEffectReceipts(state: AdmissionState, lease: DispatcherLease | undefined,
    after?: number): Promise<RetiredEffectReceipts> {
    const unavailable: RetiredEffectReceipts = { version: 1, activityId: state.intent.activityId,
      scan: 'unavailable', pageStatus: 'unavailable', journalCount: null, inspectedEntries: 0,
      unresolvedJournalEntries: null, unclassifiedEntries: 0, nextAfterOrdinal: null, items: [] };
    const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    try {
      const receipt = state.receipt;
      const journal = await this.ctx.storage.get<DispatcherJournal>(DISPATCHER_JOURNAL);
      if (!receipt || !isManagementReceipt(receipt) || receipt.selection.operator.profile !== 'dispatcher'
        || receipt.selection.release.intentVersion !== '4' || !state.drive || !lease?.serial || !journal
        || !['cancel-requested', 'unknown'].includes(state.drive.status) || lease.status !== 'unknown'
        || !integer(lease.generation) || lease.generation < 1 || state.drive.generation !== lease.generation + 1
        || journal.generation !== lease.generation || receipt.activityId !== state.intent.activityId
        || receipt.intentDigest !== state.intent.intentDigest || lease.inputDigest !== receipt.intentDigest
        || !digest(lease.inputDigest) || !digest(lease.artifactDigest)
        || lease.artifactDigest !== receipt.selection.release.bundleDigest
        || state.executionContext?.artifactDigest !== lease.artifactDigest
        || !integer(journal.count) || !integer(journal.nextOrdinal) || !integer(journal.unresolved)
        || journal.unresolved > journal.count || !state.invocationJson) return unavailable;
      const admissionDigest = await sha256(JSON.stringify(receipt));
      const authority: DispatcherPhaseAuthority = { scope: 'submission', generation: lease.generation,
        deadline: new Date(lease.expiresAt).toISOString(), releaseDigest: lease.artifactDigest,
        authorityDigest: admissionDigest, repositoryJson: state.invocationJson,
        assessmentBytes: dispatcherCapacities(receipt.selection.operator.policy).assessmentBytes };
      // Reuse the strict, pure reconstruction check, never a live SDK/status read.
      const context = dispatcherPhaseContext(lease.serial, authority, lease.serial.current.deliveryToken);
      if (context.submissionId !== lease.submissionId) return unavailable;
      const repository = JSON.parse(state.invocationJson).repository as string;
      const prefix = `dispatcher:operation:${lease.generation}:`;
      const entries: Array<{ key: string; record: DispatcherOperationRecord }> = [];
      let startAfter: string | undefined;
      let exhausted = false;
      for (let page = 0; page < 32; page++) {
        const rows = await this.ctx.storage.list<DispatcherOperationRecord>({ prefix, limit: 32,
          ...(startAfter ? { startAfter } : {}) });
        for (const [key, record] of rows) { entries.push({ key, record }); startAfter = key; }
        if (rows.size < 32) { exhausted = true; break; }
      }
      const ordinals = new Set<number>();
      let damaged = journal.nextOrdinal !== journal.count;
      let unclassifiedEntries = 0;
      const candidates: typeof entries = [];
      for (const row of entries) {
        const entry = row.record;
        if (!entry || !integer(entry.ordinal) || entry.ordinal >= journal.nextOrdinal
          || ordinals.has(entry.ordinal) || entry.generation !== lease.generation) { damaged = true; continue; }
        ordinals.add(entry.ordinal);
        if (entry.request?.method === 'POST' || entry.request?.method === 'PUT') candidates.push(row);
        else if (entry.request?.method !== 'GET' && !entry.inference && !entry.native) unclassifiedEntries++;
      }
      const complete = exhausted && !damaged && unclassifiedEntries === 0
        && entries.length === journal.count && ordinals.size === journal.count;
      if (after !== undefined && (!integer(after) || !ordinals.has(after))) return unavailable;
      candidates.sort((a, b) => a.record.ordinal! - b.record.ordinal!);
      const remaining = candidates.filter(row => after === undefined || row.record.ordinal! > after);
      const items: RetiredEffectItem[] = [];
      for (const { key, record: entry } of remaining.slice(0, 8)) {
        const method = entry.request!.method as 'POST' | 'PUT';
        const item: RetiredEffectItem = { ordinal: entry.ordinal!, operationDigest: await sha256(key.slice(prefix.length)),
          journalPhase: ['reserved', 'completed', 'unknown'].includes(entry.phase) ? entry.phase : 'unknown',
          binding: 'unresolved', method, effect: method === 'POST' ? 'comment' : 'merge',
          ...(digest(entry.requestDigest) ? { requestDigest: entry.requestDigest } : {}),
          ...(digest(entry.responseDigest) ? { responseDigest: entry.responseDigest } : {}) };
        items.push(item);
        const binding = entry.phaseBinding;
        if (!binding || binding.resource !== 'source' || binding.phase.kind !== 'target'
          || !integer(binding.phase.index) || typeof binding.submissionId !== 'string'
          || typeof binding.deliveryToken !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(binding.deliveryToken)) continue;
        const phase = binding.phase;
        const frozen = lease.serial.targets?.[phase.index];
        const original = binding.submissionId === context.submissionId ? context.phase
          : lease.serial.previous.find(row => row.submissionId === binding.submissionId)?.phase;
        if (!frozen || !original || !sameDispatcherPhaseValue(original, phase)
          || !sameDispatcherPhaseValue(frozen, phase.target)
          || binding.submissionId === context.submissionId && binding.deliveryToken !== context.deliveryToken) continue;
        const expectedUrl = `${dispatcherGithubApiOrigin(this.#appEnv)}/repos/${repository}/${method === 'POST'
          ? `issues/${frozen.pullRequest}/comments` : `pulls/${frozen.pullRequest}/merge`}`;
        if (entry.request!.url !== expectedUrl) continue;
        Object.assign(item, { phaseIndex: phase.index, submissionDigest: await sha256(binding.submissionId),
          deliveryDigest: await sha256(binding.deliveryToken), target: { repository, ...frozen } });
        if (entry.phase !== 'completed' || !digest(entry.requestDigest) || !digest(entry.responseDigest)) continue;
        const response = await this.ctx.storage.get<NonNullable<DispatcherOperationRecord['response']>>(
          `dispatcher:response:${key.slice(prefix.length)}`);
        if (!response || response.status !== 200 || typeof response.body !== 'string'
          || new TextEncoder().encode(response.body).byteLength > sourceResponseBytes(receipt.selection.installation.policy)
          || await sha256(response.body) !== entry.responseDigest) continue;
        let envelope: { url?: unknown; status?: unknown; body?: unknown };
        let body: { id?: unknown; body?: unknown; merged?: unknown; sha?: unknown };
        try { envelope = JSON.parse(response.body); body = JSON.parse(envelope.body as string); }
        catch { continue; }
        if (!envelope || !body || envelope.url !== expectedUrl || typeof envelope.body !== 'string') continue;
        if (method === 'POST' && envelope.status === 201 && integer(body.id) && body.id > 0 && typeof body.body === 'string') {
          item.observedResponse = { kind: 'comment', status: 201, commentId: body.id, responseBodyDigest: await sha256(body.body) };
        } else if (method === 'PUT' && envelope.status === 200 && body.merged === true
          && typeof body.sha === 'string' && /^[a-f0-9]{40}$/.test(body.sha)) {
          item.observedResponse = { kind: 'merge', status: 200, merged: true, mergeSha: body.sha };
        } else continue;
        item.binding = 'verified';
      }
      // A racing retirement/selection change cannot publish the pre-await association.
      const [freshState, freshLease, freshJournal] = await Promise.all([
        this.ctx.storage.get<AdmissionState>('admission'), this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE),
        this.ctx.storage.get<DispatcherJournal>(DISPATCHER_JOURNAL) ]);
      if (JSON.stringify(freshState) !== JSON.stringify(state) || JSON.stringify(freshLease) !== JSON.stringify(lease)
        || JSON.stringify(freshJournal) !== JSON.stringify(journal)) return unavailable;
      const more = remaining.length > 8;
      return { version: 1, activityId: state.intent.activityId, generation: lease.generation,
        inputDigest: lease.inputDigest, artifactDigest: lease.artifactDigest, admissionDigest,
        scan: complete ? 'complete' : 'partial', pageStatus: more ? 'more' : complete ? 'complete' : 'partial',
        journalCount: journal.count, inspectedEntries: entries.length, unresolvedJournalEntries: journal.unresolved,
        unclassifiedEntries, nextAfterOrdinal: more ? items.at(-1)!.ordinal : null, items };
    } catch { return unavailable; }
  }

  async getBrowserDetail(options?: { effectReceipts: true; receiptAfter?: number }): Promise<(OperatorBrowserSummary & {
    checkpoint: unknown; result: unknown; sdkCleanupReleased?: boolean; effectReceipts?: RetiredEffectReceipts }) | null> {
    this.#resumeDispatcherOnEntry();
    let state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state) return null;
    const dispatcher = state.drive && state.receipt && isManagementReceipt(state.receipt)
      && state.receipt.selection.operator.profile === 'dispatcher';
    let observed: OperatorBrowserSummary | null = null;
    if (dispatcher && state.ownerKey) {
      try {
        observed = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry')
          .getOwnedActivity(state.ownerKey, state.intent.activityId);
      } catch { /* owner detail remains authoritative if the retained index is unavailable */ }
      if (observed) {
        // The lookup can yield to a lifecycle transition; never publish its earlier admission snapshot.
        state = await this.ctx.storage.get<AdmissionState>('admission');
        if (!state) return null;
      }
    }
    const lease = dispatcher ? await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE) : undefined;
    const retired = options?.effectReceipts && dispatcher && ['unknown', 'cancel-requested'].includes(state.drive!.status)
      && ((state.receipt as ManagementAdmissionReceipt).selection.release.intentVersion === '4' || lease?.serial);
    // The receipt path replaces (not adds to) the metadata diagnostic scan and its response reads.
    if (!retired) await this.inspectDispatcherJournal(state);
    const effectReceipts = retired ? await this.retiredEffectReceipts(state, lease, options?.receiptAfter) : undefined;
    const released = this.sdkCleanupReleased(state, lease);
    const summary = this.browserSummary(state, lease);
    if (observed) await this.publishBrowserSummary(state, summary, observed);
    return { ...summary, checkpoint: state.drive?.checkpoint ?? null, result: state.drive?.result ?? null,
      ...(released === undefined ? {} : { sdkCleanupReleased: released }), ...(effectReceipts ? { effectReceipts } : {}) };
  }

  /** Read one already-settled Dispatcher assessment; never resume or re-admit its submission. */
  private async completeSettledDispatcherAssessment(): Promise<void> {
    const matches = (state: AdmissionState | undefined, lease: DispatcherLease | undefined): boolean => {
      const checkpoint = state?.drive?.checkpoint;
      return !!state && !!lease && state.drive?.status === 'waiting' && !!state.receipt
        && isManagementReceipt(state.receipt) && state.receipt.selection.operator.profile === 'dispatcher'
        && checkpoint !== null && typeof checkpoint === 'object' && !Array.isArray(checkpoint)
        && (checkpoint as Record<string, unknown>).submissionId === lease.submissionId
        && (checkpoint as Record<string, unknown>).inputDigest === lease.inputDigest
        && (checkpoint as Record<string, unknown>).artifactDigest === lease.artifactDigest
        && lease.status === 'settled' && lease.generation === state.drive.generation
        && lease.submissionId !== null && lease.settledSubmissionId === lease.submissionId
        && lease.inputDigest === state.receipt.intentDigest
        && lease.artifactDigest === state.receipt.selection.release.bundleDigest;
    };
    const [state, lease] = await Promise.all([this.ctx.storage.get<AdmissionState>('admission'),
      this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE)]);
    if (!matches(state, lease)) return;
    const assessment = await this.ctx.storage.get<unknown>(`dispatcher:result:${lease!.generation}`);
    if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment)
      || !z.json().safeParse(assessment).success
      || new TextEncoder().encode(JSON.stringify(assessment)).byteLength > dispatcherCapacities(state!.receipt && isManagementReceipt(state!.receipt) ? state!.receipt.selection.operator.policy : undefined).assessmentBytes) return;
    if (await this.ctx.storage.get<string>('prospective-admission')) {
      try {
        const plan = await this.getRuntimePlan();
        if (!plan) return;
        const { admittedTarget } = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (admittedTarget && !admittedDispatcherResultMatches(assessment, admittedTarget, isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined)) return;
      } catch { return; }
    }
    const committed = await this.ctx.storage.transaction(async tx => {
      const [record, currentLease] = await Promise.all([tx.get<AdmissionState>('admission'),
        tx.get<DispatcherLease>(DISPATCHER_LEASE)]);
      if (!matches(record, currentLease) || currentLease!.generation !== lease!.generation) return false;
      if ((await loadDispatcherJournal(tx, lease!.generation)).unresolved !== 0) return false;
      await tx.put<AdmissionState>('admission', { ...record!, drive: {
        ...record!.drive!, status: 'completed', checkpoint: null, result: assessment,
      }, updatedAt: Date.now() });
      return true;
    });
    if (committed) await this.publishBrowserSummary();
  }

  async collectBrowserResult(): Promise<{ ok: true; detail: OperatorBrowserSummary & { checkpoint: unknown; result: unknown;
    sdkCleanupReleased?: boolean } } | { ok: false; reason: 'not-ready' | 'not-admitted' }> {
    this.#resumeDispatcherOnEntry();
    await this.completeSettledDispatcherAssessment();
    const before = await this.ctx.storage.get<AdmissionState>('admission');
    if (before?.drive?.status === 'completed' && before.receipt && isManagementReceipt(before.receipt)
      && before.receipt.selection.operator.profile === 'dispatcher') {
      try { await this.#releaseDispatcherSdk(); }
      catch { /* The immutable result remains readable; cleanup is not claimed. */ }
    }
    const outcome = await this.ctx.storage.transaction<{ ok: true; detail: OperatorBrowserSummary & { checkpoint: unknown;
      result: unknown; sdkCleanupReleased?: boolean } } | { ok: false; reason: 'not-ready' | 'not-admitted' }>(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state) return { ok: false, reason: 'not-admitted' };
      if (state.drive?.status !== 'completed' && state.drive?.status !== 'failed') return { ok: false, reason: 'not-ready' };
      const consumed = { ...state, browserCollectionConsumed: true, updatedAt: Date.now() };
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      const released = this.sdkCleanupReleased(consumed, lease);
      await tx.put<AdmissionState>('admission', consumed);
      return { ok: true, detail: { ...this.browserSummary(consumed, lease), checkpoint: consumed.drive?.checkpoint ?? null,
        result: consumed.drive?.result ?? null, ...(released === undefined ? {} : { sdkCleanupReleased: released }) } };
    });
    const trace = before?.drive ? { activityId: before.intent.activityId, generation: before.drive.generation, loggingEnabled: executionLoggingEnabled(before.receipt) } : undefined;
    inferenceDiagnostic(trace, { stage: 'collection', outcome: outcome.ok ? 'completed' : 'denied' });
    if (outcome.ok) {
      inferenceDiagnostic(trace, { stage: 'cleanup', outcome: 'observed', sdkReleased: outcome.detail.sdkCleanupReleased, physicalCleanup: 'unknown' });
      await this.publishBrowserSummary();
    }
    return outcome;
  }

  /** Existing Registry reads original terminal proof. Never drives, re-admits or collects history. */
  async readProspectiveRenovateRetryProof(input: { repositoryId: number; pullRequest: number; head: string }):
    Promise<ProspectiveRenovateRetryProof | null> {
    this.#resumeDispatcherOnEntry();
    if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1
      || !Number.isSafeInteger(input.pullRequest) || input.pullRequest < 1 || !/^[a-f0-9]{40}$/.test(input.head)) return null;
    const bound = await this.ctx.storage.get<string>('prospective-admission');
    if (!bound) return null;
    const original = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').readProspectiveRenovateAdmission(bound);
    if (!original || original.repositoryId !== input.repositoryId || original.pullRequest !== input.pullRequest
      || original.head !== input.head) return null;
    return this.ctx.storage.transaction(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!state?.receipt || !isManagementReceipt(state.receipt) || !state.browserCollectionConsumed
        || state.drive?.status !== 'completed' || !lease?.serial || lease.status !== 'settled'
        || (lease.hosting === 'normal' ? !this.#normalSettlementObserved(lease) : !lease.sdkReleased)
        || lease.serial.current.phase.kind !== 'final' || lease.generation !== state.drive.generation
        || !lease.terminalAt || !lease.submissionId || lease.settledSubmissionId !== lease.submissionId
        || lease.serial.current.receipt?.submissionId !== lease.submissionId
        || state.intent.activityId !== original.activityId || state.ownerKey !== original.ownerKey
        || lease.artifactDigest !== original.bundleDigest || lease.inputDigest !== state.receipt.intentDigest
        || JSON.stringify(state.drive.result) !== JSON.stringify(await tx.get(`dispatcher:result:${lease.generation}`))) return null;
      const result = state.drive.result as { repository?: string; results?: Array<{ pullRequest: number; headSha: string; outcome: string; reason?: string }> };
      const row = result?.results?.length === 1 ? result.results[0] : undefined;
      if (result?.repository !== original.repository || !row || row.pullRequest !== input.pullRequest
        || row.headSha !== input.head || !['EXECUTION_FAILED', 'DEFERRED'].includes(row.outcome)
        || lease.serial.targets?.length !== 1 || lease.serial.targets[0].pullRequest !== input.pullRequest
        || lease.serial.targets[0].headSha !== input.head) return null;
      // Collection can honestly cover a deferred unknown write; that is not
      // permission for the scheduler to repeat it under a fresh operation identity.
      if (['comment-uncertain', 'merge-uncertain', 'prior-effect-uncertain'].includes(row.reason ?? '')) return null;
      let startAfter: string | undefined;
      for (;;) {
        const entries = await tx.list<DispatcherOperationRecord>({ prefix: `dispatcher:operation:${lease.generation}:`, limit: 128,
          ...(startAfter ? { startAfter } : {}) });
        for (const [key, entry] of entries) {
          startAfter = key;
          if (entry.phase !== 'completed' && entry.request && entry.request.method !== 'GET') return null;
        }
        if (entries.size < 128) break;
      }
      const parsed = prospectiveRenovateRetryProof.safeParse({ activityId: original.activityId, generation: lease.generation,
        repository: original.repository, repositoryId: original.repositoryId, baseBranch: original.baseBranch,
        pullRequest: original.pullRequest, head: original.head, createdAt: original.createdAt, artifactDigest: lease.artifactDigest,
        terminalAt: lease.terminalAt, collected: true, settled: true, sdkSubmissionId: lease.submissionId, disposition: row.outcome });
      return parsed.success ? parsed.data : null;
    });
  }

  /** Explicit parent-only publication; result collection and child operations never call this method. */
  async publishRenovateAssessment(command: { bucket: string; sessionId: string; sessionGeneration: number;
    operationId: string }, authority: { human: VerifiedHumanAccessClaims; accessJwt: string; platformAdmin: boolean }):
    Promise<{ ok: true; phase: 'completed'; effect: RenovateEffect; mergeSha?: string } | { ok: false; reason: string }> {
    this.#resumeDispatcherOnEntry();
    const validId = /^[A-Za-z0-9_-]{1,128}$/;
    if (!authority.platformAdmin || !validId.test(command.sessionId) || !validId.test(command.operationId)
      || !/^[A-Za-z0-9._-]{1,128}$/.test(command.bucket)
      || !Number.isSafeInteger(command.sessionGeneration) || command.sessionGeneration <= 0) {
      return { ok: false, reason: 'not-authorized' };
    }
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    const plan = await this.getRuntimePlan();
    if (!state?.ownerKey || !plan || state.drive?.status !== 'completed' || !state.drive.result
      || !isManagementReceipt(plan.receipt) || plan.receipt.selection.operator.profile !== 'dispatcher') {
      return { ok: false, reason: 'not-ready' };
    }
    const parent = JSON.parse(plan.invocationJson) as { repository: string; pullRequest: number };
    let assessment: ReturnType<typeof parsePublishableAssessment>;
    try { assessment = parsePublishableAssessment(state.drive.result, parent); }
    catch { return { ok: false, reason: 'invalid-assessment' }; }
    const ownerKey = await operatorOwnerKey(authority.human);
    if (state.ownerKey !== ownerKey || plan.executionContext.owner.subject !== authority.human.subject
      || plan.executionContext.owner.issuer !== authority.human.issuer
      || plan.executionContext.owner.email.toLowerCase() !== authority.human.email.toLowerCase()
      || JSON.stringify([...plan.executionContext.owner.audiences].sort()) !== JSON.stringify([...authority.human.audiences].sort())) {
      return { ok: false, reason: 'not-authorized' };
    }
    const digest = await sha256(JSON.stringify(state.drive.result));
    const generation = state.drive.generation;
    const prospective = parent.pullRequest !== 1299;
    const registry = this.#appEnv.OPERATOR_REGISTRY.getByName('registry');
    const proof = prospective ? await registry.readProspectiveRenovateAdmission(plan.activityId) : null;
    const validProof = !!proof && proof.activityId === plan.activityId
      && (!plan.prospectiveAdmissionId || plan.prospectiveAdmissionId === proof.activityId)
      && proof.installationId === plan.receipt.selection.installation.id
      && proof.repositoryId === 973175879 && proof.pullRequest === parent.pullRequest
      && proof.ownerKey === ownerKey && proof.head === assessment.observedHead
      && proof.createdAt > proof.activatedAt
      && proof.actor.bucket === command.bucket && proof.actor.sessionId === command.sessionId
      && proof.actor.sessionGeneration === command.sessionGeneration
      && proof.actor.subject === authority.human.subject && proof.actor.issuer === authority.human.issuer
      && proof.actor.email.toLowerCase() === authority.human.email.toLowerCase()
      && JSON.stringify([...proof.actor.audiences].sort()) === JSON.stringify([...authority.human.audiences].sort());
    if (prospective && (!validProof || parent.repository.toLowerCase() !== 'nikolanovoselec/komodo')) {
      return { ok: false, reason: 'not-authorized' };
    }
    const current = async () => {
      const [latest, session, rawUser] = await Promise.all([
        this.ctx.storage.get<AdmissionState>('admission'),
        new D1SessionRepository(this.#appEnv.USAGE_DB).getSession(command.bucket, command.sessionId),
        this.#appEnv.KV.get(`user:${authority.human.email.toLowerCase()}`),
      ]);
      let user: unknown;
      try { user = rawUser ? JSON.parse(rawUser) : null; } catch { /* no current role */ }
      if (!authority.platformAdmin || !user || typeof user !== 'object' || (user as { role?: unknown }).role !== 'admin'
        || !latest || latest.ownerKey !== ownerKey || latest.drive?.status !== 'completed'
        || latest.drive.generation !== generation || await sha256(JSON.stringify(latest.drive.result)) !== digest
        || session?.lifecycleState !== 'running' || session.lifecycleGeneration !== command.sessionGeneration
        || authority.human.expiresAt * 1000 <= Date.now()) throw new Error('Renovate publication authority changed');
      await authorizeDispatcherPlan(plan, this.#appEnv);
      if (prospective) {
        const live = await registry.currentProspectiveRenovateRegistration(proof!.actor.registrationId);
        if (!live || live.installationId !== proof!.installationId
          || live.bucket !== command.bucket || live.sessionId !== command.sessionId
          || live.sessionGeneration !== command.sessionGeneration
          || live.human.subject !== authority.human.subject || live.human.issuer !== authority.human.issuer
          || live.human.email.toLowerCase() !== authority.human.email.toLowerCase()) {
          throw new Error('Prospective Renovate actor changed');
        }
      }
      if (!await operatorAccessSessionCurrent(authority.human, authority.accessJwt)) {
        throw new Error('Renovate publication Access session ended');
      }
    };
    try { await current(); } catch { return { ok: false, reason: 'not-authorized' }; }
    const exports = (this.ctx as unknown as { exports?: Record<string, (input: { props: Record<string, unknown> }) => Fetcher> }).exports;
    if (!exports) return { ok: false, reason: 'unavailable' };
    let github: ReturnType<typeof renovateGithub>;
    try { github = renovateGithub({ env: this.#appEnv, exports, user: authority.human.email,
      bucket: command.bucket, repository: parent.repository, pullRequest: parent.pullRequest, current,
      prospective, prospectiveCreatedAt: proof?.createdAt }); }
    catch { return { ok: false, reason: 'unavailable' }; }
    const marker = `<!-- Codeflare Renovate ${plan.activityId}:${generation}:${assessment.observedHead} -->`;
    const commentBody = `${marker}\n${assessment.classification.toUpperCase()}: ${assessment.compatibility}\n${assessment.reasons.join('; ')}`.slice(0, 3800);
    const effectOrder: RenovateEffect[] = assessment.classification === 'safe' ? ['approval', 'merge'] : ['comment'];
    const binding = (record: RenovatePublication) => record.ownerKey === ownerKey && record.bucket === command.bucket
      && record.sessionId === command.sessionId && record.sessionGeneration === command.sessionGeneration
      && record.activityGeneration === generation && record.assessmentDigest === digest;
    const confirm = async (effect: RenovateEffect): Promise<number | null> => {
      if (effect === 'merge') {
        const response = await github.request(`/pulls/${parent.pullRequest}/merge`);
        // A 204 proves merged, not who merged; fence rather than misattribute it.
        if (response.status === 204) return -1;
        if (response.status === 404) return null;
        throw new Error('Merge readback unavailable');
      }
      const publisher = await github.publisherIdentity();
      const list: unknown = await github.json(effect === 'comment'
        ? `/issues/${parent.pullRequest}/comments?per_page=100` : `/pulls/${parent.pullRequest}/reviews?per_page=100`);
      if (!Array.isArray(list)) throw new Error('Publication readback unavailable');
      const matching = list.filter(item => item && typeof item === 'object'
        && (item as { body?: unknown }).body === (effect === 'comment' ? commentBody : marker)
        && (item as { user?: { id?: unknown; login?: unknown } }).user?.id === publisher.id
        && (item as { user?: { id?: unknown; login?: unknown } }).user?.login === publisher.login
        && (effect === 'comment' || ((item as { state?: unknown }).state === 'APPROVED'
          && (item as { commit_id?: unknown }).commit_id === assessment.observedHead))) as Array<{ id?: unknown }>;
      return matching.length === 1 && Number.isSafeInteger(matching[0].id) && (matching[0].id as number) > 0
        ? matching[0].id as number : null;
    };
    const completed = await this.ctx.storage.get<RenovatePublication>(RENOVATE_PUBLICATION);
    if (completed && binding(completed) && completed.effects.merge
      && completed.effects.merge.phase !== 'completed' && !completed.effects.merge.remoteMerged) {
      // A lost accepted merge closes the PR. Reconcile the reserved effect
      // before the open-PR preflight can reject that exact terminal outcome.
      try {
        if (await confirm('merge') === -1) {
          await this.ctx.storage.transaction(async tx => {
            const pending = await tx.get<RenovatePublication>(RENOVATE_PUBLICATION);
            if (pending && binding(pending) && pending.effects.merge?.phase !== 'completed') {
              pending.effects.merge = { phase: 'unknown', remoteMerged: true };
              await tx.put(RENOVATE_PUBLICATION, pending);
            }
          });
          return { ok: false, reason: 'remote-merged-unattributed' };
        }
      } catch { /* An unavailable read cannot authorize another merge. */ }
      return { ok: false, reason: 'uncertain-effect' };
    }
    if (completed && binding(completed) && completed.effects.merge?.remoteMerged) {
      return { ok: false, reason: 'remote-merged-unattributed' };
    }
    if (completed && binding(completed) && completed.effects[effectOrder[effectOrder.length - 1]]?.phase === 'completed') {
      return { ok: true, phase: 'completed', effect: effectOrder[effectOrder.length - 1],
        ...(completed.effects.merge?.mergeSha ? { mergeSha: completed.effects.merge.mergeSha } : {}) };
    }
    for (const effect of effectOrder) {
      try { await current(); await github.observe(assessment, effect); }
      catch { return { ok: false, reason: 'current-evidence-unavailable' }; }
      const claim = await this.ctx.storage.transaction<'reserved' | 'reconcile' | 'completed' | 'conflict'>(async tx => {
        const admission = await tx.get<AdmissionState>('admission');
        if (admission?.drive?.status !== 'completed' || admission.drive.generation !== generation
          || await sha256(JSON.stringify(admission.drive.result)) !== digest) return 'conflict';
        const previous = await tx.get<RenovatePublication>(RENOVATE_PUBLICATION);
        if (previous && !binding(previous)) return 'conflict';
        const record = previous ?? { ownerKey, bucket: command.bucket, sessionId: command.sessionId,
          sessionGeneration: command.sessionGeneration, activityGeneration: generation, assessmentDigest: digest,
          operationId: command.operationId, effects: {} };
        const existing = record.effects[effect];
        if (existing?.phase === 'completed') return 'completed';
        if (existing) return 'reconcile';
        record.effects[effect] = { phase: 'reserved' };
        await tx.put(RENOVATE_PUBLICATION, record);
        return 'reserved';
      });
      if (claim === 'conflict') return { ok: false, reason: 'stale-publication' };
      if (claim === 'completed') continue;
      let receiptId: number | null = null;
      let mergeSha: string | null = null;
      if (claim === 'reserved') {
        try {
          // The transport itself checks current authority immediately before the write.
          const response = effect === 'merge'
            ? await github.request(`/pulls/${parent.pullRequest}/merge`, 'PUT',
              { sha: assessment.observedHead, merge_method: 'merge' })
            : effect === 'approval'
              ? await github.request(`/pulls/${parent.pullRequest}/reviews`, 'POST',
                { event: 'APPROVE', body: marker, commit_id: assessment.observedHead })
              : await github.request(`/issues/${parent.pullRequest}/comments`, 'POST', { body: commentBody });
          if (response.ok) {
            const value = JSON.parse(await readDispatcherBody(response)) as { id?: unknown; merged?: unknown; sha?: unknown };
            if (effect === 'merge' && value.merged === true && /^[0-9a-f]{40}$/.test(String(value.sha))) {
              receiptId = 0; mergeSha = value.sha as string;
            }
            else if (effect !== 'merge' && Number.isSafeInteger(value.id) && (value.id as number) > 0) receiptId = value.id as number;
          }
        } catch { /* A lost response may still have produced an external effect. */ }
      }
      if (receiptId === null) {
        await this.ctx.storage.transaction(async tx => {
          const record = await tx.get<RenovatePublication>(RENOVATE_PUBLICATION);
          if (record && binding(record) && record.effects[effect]?.phase === 'reserved') {
            record.effects[effect] = { phase: 'unknown' }; await tx.put(RENOVATE_PUBLICATION, record);
          }
        });
        try { receiptId = await confirm(effect); } catch { /* No blind write retry. */ }
      }
      if (receiptId === -1 && effect === 'merge') {
        await this.ctx.storage.transaction(async tx => {
          const record = await tx.get<RenovatePublication>(RENOVATE_PUBLICATION);
          if (record && binding(record) && record.effects.merge?.phase !== 'completed') {
            record.effects.merge = { phase: 'unknown', remoteMerged: true };
            await tx.put(RENOVATE_PUBLICATION, record);
          }
        });
        return { ok: false, reason: 'remote-merged-unattributed' };
      }
      if (receiptId === null) return { ok: false, reason: 'uncertain-effect' };
      const saved = await this.ctx.storage.transaction(async tx => {
        const record = await tx.get<RenovatePublication>(RENOVATE_PUBLICATION);
        if (!record || !binding(record) || !record.effects[effect]) return false;
        record.effects[effect] = { phase: 'completed', ...(receiptId! > 0 ? { receiptId: receiptId! } : {}),
          ...(mergeSha ? { mergeSha } : {}) };
        await tx.put(RENOVATE_PUBLICATION, record);
        return true;
      });
      if (!saved) return { ok: false, reason: 'stale-publication' };
      if (claim === 'reconcile') return { ok: false, reason: 'reconciled-effect' };
    }
    const receipt = await this.ctx.storage.get<RenovatePublication>(RENOVATE_PUBLICATION);
    return { ok: true, phase: 'completed', effect: effectOrder[effectOrder.length - 1],
      ...(receipt?.effects.merge?.mergeSha ? { mergeSha: receipt.effects.merge.mergeSha } : {}) };
  }

  /** Parent-only projection excludes the capability verifier; readback grants no authority. */
  async getAdmission(): Promise<ActivityAdmissionProjection | null> {
    this.#resumeDispatcherOnEntry();
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state ? { activityId: state.intent.activityId, phase: state.phase, receipt: state.receipt } : null;
  }
}

type DispatcherChildDiagnostic = { stage: 'fetch-rejected' } | { stage: 'http-rejected'; status: number };

/** Only exact fixed child warnings enter trusted parent observability. No child text or IDs cross the filter. */
function filterDispatcherTailEvents(events: unknown): DispatcherChildDiagnostic[] {
  const result: DispatcherChildDiagnostic[] = [];
  if (!Array.isArray(events)) return result;
  let inspected = 0;
  for (const event of events.slice(0, 64)) {
    if (!event || typeof event !== 'object' || !Array.isArray(event.logs)) continue;
    for (const log of event.logs) {
      if (++inspected > 128 || result.length >= 8) return result;
      if (!log || typeof log !== 'object' || log.level !== 'warn'
        || !Array.isArray(log.message) || log.message.length !== 2
        || log.message[0] !== 'Dispatcher inference boundary') continue;
      const value: unknown = log.message[1];
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const data = value as Record<string, unknown>;
      let fields = 0;
      let allowed = true;
      for (const key in data) {
        if (++fields > 2 || (key !== 'stage' && key !== 'status')) { allowed = false; break; }
      }
      if (!allowed || !Object.hasOwn(data, 'stage')) continue;
      if (data.stage === 'fetch-rejected' && fields === 1) result.push({ stage: 'fetch-rejected' });
      else if (data.stage === 'http-rejected' && fields === 2 && Object.hasOwn(data, 'status')
        && typeof data.status === 'number' && Number.isInteger(data.status)
        && data.status >= 300 && data.status <= 599) result.push({ stage: 'http-rejected', status: data.status });
    }
  }
  return result;
}

/** Platform Tail delivery runs after the child event. Failure here cannot affect its settlement. */
export class OperatorDispatcherTail extends WorkerEntrypoint<AppEnv> {
  async tail(events: unknown): Promise<void> {
    try {
      const props = this.ctx.props as { activityId?: unknown; generation?: unknown; loggingEnabled?: boolean } | undefined;
      if (props?.loggingEnabled === false) return;
      if (!props || typeof props.activityId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(props.activityId)
        || typeof props.generation !== 'number' || !Number.isSafeInteger(props.generation)
        || props.generation < 1) return;
      for (const diagnostic of filterDispatcherTailEvents(events)) {
        dispatcherTailLog.warn('Dispatcher child inference diagnostic', {
          activityId: props.activityId, generation: props.generation, ...diagnostic,
        });
      }
    } catch { /* untrusted child logs and telemetry failures never affect execution */ }
  }
}

/** Installation-level service binding for normal Workers; no per-run props or SDK bridge. */
export class OperatorInstalledDispatcherCapability extends WorkerEntrypoint<AppEnv> {
  override async fetch(request: Request): Promise<Response> {
    try {
      const binding = await authenticateInstalledDispatcher(this.env, request);
      if (!this.env.OPERATOR_ACTIVITY) throw new Error('Dispatcher owner unavailable');
      const activity = this.env.OPERATOR_ACTIVITY.getByName(binding.activityId);
      if (new URL(request.url).pathname === '/v1/dispatcher/logging-policy') {
        return activity.dispatcherLoggingPolicy(binding.generation, request);
      }
      return new URL(request.url).pathname === '/v1/dispatcher/abort-authority'
        ? activity.dispatcherAbortAuthority(binding.generation, request)
        : activity.dispatcherInstalledCallback(binding.generation, request);
    } catch { return dispatcherRefusal('execution-inactive'); }
  }
}

/** REQ-OPERATOR-048: the child receives this fetcher, never an Activity stub or namespace. */
export class OperatorDispatcherCapability extends WorkerEntrypoint<Env> {
  #binding() {
    const props = this.ctx.props as { activityId?: unknown; generation?: unknown };
    if (!props || typeof props.activityId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(props.activityId)
      || typeof props.generation !== 'number' || !Number.isSafeInteger(props.generation) || props.generation < 1
      || !this.env.OPERATOR_ACTIVITY) throw new Error('Dispatcher binding unavailable');
    return { activity: this.env.OPERATOR_ACTIVITY.getByName(props.activityId), generation: props.generation };
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      const { activity, generation } = this.#binding();
      const url = new URL(request.url);
      if (request.headers.has('x-codeflare-native-inference') || url.origin === 'https://operator.internal'
        && ['/v1/dispatcher/native-binding', '/v1/dispatcher/native-admission', '/v1/dispatcher/native-result'].includes(url.pathname)) {
        return await activity.dispatcherNative(generation, request);
      }
      if (url.origin !== 'https://operator.internal') {
        // The same generation-bound capability services Loader outbound; identity never comes from HTTP headers.
        const operationId = request.headers.get('x-codeflare-operator-operation-id');
        if (!['GET', 'POST', 'PUT'].includes(request.method) || !operationId || !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)
          || ['authorization', 'cookie', 'cf-access-jwt-assertion', 'x-api-key'].some(name => request.headers.has(name))) {
          return Response.json({ code: 'OPERATOR_CAPABILITY_DENIED' }, { status: 403 });
        }
        let body: string | undefined;
        if (request.method !== 'GET') {
          const admittedPlan = await activity.getRuntimePlan();
          if (!admittedPlan || !isManagementReceipt(admittedPlan.receipt)) throw new Error('Dispatcher source authority unavailable');
          body = await readDispatcherBody(request, request.signal, dispatcherCapacities(admittedPlan.receipt.selection.operator.policy).dispatcherRequestBytes);
        }
        const result = await activity.dispatcherOperation(generation, new Request('https://operator.internal/v1/dispatcher/source', {
          method: 'POST', signal: request.signal, headers: { 'content-type': 'application/json',
            ...(request.headers.has('x-codeflare-dispatcher-delivery')
              ? { 'x-codeflare-dispatcher-delivery': request.headers.get('x-codeflare-dispatcher-delivery')! } : {}) },
          body: JSON.stringify({ operationId, url: request.url,
            ...(request.method !== 'GET' ? { method: request.method, body } : {}) }),
        }));
        if (!result.ok) return result;
        const plan = await activity.getRuntimePlan();
        if (!plan || !isManagementReceipt(plan.receipt)) throw new Error('Dispatcher source authority unavailable');
        const source = JSON.parse(await readDispatcherBody(result, undefined,
          sourceResponseBytes(plan.receipt.selection.installation.policy)));
        if (source.url !== request.url || !Number.isInteger(source.status) || source.status < 200 || source.status > 599
          || typeof source.body !== 'string' || !source.headers || typeof source.headers !== 'object'
          || Array.isArray(source.headers)) throw new Error('Dispatcher source receipt unavailable');
        return new Response([204, 205, 304].includes(source.status) ? null : source.body,
          { status: source.status, headers: source.headers });
      }
      if (new URL(request.url).pathname === '/v1/dispatcher/diagnostic/runtime') {
        return await activity.dispatcherRuntimeDiagnostic(generation, request);
      }
      if (new URL(request.url).pathname === '/v1/dispatcher/phase-context') {
        return await activity.dispatcherPhaseContext(generation, request);
      }
      if (new URL(request.url).pathname === '/v1/dispatcher/diagnostic') {
        return await activity.dispatcherDiagnosticReport(generation, request);
      }
      return await activity.dispatcherOperation(generation, request);
    } catch { return Response.json({ code: 'OPERATOR_CAPABILITY_DENIED' }, { status: 403 }); }
  }

  async #bridge<T>(method: DispatcherSdkMethod, args: unknown[]): Promise<T> {
    const { activity, generation } = this.#binding();
    return await activity.dispatcherBridge(generation, method, args) as T;
  }
  async _cf_scheduleForFacet<T = string>(ownerPath: DispatcherFacetPath, when: Date | string | number,
    callback: string, payload?: T, options?: { retry?: RetryOptions; idempotent?: boolean }): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this.#bridge('_cf_scheduleForFacet', [ownerPath, when, callback, payload, options]);
  }
  async _cf_scheduleEveryForFacet<T = string>(ownerPath: DispatcherFacetPath, intervalSeconds: number,
    callback: string, payload?: T, options?: { retry?: RetryOptions; _idempotent?: boolean }): Promise<{ schedule: Schedule<T>; created: boolean }> {
    return this.#bridge('_cf_scheduleEveryForFacet', [ownerPath, intervalSeconds, callback, payload, options]);
  }
  async _cf_getScheduleForFacet(ownerPath: DispatcherFacetPath, id: string): Promise<Schedule<unknown> | undefined> {
    return this.#bridge('_cf_getScheduleForFacet', [ownerPath, id]);
  }
  async _cf_listSchedulesForFacet(ownerPath: DispatcherFacetPath, criteria?: ScheduleCriteria): Promise<Schedule<unknown>[]> {
    return this.#bridge('_cf_listSchedulesForFacet', [ownerPath, criteria]);
  }
  async _cf_cancelScheduleForFacet(ownerPath: DispatcherFacetPath, id: string): Promise<{ ok: boolean; callback?: string }> {
    return this.#bridge('_cf_cancelScheduleForFacet', [ownerPath, id]);
  }
  async _cf_acquireFacetKeepAlive(ownerPath: DispatcherFacetPath): Promise<string> {
    return this.#bridge('_cf_acquireFacetKeepAlive', [ownerPath]);
  }
  async _cf_releaseFacetKeepAlive(token: string): Promise<void> {
    return this.#bridge('_cf_releaseFacetKeepAlive', [token]);
  }
  async _cf_registerFacetRun(ownerPath: DispatcherFacetPath, runId: string): Promise<void> {
    return this.#bridge('_cf_registerFacetRun', [ownerPath, runId]);
  }
  async _cf_unregisterFacetRun(ownerPath: DispatcherFacetPath, runId: string): Promise<void> {
    return this.#bridge('_cf_unregisterFacetRun', [ownerPath, runId]);
  }
  async _cf_broadcastToSubAgent(ownerPath: DispatcherFacetPath, message: unknown, without?: readonly string[]): Promise<void> {
    return this.#bridge('_cf_broadcastToSubAgent', [ownerPath, message, without]);
  }
  async _cf_subAgentConnectionMetas(ownerPath: DispatcherFacetPath): Promise<unknown[]> {
    return this.#bridge('_cf_subAgentConnectionMetas', [ownerPath]);
  }
}
