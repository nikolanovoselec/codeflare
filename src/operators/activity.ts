/**
 * Durable execution owner
 * Admission intent and receipt reconciliation come first; drive/checkpoint transitions follow.
 * Only the authenticated parent calls this object. Registry ordering and local token consumption
 * are separate transactions. Generation fences reject stale work but do not prove compute cleanup.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { Agent, type RetryOptions, type Schedule, type ScheduleCriteria } from 'agents';
import type { Env as AppEnv } from '../types';
import { parseDispatcherBundle, type DispatcherBundle } from './distribution';
import { loadOperatorDispatcherClass } from './loader';
import { DEFAULT_SOURCE_RESPONSE_BYTES, sourceResponseBytes } from './dispatcher-source-limits';
import { producerDiagnosticSchema, sdkPublicReasonCode, type ProducerDiagnostic } from './dispatcher-diagnostic-wire';
import { submissionAttemptLimit } from './dispatcher-submission-limits';
import { inferenceRequestBytes, inferenceAttemptLimit } from './dispatcher-inference-limits';
import { dispatcherCapacities, type DispatcherCapacityPolicy } from './dispatcher-capacity-limits';
import { classifyDispatcherInference, inferenceAttemptKey, inferenceRetryDelay,
  type DispatcherInferenceAttempt, type DispatcherInferenceChain, type DispatcherInferenceResponse } from './dispatcher-inference-recovery';
import { DEFAULT_DISPATCHER_OPERATION_LIMIT, dispatcherOperationLimit } from './dispatcher-operation-limits';
import { authorizeDispatcherPlan, createDispatcherOperation, parseDispatcherOperation,
  readDispatcherBody, dispatcherGithubApiOrigin, dispatcherWireRules, type DispatcherAdmittedTarget } from './operator-runtime-capability';
import { z } from 'zod';
import { readDispatcherUpdates, type DispatcherResultProjection } from './dispatcher-result';
import type { OperatorAdmissionRequest, OperatorAdmissionReceipt, ManagementAdmissionReceipt } from './registry';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { AppError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import { inferenceDiagnostic, inferenceResponseObservation, type InferenceDiagnosticContext } from '../lib/inference-diagnostics';
import { canInvokeOperator, operatorAccessSessionCurrent, requireOperatorHumanContext, resolveOperatorGroupIdentity } from '../lib/access';
import { D1SessionRepository } from '../lib/session-repository';
import { parsePublishableAssessment, renovateGithub } from './renovate-publication';
import { openOperatorExecutionAccess, projectOperatorExecution, reauthenticateOperatorExecution,
  type OperatorExecutionContext, type OperatorExecutionProjection } from './execution-context';
import { operatorOwnerKey, type OperatorBrowserSummary } from './browser-activity';
import { parseOperatorContainerProfile } from '../container/operator-context';
import type { OwnedOperatorSessionState } from './owned-session';
import { parseOperatorPackageResourceProjection, type OperatorPackageResourceProjection } from './package-resources';
import { parseOperatorAttachmentProjection, projectOperatorAttachments } from './attachments';

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
interface DispatcherLease {
  generation: number; artifactDigest: string; inputDigest: string; expiresAt: number;
  submissionId: string | null; settledSubmissionId?: string; sdkReleased?: boolean;
  projection?: DispatcherResultProjection;
  inferenceRecovery?: { version: 1; attemptLimit: number };
  status: 'admitting' | 'running' | 'settled' | 'unknown';
}
interface DispatcherOperationRecord {
  generation: number; requestDigest: string; phase: 'reserved' | 'completed' | 'unknown';
  request?: { method: 'GET' | 'POST' | 'PUT'; url: string };
  responseDigest?: string;
  ordinal?: number;
  resolution?: { readbacks: Array<{ operationId: string; requestDigest: string; responseDigest: string }> };
  response?: { status: number; contentType: string; body: string };
  inference?: DispatcherInferenceChain;
}
const DISPATCHER_LEASE = 'dispatcher:lease';
const DISPATCHER_OPERATIONS = 'dispatcher:operations';
const DISPATCHER_JOURNAL = 'dispatcher:journal';
interface DispatcherJournal { generation: number; count: number; nextOrdinal: number; unresolved: number }
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

export interface OperatorRuntimePlan {
  activityId: string;
  deadline: number;
  invocationJson: string;
  receipt: OperatorAdmissionReceipt | ManagementAdmissionReceipt;
  executionContext: OperatorExecutionContext;
  prospectiveAdmissionId?: string;
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
  invocationJson?: string;
  inferenceRecoveryVersion?: 1;
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
  #dispatcher?: { generation: number; facet: Promise<DispatcherFacet> };
  #diagnosticReportGeneration?: number;
  #diagnosticReports = 0;
  #producerReports = 0;
  #producerFailureReports = 0;
  #reconciling?: Promise<void>;
  #inferenceOwner?: { generation: number; epoch: Promise<number> };
  #inferenceFlights = new Map<string, { digest: string; controller: AbortController; result: Promise<DispatcherInferenceResponse> }>();

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env as unknown as Env);
    this.#appEnv = env as AppEnv & { OPERATOR_REGISTRY: NonNullable<AppEnv['OPERATOR_REGISTRY']> };
    ctx.blockConcurrencyWhile(async () => {
      const lease = await ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (lease?.status === 'admitting') {
        // The POST may have reached Flue. Never resubmit when its receipt was lost.
        ctx.waitUntil(this.interruptDrive(lease.generation));
      } else if (lease && lease.status !== 'running' && !lease.sdkReleased) {
        ctx.waitUntil(this.#releaseDispatcherSdk());
      }
    });
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    await this.reconcileDispatcherLease();
  }

  /** Production preparation stores parent-created encrypted human authority. */
  async prepareAuthorized(intent: OperatorActivityPreparation,
    executionContext: OperatorExecutionContext, invocationJson = 'null',
    boundary?: BoundaryActivityBinding): Promise<ActivityAdmissionResult> {
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
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state?.intent.activityId === activityId && state.boundary
      ? structuredClone(state.boundary) : null;
  }

  /** Parent-only non-driving terminal metadata; no result bytes, JWT or capability leaves this read. */
  async getBoundaryPublicationState(activityId: string): Promise<{ binding: BoundaryActivityBinding;
    generation: number; status: 'completed' | 'failed'; collected: boolean } | null> {
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
    if (!syncDigest.safeParse(ownerKey).success) return false;
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state?.ownerKey === ownerKey && (state.phase === 'prepared' || state.phase === 'admitting');
  }

  /** Parent-safe discriminator used to require live installation authorization at start. */
  async getPreparedInstallationId(): Promise<string | null> {
    const intent = (await this.ctx.storage.get<AdmissionState>('admission'))?.intent;
    return intent && 'installationId' in intent ? intent.installationId : null;
  }

  /** Parent-safe activity identity read; no credential ciphertext or token. */
  async getExecutionContext(): Promise<OperatorExecutionProjection | null> {
    const context = (await this.ctx.storage.get<AdmissionState>('admission'))?.executionContext;
    return context ? projectOperatorExecution(context) : null;
  }

  /** Bind the existing Registry reservation before any prospective preparation. */
  async bindProspectiveRenovateAdmission(activityId: string): Promise<boolean> {
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

  /** Parent-only runtime input; never returned by browser, webhook, or child capabilities. */
  async getRuntimePlan(): Promise<OperatorRuntimePlan | null> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state?.executionContext || !state.receipt || state.phase !== 'queued'
      || !await this.boundaryCurrent(state)) return null;
    const prospectiveAdmissionId = await this.ctx.storage.get<string>('prospective-admission');
    return { activityId: state.intent.activityId, deadline: state.intent.deadline,
      invocationJson: state.invocationJson ?? 'null', receipt: structuredClone(state.receipt),
      executionContext: structuredClone(state.executionContext),
      ...(prospectiveAdmissionId ? { prospectiveAdmissionId } : {}) };
  }

  /** Persist only the projection derived from the exact admitted bundle digest. */
  async savePackageResources(input: unknown): Promise<void> {
    const projection = parseOperatorPackageResourceProjection(input);
    const plan = await this.getRuntimePlan();
    if (!plan) throw new Error('Package resource digest mismatch');
    const digest = isManagementReceipt(plan.receipt)
      ? plan.receipt.selection.release.bundleDigest : plan.receipt.artifactDigest;
    if (projection.artifactDigest !== digest) throw new Error('Package resource digest mismatch');
    await this.ctx.storage.put('packageResources', projection);
  }

  async getPackageResources(): Promise<OperatorPackageResourceProjection | null> {
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
    const state = await this.ctx.storage.get<OwnedOperatorSessionState>('ownedSession');
    return state ? structuredClone(state) : null;
  }

  async prepare(intent: OperatorActivityPreparation): Promise<ActivityAdmissionResult> {
    return this.ctx.storage.transaction<ActivityAdmissionResult>(async tx => {
      if (await tx.get('admission')) return { ok: false, reason: 'already-prepared' };
      await tx.put<AdmissionState>('admission', { intent, phase: 'prepared', receipt: null });
      return { ok: true, phase: 'prepared' };
    });
  }

  /** Validate before registry I/O; consume and queue together only after receipt. */
  async start(capability: string): Promise<ActivityAdmissionResult> {
    return this.consumeStart(capability, false);
  }

  /** External start winner receives a distinct read capability exactly once. */
  async startWebhook(capability: string): Promise<WebhookStartResult> {
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
      await tx.put<AdmissionState>('admission', {
        ...state, intent: { ...intent, startVerifier: '' }, phase: 'queued', receipt,
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
    const checked = await this.readWebhook(capability);
    if (!checked.ok) return checked;
    return { ok: true, terminal: checked.terminal, status: checked.status, generation: checked.generation,
      ...(checked.terminal ? { result: checked.result } : {}) };
  }

  /** Claim one observed waiting generation; a read or delayed callback never drives a later one. */
  async continueWebhook(capability: string, expectedGeneration: number): Promise<WebhookContinueResult> {
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
    if (!syncIdentity.safeParse(operationId).success) return null;
    const operation = (await this.ctx.storage.get<AdmissionState>('admission'))?.syncOperations?.[operationId];
    return operation ? structuredClone(operation) : null;
  }

  /** Bind one admitted Review generation to immutable source, package and packet identities. */
  async prepareReviewState(input: unknown): Promise<OperatorReviewResult> {
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
    return this.updateReviewPublication(generation, head, operationId, requestDigest, 'unknown');
  }

  async completeReviewPublication(generation: number, head: string, operationId: string,
    requestDigest: string, receipt: { checkId: number; recordId: number }): Promise<OperatorReviewResult> {
    if (!Number.isSafeInteger(receipt?.checkId) || receipt.checkId < 1
      || !Number.isSafeInteger(receipt?.recordId) || receipt.recordId < 1) return { ok: false, reason: 'invalid' };
    return this.updateReviewPublication(generation, head, operationId, requestDigest, 'completed', receipt, false);
  }

  /** Complete an unknown write only from an exact external reconciliation receipt. */
  async reconcileReviewPublication(generation: number, head: string, operationId: string,
    requestDigest: string, receipt: { checkId: number; recordId: number }): Promise<OperatorReviewResult> {
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
    const review = (await this.ctx.storage.get<AdmissionState>('admission'))?.review;
    return review ? structuredClone(review) : null;
  }

  /**
   * Reserve one durable generation before loading a child. Only waiting work may
   * resume; a running/unknown drive is never replayed based on isolate loss.
   * The parent binds the returned generation to its child capabilities.
   */
  async beginDrive(expectedGeneration?: number): Promise<OperatorDriveResult> {
    const result = await this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      if (!record || record.phase !== 'queued') return { ok: false, reason: 'not-admitted' };
      if (!Number.isFinite(record.intent.deadline) || record.intent.deadline <= Date.now()
        || !await this.boundaryCurrent(record)) {
        return { ok: false, reason: 'authority-expired' };
      }
      if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration)
        || expectedGeneration < 1 || record.drive?.status !== 'waiting'
        || record.drive.generation !== expectedGeneration
        || record.webhook?.continuedGeneration !== expectedGeneration)) {
        return { ok: false, reason: 'stale-drive' };
      }
      if (record.drive?.status === 'running') return { ok: false, reason: 'drive-active' };
      if (record.drive && record.drive.status !== 'waiting') return { ok: false, reason: 'drive-settled' };
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (lease && !lease.sdkReleased) return { ok: false, reason: 'drive-active' };
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
    if (!Number.isSafeInteger(generation) || generation < 1) return false;
    const record = await this.ctx.storage.get<AdmissionState>('admission');
    return !!record && record.phase === 'queued' && record.intent.deadline > Date.now()
      && record.drive?.status === 'running' && record.drive.generation === generation
      && await this.boundaryCurrent(record);
  }

  /** Parent-only checkpoint read for the live generation; browser projections do not grant execution authority. */
  async getCurrentDriveCheckpointJson(generation: number): Promise<string | null> {
    if (!await this.operatorGenerationCurrent(generation)) return null;
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (state?.drive?.status !== 'running' || state.drive.generation !== generation
      || state.drive.checkpoint === null) return null;
    const encoded = JSON.stringify(state.drive.checkpoint);
    return typeof encoded === 'string' ? encoded : null;
  }

  /** Validate bounded child output before committing the current generation only. */
  async commitDrive(generation: number, update: unknown): Promise<OperatorDriveResult> {
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
          || journal.unresolved !== 0) {
          return { ok: false, reason: 'invalid-update' };
        }
        await tx.put(DISPATCHER_LEASE, { ...lease, status: parsed.status === 'waiting' || parsed.status === 'completed' ? 'settled' : 'unknown' });
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

  /** Fence future commits; this is not confirmation that owned compute has stopped. */
  async cancelDrive(): Promise<OperatorDriveResult> {
    const result = await this.fenceDrive('cancel-requested');
    if (result.ok) {
      await this.#releaseDispatcherSdk();
      await this.publishBrowserSummary();
      const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (lease) {
        // Fence is durable before any abort delivery. Delivery is not proof of stopped compute.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([(async () => {
            const response = await (await this.#dispatcherFacet(lease)).fetch(new Request(
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
  async interruptDrive(generation: number): Promise<OperatorDriveResult> {
    const result = await this.fenceDrive('unknown', generation);
    if (result.ok) {
      await this.#releaseDispatcherSdk();
      await this.publishBrowserSummary();
    }
    return result;
  }

  /** Fence a queued request whose one attached runtime attempt failed before loading code. */
  async fenceRuntimeFailure(expectedGeneration?: number): Promise<OperatorDriveResult> {
    const result = await this.fenceDrive('unknown', expectedGeneration, true);
    if (result.ok) {
      await this.#releaseDispatcherSdk();
      await this.publishBrowserSummary();
    }
    return result;
  }

  private async fenceDrive(status: 'cancel-requested' | 'unknown', generation?: number,
    allowWaiting = false): Promise<OperatorDriveResult> {
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
      await tx.put<AdmissionState>('admission', { ...record, drive: state, updatedAt: Date.now() });
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (lease && lease.status !== 'settled') await tx.put(DISPATCHER_LEASE, { ...lease, status: 'unknown' });
      return { ok: true, state };
    });
    if (result.ok) for (const flight of this.#inferenceFlights.values()) flight.controller.abort();
    return result;
  }

  /** REQ-OPERATOR-048: bind one already-reserved drive to immutable code/input and one Flue submission. */
  async admitDispatcher(generation: number, bundle: DispatcherBundle, artifactDigest: string,
    invocation: unknown): Promise<OperatorDriveResult> {
    let trace: InferenceDiagnosticContext | undefined;
    let boundary = 'authority';
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
      inferenceDiagnostic(trace, { stage: 'drive', outcome: 'observed', boundary });
      inferenceDiagnostic(trace, { stage: 'drive', outcome: 'started', operationLimit: dispatcherOperationLimit(plan.receipt.selection.operator.policy), inferenceRequestBytes: inferenceRequestBytes(plan.receipt.selection.operator.policy) });
      const attemptLimit = inferenceAttemptLimit(plan.receipt.selection.operator.policy);
      const lease: DispatcherLease = { generation, artifactDigest, inputDigest: plan.receipt.intentDigest,
        expiresAt: Math.floor(plan.deadline / 1000) * 1000,
        submissionId: null, status: 'admitting' };
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
        // Old completed entries remain isolated; a continued generation reserves its own reads.
        await tx.put<DispatcherJournal>(DISPATCHER_JOURNAL, { generation, count: 0, nextOrdinal: 0, unresolved: 0 });
      });
      // SDK scheduling owns the physical alarm; this is a one-shot deadline, not a new scheduler.
      await this.schedule(new Date(lease.expiresAt), 'reconcileDispatcherLease', { generation }, { idempotent: true });
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
        return { submissionId: value.submissionId as string, offset };
      });
      boundary = 'commit';
      const result = await this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!this.#leaseMatches(record, current, generation) || current!.status !== 'admitting') {
          return { ok: false, reason: 'stale-drive' };
        }
        await tx.put<DispatcherLease>(DISPATCHER_LEASE, { ...current!, submissionId: admitted.submissionId,
          projection: { offset: admitted.offset, messageIds: [], writes: 0 }, status: 'running' });
        return { ok: true, state: record!.drive! };
      });
      if (!result.ok) return this.interruptDrive(generation);
      inferenceDiagnostic(trace, { stage: 'drive', outcome: 'completed', boundary });
      return result;
    } catch {
      inferenceDiagnostic(trace, { stage: 'drive', outcome: 'failed', boundary });
      return this.interruptDrive(generation);
    }
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

  async #dispatcherFacet(lease: DispatcherLease, approved?: DispatcherBundle): Promise<DispatcherFacet> {
    if (this.#dispatcher?.generation === lease.generation) return this.#dispatcher.facet;
    const facet = (async () => {
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
      const context = this.ctx as unknown as {
        exports: {
          OperatorDispatcherCapability(options: { props: { activityId: string; generation: number } }): Fetcher;
          OperatorDispatcherTail(options: { props: { activityId: string; generation: number } }): OperatorDispatcherTail;
        };
        facets: { get(name: string, init: () => unknown): DispatcherFacet };
      };
      const props = { activityId: plan.activityId, generation: lease.generation,
        ...(executionLoggingEnabled(plan.receipt) ? {} : { loggingEnabled: false }) };
      const capability = context.exports.OperatorDispatcherCapability({ props });
      const tail = context.exports.OperatorDispatcherTail({ props });
      const admittedTarget = plan.prospectiveAdmissionId
        ? (await authorizeDispatcherPlan(plan, this.#appEnv)).admittedTarget : undefined;
      const dynamicClass = loadOperatorDispatcherClass(loader, bundle, lease.artifactDigest,
        plan.activityId, lease.generation, capability, tail,
        JSON.parse(plan.invocationJson).pullRequest === undefined ? capability : null,
        JSON.parse(plan.invocationJson).pullRequest === undefined ? dispatcherGithubApiOrigin(this.#appEnv) : undefined,
        isManagementReceipt(plan.receipt) ? sourceResponseBytes(plan.receipt.selection.installation.policy) : undefined,
        admittedTarget ? JSON.stringify(admittedTarget) : undefined, executionLoggingEnabled(plan.receipt),
        isManagementReceipt(plan.receipt) ? submissionAttemptLimit(plan.receipt.selection.operator.policy) : undefined);
      const child = context.facets.get('dispatcher', () => ({ class: dynamicClass,
        id: activities.idFromName('dispatcher') }));
      await child._cf_initAsFacet('dispatcher', [{ className: 'OperatorActivity', name: plan.activityId }], 'dispatcher');
      return child;
    })();
    this.#dispatcher = { generation: lease.generation, facet };
    return facet;
  }

  /** SDK deadline callback and alarm/reconstruction reconciliation. Only exact persisted settlement can wait. */
  async reconcileDispatcherLease(expected?: { generation: number }): Promise<void> {
    if (this.#reconciling) return this.#reconciling;
    this.#reconciling = (async () => {
      const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!lease || (expected && expected.generation !== lease.generation)
        || (lease.status !== 'running' && lease.status !== 'admitting')) return;
      if (!await this.dispatcherGenerationCurrent(lease.generation)) {
        await this.interruptDrive(lease.generation);
        return;
      }
      // Historical executions without an admission cursor are never re-read or replayed.
      if (lease.status !== 'running' || !lease.submissionId || !lease.projection) return;
      const loggingEnabled = executionLoggingEnabled((await this.ctx.storage.get<AdmissionState>('admission'))?.receipt);
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
          statusStep = 'http';
          statusHttpStatus = response.status;
          if (!response.ok) throw new Error('Dispatcher status unavailable');
          statusStep = 'body';
          return readDispatcherUpdates(response, lease.projection!, lease.submissionId!,
            AbortSignal.timeout(Math.max(1, lease.expiresAt - Date.now())),
            isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined);
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
        if (!settlement || !value.upToDate) {
          stage = 'recheck';
          inferenceDiagnostic({ activityId: plan.activityId, generation: lease.generation, loggingEnabled }, { stage: 'settlement', outcome: 'pending', boundary: stage });
          // A child may settle just after this snapshot; the deadline alarm cannot
          // read it once the lease expires. Recheck within the original lease.
          const remainingSeconds = Math.floor((lease.expiresAt - Date.now() - 1_000) / 1_000);
          if (remainingSeconds > 0) await this.schedule(Math.min(value.upToDate ? 5 : 1, remainingSeconds),
            'reconcileDispatcherLease', { generation: lease.generation }, { idempotent: true });
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
        if (settlement.outcome !== 'completed' || !await this.dispatcherGenerationCurrent(lease.generation)) {
          const errorType = settlement.error?.type ?? '';
          const reason = settlement.error?.meta?.reason ?? '';
          const label = settlement.error?.meta?.operation;
          const operation = errorType !== 'operation_failed' ? 'unknown'
            : label === 'prompt' ? 'prompt'
              : label === `direct(${lease.submissionId})` ? 'direct' : 'unknown';
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
            reasonAvailable: reason.length > 0, reasonDigest,
            reasonCode: sdkPublicReasonCode(reason), reasonBytes: new TextEncoder().encode(reason).length,
            reasonClass: [
              /\b(model|provider|api key|cloudflare_ai)\b/i.test(reason) ? 'model' : null,
              /\b(facet|rpc|schedule|bridge)\b/i.test(reason) ? 'bridge' : null,
              /\b(fetch|network|gateway|http)\b/i.test(reason) ? 'transport' : null,
              /\b(conversation|stream|persist|storage)\b/i.test(reason) ? 'state' : null,
              /\b(tool|function)\b/i.test(reason) ? 'tool' : null,
              /\b(undefined|not a function|cannot read properties)\b/i.test(reason) ? 'runtime-shape' : null,
            ].filter(Boolean).join(',') || 'none' });
          await this.interruptDrive(lease.generation); return;
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
          await this.interruptDrive(lease.generation); return;
        }
        stage = 'operations';
        // An unsettled protected operation is not a safe checkpoint, even if Flue says completed.
        const journal = await this.ctx.storage.transaction(tx => loadDispatcherJournal(tx, lease.generation));
        if (journal.unresolved !== 0) {
          if (loggingEnabled) dispatcherLog.warn('Dispatcher settlement rejected', { stage: 'operations' });
          await this.interruptDrive(lease.generation); return;
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
          await this.interruptDrive(lease.generation);
        }
      } catch (error) {
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
        await this.interruptDrive(lease.generation);
      }
    })();
    try { await this.#reconciling; } finally { this.#reconciling = undefined; }
  }

  /** REQ-OPERATOR-047: durable intent precedes protected I/O; uncertain effects are never replayed. */
  /** Supplemental, non-authorizing child telemetry; never reserves a protected operation. */
  async dispatcherDiagnosticReport(generation: number, request: Request): Promise<Response> {
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
    const diagnosticState = await this.ctx.storage.get<AdmissionState>('admission').catch(() => undefined);
    const loggingEnabled = executionLoggingEnabled(diagnosticState?.receipt);
    const trace: InferenceDiagnosticContext | undefined = diagnosticState ? { activityId: diagnosticState.intent.activityId, generation, loggingEnabled } : undefined;
    const began = performance.now();
    const denied = () => {
      inferenceDiagnostic(trace, { stage: 'authority', outcome: 'denied' });
      return Response.json({ code: 'OPERATOR_CAPABILITY_DENIED' }, { status: 403 });
    };
    const deadline = (lease?: DispatcherLease) => !lease ? 'unavailable'
      : lease.expiresAt <= Date.now() ? 'expired' : 'current';
    const rejected = (stage: 'reservation' | 'effect' | 'authority' | 'upstream' | 'forwarded-upstream' | 'commit',
      resource: 'unparsed' | 'inference' | 'pull-request' | 'files' | 'checks' | 'release-notes' | 'upstream-guide' | 'changed-compose' | 'open-pull-requests' | 'comment' | 'merge' | 'source',
      lease: DispatcherLease | undefined, status: number, upstreamStatus?: number) => {
      if (loggingEnabled) dispatcherLog.warn('Dispatcher operation rejected', { stage, resource, deadline: deadline(lease), status,
        ...(upstreamStatus === undefined ? {} : { upstreamStatus }) });
    };
    if (!await this.dispatcherGenerationCurrent(generation)) {
      rejected('authority', 'unparsed', await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE).catch(() => undefined), 403);
      return denied();
    }
    let operation: Awaited<ReturnType<typeof parseDispatcherOperation>>;
    let perform: () => Promise<Response>;
    let sourceBytes = DEFAULT_SOURCE_RESPONSE_BYTES;
    let inferenceBytes = inferenceRequestBytes();
    let limits = dispatcherCapacities();
    let operationLimit = DEFAULT_DISPATCHER_OPERATION_LIMIT;
    let lease: DispatcherLease | undefined;
    let effectContext: NonNullable<Parameters<typeof createDispatcherOperation>[0]['effectContext']> | undefined;
    let preparationStep: 'parse' | 'capability' = 'parse';
    try {
      lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!lease) {
        rejected('authority', 'unparsed', undefined, 403);
        return denied();
      }
      const plan = await this.getRuntimePlan();
      if (!plan) return denied();
      const capacityPolicy = isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined;
      limits = dispatcherCapacities(capacityPolicy);
      inferenceBytes = inferenceRequestBytes(capacityPolicy);
      operationLimit = dispatcherOperationLimit(isManagementReceipt(plan.receipt) ? plan.receipt.selection.operator.policy : undefined);
      operation = await this.#boundedDispatcher(lease, () => parseDispatcherOperation(request, inferenceBytes, capacityPolicy));
      preparationStep = 'capability';
      if (operation.path === '/v1/dispatcher/source' && isManagementReceipt(plan.receipt)) {
        sourceBytes = sourceResponseBytes(plan.receipt.selection.installation.policy);
      }
      if (operation.path === '/v1/dispatcher/receipt' || operation.path === '/v1/dispatcher/resolve') {
        const { authority, policy } = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (!policy.capabilities.includes('fetch') || !await operatorAccessSessionCurrent(authority.human, authority.accessJwt)
          || JSON.parse(plan.invocationJson).pullRequest !== undefined) return denied();
        const value = operation.body as { operationId: string; requestDigest?: string;
          readbacks?: Array<{ operationId: string; requestDigest: string; responseDigest: string }> };
        return await this.ctx.storage.transaction(async tx => {
          const record = await tx.get<AdmissionState>('admission');
          const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(record, live, generation)) return denied();
          const journal = await loadDispatcherJournal(tx, generation);
          const original = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, value.operationId));
          if (!original?.request || original.generation !== generation) return denied();
          if (operation.path.endsWith('/receipt')) return Response.json({ operationId: value.operationId,
            generation, requestDigest: original.requestDigest, ...original.request, phase: original.phase,
            operationCount: journal.count, operationLimit,
            ...(original.responseDigest ? { responseDigest: original.responseDigest } : {}) });
          if (original.requestDigest !== value.requestDigest) return Response.json({ code: 'OPERATOR_OPERATION_CONFLICT' }, { status: 409 });
          const readbacks = value.readbacks!;
          if (original.request.method === 'GET' || new Set(readbacks.map(item => item.operationId)).size !== readbacks.length) return denied();
          if (original.resolution) return JSON.stringify(original.resolution.readbacks) === JSON.stringify(readbacks)
            ? Response.json({ resolved: true, operationId: value.operationId, requestDigest: original.requestDigest })
            : Response.json({ code: 'OPERATOR_OPERATION_CONFLICT' }, { status: 409 });
          if (original.phase !== 'unknown') return denied();
          for (const reference of readbacks) {
            const readback = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, reference.operationId));
            if (!readback || readback.generation !== generation || readback.phase !== 'completed'
              || readback.request?.method !== 'GET' || original.ordinal === undefined || readback.ordinal === undefined
              || readback.ordinal <= original.ordinal || readback.requestDigest !== reference.requestDigest
              || readback.responseDigest !== reference.responseDigest) return Response.json({ code: 'OPERATOR_OPERATION_UNKNOWN' }, { status: 409 });
            const receipt = await tx.get<NonNullable<DispatcherOperationRecord['response']>>(`dispatcher:response:${reference.operationId}`);
            if (!receipt || receipt.status !== 200 || JSON.parse(receipt.body).status < 200
              || JSON.parse(receipt.body).status >= 300) return Response.json({ code: 'OPERATOR_OPERATION_UNKNOWN' }, { status: 409 });
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
          || !await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher effect authority unavailable');
      } };
      if (operation.path === '/v1/dispatcher/github/comment' || operation.path === '/v1/dispatcher/github/merge') await effectContext.authorize();
      if (trace) trace.requestDigest = await sha256(JSON.stringify({ path: operation.path, body: operation.body }));
      perform = await createDispatcherOperation({ plan, env: this.#appEnv, operation, effectContext, diagnosticContext: trace,
        current: () => this.dispatcherGenerationCurrent(generation),
        exports: (this.ctx as unknown as { exports: Parameters<typeof createDispatcherOperation>[0]['exports'] }).exports });
    } catch (error) {
      try {
        const state = await this.ctx.storage.get<AdmissionState>('admission');
        if (state) {
          const failureClass = preparationStep === 'capability' ? 'authority-denied'
            : error instanceof Error && error.message === 'Dispatcher body exceeds limit' ? 'body-limit'
              : error instanceof SyntaxError ? 'invalid-json'
                : error instanceof z.ZodError ? 'invalid-wire' : 'request-denied';
          // Fixed diagnostic wire only: no request, exception text or child identity.
          if (loggingEnabled) dispatcherLog.warn('Dispatcher operation rejected', { stage: 'preparation', preparationStep, failureClass,
            activityId: state.intent.activityId, generation, resource: 'unparsed', deadline: deadline(lease), status: 403,
            ...(preparationStep === 'parse' && error instanceof z.ZodError ? dispatcherWireRules(error) : {}) });
        }
      } catch { /* Observability cannot replace the original denial. */ }
      return denied();
    }
    const resource = operation.path === '/v1/dispatcher/inference' ? 'inference'
      : operation.path === '/v1/dispatcher/source' ? 'source'
      : operation.path === '/v1/dispatcher/github/comment' ? 'comment'
        : operation.path === '/v1/dispatcher/github/merge' ? 'merge'
          : (operation.body as { resource: 'pull-request' | 'files' | 'checks' | 'release-notes' | 'upstream-guide' | 'changed-compose' | 'open-pull-requests' }).resource;
    const requestDigest = trace?.requestDigest ?? await sha256(JSON.stringify({ path: operation.path, body: operation.body }));
    inferenceDiagnostic(trace, { stage: 'operation-prepared', outcome: 'completed', resource });
    if (resource === 'inference' && lease?.inferenceRecovery?.version === 1) {
      return this.#recoverDispatcherInference(generation, operation, requestDigest, lease, inferenceBytes, operationLimit, trace);
    }
    const reserved = await this.ctx.storage.transaction(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!this.#leaseMatches(record, lease, generation)) return { kind: 'denied', reason: 'lease-mismatch',
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
        generation, requestDigest, phase: 'reserved', ordinal: journal.nextOrdinal, ...(operation.path === '/v1/dispatcher/source'
          ? { request: { method: (operation.body as { method?: 'GET' | 'POST' | 'PUT' }).method ?? 'GET',
            url: (operation.body as { url: string }).url } } : {}) });
      return { kind: 'reserved', lease: lease!, ordinal: journal.nextOrdinal, operationCount: journal.count + 1 } as const;
    });
    if (reserved.kind === 'denied') {
      inferenceDiagnostic(trace, { stage: 'journal', outcome: 'denied', resource, operationLimit, ...('operationCount' in reserved ? { operationCount: reserved.operationCount } : {}) });
      try {
        if (loggingEnabled) dispatcherLog.warn('Dispatcher operation rejected', { stage: 'reservation', reason: reserved.reason,
          ...(reserved.activityId === undefined ? {} : { activityId: reserved.activityId }), generation,
          resource, deadline: deadline(reserved.lease), status: 403,
          ...(reserved.reason === 'operation-limit' ? { operationCount: reserved.operationCount, operationLimit } : {}) });
      } catch { /* Observability cannot replace the original denial. */ }
      return denied();
    }
    if ('ordinal' in reserved && trace) trace.operationOrdinal = reserved.ordinal;
    inferenceDiagnostic(trace, { stage: 'journal', outcome: reserved.kind === 'completed' ? 'cached' : reserved.kind,
      resource, operationLimit, ...('operationCount' in reserved ? { operationCount: reserved.operationCount } : {}),
      ...(reserved.kind === 'completed' ? { ...inferenceResponseObservation(reserved.response), responseDigest: reserved.responseDigest } : {}) });
    if (reserved.kind === 'conflict') {
      rejected('reservation', resource, lease, 409);
      return Response.json({ code: 'OPERATOR_OPERATION_CONFLICT' }, { status: 409 });
    }
    const response = (value: NonNullable<DispatcherOperationRecord['response']>) => new Response(value.body, {
      status: value.status, headers: { 'content-type': value.contentType, 'cache-control': 'no-store' } });
    if (reserved.kind === 'completed') return response(reserved.response);
    const genericMutation = resource === 'source' && ((operation.body as { method?: string }).method ?? 'GET') !== 'GET';
    const readOnly = resource !== 'inference' && resource !== 'comment' && resource !== 'merge' && !genericMutation;
    if (reserved.kind === 'unknown' && genericMutation) return Response.json({ code: 'OPERATOR_OPERATION_UNKNOWN' }, { status: 409 });
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
      if (!await this.dispatcherGenerationCurrent(generation)) throw new Error('Stale protected operation');
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
          || prior?.generation !== generation || prior.requestDigest !== requestDigest) throw new Error('Stale protected result');
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
        await putDispatcherEntry(tx, journal, operation.operationId, prior,
          { ...prior, phase: 'completed', responseDigest: committedResponseDigest });
        return result;
      });
      inferenceDiagnostic(trace, { stage: 'response-commit', outcome: 'completed', resource, status: committedResult.status, ...inferenceResponseObservation(committedResult), responseDigest: committedResponseDigest, elapsedMs: performance.now() - began });
      if (committedResult.status >= 400) rejected('forwarded-upstream', resource, lease, committedResult.status);
      return response(committedResult);
    } catch (error) {
      await this.ctx.storage.transaction(async tx => {
        const live = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (live?.generation !== generation) return;
        const journal = await loadDispatcherJournal(tx, generation);
        const prior = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operation.operationId));
        if (prior?.generation === generation && prior.requestDigest === requestDigest && prior.phase === 'reserved') {
          await putDispatcherEntry(tx, journal, operation.operationId, prior, { ...prior, phase: 'unknown' });
        }
      });
      // Leave a live write's unknown intent available for read-only reconciliation.
      // Terminal SDK reconciliation still refuses collection while any intent remains unknown.
      if ((!genericMutation && resource !== 'comment' && resource !== 'merge') || !await this.dispatcherGenerationCurrent(generation)) {
        await this.interruptDrive(generation);
      }
      inferenceDiagnostic(trace, { stage: 'response-commit', outcome: 'unknown', resource, failureClass: stage === 'authority' ? 'authority' : stage === 'commit' ? 'commit' : upstreamStatus !== undefined ? 'upstream-status' : bodyReading && error instanceof Error && error.message === 'Dispatcher body exceeds limit' ? 'body-limit' : bodyReading ? 'body-read' : 'unknown', elapsedMs: performance.now() - began });
      rejected(stage, resource, lease, 409, upstreamStatus);
      return Response.json({ code: 'OPERATOR_OPERATION_UNKNOWN' }, { status: 409 });
    }
  }

  /** One logical inference owns its attempts; delivery retries join rather than poisoning its reservation. */
  async #recoverDispatcherInference(generation: number, operation: Awaited<ReturnType<typeof parseDispatcherOperation>>,
    requestDigest: string, lease: DispatcherLease, byteLimit: number, operationLimit: number,
    trace: InferenceDiagnosticContext | undefined): Promise<Response> {
    const key = `${generation}:${operation.operationId}`;
    let flight = this.#inferenceFlights.get(key);
    if (flight && flight.digest !== requestDigest) return Response.json({ code: 'OPERATOR_OPERATION_CONFLICT' }, { status: 409 });
    if (!flight) {
      const controller = new AbortController();
      // Register synchronously before the first reservation can become visible to another delivery.
      const result = this.#runDispatcherInference(generation, operation, requestDigest, lease, byteLimit, operationLimit, trace, controller)
        .finally(() => { this.#inferenceFlights.delete(key); controller.abort(); });
      flight = { digest: requestDigest, controller, result };
      this.#inferenceFlights.set(key, flight);
    }
    const value = await flight.result;
    if (value.status < 400) {
      try {
        const plan = await this.getRuntimePlan();
        if (!plan) throw new Error('Dispatcher inference unavailable');
        const { authority } = await authorizeDispatcherPlan(plan, this.#appEnv);
        if (!await operatorAccessSessionCurrent(authority.human, authority.accessJwt)
          || !await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher inference denied');
      } catch { return Response.json({ code: 'OPERATOR_CAPABILITY_DENIED' }, { status: 403 }); }
    }
    return new Response(value.body, { status: value.status,
      headers: { 'content-type': value.contentType, 'cache-control': 'no-store' } });
  }

  async #runDispatcherInference(generation: number, operation: Awaited<ReturnType<typeof parseDispatcherOperation>>,
    requestDigest: string, lease: DispatcherLease, byteLimit: number, operationLimit: number,
    trace: InferenceDiagnosticContext | undefined, controller: AbortController): Promise<DispatcherInferenceResponse> {
    const rejected = (code: string, status = 409): DispatcherInferenceResponse => ({ status, contentType: 'application/json', body: JSON.stringify({ code }) });
    const ownerKey = `dispatcher:inference-owner:${generation}`;
    const attemptLimit = lease.inferenceRecovery!.attemptLimit;
    let epoch: number | undefined;
    let terminalCode = 'OPERATOR_OPERATION_UNKNOWN';
    let failureClass = 'commit';
    const live = async (tx: DispatcherJournalTx) => {
      const [record, currentLease, owner] = await Promise.all([tx.get<AdmissionState>('admission'),
        tx.get<DispatcherLease>(DISPATCHER_LEASE), tx.get<number>(ownerKey)]);
      if (!this.#leaseMatches(record, currentLease, generation) || owner !== epoch || controller.signal.aborted
        || currentLease?.inferenceRecovery?.version !== 1 || currentLease.inferenceRecovery.attemptLimit !== attemptLimit) {
        throw new Error('Dispatcher inference fenced');
      }
    };
    try {
      if (!this.#inferenceOwner || this.#inferenceOwner.generation !== generation) {
        this.#inferenceOwner = { generation, epoch: this.ctx.storage.transaction(async tx => {
          if (!this.#leaseMatches(await tx.get<AdmissionState>('admission'), await tx.get<DispatcherLease>(DISPATCHER_LEASE), generation)) {
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
          || !await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher inference authority expired');
        return createDispatcherOperation({ plan, env: this.#appEnv, operation: { ...operation, signal: controller.signal },
          current: () => this.dispatcherGenerationCurrent(generation), diagnosticContext: attemptTrace,
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
              { generation, requestDigest, phase: 'reserved', ordinal: attempt.ordinal, inference: { version: 1, attempt: 1 } });
            return { kind: 'ready', attempt, operationCount: journal.count + 1 } as const;
          }
          const attemptKey = inferenceAttemptKey(generation, operation.operationId, record.inference!.attempt);
          let previous = await tx.get<DispatcherInferenceAttempt>(attemptKey);
          if (!previous) throw new Error('Dispatcher inference attempt missing');
          if (previous.phase === 'ready') return { kind: 'ready', attempt: previous, operationCount: journal.count } as const;
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
          return { kind: 'ready', attempt, operationCount: journal.count + 1 } as const;
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
          return { kind: 'ready', attempt, operationCount: journal.count } as const;
        }));
        if (next.kind === 'conflict') return rejected('OPERATOR_OPERATION_CONFLICT');
        if (next.kind === 'capacity' || next.kind === 'exhausted') {
          inferenceDiagnostic(trace, { stage: 'journal', outcome: 'denied', resource: 'inference',
            operationCount: next.operationCount, operationLimit, inferenceAttemptLimit: attemptLimit });
          if (next.kind === 'capacity') return rejected('OPERATOR_CAPABILITY_DENIED', 403);
          terminalCode = 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED'; throw new Error('Dispatcher inference exhausted');
        }
        if (next.kind === 'cached') {
          await prepare(trace, next.recoverable);
          inferenceDiagnostic(trace ? { ...trace, operationOrdinal: next.ordinal } : undefined, { stage: 'journal', outcome: 'cached', resource: 'inference', operationCount: next.operationCount, operationLimit });
          return next.response;
        }
        const attempt = next.attempt;
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
          classification = classifyDispatcherInference(response, (operation.body as { input: { stream?: boolean } }).input.stream !== false);
        } catch (error) {
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
        inferenceDiagnostic(attemptTrace, { stage: 'inference-attempt', outcome: classification === 'usable' ? 'completed' : response ? 'failed' : 'unknown',
          resource: 'inference', inferenceAttempt: attempt.index, inferenceAttemptLimit: attemptLimit,
          operationCount: next.operationCount, operationLimit, inferenceOutcome: classification,
          ...(responseFailure ? { failureClass: responseFailure } : {}),
          ...(response ? { status: response.status, responseDigest, ...inferenceResponseObservation(response) } : {}) });
        if ((classification === 'usable' || classification === 'final-error') && response) return response;
        if (classification === 'permanent') { failureClass = responseFailure ?? 'model-completion'; throw new Error('Dispatcher inference permanent failure'); }
      }
    } catch {
      // A replaced owner's late failure cannot fence its successor. Persistence ambiguity never authorizes I/O.
      let owns = false;
      try {
        owns = epoch !== undefined && await this.ctx.storage.get<number>(ownerKey) === epoch;
        if (owns) await this.ctx.storage.transaction(async tx => {
          const currentLease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (currentLease?.generation !== generation || await tx.get<number>(ownerKey) !== epoch) { owns = false; return; }
          const journal = await loadDispatcherJournal(tx, generation);
          const record = await tx.get<DispatcherOperationRecord>(dispatcherEntryKey(journal, operation.operationId));
          if (record?.requestDigest === requestDigest && record.phase === 'reserved') {
            await putDispatcherEntry(tx, journal, operation.operationId, record, { ...record, phase: 'unknown' });
          }
        });
        if (owns) await this.interruptDrive(generation);
      } catch { /* No fresh inference follows a journal or fence failure. */ }
      inferenceDiagnostic(trace, { stage: 'response-commit', outcome: 'unknown', resource: 'inference', failureClass });
      return rejected(terminalCode);
    }
  }

  /** SDK-owned bookkeeping is retired before a settled generation can be continued. */
  async #releaseDispatcherSdk(): Promise<void> {
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!lease || lease.sdkReleased || lease.status === 'running' || lease.status === 'admitting') return;
    const admission = await this.ctx.storage.get<AdmissionState>('admission');
    if (!admission) return;
    const trace = { activityId: admission.intent.activityId, generation: lease.generation, loggingEnabled: executionLoggingEnabled(admission.receipt) };
    inferenceDiagnostic(trace, { stage: 'sdk-release', outcome: 'started' });
    try {
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
    } catch (error) {
      inferenceDiagnostic(trace, { stage: 'sdk-release', outcome: 'failed', failureClass: 'sdk-cleanup' });
      throw error;
    }
  }

  async #dispatcherPath(path: DispatcherFacetPath): Promise<void> {
    const admission = await this.ctx.storage.get<AdmissionState>('admission');
    if (!admission || !Array.isArray(path) || path.length !== 2
      || path.some(segment => !segment || typeof segment !== 'object' || Array.isArray(segment)
        || Object.keys(segment).length !== 2)
      || path[0].className !== 'OperatorActivity' || path[0].name !== admission.intent.activityId
      || path[1].className !== 'FlueDispatcherAgent' || path[1].name !== 'dispatcher') {
      throw new Error('Dispatcher facet path denied');
    }
  }

  /** The exact pinned SDK list, never a general RPC reflector. Original generation is rechecked here. */
  async dispatcherBridge(generation: number, method: DispatcherSdkMethod, args: unknown[]): Promise<unknown> {
    if (!DISPATCHER_SDK_METHODS.includes(method) || !Array.isArray(args)
      || new TextEncoder().encode(JSON.stringify(args)).byteLength > 64 * 1024
      || !await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher SDK authority denied');
    if (method !== '_cf_releaseFacetKeepAlive') await this.#dispatcherPath(args[0] as DispatcherFacetPath);
    const sdk = Agent.prototype as unknown as Record<DispatcherSdkMethod, (...args: unknown[]) => Promise<unknown>>;
    if (method === '_cf_releaseFacetKeepAlive') {
      const tokens = await this.ctx.storage.get<Record<string, number>>('dispatcher:keepalive') ?? {};
      if (typeof args[0] !== 'string' || !Object.hasOwn(tokens, args[0]) || tokens[args[0]] !== generation) {
        throw new Error('Dispatcher keepalive denied');
      }
      await sdk[method].call(this, args[0]);
      delete tokens[args[0]];
      await this.ctx.storage.put('dispatcher:keepalive', tokens);
      return;
    }
    if (method === '_cf_scheduleForFacet' || method === '_cf_scheduleEveryForFacet') {
      const when = args[1];
      const delay = when instanceof Date ? (when.getTime() - Date.now()) / 1000 : when;
      if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 30
        || (method === '_cf_scheduleEveryForFacet' && delay < 1)
        || args[2] !== '__flueWakeAgentSubmissions' || args[3] !== undefined) {
        throw new Error('Dispatcher callback denied');
      }
      const options = args[4];
      if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.entries(options).some(([key, value]) => !['idempotent', '_idempotent'].includes(key) || typeof value !== 'boolean'))) {
        throw new Error('Dispatcher schedule options denied');
      }
      const schedules = await super._cf_listSchedulesForFacet(args[0] as DispatcherFacetPath);
      if (schedules.length >= 128) throw new Error('Dispatcher schedule limit');
    }
    if (['_cf_getScheduleForFacet', '_cf_cancelScheduleForFacet', '_cf_registerFacetRun', '_cf_unregisterFacetRun'].includes(method)
      && (typeof args[1] !== 'string' || !/^[A-Za-z0-9:._-]{1,128}$/.test(args[1]))) throw new Error('Dispatcher SDK identity denied');
    if (!await this.dispatcherGenerationCurrent(generation)) throw new Error('Dispatcher SDK generation changed');
    // This activity grants no subagent connections. Answer the pinned SDK's
    // connection-free facet protocol without exposing parent connections or data.
    if (method === '_cf_subAgentConnectionMetas') return [];
    if (method === '_cf_broadcastToSubAgent') return;
    if (method === '_cf_acquireFacetKeepAlive') {
      const tokens = await this.ctx.storage.get<Record<string, number>>('dispatcher:keepalive') ?? {};
      if (Object.keys(tokens).length >= 64) throw new Error('Dispatcher keepalive limit');
      const token = await sdk[method].call(this, ...args) as string;
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
    return sdk[method].call(this, ...args);
  }

  /** SDK alarm dispatch stays on the one dynamically loaded activity-private child. */
  override async _cf_dispatchScheduledCallback(ownerPath: DispatcherFacetPath, row: unknown): Promise<boolean> {
    await this.#dispatcherPath(ownerPath);
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!lease || !await this.dispatcherGenerationCurrent(lease.generation)) return false;
    return (await this.#dispatcherFacet(lease))._cf_dispatchScheduledCallback(ownerPath, row);
  }

  override async _cf_checkRunFibersForFacet(ownerPath: DispatcherFacetPath): Promise<number> {
    await this.#dispatcherPath(ownerPath);
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!lease || !await this.dispatcherGenerationCurrent(lease.generation)) return 0;
    return (await this.#dispatcherFacet(lease))._cf_checkRunFibersForFacet(ownerPath);
  }

  private browserSummary(state: AdmissionState): OperatorBrowserSummary {
    const executionStatus = state.drive?.status ?? 'queued';
    const terminal = executionStatus === 'completed' || executionStatus === 'failed';
    const safeText = (value: unknown, max = 128): string | null =>
      typeof value === 'string' && value.length <= max && /^[\p{L}\p{N} ._/#-]+$/u.test(value) ? value : null;
    let name: string | null = null;
    let context: string | null = null;
    try {
      const manifest = state.receipt && (isManagementReceipt(state.receipt)
        ? state.receipt.selection.manifestJson : state.receipt.manifestJson);
      if (manifest) name = safeText((JSON.parse(manifest) as { name?: unknown }).name);
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
        const repository = safeText(review && source?.kind === 'session' ? source.reference : value.repository, 256);
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
    return { activityId: state.intent.activityId, operatorId: state.intent.operatorId,
      ...(name ? { operatorName: name } : {}), ...(context ? { context } : {}), ...(progress ? { progress } : {}), executionStatus,
      cleanupStatus: executionStatus === 'cancel-requested' ? 'stopping' : terminal ? 'unknown' : 'pending',
      collectionStatus: state.browserCollectionConsumed ? 'consumed' : terminal ? 'ready' : 'unavailable',
      attention: executionStatus === 'failed' || executionStatus === 'unknown' || (terminal && !state.browserCollectionConsumed),
      sessionId: null, source: null, updatedAt: state.updatedAt ?? Date.now() };
  }

  private async publishBrowserSummary(): Promise<void> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state?.ownerKey) return;
    try { await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').upsertOwnedActivity(state.ownerKey, this.browserSummary(state)); }
    catch { /* execution state remains authoritative; the safe index can reconcile later */ }
  }

  private sdkCleanupReleased(state: AdmissionState, lease?: DispatcherLease): boolean | undefined {
    if (!state.drive || !state.receipt || !isManagementReceipt(state.receipt)
      || state.receipt.selection.operator.profile !== 'dispatcher') return undefined;
    return !!lease && lease.generation === state.drive.generation && lease.inputDigest === state.receipt.intentDigest
      && lease.artifactDigest === state.receipt.selection.release.bundleDigest && lease.sdkReleased === true;
  }

  async getBrowserSummary(ownerKey: string): Promise<OperatorBrowserSummary | null> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state?.ownerKey && state.ownerKey === ownerKey ? this.browserSummary(state) : null;
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

  async getBrowserDetail(): Promise<(OperatorBrowserSummary & { checkpoint: unknown; result: unknown;
    sdkCleanupReleased?: boolean }) | null> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state) return null;
    await this.inspectDispatcherJournal(state);
    const released = state.drive && state.receipt && isManagementReceipt(state.receipt)
      && state.receipt.selection.operator.profile === 'dispatcher'
      ? this.sdkCleanupReleased(state, await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE)) : undefined;
    return { ...this.browserSummary(state), checkpoint: state.drive?.checkpoint ?? null,
      result: state.drive?.result ?? null, ...(released === undefined ? {} : { sdkCleanupReleased: released }) };
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
      const released = this.sdkCleanupReleased(consumed, await tx.get<DispatcherLease>(DISPATCHER_LEASE));
      await tx.put<AdmissionState>('admission', consumed);
      return { ok: true, detail: { ...this.browserSummary(consumed), checkpoint: consumed.drive?.checkpoint ?? null,
        result: consumed.drive?.result ?? null, ...(released === undefined ? {} : { sdkCleanupReleased: released }) } };
    });
    const trace = before?.drive ? { activityId: before.intent.activityId, generation: before.drive.generation, loggingEnabled: executionLoggingEnabled(before.receipt) } : undefined;
    inferenceDiagnostic(trace, { stage: 'collection', outcome: outcome.ok ? 'completed' : 'denied' });
    if (outcome.ok) {
      inferenceDiagnostic(trace, { stage: 'cleanup', outcome: 'observed', sdkReleased: outcome.detail.sdkCleanupReleased, physicalCleanup: outcome.detail.cleanupStatus });
      await this.publishBrowserSummary();
    }
    return outcome;
  }

  /** Explicit parent-only publication; result collection and child operations never call this method. */
  async publishRenovateAssessment(command: { bucket: string; sessionId: string; sessionGeneration: number;
    operationId: string }, authority: { human: VerifiedHumanAccessClaims; accessJwt: string; platformAdmin: boolean }):
    Promise<{ ok: true; phase: 'completed'; effect: RenovateEffect; mergeSha?: string } | { ok: false; reason: string }> {
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
      if (new URL(request.url).origin !== 'https://operator.internal') {
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
          method: 'POST', signal: request.signal, headers: { 'content-type': 'application/json' },
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
