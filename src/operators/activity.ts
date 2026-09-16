import { DurableObject } from 'cloudflare:workers';
import type { OperatorRegistry, OperatorAdmissionRequest, OperatorAdmissionReceipt } from './registry';

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

interface ActivityEnv { REGISTRY: DurableObjectNamespace<OperatorRegistry> }

interface AdmissionState {
  intent: OperatorActivityPreparation;
  phase: ActivityAdmissionProjection['phase'];
  receipt: OperatorAdmissionReceipt | null;
}

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

  /** Parent-only projection excludes the capability verifier; readback grants no authority. */
  async getAdmission(): Promise<ActivityAdmissionProjection | null> {
    const state = await this.ctx.storage.get<AdmissionState>('admission');
    return state ? { activityId: state.intent.activityId, phase: state.phase, receipt: state.receipt } : null;
  }
}
