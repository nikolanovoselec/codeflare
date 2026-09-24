/**
 * Deployment-local registration and admission authority
 * JSON validation and RPC-safe contracts precede the Durable Object. Methods are grouped as secrets,
 * distribution, registration/policy projections, approval/enablement and immutable admission receipts.
 * Transactions own revision/order decisions; callers own human authorization and network work.
 * Public projections explicitly exclude ciphertext. This object is never a child Worker binding.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { DurableObject } from 'cloudflare:workers';
import { createOperatorWebhookKey, openOperatorSecret, sealOperatorSecret } from './protected-secrets';
import { parseOperatorManifest, validateOperatorEndpoint, type OperatorManifest } from './distribution';
import { ValidationError } from '../lib/error-types';
import { createLogger } from '../lib/logger';
import { parseOperatorPolicy } from './policy';
import type { OperatorBrowserSummary } from './browser-activity';
import type { BoundaryActionBinding } from './boundary-action-trust';

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

export type ManagementOperatorProfile = 'conductor' | 'dispatcher';
export type ManagementOperatorRealm = 'internal' | 'external';
export interface ManagementGrant { users: string[]; groups: Array<{ issuer: string; id: string }> }
export interface ManagementPolicy { capabilities: string[]; resourceProfileId: string | null }
export interface ManagementRelease {
  id: string; operatorId: string; githubReleaseId: number; sourceCommit: string;
  manifestDigest: string; bundleDigest: string; interfaceVersion: 1; approved: boolean;
  repositoryId: number; sourceRevision: number; coreVersion: string; intentVersion: string;
  requestedCapabilities: string[];
  assets: Array<{ id: number; name: string; digest: string }>;
  provenance: { compilerCommit?: string; workflowId: number; workflowRef: string; runId: number; runAttempt: number; artifactId: number; artifactDigest: string };
}
export interface ManagementReleaseCandidate { release: ManagementRelease; manifestJson: string; bundleBytes: Uint8Array }
export interface ManagementControls {
  revision: number; managers: ManagementGrant;
  ceiling: { capabilities: string[]; resourceProfileIds: string[] };
  /** Target repository trust, never the operator package's approved build workflow. */
  boundaryActions?: Array<Omit<BoundaryActionBinding, 'controlsRevision'>>;
}

export interface BoundaryPreparation {
  repositoryId: number; pullRequest: number; contextDigest: string; ownerKey: string;
  installationId: string; operatorId: string; deadline: number; activityId: string; phase: 'pending' | 'prepared' | 'claimed';
  revision: { head: string; base: string; mergeBase: string };
  controlsRevision: number; installationRevision: number; operatorRevision: number;
  releaseId: string; bundleDigest: string; workflowId: number; workflowDigest: string;
  session: { bucket: string; sessionId: string; generation: number };
}
export type BoundaryPublicationInput = {
  repositoryId: number; pullRequest: number; head: string; base: string; mergeBase: string;
  workflowId: number; runId: number; runAttempt: number; activityId: string;
  contextDigest: string; sessionGeneration: number; activityGeneration: number;
  effect: 'artifact' | 'comment' | 'check'; digest: string;
};
export type BoundaryPublicationReceipt = { status: 'pending' | 'published'; digest: string; externalId?: number };
type BoundaryPublicationOutcome = { status: 'new' | 'pending' | 'published' | 'stale' | 'conflict'; externalId?: number };
export interface ManagementAuthority { operatorRevision: number; controlsRevision: number; expiresAt: number }
export interface ManagementAdmissionRequest {
  installationId: string; activityId: string; intentDigest: string;
  expectedInstallationRevision: number; expectedOperatorRevision: number; expectedControlsRevision: number; deadline: number;
}
export interface ManagementExecutionSelection {
  installation: ManagementInstallation; operator: ManagementOperatorProjection; release: ManagementRelease; manifestJson: string; controlsRevision: number;
}
export interface ManagementAdmissionReceipt extends ManagementAdmissionRequest {
  admittedAt: number; selection: ManagementExecutionSelection;
}
export interface ManagementCatalogQuery {
  email: string; issuer: string; groups: string[]; platformAdmin: boolean; limit: number; cursor: string | null;
  profile?: string; realm?: string; state?: string; search?: string;
}
export interface ManagementInstallation {
  id: string; operatorId: string; name: string; releaseId: string | null;
  revision: number; enabled: boolean; policy: ManagementPolicy;
  /** JSON object bytes cross the Durable Object RPC boundary as a string. */
  configurationJson: string;
  approvedSourceRevision: number | null;
}
interface ManagementOperatorState {
  id: string; revision: number; repositoryUrl: string; repositoryId: number;
  githubPatCiphertext: string; profile: ManagementOperatorProfile; realm: ManagementOperatorRealm;
  managers: ManagementGrant; invokers: ManagementGrant;
  policy: ManagementPolicy; approvedWorkflow: { id: number; ref: string };
  sourceRevision: number;
}
export interface ManagementOperatorProjection {
  id: string; operatorId: string; revision: number; repositoryUrl: string; repositoryId: number;
  profile: ManagementOperatorProfile; realm: ManagementOperatorRealm; enabled: boolean;
  managers: ManagementGrant; invokers: ManagementGrant; policy: ManagementPolicy;
  source: { kind: 'github-release'; repositoryUrl: string; repositoryId: number;
    credentialConfigured: boolean; approvedWorkflow: { id: number; ref: string } | null };
}
type ManagementAcquisition = ManagementOperatorState;

function managementProjection(value: ManagementOperatorState, enabled = false): ManagementOperatorProjection {
  return {
    id: value.id, operatorId: value.id, revision: value.revision, repositoryUrl: value.repositoryUrl,
    repositoryId: value.repositoryId, profile: value.profile, realm: value.realm, enabled,
    managers: structuredClone(value.managers), invokers: structuredClone(value.invokers), policy: structuredClone(value.policy),
    source: { kind: 'github-release', repositoryUrl: value.repositoryUrl, repositoryId: value.repositoryId,
      credentialConfigured: Boolean(value.githubPatCiphertext), approvedWorkflow: value.approvedWorkflow && structuredClone(value.approvedWorkflow) },
  };
}

/** Serializable RPC outcomes; never rely on custom Error fields surviving RPC. */
export type OperatorRegistryResult<T> = { ok: true; value: T } | {
  ok: false;
  reason: 'not-found' | 'already-exists' | 'revision-conflict' | 'artifact-unapproved'
    | 'disabled' | 'activity-conflict' | 'authority-expired';
};

/**
 * REQ-OPERATOR-011: Deployment-local registration/admission ordering on SQLite DO
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

  /** Additive private tables in the existing SQLite registry, never a user bucket. */
  private managementSchema(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS operator_catalog (
      id TEXT PRIMARY KEY, profile TEXT NOT NULL, realm TEXT NOT NULL, enabled INTEGER NOT NULL,
      search TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operator_catalog_filters ON operator_catalog(profile, realm, enabled, id);
      CREATE TABLE IF NOT EXISTS operator_acl (principal TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(principal,id));
      CREATE TABLE IF NOT EXISTS operator_search (gram TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(gram,id));
      CREATE TABLE IF NOT EXISTS operator_releases (id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, data TEXT NOT NULL, manifest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operator_release_owner ON operator_releases(operator_id,id);
      CREATE TABLE IF NOT EXISTS operator_installations (id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(operator_id,name));
      CREATE INDEX IF NOT EXISTS operator_installation_owner ON operator_installations(operator_id,id);
      CREATE TABLE IF NOT EXISTS operator_bytes (digest TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(digest,part));
      CREATE TABLE IF NOT EXISTS operator_configuration_history (installation_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(installation_id,revision));
      CREATE TABLE IF NOT EXISTS operator_admissions (activity_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operator_management_controls (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operator_boundary_preparations (
        repository_id INTEGER NOT NULL, pull_request INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(repository_id,pull_request));
      CREATE INDEX IF NOT EXISTS operator_boundary_owner ON operator_boundary_preparations(
        json_extract(data,'$.ownerKey'),repository_id,pull_request);
      CREATE TABLE IF NOT EXISTS operator_boundary_handoffs (
        activity_id TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, expires_at INTEGER NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0, run_id INTEGER, run_attempt INTEGER);
      CREATE TABLE IF NOT EXISTS operator_boundary_publications (
        repository_id INTEGER NOT NULL, pull_request INTEGER NOT NULL, activity_id TEXT NOT NULL,
        activity_generation INTEGER NOT NULL, effect TEXT NOT NULL, digest TEXT NOT NULL,
        external_id INTEGER, PRIMARY KEY(repository_id,pull_request,activity_id,activity_generation,effect));`);
    const columns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(operator_boundary_handoffs)').toArray();
    if (!columns.some(column => column.name === 'run_id')) this.ctx.storage.sql.exec('ALTER TABLE operator_boundary_handoffs ADD COLUMN run_id INTEGER');
    if (!columns.some(column => column.name === 'run_attempt')) this.ctx.storage.sql.exec('ALTER TABLE operator_boundary_handoffs ADD COLUMN run_attempt INTEGER');
  }

  private managementControls(): ManagementControls {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_management_controls WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.data) : { revision: 0, managers: { users: [], groups: [] }, ceiling: { capabilities: [], resourceProfileIds: [] } };
  }

  async getManagementControls(): Promise<ManagementControls> { return this.managementControls(); }

  async getBoundaryAction(repositoryId: number): Promise<BoundaryActionBinding | null> {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) return null;
    const controls = this.managementControls();
    const action = controls.boundaryActions?.find(value => value.repositoryId === repositoryId);
    return action ? { ...structuredClone(action), controlsRevision: controls.revision } : null;
  }

  /** Atomic PR-revision reservation; never returns an Action start credential. */
  async reserveBoundaryPreparation(input: Omit<BoundaryPreparation, 'activityId' | 'phase'> & {
    expectedContextDigest?: string | null;
  }): Promise<OperatorRegistryResult<{ activityId: string; created: boolean }>> {
    if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
      || !Number.isSafeInteger(input.pullRequest) || input.pullRequest <= 0
      || !/^[a-f0-9]{64}$/.test(input.contextDigest) || !/^[a-f0-9]{64}$/.test(input.ownerKey)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(input.installationId)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(input.operatorId)
      || !input.revision || !/^[a-f0-9]{40}$/i.test(input.revision.head)
      || !/^[a-f0-9]{40}$/i.test(input.revision.base)
      || !/^[a-f0-9]{40}$/i.test(input.revision.mergeBase)
      || !Number.isSafeInteger(input.controlsRevision) || input.controlsRevision < 1
      || !Number.isSafeInteger(input.installationRevision) || input.installationRevision < 1
      || !Number.isSafeInteger(input.operatorRevision) || input.operatorRevision < 1
      || !/^[A-Za-z0-9_-]{1,128}$/.test(input.releaseId)
      || !/^[a-f0-9]{64}$/.test(input.bundleDigest)
      || !Number.isSafeInteger(input.workflowId) || input.workflowId < 1
      || !/^[a-f0-9]{64}$/.test(input.workflowDigest)
      || !input.session || !/^[A-Za-z0-9_-]{1,128}$/.test(input.session.bucket)
      || !/^[A-Za-z0-9_-]{1,128}$/.test(input.session.sessionId)
      || !Number.isSafeInteger(input.session.generation) || input.session.generation < 1
      || (input.expectedContextDigest != null && !/^[a-f0-9]{64}$/.test(input.expectedContextDigest))
      || !Number.isSafeInteger(input.deadline) || input.deadline <= Date.now()) {
      throw new ValidationError('Invalid PR boundary reservation');
    }
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ data: string }>(
        'SELECT data FROM operator_boundary_preparations WHERE repository_id=? AND pull_request=?',
        input.repositoryId, input.pullRequest).toArray()[0];
      const previous = row ? JSON.parse(row.data) as BoundaryPreparation : null;
      const action = this.managementControls().boundaryActions?.find(binding => binding.repositoryId === input.repositoryId);
      const selected = this.managementExecution(input.installationId);
      if (!action || this.managementControls().revision !== input.controlsRevision
        || action.installationId !== input.installationId || action.workflowId !== input.workflowId
        || action.workflowDigest !== input.workflowDigest || !selected.ok
        || selected.value.controlsRevision !== input.controlsRevision
        || selected.value.installation.revision !== input.installationRevision
        || selected.value.operator.revision !== input.operatorRevision
        || selected.value.operator.operatorId !== input.operatorId
        || selected.value.release.id !== input.releaseId
        || selected.value.release.bundleDigest !== input.bundleDigest) {
        return { ok: false, reason: 'revision-conflict' };
      }
      const sameRevision = previous && previous.revision?.head === input.revision.head
        && previous.revision?.base === input.revision.base
        && previous.revision?.mergeBase === input.revision.mergeBase;
      if (previous?.contextDigest === input.contextDigest) {
        if (previous.ownerKey !== input.ownerKey || previous.session?.bucket !== input.session.bucket
          || previous.session?.sessionId !== input.session.sessionId) {
          return { ok: false, reason: 'activity-conflict' };
        }
        return previous.deadline > Date.now()
          ? { ok: true, value: { activityId: previous.activityId, created: false } }
          : { ok: false, reason: 'authority-expired' };
      }
      if (sameRevision || (previous?.contextDigest ?? null) !== (input.expectedContextDigest ?? null)) {
        return { ok: false, reason: 'revision-conflict' };
      }
      const next: BoundaryPreparation = { repositoryId: input.repositoryId, pullRequest: input.pullRequest,
        contextDigest: input.contextDigest, ownerKey: input.ownerKey, installationId: input.installationId,
        operatorId: input.operatorId, revision: structuredClone(input.revision),
        controlsRevision: input.controlsRevision, installationRevision: input.installationRevision,
        operatorRevision: input.operatorRevision, releaseId: input.releaseId, bundleDigest: input.bundleDigest,
        workflowId: input.workflowId, workflowDigest: input.workflowDigest,
        session: structuredClone(input.session),
        deadline: input.deadline, activityId: crypto.randomUUID(), phase: 'pending' };
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO operator_boundary_preparations VALUES(?,?,?)',
        input.repositoryId, input.pullRequest, JSON.stringify(next));
      return { ok: true, value: { activityId: next.activityId, created: true } };
    });
  }

  /** Reconciliation is a read only metadata projection; it grants no start authority. */
  async getBoundaryPreparation(repositoryId: number, pullRequest: number): Promise<BoundaryPreparation | null> {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0
      || !Number.isSafeInteger(pullRequest) || pullRequest <= 0) return null;
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>(
      'SELECT data FROM operator_boundary_preparations WHERE repository_id=? AND pull_request=?',
      repositoryId, pullRequest).toArray()[0];
    return row ? JSON.parse(row.data) as BoundaryPreparation : null;
  }

  private boundarySelectionCurrent(current: BoundaryPreparation): boolean {
    const controls = this.managementControls();
    const action = controls.boundaryActions?.find(binding => binding.repositoryId === current.repositoryId);
    const selected = this.managementExecution(current.installationId);
    return !!action && selected.ok && controls.revision === current.controlsRevision
      && action.installationId === current.installationId && action.workflowId === current.workflowId
      && action.workflowDigest === current.workflowDigest
      && selected.value.controlsRevision === current.controlsRevision
      && selected.value.installation.revision === current.installationRevision
      && selected.value.operator.revision === current.operatorRevision
      && selected.value.operator.operatorId === current.operatorId
      && selected.value.release.id === current.releaseId
      && selected.value.release.bundleDigest === current.bundleDigest;
  }

  /** Parent-only guard for Activity's final queue transition; no handoff authority leaves this read. */
  async getBoundaryStartGuard(activityId: string): Promise<{ claimed: boolean; repositoryId: number; pullRequest: number;
    head: string; base: string; mergeBase: string; workflowId: number; runId: number; runAttempt: number;
    generation: number; contextDigest: string; session: BoundaryPreparation['session'] } | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(activityId)) return null;
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>(
      "SELECT data FROM operator_boundary_preparations WHERE json_extract(data,'$.activityId')=? LIMIT 1", activityId).toArray()[0];
    if (!row) return null;
    const current = JSON.parse(row.data) as BoundaryPreparation;
    const handoff = this.ctx.storage.sql.exec<{ consumed: number; run_id: number | null; run_attempt: number | null }>(
      'SELECT consumed,run_id,run_attempt FROM operator_boundary_handoffs WHERE activity_id=?', activityId).toArray()[0];
    return { claimed: current.phase === 'claimed' && handoff?.consumed === 1
      && handoff.run_id != null && handoff.run_attempt != null && current.deadline > Date.now()
      && this.boundarySelectionCurrent(current), repositoryId: current.repositoryId, pullRequest: current.pullRequest,
      head: current.revision.head, base: current.revision.base, mergeBase: current.revision.mergeBase,
      workflowId: current.workflowId, runId: handoff?.run_id ?? 0, runAttempt: handoff?.run_attempt ?? 0,
      generation: current.session.generation, contextDigest: current.contextDigest,
      session: structuredClone(current.session) };
  }

  /** Terminal publication reconciliation uses immutable claimed identity, not permission to
   * start another drive. Expiry still fences new effects in beginBoundaryPublication. */
  async getBoundaryPublicationGuard(activityId: string): Promise<{
    claimed: boolean; repositoryId: number; pullRequest: number; workflowId: number;
    runId: number; runAttempt: number; contextDigest: string; sessionGeneration: number;
  } | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(activityId)) return null;
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>(
      "SELECT data FROM operator_boundary_preparations WHERE json_extract(data,'$.activityId')=? LIMIT 1",
      activityId).toArray()[0];
    if (!row) return null;
    const current = JSON.parse(row.data) as BoundaryPreparation;
    const handoff = this.ctx.storage.sql.exec<{ consumed: number; run_id: number | null; run_attempt: number | null }>(
      'SELECT consumed,run_id,run_attempt FROM operator_boundary_handoffs WHERE activity_id=?', activityId).toArray()[0];
    return { claimed: current.phase === 'claimed' && handoff?.consumed === 1
      && handoff.run_id != null && handoff.run_attempt != null && this.boundarySelectionCurrent(current),
    repositoryId: current.repositoryId, pullRequest: current.pullRequest, workflowId: current.workflowId,
    runId: handoff?.run_id ?? 0, runAttempt: handoff?.run_attempt ?? 0,
    contextDigest: current.contextDigest, sessionGeneration: current.session.generation };
  }

  /** OIDC and live session authority are verified by the authenticated parent before this one-time claim. */
  async claimBoundaryPreparation(input: { repositoryId: number; pullRequest: number; head: string; base: string;
    mergeBase: string; workflowId: number; runId: number; runAttempt: number }): Promise<OperatorRegistryResult<{
      activityId: string; startCapability: string; repositoryId: number; pullRequest: number;
      head: string; base: string; mergeBase: string; workflowId: number; runId: number;
      runAttempt: number; generation: number; session: BoundaryPreparation['session'] }>> {
    if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
      || !Number.isSafeInteger(input.pullRequest) || input.pullRequest <= 0
      || ![input.head, input.base, input.mergeBase].every(sha => /^[a-f0-9]{40}$/i.test(sha))
      || ![input.workflowId, input.runId, input.runAttempt].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new ValidationError('Invalid Action claim');
    }
    this.managementSchema();
    const claimed = this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ data: string }>(
        'SELECT data FROM operator_boundary_preparations WHERE repository_id=? AND pull_request=?',
        input.repositoryId, input.pullRequest).toArray()[0];
      if (!row) return null;
      const current = JSON.parse(row.data) as BoundaryPreparation;
      if (current.phase !== 'prepared' || current.deadline <= Date.now()
        || current.revision.head !== input.head || current.revision.base !== input.base
        || current.revision.mergeBase !== input.mergeBase || current.workflowId !== input.workflowId
        || !this.boundarySelectionCurrent(current)) return null;
      const handoff = this.ctx.storage.sql.exec<{ ciphertext: string; expires_at: number; consumed: number }>(
        'SELECT ciphertext,expires_at,consumed FROM operator_boundary_handoffs WHERE activity_id=?', current.activityId).toArray()[0];
      if (!handoff || handoff.consumed || handoff.expires_at <= Date.now()) return null;
      this.ctx.storage.sql.exec('UPDATE operator_boundary_handoffs SET consumed=1,run_id=?,run_attempt=? WHERE activity_id=? AND consumed=0',
        input.runId, input.runAttempt, current.activityId);
      this.ctx.storage.sql.exec('UPDATE operator_boundary_preparations SET data=? WHERE repository_id=? AND pull_request=?',
        JSON.stringify({ ...current, phase: 'claimed' }), input.repositoryId, input.pullRequest);
      return { current, ciphertext: handoff.ciphertext };
    });
    if (!claimed) return { ok: false, reason: 'activity-conflict' };
    const startCapability = await openOperatorSecret(claimed.ciphertext, this.env,
      { purpose: 'handoff', recordId: claimed.current.activityId });
    return { ok: true, value: { activityId: claimed.current.activityId, startCapability,
      ...input, generation: claimed.current.session.generation, session: structuredClone(claimed.current.session) } };
  }

  /** Credential-free, PR-wide journal. The parent verifies OIDC, current GitHub and the terminal
   * Activity drive before calling; this owner never holds a publisher credential or GitHub I/O. */
  private validBoundaryPublication(input: BoundaryPublicationInput): boolean {
    return Number.isSafeInteger(input.repositoryId) && input.repositoryId > 0
      && Number.isSafeInteger(input.pullRequest) && input.pullRequest > 0
      && [input.workflowId, input.runId, input.runAttempt, input.sessionGeneration, input.activityGeneration]
        .every(value => Number.isSafeInteger(value) && value > 0)
      && [input.head, input.base, input.mergeBase].every(value => /^[a-f0-9]{40}$/.test(value))
      && [input.contextDigest, input.digest].every(value => /^[a-f0-9]{64}$/.test(value))
      && /^[A-Za-z0-9_-]{1,128}$/.test(input.activityId)
      && ['artifact', 'comment', 'check'].includes(input.effect);
  }

  private boundaryPublicationCurrent(input: BoundaryPublicationInput): boolean {
    const row = this.ctx.storage.sql.exec<{ data: string }>(
      'SELECT data FROM operator_boundary_preparations WHERE repository_id=? AND pull_request=?',
      input.repositoryId, input.pullRequest).toArray()[0];
    if (!row) return false;
    const current = JSON.parse(row.data) as BoundaryPreparation;
    const handoff = this.ctx.storage.sql.exec<{ consumed: number; run_id: number | null; run_attempt: number | null }>(
      'SELECT consumed,run_id,run_attempt FROM operator_boundary_handoffs WHERE activity_id=?',
      current.activityId).toArray()[0];
    return current.phase === 'claimed' && this.boundarySelectionCurrent(current)
      && current.activityId === input.activityId && current.contextDigest === input.contextDigest
      && current.session.generation === input.sessionGeneration && current.workflowId === input.workflowId
      && current.revision.head === input.head && current.revision.base === input.base
      && current.revision.mergeBase === input.mergeBase && handoff?.consumed === 1
      && handoff.run_id === input.runId && handoff.run_attempt === input.runAttempt;
  }

  private boundaryPublicationRow(input: BoundaryPublicationInput): { digest: string; external_id: number | null } | undefined {
    return this.ctx.storage.sql.exec<{ digest: string; external_id: number | null }>(
      `SELECT digest,external_id FROM operator_boundary_publications
       WHERE repository_id=? AND pull_request=? AND activity_id=? AND activity_generation=? AND effect=?`,
      input.repositoryId, input.pullRequest, input.activityId, input.activityGeneration, input.effect).toArray()[0];
  }

  async beginBoundaryPublication(input: BoundaryPublicationInput): Promise<BoundaryPublicationOutcome> {
    if (!this.validBoundaryPublication(input)) throw new ValidationError('Invalid boundary publication');
    this.managementSchema();
    return this.ctx.storage.transactionSync<BoundaryPublicationOutcome>(() => {
      if (!this.boundaryPublicationCurrent(input)) return { status: 'stale' };
      const existing = this.boundaryPublicationRow(input);
      if (existing) {
        if (existing.digest !== input.digest) return { status: 'conflict' };
        return existing.external_id === null ? { status: 'pending' }
          : { status: 'published', externalId: existing.external_id };
      }
      const reservation = this.ctx.storage.sql.exec<{ deadline: number }>(
        "SELECT json_extract(data,'$.deadline') AS deadline FROM operator_boundary_preparations WHERE repository_id=? AND pull_request=?",
        input.repositoryId, input.pullRequest).toArray()[0];
      if (!reservation || reservation.deadline <= Date.now()) return { status: 'stale' };
      const generation = this.ctx.storage.sql.exec<{ activity_generation: number }>(
        `SELECT activity_generation FROM operator_boundary_publications
         WHERE repository_id=? AND pull_request=? AND activity_id=? LIMIT 1`,
        input.repositoryId, input.pullRequest, input.activityId).toArray()[0];
      if (generation && generation.activity_generation !== input.activityGeneration) return { status: 'stale' };
      this.ctx.storage.sql.exec(`INSERT INTO operator_boundary_publications
        (repository_id,pull_request,activity_id,activity_generation,effect,digest,external_id) VALUES(?,?,?,?,?,?,NULL)`,
      input.repositoryId, input.pullRequest, input.activityId, input.activityGeneration, input.effect, input.digest);
      return { status: 'new' };
    });
  }

  async completeBoundaryPublication(input: BoundaryPublicationInput & { externalId: number }): Promise<BoundaryPublicationOutcome> {
    if (!this.validBoundaryPublication(input) || !Number.isSafeInteger(input.externalId) || input.externalId < 1) {
      throw new ValidationError('Invalid boundary publication receipt');
    }
    this.managementSchema();
    return this.ctx.storage.transactionSync<BoundaryPublicationOutcome>(() => {
      if (!this.boundaryPublicationCurrent(input)) return { status: 'stale' };
      const existing = this.boundaryPublicationRow(input);
      if (!existing) return { status: 'stale' };
      if (existing.digest !== input.digest || existing.external_id !== null && existing.external_id !== input.externalId) {
        return { status: 'conflict' };
      }
      if (existing.external_id === null) this.ctx.storage.sql.exec(
        `UPDATE operator_boundary_publications SET external_id=? WHERE repository_id=? AND pull_request=?
         AND activity_id=? AND activity_generation=? AND effect=? AND digest=? AND external_id IS NULL`,
        input.externalId, input.repositoryId, input.pullRequest, input.activityId,
        input.activityGeneration, input.effect, input.digest);
      return { status: 'published', externalId: input.externalId };
    });
  }

  /** Reconciliation reads immutable metadata only; it is never permission to create again. */
  async getBoundaryPublication(input: BoundaryPublicationInput): Promise<BoundaryPublicationReceipt | null> {
    if (!this.validBoundaryPublication(input)) return null;
    this.managementSchema();
    const row = this.boundaryPublicationRow(input);
    return row && row.digest === input.digest ? row.external_id === null
      ? { status: 'pending', digest: row.digest }
      : { status: 'published', digest: row.digest, externalId: row.external_id } : null;
  }

  async markBoundaryPrepared(repositoryId: number, pullRequest: number, activityId: string,
    contextDigest: string, startCapability: string, startExpiresAt: number): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(startCapability) || !Number.isSafeInteger(startExpiresAt)
      || startExpiresAt <= Date.now()) throw new ValidationError('Invalid Action handoff');
    const ciphertext = await sealOperatorSecret(startCapability, this.env,
      { purpose: 'handoff', recordId: activityId });
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql.exec<{ data: string }>(
        'SELECT data FROM operator_boundary_preparations WHERE repository_id=? AND pull_request=?',
        repositoryId, pullRequest).toArray()[0];
      const current = row ? JSON.parse(row.data) as BoundaryPreparation : null;
      if (!current || current.activityId !== activityId || current.contextDigest !== contextDigest
        || current.deadline <= Date.now() || startExpiresAt > current.deadline || current.phase !== 'pending') return false;
      const action = this.managementControls().boundaryActions?.find(binding => binding.repositoryId === repositoryId);
      const selected = this.managementExecution(current.installationId);
      if (!action || !selected.ok || this.managementControls().revision !== current.controlsRevision
        || action.installationId !== current.installationId || action.workflowId !== current.workflowId
        || action.workflowDigest !== current.workflowDigest
        || selected.value.controlsRevision !== current.controlsRevision
        || selected.value.installation.revision !== current.installationRevision
        || selected.value.operator.revision !== current.operatorRevision
        || selected.value.release.id !== current.releaseId
        || selected.value.release.bundleDigest !== current.bundleDigest) return false;
      const existing = this.ctx.storage.sql.exec(
        'SELECT activity_id FROM operator_boundary_handoffs WHERE activity_id=?', activityId).toArray();
      if (existing.length) return false;
      this.ctx.storage.sql.exec(`INSERT INTO operator_boundary_handoffs
        (activity_id,ciphertext,expires_at,consumed) VALUES(?,?,?,0)`,
        activityId, ciphertext, startExpiresAt);
      this.ctx.storage.sql.exec('UPDATE operator_boundary_preparations SET data=? WHERE repository_id=? AND pull_request=?',
        JSON.stringify({ ...current, phase: 'prepared' }), repositoryId, pullRequest);
      return true;
    });
  }

  /** Current human platform-admin authorization belongs to the route, never to submitted ACL data. */
  async setManagementControls(input: ManagementControls, actor: { email: string; expiresAt: number }): Promise<OperatorRegistryResult<ManagementControls>> {
    this.managementSchema();
    if (input.boundaryActions !== undefined) {
      const seen = new Set<number>();
      if (!Array.isArray(input.boundaryActions) || input.boundaryActions.length > 100) throw new ValidationError('Invalid boundary Action bindings');
      for (const action of input.boundaryActions) {
        if (!action || !Number.isSafeInteger(action.repositoryId) || action.repositoryId <= 0
          || seen.has(action.repositoryId) || !Number.isSafeInteger(action.workflowId) || action.workflowId <= 0
          || !/^[A-Za-z0-9_-]{1,128}$/.test(action.installationId)
          || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(action.workflowPath)
          || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(action.protectedRef)
          || !/^[a-f0-9]{64}$/i.test(action.workflowDigest)
          || !Array.isArray(action.events) || action.events.length === 0
          || action.events.some(event => event !== 'pull_request_target' && event !== 'pull_request' && event !== 'push')) {
          throw new ValidationError('Invalid boundary Action binding');
        }
        seen.add(action.repositoryId);
      }
    }
    return this.ctx.storage.transactionSync(() => {
      if (!Number.isFinite(actor.expiresAt) || actor.expiresAt <= Date.now()) return { ok: false, reason: 'authority-expired' };
      const current = this.managementControls();
      if (current.revision !== input.revision) return { ok: false, reason: 'revision-conflict' };
      const value = { ...input,
        ...(input.boundaryActions === undefined && current.boundaryActions
          ? { boundaryActions: current.boundaryActions } : {}),
        revision: current.revision + 1 };
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO operator_management_controls VALUES(1,?)', JSON.stringify(value));
      createLogger('operator-management').info('Operator management controls changed', { actor: actor.email, target: 'management-controls', revision: value.revision });
      return { ok: true, value };
    });
  }

  private withinManagementCeiling(policy: ManagementPolicy): boolean {
    const controls = this.managementControls();
    return controls.revision > 0 && policy.capabilities.every(value => controls.ceiling.capabilities.includes(value))
      && (policy.resourceProfileId === null || controls.ceiling.resourceProfileIds.includes(policy.resourceProfileId));
  }

  private managementState(id: string): ManagementOperatorState | null {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_catalog WHERE id=?', id).toArray()[0];
    return row ? JSON.parse(row.data) as ManagementOperatorState : null;
  }

  private saveManagement(state: ManagementOperatorState): ManagementOperatorProjection {
    const sql = this.ctx.storage.sql;
    const enabled = sql.exec('SELECT id FROM operator_installations WHERE operator_id=? AND enabled=1 LIMIT 1', state.id).toArray().length > 0;
    const search = `${state.repositoryUrl} ${state.id}`.toLowerCase();
    sql.exec('INSERT OR REPLACE INTO operator_catalog VALUES(?,?,?,?,?,?)', state.id, state.profile, state.realm, Number(enabled), search, JSON.stringify(state));
    sql.exec('DELETE FROM operator_acl WHERE id=?', state.id);
    for (const principal of new Set([...state.managers.users.map(user => `u:${user.trim().toLowerCase()}`),
      ...state.managers.groups.map(group => `g:${JSON.stringify([group.issuer, group.id])}`)])) {
      sql.exec('INSERT INTO operator_acl VALUES(?,?)', principal, state.id);
    }
    sql.exec('DELETE FROM operator_search WHERE id=?', state.id);
    const grams = new Set<string>();
    for (let n = 1; n <= 3; n++) for (let i = 0; i <= search.length - n; i++) grams.add(search.slice(i, i + n));
    for (const gram of grams) sql.exec('INSERT INTO operator_search VALUES(?,?)', gram, state.id);
    return managementProjection(state, enabled);
  }

  /** Expiry and operator revision fence grant/source changes across every asynchronous boundary. */
  private managementFence(state: ManagementOperatorState | null, authority: ManagementAuthority): OperatorRegistryResult<never> | null {
    if (!state) return { ok: false, reason: 'not-found' };
    if (!Number.isFinite(authority.expiresAt) || authority.expiresAt <= Date.now()) return { ok: false, reason: 'authority-expired' };
    if (state.revision !== authority.operatorRevision || this.managementControls().revision !== authority.controlsRevision) return { ok: false, reason: 'revision-conflict' };
    return null;
  }

  async registerManagement(input: Omit<ManagementOperatorState, 'id' | 'revision' | 'sourceRevision' | 'githubPatCiphertext'> & { githubPat: string }, authority: Omit<ManagementAuthority, 'operatorRevision'>): Promise<OperatorRegistryResult<ManagementOperatorProjection>> {
    if (!input.githubPat.trim()) throw new ValidationError('GitHub acquisition credential is required');
    const id = crypto.randomUUID();
    const githubPatCiphertext = await sealOperatorSecret(input.githubPat, this.env, { purpose: 'connection', recordId: id });
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      if (!Number.isFinite(authority.expiresAt) || authority.expiresAt <= Date.now()) return { ok: false, reason: 'authority-expired' };
      if (this.managementControls().revision !== authority.controlsRevision) return { ok: false, reason: 'revision-conflict' };
      if (!this.withinManagementCeiling(input.policy)) throw new ValidationError('Operator exceeds management ceiling');
      const state: ManagementOperatorState = { id, revision: 1, sourceRevision: 1, repositoryUrl: input.repositoryUrl,
        repositoryId: input.repositoryId, githubPatCiphertext, profile: input.profile, realm: input.realm,
        managers: input.managers, invokers: input.invokers, policy: input.policy, approvedWorkflow: input.approvedWorkflow };
      return { ok: true, value: this.saveManagement(state) };
    });
  }

  /** Permission/search/filter indexes are applied before keyset pagination. No global scan or hidden totals. */
  async listManagementOperators(query: ManagementCatalogQuery): Promise<{ items: ManagementOperatorProjection[]; cursor: string | null }> {
    this.managementSchema();
    const principals = [`u:${query.email.trim().toLowerCase()}`, ...query.groups.map(id => `g:${JSON.stringify([query.issuer, id])}`)];
    const params: (string | number)[] = query.platformAdmin ? [query.cursor ?? ''] : [JSON.stringify(principals), query.cursor ?? ''];
    const clauses = query.platformAdmin ? ['c.id>?'] : ['c.id IN (SELECT id FROM operator_acl WHERE principal IN (SELECT value FROM json_each(?)))', 'c.id>?'];
    for (const [column, value] of [['profile', query.profile], ['realm', query.realm]] as const) {
      if (value) { clauses.push(`c.${column}=?`); params.push(value); }
    }
    if (query.state) { clauses.push('c.enabled=?'); params.push(Number(query.state === 'enabled')); }
    if (query.search) {
      clauses.push('c.id IN (SELECT id FROM operator_search WHERE gram=?) AND instr(c.search,?)>0');
      params.push(query.search.slice(0, 3), query.search);
    }
    params.push(query.limit + 1);
    const rows = this.ctx.storage.sql.exec<{ id: string; data: string; enabled: number }>(
      `SELECT c.id,c.data,c.enabled FROM operator_catalog c WHERE ${clauses.join(' AND ')} ORDER BY c.id LIMIT ?`, ...params).toArray();
    const items = rows.slice(0, query.limit).map(row => managementProjection(JSON.parse(row.data), Boolean(row.enabled)));
    return { items, cursor: rows.length > query.limit ? items[items.length - 1].id : null };
  }

  async getManagementOperator(operatorId: string): Promise<OperatorRegistryResult<ManagementOperatorProjection>> {
    const state = this.managementState(operatorId);
    if (!state) return { ok: false, reason: 'not-found' };
    const enabled = this.ctx.storage.sql.exec('SELECT id FROM operator_installations WHERE operator_id=? AND enabled=1 LIMIT 1', operatorId).toArray().length > 0;
    return { ok: true, value: managementProjection(state, enabled) };
  }

  /** Parent-only: the acquisition PAT never enters release, installation or activity records. */
  async getManagementAcquisition(operatorId: string): Promise<OperatorRegistryResult<ManagementAcquisition>> {
    const state = this.managementState(operatorId);
    return state ? { ok: true, value: state } : { ok: false, reason: 'not-found' };
  }

  async getManagementReleases(operatorId: string): Promise<ManagementRelease[]> {
    this.managementSchema();
    return this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE operator_id=? ORDER BY id LIMIT 100', operatorId)
      .toArray().map(row => JSON.parse(row.data));
  }

  async getManagementInstallations(operatorId: string): Promise<ManagementInstallation[]> {
    this.managementSchema();
    return this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE operator_id=? ORDER BY id LIMIT 100', operatorId)
      .toArray().map(row => this.parseManagementInstallation(row.data));
  }

  private managementInstallation(id: string): ManagementInstallation | null {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE id=?', id).toArray()[0];
    return row ? this.parseManagementInstallation(row.data) : null;
  }

  private parseManagementInstallation(data: string): ManagementInstallation {
    const parsed = JSON.parse(data) as ManagementInstallation & { configuration?: unknown };
    if (typeof parsed.configurationJson === 'string') return parsed;
    if (!parsed.configuration || typeof parsed.configuration !== 'object' || Array.isArray(parsed.configuration)) {
      throw new ValidationError('Invalid installation configuration');
    }
    const { configuration, ...installation } = parsed;
    return { ...installation, configurationJson: JSON.stringify(configuration) };
  }

  private managementConfiguration(input: string): string {
    if (new TextEncoder().encode(input).byteLength > 64 * 1024) throw new ValidationError('Installation configuration exceeds the size limit');
    try {
      const parsed = JSON.parse(input) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return JSON.stringify(parsed);
    } catch { throw new ValidationError('Invalid installation configuration'); }
  }

  async getManagementInstallation(installationId: string): Promise<OperatorRegistryResult<ManagementInstallation>> {
    const value = this.managementInstallation(installationId);
    return value ? { ok: true, value } : { ok: false, reason: 'not-found' };
  }

  private saveInstallation(value: ManagementInstallation): void {
    const sql = this.ctx.storage.sql;
    sql.exec('INSERT OR REPLACE INTO operator_installations VALUES(?,?,?,?,?)', value.id, value.operatorId, value.name.toLowerCase(), Number(value.enabled), JSON.stringify(value));
    sql.exec('INSERT INTO operator_configuration_history VALUES(?,?,?)', value.id, value.revision, JSON.stringify(value));
    sql.exec('UPDATE operator_catalog SET enabled=EXISTS(SELECT 1 FROM operator_installations WHERE operator_id=? AND enabled=1) WHERE id=?', value.operatorId, value.operatorId);
  }

  /** Add candidates and pinned bytes atomically; never overwrite an identity or discard rollback artifacts. */
  async replaceManagementReleases(operatorId: string, authority: ManagementAuthority, candidates: ManagementReleaseCandidate[]): Promise<OperatorRegistryResult<ManagementRelease[]>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const state = this.managementState(operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      const releases: ManagementRelease[] = [];
      for (const candidate of candidates) {
        const release = candidate.release;
        if (release.operatorId !== operatorId || release.repositoryId !== state!.repositoryId || release.sourceRevision !== state!.sourceRevision) {
          throw new ValidationError('Release source changed');
        }
        const previous = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=?', release.id).toArray()[0];
        if (previous) {
          const old = JSON.parse(previous.data) as ManagementRelease;
          const previousIdentity = { ...old, approved: false,
            provenance: { ...old.provenance } };
          const candidateIdentity = { ...release, approved: false,
            provenance: { ...release.provenance } };
          // Releases acquired before compiler provenance was mandatory remain
          // immutable and usable. Never invent or persist a compiler identity;
          // only ignore the new field while comparing that exact legacy row.
          if (previousIdentity.provenance.compilerCommit === undefined) {
            delete candidateIdentity.provenance.compilerCommit;
          }
          if (JSON.stringify(previousIdentity) !== JSON.stringify(candidateIdentity)) {
            throw new ValidationError('Immutable release identity changed');
          }
          releases.push(old);
        } else {
          if (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM operator_releases WHERE operator_id=?', operatorId).one().n >= 100) throw new ValidationError('Retained release limit reached');
          this.ctx.storage.sql.exec('INSERT INTO operator_releases VALUES(?,?,?,?)', release.id, operatorId, JSON.stringify(release), candidate.manifestJson);
          releases.push(release);
        }
        // Each row remains below the existing DO per-value limit. No artifact GC.
        for (let offset = 0, part = 0; offset < candidate.bundleBytes.length; offset += 64 * 1024, part++) {
          this.ctx.storage.sql.exec('INSERT OR IGNORE INTO operator_bytes VALUES(?,?,?)', release.bundleDigest, part, candidate.bundleBytes.slice(offset, offset + 64 * 1024));
        }
      }
      this.saveManagement({ ...state!, revision: state!.revision + 1 });
      return { ok: true, value: releases };
    });
  }

  private restrictivePolicy(policy: ManagementPolicy, ceiling: ManagementPolicy): boolean {
    return this.withinManagementCeiling(policy) && policy.capabilities.every(capability => ceiling.capabilities.includes(capability))
      && (policy.resourceProfileId === null || policy.resourceProfileId === ceiling.resourceProfileId);
  }

  async createManagementInstallation(operatorId: string, name: string, policy: ManagementPolicy, authority: ManagementAuthority, configurationJson = '{}'): Promise<OperatorRegistryResult<ManagementInstallation>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const state = this.managementState(operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      if (!this.restrictivePolicy(policy, state!.policy)) throw new ValidationError('Installation exceeds operator policy');
      if (this.ctx.storage.sql.exec('SELECT id FROM operator_installations WHERE operator_id=? AND name=?', operatorId, name.toLowerCase()).toArray().length) return { ok: false, reason: 'already-exists' };
      if (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM operator_installations WHERE operator_id=?', operatorId).one().n >= 100) throw new ValidationError('Installation limit reached');
      const value: ManagementInstallation = { id: crypto.randomUUID(), operatorId, name, releaseId: null, revision: 1,
        enabled: false, policy, configurationJson: this.managementConfiguration(configurationJson), approvedSourceRevision: null };
      this.saveInstallation(value);
      return { ok: true, value };
    });
  }

  /** Exact release selection is approval, not enablement. Configuration and old bytes remain untouched. */
  async promoteManagementInstallation(installationId: string, releaseId: string, expectedRevision: number, authority: ManagementAuthority): Promise<OperatorRegistryResult<ManagementInstallation>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const installation = this.managementInstallation(installationId);
      if (!installation) return { ok: false, reason: 'not-found' };
      const state = this.managementState(installation.operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      if (installation.revision !== expectedRevision) return { ok: false, reason: 'revision-conflict' };
      if (!this.withinManagementCeiling(installation.policy)) throw new ValidationError('Installation exceeds management ceiling');
      const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=? AND operator_id=?', releaseId, installation.operatorId).toArray()[0];
      if (!row) return { ok: false, reason: 'not-found' };
      const release = JSON.parse(row.data) as ManagementRelease;
      if (!release.requestedCapabilities.every(capability => installation.policy.capabilities.includes(capability))
        || !release.requestedCapabilities.every(capability => this.managementControls().ceiling.capabilities.includes(capability))) {
        throw new ValidationError('Release capabilities exceed installation policy');
      }
      if (release.sourceRevision !== state!.sourceRevision || !this.ctx.storage.sql.exec('SELECT part FROM operator_bytes WHERE digest=? LIMIT 1', release.bundleDigest).toArray().length) return { ok: false, reason: 'artifact-unapproved' };
      this.ctx.storage.sql.exec('UPDATE operator_releases SET data=? WHERE id=?', JSON.stringify({ ...release, approved: true }), releaseId);
      const value = { ...installation, releaseId, revision: installation.revision + 1, enabled: false, approvedSourceRevision: state!.sourceRevision };
      this.saveInstallation(value);
      return { ok: true, value };
    });
  }

  async setManagementInstallationEnabled(installationId: string, enabled: boolean, expectedRevision: number, authority: ManagementAuthority): Promise<OperatorRegistryResult<ManagementInstallation>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const installation = this.managementInstallation(installationId);
      if (!installation) return { ok: false, reason: 'not-found' };
      const state = this.managementState(installation.operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      if (installation.revision !== expectedRevision) return { ok: false, reason: 'revision-conflict' };
      if (enabled) {
        if (!this.withinManagementCeiling(installation.policy)) throw new ValidationError('Installation exceeds management ceiling');
        if (!installation.releaseId || installation.approvedSourceRevision !== state!.sourceRevision) return { ok: false, reason: 'artifact-unapproved' };
        const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=? AND operator_id=?', installation.releaseId, installation.operatorId).toArray()[0];
        if (!row) return { ok: false, reason: 'artifact-unapproved' };
        const release = JSON.parse(row.data) as ManagementRelease;
        if (!release.requestedCapabilities.every(capability => installation.policy.capabilities.includes(capability))
          || !release.requestedCapabilities.every(capability => this.managementControls().ceiling.capabilities.includes(capability))) {
          throw new ValidationError('Release capabilities exceed installation policy');
        }
        if (!release.approved || !this.ctx.storage.sql.exec('SELECT part FROM operator_bytes WHERE digest=? LIMIT 1', release.bundleDigest).toArray().length) return { ok: false, reason: 'artifact-unapproved' };
      }
      const value = { ...installation, revision: installation.revision + 1, enabled };
      this.saveInstallation(value);
      return { ok: true, value };
    });
  }

  async configureManagementInstallation(installationId: string, input: { policy: ManagementPolicy; configurationJson: string; revision: number }, authority: ManagementAuthority): Promise<OperatorRegistryResult<ManagementInstallation>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const installation = this.managementInstallation(installationId);
      if (!installation) return { ok: false, reason: 'not-found' };
      const state = this.managementState(installation.operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      if (installation.revision !== input.revision) return { ok: false, reason: 'revision-conflict' };
      if (!this.restrictivePolicy(input.policy, state!.policy)) throw new ValidationError('Installation exceeds operator policy');
      const value = { ...installation, policy: input.policy, configurationJson: this.managementConfiguration(input.configurationJson), revision: installation.revision + 1, enabled: false };
      this.saveInstallation(value);
      return { ok: true, value };
    });
  }

  async setManagementGrants(operatorId: string, managers: ManagementGrant, invokers: ManagementGrant, authority: ManagementAuthority): Promise<OperatorRegistryResult<ManagementOperatorProjection>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const state = this.managementState(operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      return { ok: true, value: this.saveManagement({ ...state!, revision: state!.revision + 1, managers, invokers }) };
    });
  }

  /** A source/trust edit disables future starts, invalidates approval, and retains every old pin. */
  async setManagementSource(operatorId: string, input: { repositoryUrl: string; repositoryId: number; githubPat: string; approvedWorkflow: { id: number; ref: string } }, authority: ManagementAuthority): Promise<OperatorRegistryResult<ManagementOperatorProjection>> {
    const githubPatCiphertext = await sealOperatorSecret(input.githubPat, this.env, { purpose: 'connection', recordId: operatorId });
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const state = this.managementState(operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      const rows = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE operator_id=?', operatorId).toArray();
      for (const row of rows) {
        const installation = JSON.parse(row.data) as ManagementInstallation;
        this.saveInstallation({ ...installation, enabled: false, revision: installation.revision + 1, approvedSourceRevision: null });
      }
      return { ok: true, value: this.saveManagement({ ...state!, repositoryUrl: input.repositoryUrl, repositoryId: input.repositoryId,
        githubPatCiphertext, approvedWorkflow: input.approvedWorkflow, revision: state!.revision + 1, sourceRevision: state!.sourceRevision + 1 }) };
    });
  }

  /** Parent runtime integration: immutable credential-free snapshot. Caller owns current invoker authorization. */
  async resolveManagementExecution(installationId: string): Promise<OperatorRegistryResult<ManagementExecutionSelection>> {
    return this.managementExecution(installationId);
  }

  private managementExecution(installationId: string): OperatorRegistryResult<ManagementExecutionSelection> {
    const installation = this.managementInstallation(installationId);
    if (!installation) return { ok: false, reason: 'not-found' };
    const state = this.managementState(installation.operatorId);
    if (!state || !installation.enabled) return { ok: false, reason: 'disabled' };
    const row = this.ctx.storage.sql.exec<{ data: string; manifest: string }>('SELECT data,manifest FROM operator_releases WHERE id=? AND operator_id=?', installation.releaseId ?? '', installation.operatorId).toArray()[0];
    if (!row || installation.approvedSourceRevision !== state.sourceRevision || !this.withinManagementCeiling(installation.policy)) return { ok: false, reason: 'artifact-unapproved' };
    const release = JSON.parse(row.data) as ManagementRelease;
    if (!release.approved) return { ok: false, reason: 'artifact-unapproved' };
    return { ok: true, value: { installation, operator: managementProjection(state, true), release, manifestJson: row.manifest, controlsRevision: this.managementControls().revision } };
  }

  /** Parent authorizes the invoker before this call. One local transaction orders disable/grant edits against admission. */
  async admitManagement(request: ManagementAdmissionRequest): Promise<OperatorRegistryResult<ManagementAdmissionReceipt>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      if (!Number.isFinite(request.deadline) || request.deadline <= Date.now()) return { ok: false, reason: 'authority-expired' };
      const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_admissions WHERE activity_id=?', request.activityId).toArray()[0];
      if (row) {
        const receipt = JSON.parse(row.data) as ManagementAdmissionReceipt;
        if (receipt.installationId !== request.installationId || receipt.intentDigest !== request.intentDigest
          || receipt.expectedInstallationRevision !== request.expectedInstallationRevision || receipt.expectedOperatorRevision !== request.expectedOperatorRevision
          || receipt.expectedControlsRevision !== request.expectedControlsRevision || receipt.deadline !== request.deadline) return { ok: false, reason: 'activity-conflict' };
        return { ok: true, value: receipt };
      }
      const selected = this.managementExecution(request.installationId);
      if (!selected.ok) return selected;
      if (selected.value.installation.revision !== request.expectedInstallationRevision || selected.value.operator.revision !== request.expectedOperatorRevision
        || selected.value.controlsRevision !== request.expectedControlsRevision) return { ok: false, reason: 'revision-conflict' };
      const receipt: ManagementAdmissionReceipt = { ...request, admittedAt: Date.now(), selection: selected.value };
      this.ctx.storage.sql.exec('INSERT INTO operator_admissions VALUES(?,?)', request.activityId, JSON.stringify(receipt));
      return { ok: true, value: receipt };
    });
  }

  /** Reconciliation is read-only and grants no new human authority. */
  async getManagementAdmission(activityId: string): Promise<ManagementAdmissionReceipt | null> {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_admissions WHERE activity_id=?', activityId).toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }

  /** Parent-only pinned bytes; never exposed through management/user storage APIs or refreshed from latest. */
  async getManagementBundle(digest: string): Promise<Uint8Array | null> {
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    this.managementSchema();
    const rows = this.ctx.storage.sql.exec<{ part: number; bytes: ArrayBuffer }>('SELECT part,bytes FROM operator_bytes WHERE digest=? ORDER BY part', digest).toArray();
    if (!rows.length || rows.some((row, i) => row.part !== i)) return null;
    const size = rows.reduce((n, row) => n + row.bytes.byteLength, 0);
    if (size > 8 * 1024 * 1024) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const row of rows) { bytes.set(new Uint8Array(row.bytes), offset); offset += row.bytes.byteLength; }
    return bytes;
  }

  async getManagementConfigurationHistory(installationId: string, revision: number): Promise<ManagementInstallation | null> {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_configuration_history WHERE installation_id=? AND revision=?', installationId, revision).toArray()[0];
    return row ? this.parseManagementInstallation(row.data) : null;
  }

  /** Read-only legacy default-installation adapter; no eager conversion or changed legacy authority. */
  async getLegacyDefaultInstallation(operatorId: string): Promise<OperatorRegistryResult<{ id: string; operatorId: string; name: string; revision: number; enabled: boolean; artifactDigest: string | null; policyJson: string | null }>> {
    const detail = await this.getAdminDetail(operatorId);
    if (!detail.ok) return detail;
    return { ok: true, value: { id: operatorId, operatorId, name: 'default', revision: detail.value.registration.revision,
      enabled: detail.value.registration.enabled, artifactDigest: detail.value.registration.approvedArtifactDigest, policyJson: detail.value.policyJson } };
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
    const existing = values.filter((value): value is OperatorBrowserSummary => value !== undefined);
    this.managementSchema();
    const pending = this.ctx.storage.sql.exec<{ data: string }>(
      `SELECT data FROM operator_boundary_preparations
       WHERE json_extract(data,'$.ownerKey')=? ORDER BY repository_id DESC,pull_request DESC LIMIT 100`,
      ownerKey).toArray().map(row => JSON.parse(row.data) as BoundaryPreparation);
    const known = new Set(existing.map(item => item.activityId));
    const uncertain = pending.filter(item => item.phase === 'pending' && !known.has(item.activityId))
      .map(item => ({ activityId: item.activityId, operatorId: item.operatorId,
        executionStatus: 'unknown' as const, cleanupStatus: 'pending' as const,
        collectionStatus: 'unavailable' as const, attention: true, sessionId: null,
        source: 'pr-boundary', updatedAt: Date.now() }));
    return [...uncertain, ...existing].slice(0, 100);
  }

  async getOwnedActivity(ownerKey: string, activityId: string): Promise<OperatorBrowserSummary | null> {
    if (!/^[0-9a-f]{64}$/.test(ownerKey) || !/^[A-Za-z0-9_-]{1,128}$/.test(activityId)) return null;
    return await this.ctx.storage.get<OperatorBrowserSummary>(`owner-activity:${ownerKey}:${activityId}`) ?? null;
  }
}
