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
import { authorizeDispatcherPlan, createDispatcherOperation, parseDispatcherOperation,
  readDispatcherBody } from './gate1-production';
import { z } from 'zod';
import type { OperatorAdmissionRequest, OperatorAdmissionReceipt, ManagementAdmissionReceipt } from './registry';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { AppError } from '../lib/error-types';
import { canInvokeOperator, requireOperatorHumanContext, resolveOperatorGroupIdentity } from '../lib/access';
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
  status: 'admitting' | 'running' | 'settled' | 'unknown';
}
interface DispatcherOperationRecord {
  generation: number; requestDigest: string; phase: 'reserved' | 'completed' | 'unknown';
  response?: { status: number; contentType: string; body: string };
}
const DISPATCHER_LEASE = 'dispatcher:lease';
const DISPATCHER_OPERATIONS = 'dispatcher:operations';
const DISPATCHER_LIMIT_MS = 30_000;
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
  #reconciling?: Promise<void>;

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
        invocationJson, ownerKey, ...(boundary ? { boundary: structuredClone(boundary) } : {}), updatedAt: Date.now() });
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
    if (result.ok) await this.publishBrowserSummary().catch(() => {});
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

  /** Parent-only runtime input; never returned by browser, webhook, or child capabilities. */
  async getRuntimePlan(): Promise<OperatorRuntimePlan | null> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    if (!state?.executionContext || !state.receipt || state.phase !== 'queued'
      || !await this.boundaryCurrent(state)) return null;
    return { activityId: state.intent.activityId, deadline: state.intent.deadline,
      invocationJson: state.invocationJson ?? 'null', receipt: structuredClone(state.receipt),
      executionContext: structuredClone(state.executionContext) };
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
        ...(readVerifier ? { webhook: { readVerifier, expiresAt: intent.deadline + 7 * 24 * 60 * 60 * 1000,
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
      if (state.webhook.expiresAt <= Date.now()) return { ok: false, reason: 'capability-expired' };
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
    if (state.webhook.expiresAt <= Date.now()) return { ok: false, reason: 'capability-expired' };
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
      const json = JSON.stringify(update);
      if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > 64 * 1024) {
        return { ok: false, reason: 'invalid-update' };
      }
      const result = driveUpdateSchema.safeParse(update);
      if (!result.success) return { ok: false, reason: 'invalid-update' };
      parsed = result.data;
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
        const operations = await tx.get<Record<string, DispatcherOperationRecord>>(DISPATCHER_OPERATIONS) ?? {};
        if (lease.status !== 'running' || lease.expiresAt <= Date.now()
          || !lease.submissionId || lease.settledSubmissionId !== lease.submissionId
          || Object.values(operations).some(operation => operation.phase !== 'completed')) {
          return { ok: false, reason: 'invalid-update' };
        }
        await tx.put(DISPATCHER_LEASE, { ...lease, status: parsed.status === 'waiting' ? 'settled' : 'unknown' });
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
    return this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
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
  }

  /** REQ-OPERATOR-048: bind one already-reserved drive to immutable code/input and one Flue submission. */
  async admitDispatcher(generation: number, bundle: DispatcherBundle, artifactDigest: string,
    invocation: unknown): Promise<OperatorDriveResult> {
    try {
      const plan = await this.getRuntimePlan();
      if (!plan || !isManagementReceipt(plan.receipt) || plan.receipt.selection.operator.profile !== 'dispatcher'
        || artifactDigest !== plan.receipt.selection.release.bundleDigest
        || artifactDigest !== plan.executionContext.artifactDigest
        || JSON.stringify(invocation) !== plan.invocationJson) throw new Error('Dispatcher pin mismatch');
      const bytes = await this.#appEnv.OPERATOR_REGISTRY.getByName('registry').getManagementBundle(artifactDigest);
      if (!bytes) throw new Error('Dispatcher artifact unavailable');
      const approved = await parseDispatcherBundle(bytes, artifactDigest);
      if (JSON.stringify(approved) !== JSON.stringify(bundle)
        || approved.sourceCommit !== plan.receipt.selection.release.sourceCommit) throw new Error('Dispatcher artifact mismatch');
      await authorizeDispatcherPlan(plan, this.#appEnv);
      const lease: DispatcherLease = { generation, artifactDigest, inputDigest: plan.receipt.intentDigest,
        expiresAt: Math.floor(Math.min(plan.deadline, Date.now() + DISPATCHER_LIMIT_MS) / 1000) * 1000,
        submissionId: null, status: 'admitting' };
      await this.ctx.storage.transaction(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const previous = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (record?.drive?.status !== 'running' || record.drive.generation !== generation
          || lease.expiresAt <= Date.now() || (previous && (previous.status !== 'settled' || previous.generation !== generation - 1))) {
          throw new Error('Dispatcher generation unavailable');
        }
        await tx.put(DISPATCHER_LEASE, lease);
        // Operation identities and cached outputs are generation-scoped. A safely
        // continued generation must perform and receipt its own protected reads.
        await tx.put(DISPATCHER_OPERATIONS, {});
      });
      // SDK scheduling owns the physical alarm; this is a one-shot deadline, not a new scheduler.
      await this.schedule(new Date(lease.expiresAt), 'reconcileDispatcherLease', { generation }, { idempotent: true });
      const admitted = await this.#boundedDispatcher(lease, async () => {
        const child = await this.#dispatcherFacet(lease, approved);
        const response = await child.fetch(new Request('https://flue.internal/agents/Dispatcher/dispatcher', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'user', body: plan.invocationJson }),
        }));
        if (response.status !== 202) throw new Error('Dispatcher admission failed');
        const value = JSON.parse(await readDispatcherBody(response));
        if (typeof value?.submissionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.submissionId)) {
          throw new Error('Dispatcher admission receipt invalid');
        }
        return value.submissionId as string;
      });
      const result = await this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        if (!this.#leaseMatches(record, current, generation) || current!.status !== 'admitting') {
          return { ok: false, reason: 'stale-drive' };
        }
        await tx.put<DispatcherLease>(DISPATCHER_LEASE, { ...current!, submissionId: admitted, status: 'running' });
        return { ok: true, state: record!.drive! };
      });
      if (!result.ok) return this.interruptDrive(generation);
      return result;
    } catch { return this.interruptDrive(generation); }
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
    return this.#leaseMatches(record, lease, generation);
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
        exports: { OperatorDispatcherCapability(options: { props: { activityId: string; generation: number } }): Fetcher };
        facets: { get(name: string, init: () => unknown): DispatcherFacet };
      };
      const capability = context.exports.OperatorDispatcherCapability({ props: { activityId: plan.activityId, generation: lease.generation } });
      const dynamicClass = loadOperatorDispatcherClass(loader, bundle, lease.artifactDigest,
        plan.activityId, lease.generation, capability);
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
      if (lease.status !== 'running' || !lease.submissionId) return;
      try {
        const plan = await this.getRuntimePlan();
        if (!plan) throw new Error('Dispatcher plan unavailable');
        const value = await this.#boundedDispatcher(lease, async () => {
          const response = await (await this.#dispatcherFacet(lease)).fetch(new Request('https://flue.internal/agents/Dispatcher/dispatcher'));
          if (!response.ok) throw new Error('Dispatcher status unavailable');
          return JSON.parse(await readDispatcherBody(response));
        });
        const settlement = Array.isArray(value?.settlements)
          ? value.settlements.find((item: { submissionId?: string }) => item.submissionId === lease.submissionId) : null;
        if (!settlement) return;
        await authorizeDispatcherPlan(plan, this.#appEnv);
        if (settlement.outcome !== 'completed' || !await this.dispatcherGenerationCurrent(lease.generation)) {
          await this.interruptDrive(lease.generation); return;
        }
        // An unsettled protected operation is not a safe checkpoint, even if Flue says completed.
        const operations = await this.ctx.storage.get<Record<string, DispatcherOperationRecord>>(DISPATCHER_OPERATIONS) ?? {};
        if (Object.values(operations).some(operation => operation.phase !== 'completed')) {
          await this.interruptDrive(lease.generation); return;
        }
        await this.ctx.storage.transaction(async tx => {
          const record = await tx.get<AdmissionState>('admission');
          const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
          if (!this.#leaseMatches(record, current, lease.generation)
            || current!.submissionId !== lease.submissionId) throw new Error('Stale Dispatcher settlement');
          await tx.put(DISPATCHER_LEASE, { ...current!, settledSubmissionId: lease.submissionId });
        });
        const committed = await this.commitDrive(lease.generation, { schemaVersion: 1, status: 'waiting',
          checkpoint: { submissionId: lease.submissionId, inputDigest: lease.inputDigest, artifactDigest: lease.artifactDigest } });
        if (!committed.ok) await this.interruptDrive(lease.generation);
      } catch { await this.interruptDrive(lease.generation); }
    })();
    try { await this.#reconciling; } finally { this.#reconciling = undefined; }
  }

  /** REQ-OPERATOR-047: durable intent precedes protected I/O; uncertain effects are never replayed. */
  async dispatcherOperation(generation: number, request: Request): Promise<Response> {
    const denied = () => Response.json({ code: 'OPERATOR_CAPABILITY_DENIED' }, { status: 403 });
    if (!await this.dispatcherGenerationCurrent(generation)) return denied();
    let operation: Awaited<ReturnType<typeof parseDispatcherOperation>>;
    let perform: () => Promise<Response>;
    try {
      const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!lease) return denied();
      operation = await this.#boundedDispatcher(lease, () => parseDispatcherOperation(request));
      const plan = await this.getRuntimePlan();
      if (!plan) return denied();
      perform = await createDispatcherOperation({ plan, env: this.#appEnv, operation,
        current: () => this.dispatcherGenerationCurrent(generation),
        exports: (this.ctx as unknown as { exports: Parameters<typeof createDispatcherOperation>[0]['exports'] }).exports });
    } catch { return denied(); }
    const requestDigest = await sha256(JSON.stringify({ path: operation.path, body: operation.body }));
    const reserved = await this.ctx.storage.transaction(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (!this.#leaseMatches(record, lease, generation)) return { kind: 'denied' } as const;
      const operations = await tx.get<Record<string, DispatcherOperationRecord>>(DISPATCHER_OPERATIONS) ?? {};
      const prior = Object.hasOwn(operations, operation.operationId) ? operations[operation.operationId] : undefined;
      if (prior) {
        if (prior.requestDigest !== requestDigest) return { kind: 'conflict' } as const;
        if (prior.phase === 'completed') {
          const response = await tx.get<NonNullable<DispatcherOperationRecord['response']>>(`dispatcher:response:${operation.operationId}`);
          return response ? { kind: 'completed', response } as const : { kind: 'unknown' } as const;
        }
        await tx.put(DISPATCHER_OPERATIONS, { ...operations, [operation.operationId]: { ...prior, phase: 'unknown' } });
        return { kind: 'unknown' } as const;
      }
      if (Object.keys(operations).length >= 128) return { kind: 'denied' } as const;
      await tx.put(DISPATCHER_OPERATIONS, { ...operations, [operation.operationId]: {
        generation, requestDigest, phase: 'reserved' } satisfies DispatcherOperationRecord });
      return { kind: 'reserved', lease: lease! } as const;
    });
    if (reserved.kind === 'denied') return denied();
    if (reserved.kind === 'conflict') return Response.json({ code: 'OPERATOR_OPERATION_CONFLICT' }, { status: 409 });
    const response = (value: NonNullable<DispatcherOperationRecord['response']>) => new Response(value.body, {
      status: value.status, headers: { 'content-type': value.contentType, 'cache-control': 'no-store' } });
    if (reserved.kind === 'completed') return response(reserved.response);
    try {
      if (reserved.kind === 'unknown') throw new Error('Unknown protected operation');
      // Recheck after asynchronous capability construction/reservation, before external I/O.
      if (!await this.dispatcherGenerationCurrent(generation)) throw new Error('Stale protected operation');
      const result = await this.#boundedDispatcher(reserved.lease, async () => {
        const upstream = await perform();
        if (upstream.status >= 500 || upstream.status < 200 || (upstream.status >= 300 && upstream.status < 400)) {
          throw new Error('Protected operation did not complete');
        }
        return { status: upstream.status, contentType: upstream.headers.get('content-type') ?? 'application/json',
          body: await readDispatcherBody(upstream) };
      });
      await this.ctx.storage.transaction(async tx => {
        const record = await tx.get<AdmissionState>('admission');
        const lease = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
        const operations = await tx.get<Record<string, DispatcherOperationRecord>>(DISPATCHER_OPERATIONS) ?? {};
        const prior = operations[operation.operationId];
        if (!this.#leaseMatches(record, lease, generation) || prior?.phase !== 'reserved'
          || prior.generation !== generation || prior.requestDigest !== requestDigest) throw new Error('Stale protected result');
        await tx.put(`dispatcher:response:${operation.operationId}`, result);
        await tx.put(DISPATCHER_OPERATIONS, { ...operations,
          [operation.operationId]: { ...prior, phase: 'completed' } });
      });
      return response(result);
    } catch {
      await this.ctx.storage.transaction(async tx => {
        const operations = await tx.get<Record<string, DispatcherOperationRecord>>(DISPATCHER_OPERATIONS) ?? {};
        const prior = operations[operation.operationId];
        if (prior?.phase === 'reserved') await tx.put(DISPATCHER_OPERATIONS, {
          ...operations, [operation.operationId]: { ...prior, phase: 'unknown' } });
      });
      await this.interruptDrive(generation);
      return Response.json({ code: 'OPERATOR_OPERATION_UNKNOWN' }, { status: 409 });
    }
  }

  /** SDK-owned bookkeeping is retired before a settled generation can be continued. */
  async #releaseDispatcherSdk(): Promise<void> {
    const lease = await this.ctx.storage.get<DispatcherLease>(DISPATCHER_LEASE);
    if (!lease || lease.sdkReleased || lease.status === 'running' || lease.status === 'admitting') return;
    const admission = await this.ctx.storage.get<AdmissionState>('admission');
    if (!admission) return;
    await super._cf_cleanupFacetPrefix([{ className: 'OperatorActivity', name: admission.intent.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }]);
    const tokens = await this.ctx.storage.get<Record<string, number>>('dispatcher:keepalive') ?? {};
    for (const [token, generation] of Object.entries(tokens)) {
      if (generation === lease.generation) await super._cf_releaseFacetKeepAlive(token);
    }
    await this.ctx.storage.transaction(async tx => {
      const current = await tx.get<DispatcherLease>(DISPATCHER_LEASE);
      if (current?.generation === lease.generation) {
        await tx.put(DISPATCHER_LEASE, { ...current, sdkReleased: true });
        await tx.delete('dispatcher:keepalive');
      }
    });
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
    return { activityId: state.intent.activityId, operatorId: state.intent.operatorId, executionStatus,
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

  async getBrowserDetail(): Promise<(OperatorBrowserSummary & { checkpoint: unknown; result: unknown }) | null> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state ? { ...this.browserSummary(state), checkpoint: state.drive?.checkpoint ?? null,
      result: state.drive?.result ?? null } : null;
  }

  async collectBrowserResult(): Promise<{ ok: true; detail: OperatorBrowserSummary & { checkpoint: unknown; result: unknown } }
    | { ok: false; reason: 'not-ready' | 'not-admitted' }> {
    const outcome = await this.ctx.storage.transaction<{ ok: true; detail: OperatorBrowserSummary & { checkpoint: unknown; result: unknown } }
      | { ok: false; reason: 'not-ready' | 'not-admitted' }>(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state) return { ok: false, reason: 'not-admitted' };
      if (state.drive?.status !== 'completed' && state.drive?.status !== 'failed') return { ok: false, reason: 'not-ready' };
      const consumed = { ...state, browserCollectionConsumed: true, updatedAt: Date.now() };
      await tx.put<AdmissionState>('admission', consumed);
      return { ok: true, detail: { ...this.browserSummary(consumed), checkpoint: consumed.drive?.checkpoint ?? null,
        result: consumed.drive?.result ?? null } };
    });
    if (outcome.ok) await this.publishBrowserSummary();
    return outcome;
  }

  /** Parent-only projection excludes the capability verifier; readback grants no authority. */
  async getAdmission(): Promise<ActivityAdmissionProjection | null> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state ? { activityId: state.intent.activityId, phase: state.phase, receipt: state.receipt } : null;
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
