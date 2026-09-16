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
import type { OperatorExecutionContext, OperatorExecutionProjection } from './execution-context';

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

interface ActivityEnv { REGISTRY: DurableObjectNamespace<OperatorRegistry>; ENCRYPTION_KEY?: string }

interface AdmissionState {
  intent: OperatorActivityPreparation;
  phase: ActivityAdmissionProjection['phase'];
  receipt: OperatorAdmissionReceipt | null;
  executionContext?: OperatorExecutionContext;
  drive?: OperatorDriveState;
}

const driveUpdateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(['waiting', 'completed', 'failed']),
  checkpoint: z.json(),
  result: z.json().optional(),
});

type AdmissionFailure = Extract<ActivityAdmissionResult, { ok: false }>;

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
  async prepareAuthorized(_intent: OperatorActivityPreparation,
    _executionContext: OperatorExecutionContext): Promise<ActivityAdmissionResult> {
    throw new Error('Not implemented');
  }

  /** Replace protected authority only through same-owner reauthentication. */
  async reauthenticate(_human: import('../lib/jwt').VerifiedHumanAccessClaims,
    _accessJwt: string): Promise<OperatorExecutionProjection> {
    throw new Error('Not implemented');
  }

  /** Parent-safe activity identity read; no credential ciphertext or token. */
  async getExecutionContext(): Promise<OperatorExecutionProjection | null> {
    throw new Error('Not implemented');
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
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(capability)) return { ok: false, reason: 'invalid-capability' };
    const verifier = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(capability))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
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
      const admitted = await this.env.REGISTRY.getByName('registry').admit({
        activityId, operatorId, intentDigest, expectedRevision, deadline,
      });
      if (!admitted.ok) return { ok: false, reason: 'admission-denied' };
      receipt = admitted.value;
    } catch {
      return { ok: false, reason: 'admission-uncertain' };
    }
    return this.ctx.storage.transaction<ActivityAdmissionResult>(async tx => {
      const state = await tx.get<AdmissionState>('admission');
      if (!state) return { ok: false, reason: 'not-prepared' };
      const denied = checkStart(state, verifier);
      if (denied) return denied;
      const intent = state.intent;
      if (receipt.activityId !== intent.activityId || receipt.operatorId !== intent.operatorId
        || receipt.intentDigest !== intent.intentDigest || receipt.expectedRevision !== intent.expectedRevision
        || receipt.deadline !== intent.deadline) return { ok: false, reason: 'admission-denied' };
      await tx.put<AdmissionState>('admission', {
        intent: { ...intent, startVerifier: '' }, phase: 'queued', receipt,
      });
      return { ok: true, phase: 'queued' };
    });
  }

  /**
   * Reserve one durable generation before loading a child. Only waiting work may
   * resume; a running/unknown drive is never replayed based on isolate loss.
   * The parent binds the returned generation to its child capabilities.
   */
  async beginDrive(): Promise<OperatorDriveResult> {
    return this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
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
      await tx.put<AdmissionState>('admission', { ...record, drive: state });
      return { ok: true, state };
    });
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
    return this.ctx.storage.transaction<OperatorDriveResult>(async tx => {
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
      await tx.put<AdmissionState>('admission', { ...record, drive: state });
      return { ok: true, state };
    });
  }

  /** Fence future commits; this is not confirmation that owned compute has stopped. */
  async cancelDrive(): Promise<OperatorDriveResult> {
    return this.fenceDrive('cancel-requested');
  }

  /** Parent reports an interrupted drive; its uncertain effects cannot be replayed. */
  async interruptDrive(generation: number): Promise<OperatorDriveResult> {
    return this.fenceDrive('unknown', generation);
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
      await tx.put<AdmissionState>('admission', { ...record, drive: state });
      return { ok: true, state };
    });
  }

  /** Parent-only projection excludes the capability verifier; readback grants no authority. */
  async getAdmission(): Promise<ActivityAdmissionProjection | null> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state ? { activityId: state.intent.activityId, phase: state.phase, receipt: state.receipt } : null;
  }
}
