import { DurableObject } from 'cloudflare:workers';

/** Registration ordering state only; protected metadata/policy wiring comes separately. */
export interface OperatorRegistrationState {
  operatorId: string;
  revision: number;
  enabled: boolean;
  approvedArtifactDigest: string | null;
}

export interface OperatorAdmissionRequest {
  operatorId: string;
  activityId: string;
  intentDigest: string;
  expectedRevision: number;
  /** Absolute milliseconds, bounded by verified human expiry by the caller. */
  deadline: number;
}

export interface OperatorAdmissionReceipt extends OperatorAdmissionRequest {
  artifactDigest: string;
  admittedAt: number;
}

/** Serializable RPC outcomes; never rely on custom Error fields surviving RPC. */
export type OperatorRegistryResult<T> = { ok: true; value: T } | {
  ok: false;
  reason: 'not-found' | 'already-exists' | 'revision-conflict' | 'artifact-unapproved'
    | 'disabled' | 'activity-conflict' | 'authority-expired';
};

/** REQ-OPERATOR-002 ordering boundary under TDD; no production binding. */
export class OperatorRegistry extends DurableObject {
  async create(_operatorId: string): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    throw new Error('Operator registry is not implemented');
  }

  async approve(_operatorId: string, _artifactDigest: string, _expectedRevision: number): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    throw new Error('Operator registry is not implemented');
  }

  async setEnabled(_operatorId: string, _enabled: boolean, _expectedRevision: number): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    throw new Error('Operator registry is not implemented');
  }

  async admit(_request: OperatorAdmissionRequest): Promise<OperatorRegistryResult<OperatorAdmissionReceipt>> {
    throw new Error('Operator registry is not implemented');
  }

  async getReceipt(_activityId: string): Promise<OperatorRegistryResult<OperatorAdmissionReceipt | null>> {
    throw new Error('Operator registry is not implemented');
  }
}
