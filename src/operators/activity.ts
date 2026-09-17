/**
 * Durable execution owner
 * Admission intent and receipt reconciliation come first; drive/checkpoint transitions follow.
 * Only the authenticated parent calls this object. Registry ordering and local token consumption
 * are separate transactions. Generation fences reject stale work but do not prove compute cleanup.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { OperatorRegistry, OperatorAdmissionRequest, OperatorAdmissionReceipt } from './registry';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { AppError } from '../lib/error-types';
import { projectOperatorExecution, reauthenticateOperatorExecution,
  type OperatorExecutionContext, type OperatorExecutionProjection } from './execution-context';
import { operatorOwnerKey, type OperatorBrowserSummary } from './browser-activity';

/** Parent-authorized admission intent; raw capabilities/credentials are not stored. */
export interface OperatorActivityPreparation extends OperatorAdmissionRequest {
  startVerifier: string;
  startExpiresAt: number;
}

export type ActivityAdmissionResult = { ok: true; phase: 'prepared' | 'queued' } | {
  ok: false;
  reason: 'already-prepared' | 'not-prepared' | 'invalid-capability' | 'capability-expired'
    | 'authority-expired' | 'already-started' | 'admission-denied' | 'admission-uncertain';
};

export interface ActivityAdmissionProjection {
  activityId: string;
  phase: 'prepared' | 'admitting' | 'queued';
  receipt: OperatorAdmissionReceipt | null;
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

interface ActivityEnv { OPERATOR_REGISTRY: DurableObjectNamespace<OperatorRegistry>; ENCRYPTION_KEY?: string }

interface OperatorSyncState {
  operationId: string;
  sessionId: string;
  requestDigest: string;
  policyDigest: string;
  prefix: string;
  deadline: number;
  phase: 'prepared' | 'uploaded' | 'verified';
  manifestDigest: string | null;
  evidence: { filesVerified: number; bytesVerified: number } | null;
}

export type OperatorSyncResult = { ok: true; phase: OperatorSyncState['phase'] } | { ok: false; reason:
  'not-admitted' | 'invalid-scope' | 'conflict' | 'operation-limit' | 'authority-expired'
    | 'not-prepared' | 'sealed' | 'evidence-mismatch' };
export type WebhookStartResult = { ok: true; phase: 'queued'; readCapability: string } | AdmissionFailure;
export type WebhookReadResult = { ok: true; terminal: boolean; status: string; result?: unknown } | {
  ok: false; reason: 'invalid-capability' | 'capability-expired' | 'not-ready' | 'consumed' | 'not-prepared' };

interface AdmissionState {
  intent: OperatorActivityPreparation;
  phase: ActivityAdmissionProjection['phase'];
  receipt: OperatorAdmissionReceipt | null;
  executionContext?: OperatorExecutionContext;
  drive?: OperatorDriveState;
  syncOperations?: Record<string, OperatorSyncState>;
  webhook?: { readVerifier: string; expiresAt: number; consumed: boolean };
  ownerKey?: string;
  browserCollectionConsumed?: boolean;
  updatedAt?: number;
}

const syncIdentity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const syncDigest = z.string().regex(/^[0-9a-f]{64}$/);
const syncPreparationSchema = z.strictObject({
  operationId: syncIdentity, sessionId: syncIdentity, requestDigest: syncDigest, policyDigest: syncDigest,
  prefix: z.string().min(2).max(2048), deadline: z.number().finite().positive(),
});

function canonicalSyncPrefix(value: string, operationId: string): boolean {
  return value.endsWith(`/${operationId}/`) && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.slice(0, -1).split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function canonicalSyncKey(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !/[\\%\x00-\x1f\x7f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

const driveUpdateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(['waiting', 'completed', 'failed']),
  checkpoint: z.json(),
  result: z.json().optional(),
});

type AdmissionFailure = Extract<ActivityAdmissionResult, { ok: false }>;

async function capabilityVerifier(capability: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(capability))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function randomCapability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function checkStart(state: AdmissionState, verifier: string): AdmissionFailure | null {
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
 * REQ-OPERATOR-003: Activity-owned admission state. The authorized parent prepares
 * validated intent and a SHA-256 start verifier, with deadlines bounded by the
 * actual human authority. Neither raw capabilities nor human credentials enter
 * this ordering record. This binding must never be exposed to child Workers.
 * Registry RPC is outside local transactions. An uncertain response preserves
 * pending intent for same-ID reconciliation; it never creates a new execution.
 * Queued state is the durable execution intent, not proof that work has run.
 */
export class OperatorActivity extends DurableObject<ActivityEnv> {
  /** Production preparation stores parent-created encrypted human authority. */
  async prepareAuthorized(intent: OperatorActivityPreparation,
    executionContext: OperatorExecutionContext): Promise<ActivityAdmissionResult> {
    if (intent.activityId !== executionContext.activityId || intent.operatorId !== executionContext.operatorId) {
      return { ok: false, reason: 'admission-denied' };
    }
    if (!Number.isFinite(intent.deadline) || intent.deadline > executionContext.expiresAt * 1000
      || intent.deadline <= Date.now()) return { ok: false, reason: 'authority-expired' };
    const ownerKey = await operatorOwnerKey(executionContext.owner);
    return this.ctx.storage.transaction<ActivityAdmissionResult>(async tx => {
      if (await tx.get('admission')) return { ok: false, reason: 'already-prepared' };
      await tx.put<AdmissionState>('admission', { intent, phase: 'prepared', receipt: null, executionContext,
        ownerKey, updatedAt: Date.now() });
      return { ok: true, phase: 'prepared' };
    });
  }

  /** Replace protected authority only through same-owner reauthentication. */
  async reauthenticate(human: VerifiedHumanAccessClaims, accessJwt: string): Promise<OperatorExecutionProjection> {
    const record = await this.ctx.storage.get<AdmissionState>('admission');
    if (!record?.executionContext) throw new AppError('NOT_FOUND', 404, 'Operator execution context not found');
    const previous = record.executionContext;
    const replacement = await reauthenticateOperatorExecution(previous, human, accessJwt, this.env);
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

  /** Parent-safe activity identity read; no credential ciphertext or token. */
  async getExecutionContext(): Promise<OperatorExecutionProjection | null> {
    const context = (await this.ctx.storage.get<AdmissionState>('admission'))?.executionContext;
    return context ? projectOperatorExecution(context) : null;
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
      await tx.put<AdmissionState>('admission', { ...state, phase: 'admitting' });
      return { ok: true, intent: state.intent };
    });
    if (!pending.ok) return pending;
    const { activityId, operatorId, intentDigest, expectedRevision, deadline } = pending.intent;
    let receipt: OperatorAdmissionReceipt;
    try {
      const admitted = await this.env.OPERATOR_REGISTRY.getByName('registry').admit({
        activityId, operatorId, intentDigest, expectedRevision, deadline,
      });
      if (!admitted.ok) return { ok: false, reason: 'admission-denied' };
      receipt = admitted.value;
    } catch {
      return { ok: false, reason: 'admission-uncertain' };
    }
    const receiptPolicyDigest = receipt.policyJson
      ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(receipt.policyJson))))
        .map(byte => byte.toString(16).padStart(2, '0')).join('')
      : null;
    const readCapability = issueRead ? randomCapability() : null;
    const readVerifier = readCapability ? await capabilityVerifier(readCapability) : null;
    const queued = await this.ctx.storage.transaction<ActivityAdmissionResult | WebhookStartResult>(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state) return { ok: false, reason: 'not-prepared' };
      const denied = checkStart(state, verifier);
      if (denied) return denied;
      const intent = state.intent;
      if (receipt.activityId !== intent.activityId || receipt.operatorId !== intent.operatorId
        || receipt.intentDigest !== intent.intentDigest || receipt.expectedRevision !== intent.expectedRevision
        || receipt.deadline !== intent.deadline
        || (state.executionContext && (receipt.artifactDigest !== state.executionContext.artifactDigest
          || receiptPolicyDigest !== state.executionContext.policyDigest))) {
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
    return { ok: true, terminal: checked.terminal, status: checked.status,
      ...(checked.terminal ? { result: checked.result } : {}) };
  }

  /** A not-ready read is non-consuming; one terminal transaction wins before delivery. */
  async redeemWebhookResult(capability: string): Promise<WebhookReadResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) return { ok: false, reason: 'invalid-capability' };
    const verifier = await capabilityVerifier(capability);
    return this.ctx.storage.transaction<WebhookReadResult>(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      const checked = this.checkWebhookRead(state, verifier);
      if (!checked.ok) return checked;
      if (!checked.terminal) return { ok: false, reason: 'not-ready' };
      await tx.put<AdmissionState>('admission', { ...state!, webhook: { ...state!.webhook!, consumed: true } });
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
    return { ok: true, terminal, status, ...(terminal ? { result: state.drive?.result ?? null } : {}) };
  }

  /** Persist a stable parent-authorized upload scope before host-side effects. */
  async prepareSync(input: unknown): Promise<OperatorSyncResult> {
    const parsed = syncPreparationSchema.safeParse(input);
    if (!parsed.success || !canonicalSyncPrefix(parsed.data.prefix, parsed.data.operationId)) {
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
          && existing.deadline === scope.deadline;
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
    if (!key.startsWith(operation.prefix) || key === operation.prefix || !canonicalSyncPrefix(operation.prefix, operationId)
      || !canonicalSyncKey(key)) return { ok: false, reason: 'invalid-scope' };
    return { ok: true };
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

  /**
   * Reserve one durable generation before loading a child. Only waiting work may
   * resume; a running/unknown drive is never replayed based on isolate loss.
   * The parent binds the returned generation to its child capabilities.
   */
  async beginDrive(): Promise<OperatorDriveResult> {
    const result = await this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      if (!record || record.phase !== 'queued') return { ok: false, reason: 'not-admitted' };
      if (!Number.isFinite(record.intent.deadline) || record.intent.deadline <= Date.now()) {
        return { ok: false, reason: 'authority-expired' };
      }
      if (record.drive?.status === 'running') return { ok: false, reason: 'drive-active' };
      if (record.drive && record.drive.status !== 'waiting') return { ok: false, reason: 'drive-settled' };
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
      if (!Number.isFinite(record.intent.deadline) || record.intent.deadline <= Date.now()) {
        return { ok: false, reason: 'authority-expired' };
      }
      if (record.drive?.status !== 'running' || record.drive.generation !== generation) {
        return { ok: false, reason: 'stale-drive' };
      }
      const state: OperatorDriveState = {
        generation, status: parsed.status, checkpoint: parsed.checkpoint, result: parsed.result ?? null,
      };
      await tx.put<AdmissionState>('admission', { ...record, drive: state, updatedAt: Date.now() });
      return { ok: true, state };
    });
    if (committed.ok) await this.publishBrowserSummary();
    return committed;
  }

  /** Fence future commits; this is not confirmation that owned compute has stopped. */
  async cancelDrive(): Promise<OperatorDriveResult> {
    const result = await this.fenceDrive('cancel-requested');
    if (result.ok) await this.publishBrowserSummary();
    return result;
  }

  /** Parent reports an interrupted drive; its uncertain effects cannot be replayed. */
  async interruptDrive(generation: number): Promise<OperatorDriveResult> {
    const result = await this.fenceDrive('unknown', generation);
    if (result.ok) await this.publishBrowserSummary();
    return result;
  }

  private async fenceDrive(status: 'cancel-requested' | 'unknown', generation?: number): Promise<OperatorDriveResult> {
    return this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
      const record = await tx.get<AdmissionState>('admission');
      if (!record || record.phase !== 'queued') return { ok: false, reason: 'not-admitted' };
      if (generation !== undefined && (record.drive?.status !== 'running' || record.drive.generation !== generation)) {
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
      return { ok: true, state };
    });
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
    try { await this.env.OPERATOR_REGISTRY.getByName('registry').upsertOwnedActivity(state.ownerKey, this.browserSummary(state)); }
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
