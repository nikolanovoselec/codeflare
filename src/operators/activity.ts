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

/** REQ-OPERATOR-003 admission boundary under TDD; no production binding or execution. */
export class OperatorActivity extends DurableObject<ActivityEnv> {
  async prepare(_intent: OperatorActivityPreparation): Promise<ActivityAdmissionResult> {
    throw new Error('Operator activity admission is not implemented');
  }

  async start(_capability: string): Promise<ActivityAdmissionResult> {
    throw new Error('Operator activity admission is not implemented');
  }

  async getAdmission(): Promise<ActivityAdmissionProjection | null> {
    throw new Error('Operator activity admission is not implemented');
  }
}
