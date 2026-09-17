/**
 * Deployment-local registration and admission authority
 * JSON validation and RPC-safe contracts precede the Durable Object. Methods are grouped as secrets,
 * distribution, registration/policy projections, approval/enablement and immutable admission receipts.
 * Transactions own revision/order decisions; callers own human authorization and network work.
 * Public projections explicitly exclude ciphertext. This object is never a child Worker binding.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { DurableObject } from 'cloudflare:workers';
import { createOperatorWebhookKey, sealOperatorSecret } from './protected-secrets';
import { parseOperatorManifest, validateOperatorEndpoint, type OperatorManifest } from './distribution';
import { ValidationError } from '../lib/error-types';
import { parseOperatorPolicy } from './policy';
import type { OperatorBrowserSummary } from './browser-activity';

/** RPC carries bounded JSON text rather than recursively serialized schema types. */
function normalizePolicyJson(json: string): string {
  try {
    if (new TextEncoder().encode(json).byteLength > 64 * 1024) throw new Error('Oversized policy');
    return JSON.stringify(parseOperatorPolicy(JSON.parse(json)));
  } catch {
    throw new ValidationError('Invalid operator execution policy');
  }
}

/** Validate the RPC envelope while retaining the existing strict manifest parser. */
function validateManifestJson(json: string, endpoint: string, operatorId?: string): OperatorManifest {
  try {
    if (new TextEncoder().encode(json).byteLength > 64 * 1024) throw new Error('Oversized manifest');
    const manifest = JSON.parse(json);
    const { url, ...artifact } = manifest.artifact;
    const approved = parseOperatorManifest(JSON.stringify({ ...manifest, artifact }), endpoint);
    if ((operatorId !== undefined && approved.id !== operatorId) || approved.artifact.url !== url) throw new Error('Mismatched manifest');
    return approved;
  } catch {
    throw new ValidationError('Operator manifest does not match registration');
  }
}

/** Safe registration projection; protected credentials and metadata are stored separately. */
export interface OperatorRegistrationState {
  operatorId: string;
  revision: number;
  enabled: boolean;
  approvedArtifactDigest: string | null;
}

interface OperatorAdminDetail {
  registration: OperatorRegistrationState;
  endpoint: string | null;
  connectionSecretConfigured: boolean;
  webhookKeyConfigured: boolean;
  discoveredManifestJson: string | null;
  approvedManifestJson: string | null;
  policyJson: string | null;
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
  /** Pinned when admission uses a metadata-approved registration. */
  manifestJson?: string;
  policyJson?: string;
}

export interface OperatorExecutionSelection {
  operatorId: string;
  revision: number;
  artifactDigest: string;
  manifestJson: string;
  policyJson: string;
}

interface ProtectedDistribution {
  endpoint: string;
  connectionSecretCiphertext: string;
}

/** Serializable RPC outcomes; never rely on custom Error fields surviving RPC. */
export type OperatorRegistryResult<T> = { ok: true; value: T } | {
  ok: false;
  reason: 'not-found' | 'already-exists' | 'revision-conflict' | 'artifact-unapproved'
    | 'disabled' | 'activity-conflict' | 'authority-expired';
};

/**
 * REQ-OPERATOR-002: Deployment-local registration/admission ordering on SQLite DO
 * storage. Each mutation is one local transaction; no network/discovery or other
 * DO call belongs inside it. The authenticated parent must validate inputs,
 * authorize administration and bind admission intent/deadline to current human
 * authority before RPC. Never expose this binding to child Workers.
 *
 * Receipt creation orders disable/admit, but does not consume a start capability
 * or queue execution in another DO. The activity reconciles by the same ID before
 * its own consume/queue transaction. Readback grants no renewed authority.
 * HTTP authorization and runtime policy enforcement belong to their respective
 * callers; persisted restrictions never replace current human authority.
 */
export class OperatorRegistry extends DurableObject<{ ENCRYPTION_KEY?: string }> {
  /**
   * Parent-authorized rotation. Encrypt outside the transaction, then atomically
   * compare the revision and replace the ciphertext. Only the winner receives
   * plaintext; no retired-key fallback is retained. Losing the response requires
   * an explicit new rotation, not plaintext recovery from a public projection.
   */
  async rotateWebhookKey(
    operatorId: string,
    expectedRevision: number,
  ): Promise<OperatorRegistryResult<{ registration: OperatorRegistrationState; key: string }>> {
    const generated = await createOperatorWebhookKey(operatorId, this.env);
    return this.ctx.storage.transaction<OperatorRegistryResult<{ registration: OperatorRegistrationState; key: string }>>(async tx => {
      const registrationKey = `registration:${operatorId}`;
      const current = await tx.get<OperatorRegistrationState>(registrationKey);
      if (!current) return { ok: false, reason: 'not-found' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'revision-conflict' };
      const registration = { ...current, revision: current.revision + 1 };
      await tx.put(`webhook-key:${operatorId}`, generated.ciphertext);
      await tx.put(registrationKey, registration);
      return { ok: true, value: { registration, key: generated.key } };
    });
  }

  /** Protected parent-only read for handoff decryption; never a public projection. */
  async getEncryptedWebhookKey(operatorId: string): Promise<string | null> {
    return await this.ctx.storage.get<string>(`webhook-key:${operatorId}`) ?? null;
  }

  /**
   * Authorized endpoint/secret replacement. Validate and encrypt before the local
   * transaction; atomically replace protected configuration and invalidate approval.
   * No discovery/network I/O occurs here. Existing admission receipts are untouched.
   * The authenticated parent owns admin authorization and supplies the record ID.
   */
  async setDistribution(
    operatorId: string, endpoint: string, connectionSecret: string, expectedRevision: number,
  ): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    const validatedEndpoint = validateOperatorEndpoint(endpoint).href;
    if (!connectionSecret.trim()) throw new ValidationError('Operator connection secret is required');
    const connectionSecretCiphertext = await sealOperatorSecret(connectionSecret, this.env, { purpose: 'connection', recordId: operatorId });
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorRegistrationState>>(async tx => {
      const key = `registration:${operatorId}`;
      const current = await tx.get<OperatorRegistrationState>(key);
      if (!current) return { ok: false, reason: 'not-found' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'revision-conflict' };
      const value = { ...current, revision: current.revision + 1, enabled: false, approvedArtifactDigest: null };
      await tx.put(`distribution:${operatorId}`, { endpoint: validatedEndpoint, connectionSecretCiphertext });
      await tx.delete(`approved-manifest:${operatorId}`);
      await tx.delete(`discovered-manifest:${operatorId}`);
      await tx.put(key, value);
      return { ok: true, value };
    });
  }

  /** Parent-only discovery/download input; ciphertext must never enter public projections. */
  async getProtectedDistribution(operatorId: string): Promise<{ endpoint: string; connectionSecretCiphertext: string } | null> {
    return await this.ctx.storage.get<{ endpoint: string; connectionSecretCiphertext: string }>(`distribution:${operatorId}`) ?? null;
  }

  /**
   * Atomically create authenticated discovery, encrypted credentials and restrictive
   * policy, disabled/unapproved. Parent verifies human admin authority and performs
   * discovery before calling. Validation/encryption failures and collisions leave
   * no partial registration; network work never belongs in this transaction.
   */
  async register(
    endpoint: string, connectionSecret: string, manifestJson: string, policyJson: string,
  ): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    const validatedEndpoint = validateOperatorEndpoint(endpoint).href;
    const manifest = validateManifestJson(manifestJson, validatedEndpoint);
    const policy = normalizePolicyJson(policyJson);
    if (!connectionSecret.trim()) throw new ValidationError('Operator connection secret is required');
    const connectionSecretCiphertext = await sealOperatorSecret(connectionSecret, this.env, { purpose: 'connection', recordId: manifest.id });
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorRegistrationState>>(async tx => {
      const operatorId = manifest.id;
      const key = `registration:${operatorId}`;
      if (await tx.get(key)) return { ok: false, reason: 'already-exists' };
      const value: OperatorRegistrationState = { operatorId, revision: 1, enabled: false, approvedArtifactDigest: null };
      await tx.put(key, value);
      await tx.put(`distribution:${operatorId}`, { endpoint: validatedEndpoint, connectionSecretCiphertext });
      await tx.put(`discovered-manifest:${operatorId}`, JSON.stringify(manifest));
      await tx.put(`policy:${operatorId}`, policy);
      return { ok: true, value };
    });
  }

  /** Discovered metadata is informative, never artifact approval. */
  async getDiscoveredManifest(operatorId: string): Promise<string | null> {
    return await this.ctx.storage.get<string>(`discovered-manifest:${operatorId}`) ?? null;
  }

  /** Replace validated restrictive policy and disable until explicitly enabled again. */
  async setPolicy(operatorId: string, policyJson: string, expectedRevision: number): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    const normalized = normalizePolicyJson(policyJson);
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorRegistrationState>>(async tx => {
      const key = `registration:${operatorId}`;
      const current = await tx.get<OperatorRegistrationState>(key);
      if (!current) return { ok: false, reason: 'not-found' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'revision-conflict' };
      const value = { ...current, revision: current.revision + 1, enabled: false };
      await tx.put(`policy:${operatorId}`, normalized);
      await tx.put(key, value);
      return { ok: true, value };
    });
  }

  /** Non-secret admin projection; no protected distribution or webhook values. */
  async listRegistrations(): Promise<OperatorRegistrationState[]> {
    const records = await this.ctx.storage.list<OperatorRegistrationState>({ prefix: 'registration:' });
    return [...records.values()].map(({ operatorId, revision, enabled, approvedArtifactDigest }) => ({
      operatorId, revision, enabled, approvedArtifactDigest,
    }));
  }

  /** Non-secret detail projection; never decrypt, contact the publisher or wake owned compute. */
  async getAdminDetail(operatorId: string): Promise<OperatorRegistryResult<OperatorAdminDetail>> {
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorAdminDetail>>(async tx => {
      const registration = await tx.get<OperatorRegistrationState>(`registration:${operatorId}`);
      if (!registration) return { ok: false, reason: 'not-found' };
      const distribution = await tx.get<{ endpoint: string; connectionSecretCiphertext: string }>(`distribution:${operatorId}`);
      return { ok: true, value: {
        registration: { operatorId: registration.operatorId, revision: registration.revision,
          enabled: registration.enabled, approvedArtifactDigest: registration.approvedArtifactDigest },
        endpoint: distribution?.endpoint ?? null,
        connectionSecretConfigured: !!distribution?.connectionSecretCiphertext,
        webhookKeyConfigured: !!await tx.get(`webhook-key:${operatorId}`),
        discoveredManifestJson: await tx.get<string>(`discovered-manifest:${operatorId}`) ?? null,
        approvedManifestJson: await tx.get<string>(`approved-manifest:${operatorId}`) ?? null,
        policyJson: await tx.get<string>(`policy:${operatorId}`) ?? null,
      } };
    });
  }

  /** Resolve the enabled approved identities needed to prepare a parent-owned activity. */
  async resolveForExecution(operatorId: string): Promise<OperatorRegistryResult<OperatorExecutionSelection>> {
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorExecutionSelection>>(async tx => {
      const registration = await tx.get<OperatorRegistrationState>(`registration:${operatorId}`);
      if (!registration) return { ok: false, reason: 'not-found' };
      if (!registration.enabled) return { ok: false, reason: 'disabled' };
      if (!registration.approvedArtifactDigest) return { ok: false, reason: 'artifact-unapproved' };
      const manifestJson = await tx.get<string>(`approved-manifest:${operatorId}`);
      const policyJson = await tx.get<string>(`policy:${operatorId}`);
      const distribution = await tx.get<ProtectedDistribution>(`distribution:${operatorId}`);
      if (!manifestJson || !policyJson || !distribution) return { ok: false, reason: 'artifact-unapproved' };
      return { ok: true, value: { operatorId, revision: registration.revision,
        artifactDigest: registration.approvedArtifactDigest, manifestJson, policyJson } };
    });
  }

  /** Parent-only read of the protected distribution pinned by successful admission. */
  async getPinnedDistribution(activityId: string): Promise<ProtectedDistribution | null> {
    return await this.ctx.storage.get<ProtectedDistribution>(`receipt-distribution:${activityId}`) ?? null;
  }

  /** Read only the current restrictive policy, never human authority. */
  async getPolicy(operatorId: string): Promise<string | null> {
    return await this.ctx.storage.get<string>(`policy:${operatorId}`) ?? null;
  }

  /** Create disabled ordering state; duplicate IDs never overwrite it. */
  async create(operatorId: string): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorRegistrationState>>(async tx => {
      const key = `registration:${operatorId}`;
      if (await tx.get(key)) return { ok: false, reason: 'already-exists' };
      const value: OperatorRegistrationState = {
        operatorId, revision: 1, enabled: false, approvedArtifactDigest: null,
      };
      await tx.put(key, value);
      return { ok: true, value };
    });
  }

  /**
   * Parent supplies authenticated, artifact-verified metadata. Revalidate against
   * the current configured origin and stable registration ID within the revision
   * transaction. Store metadata/digest together; approval does not enable. No
   * network I/O or code execution occurs here. Admission copies the approved data.
   */
  async approveManifest(
    operatorId: string, manifestJson: string, expectedRevision: number,
  ): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorRegistrationState>>(async tx => {
      const key = `registration:${operatorId}`;
      const current = await tx.get<OperatorRegistrationState>(key);
      if (!current) return { ok: false, reason: 'not-found' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'revision-conflict' };
      const distribution = await tx.get<{ endpoint: string }>(`distribution:${operatorId}`);
      if (!distribution) throw new ValidationError('Operator distribution is not configured');
      const approved = validateManifestJson(manifestJson, distribution.endpoint, operatorId);
      const value = { ...current, revision: current.revision + 1, enabled: false, approvedArtifactDigest: approved.artifact.sha256 };
      await tx.put(`approved-manifest:${operatorId}`, JSON.stringify(approved));
      await tx.put(key, value);
      return { ok: true, value };
    });
  }

  /** Read approved metadata only; discovery advertisement alone cannot replace it. */
  async getApprovedManifest(operatorId: string): Promise<string | null> {
    return await this.ctx.storage.get<string>(`approved-manifest:${operatorId}`) ?? null;
  }

  /** Approval always requires a subsequent revision-checked enablement. */
  async approve(operatorId: string, artifactDigest: string, expectedRevision: number): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorRegistrationState>>(async tx => {
      const key = `registration:${operatorId}`;
      const current = await tx.get<OperatorRegistrationState>(key);
      if (!current) return { ok: false, reason: 'not-found' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'revision-conflict' };
      const value = { ...current, revision: current.revision + 1, enabled: false, approvedArtifactDigest: artifactDigest };
      await tx.delete(`approved-manifest:${operatorId}`);
      await tx.put(key, value);
      return { ok: true, value };
    });
  }

  /** Disable blocks future admission, not existing receipts or their readback. */
  async setEnabled(operatorId: string, enabled: boolean, expectedRevision: number): Promise<OperatorRegistryResult<OperatorRegistrationState>> {
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorRegistrationState>>(async tx => {
      const key = `registration:${operatorId}`;
      const current = await tx.get<OperatorRegistrationState>(key);
      if (!current) return { ok: false, reason: 'not-found' };
      if (current.revision !== expectedRevision) return { ok: false, reason: 'revision-conflict' };
      if (enabled && !current.approvedArtifactDigest) return { ok: false, reason: 'artifact-unapproved' };
      const value = { ...current, revision: current.revision + 1, enabled };
      await tx.put(key, value);
      return { ok: true, value };
    });
  }

  /** Repeated matching intent reconciles one receipt; it never extends expiry. */
  async admit(request: OperatorAdmissionRequest): Promise<OperatorRegistryResult<OperatorAdmissionReceipt>> {
    return this.ctx.storage.transaction<OperatorRegistryResult<OperatorAdmissionReceipt>>(async tx => {
      const key = `receipt:${request.activityId}`;
      const existing = await tx.get<OperatorAdmissionReceipt>(key);
      if (existing) {
        if (existing.operatorId !== request.operatorId || existing.intentDigest !== request.intentDigest
          || existing.expectedRevision !== request.expectedRevision || existing.deadline !== request.deadline) {
          return { ok: false, reason: 'activity-conflict' };
        }
        if (!Number.isFinite(request.deadline) || request.deadline <= Date.now()) {
          return { ok: false, reason: 'authority-expired' };
        }
        return { ok: true, value: existing };
      }
      const current = await tx.get<OperatorRegistrationState>(`registration:${request.operatorId}`);
      if (!current) return { ok: false, reason: 'not-found' };
      if (current.revision !== request.expectedRevision) return { ok: false, reason: 'revision-conflict' };
      if (!current.enabled) return { ok: false, reason: 'disabled' };
      if (!current.approvedArtifactDigest) return { ok: false, reason: 'artifact-unapproved' };
      const manifestJson = await tx.get<string>(`approved-manifest:${request.operatorId}`);
      const policyJson = await tx.get<string>(`policy:${request.operatorId}`);
      const distribution = await tx.get<ProtectedDistribution>(`distribution:${request.operatorId}`);
      if (manifestJson && (!policyJson || !distribution)) return { ok: false, reason: 'artifact-unapproved' };
      const admittedAt = Date.now();
      if (!Number.isFinite(request.deadline) || request.deadline <= admittedAt) {
        return { ok: false, reason: 'authority-expired' };
      }
      const value: OperatorAdmissionReceipt = {
        ...request, artifactDigest: current.approvedArtifactDigest, admittedAt,
        ...(manifestJson ? { manifestJson } : {}),
        ...(policyJson ? { policyJson } : {}),
      };
      await tx.put(key, value);
      if (distribution) await tx.put(`receipt-distribution:${request.activityId}`, distribution);
      return { ok: true, value };
    });
  }

  /** Read-only reconciliation, including after disablement/expiry; not admission. */
  async getReceipt(activityId: string): Promise<OperatorRegistryResult<OperatorAdmissionReceipt | null>> {
    return { ok: true, value: await this.ctx.storage.get<OperatorAdmissionReceipt>(`receipt:${activityId}`) ?? null };
  }

  /** Activity-owned, credential-free index for exact browser account lookups. */
  async upsertOwnedActivity(ownerKey: string, summary: OperatorBrowserSummary): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(ownerKey) || !/^[A-Za-z0-9_-]{1,128}$/.test(summary.activityId)) return;
    await this.ctx.storage.transaction(async tx => {
      const indexKey = `owner-activities:${ownerKey}`;
      const current = await tx.get<string[]>(indexKey) ?? [];
      const ids = [summary.activityId, ...current.filter(id => id !== summary.activityId)].slice(0, 100);
      await tx.put(indexKey, ids);
      await tx.put(`owner-activity:${ownerKey}:${summary.activityId}`, structuredClone(summary));
    });
  }

  async listOwnedActivities(ownerKey: string): Promise<OperatorBrowserSummary[]> {
    if (!/^[0-9a-f]{64}$/.test(ownerKey)) return [];
    const ids = await this.ctx.storage.get<string[]>(`owner-activities:${ownerKey}`) ?? [];
    const values = await Promise.all(ids.slice(0, 100).map(id =>
      this.ctx.storage.get<OperatorBrowserSummary>(`owner-activity:${ownerKey}:${id}`)));
    return values.filter((value): value is OperatorBrowserSummary => value !== undefined);
  }

  async getOwnedActivity(ownerKey: string, activityId: string): Promise<OperatorBrowserSummary | null> {
    if (!/^[0-9a-f]{64}$/.test(ownerKey) || !/^[A-Za-z0-9_-]{1,128}$/.test(activityId)) return null;
    return await this.ctx.storage.get<OperatorBrowserSummary>(`owner-activity:${ownerKey}:${activityId}`) ?? null;
  }
}
