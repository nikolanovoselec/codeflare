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
import { parseOperatorManifest, parseDispatcherBundle, validateOperatorEndpoint, type OperatorManifest } from './distribution';
import { AppError, ValidationError } from '../lib/error-types';
import type { DispatcherDeploymentVerification } from './dispatcher-deployment';
import { isPiReasoningLevel, type PiReasoningLevel } from '../lib/reasoning-profiles';
import { createLogger } from '../lib/logger';
import { inferencePolicySchema, parseOperatorPolicy, type OperatorPolicy } from './policy';
import { MAX_SOURCE_RESPONSE_BYTES, sourceResponseBytes as effectiveSourceResponseBytes } from './dispatcher-source-limits';
import { submissionAttemptLimit as effectiveSubmissionAttemptLimit } from './dispatcher-submission-limits';
import { inferenceRequestBytes as effectiveInferenceRequestBytes, inferenceAttemptLimit as effectiveInferenceAttemptLimit } from './dispatcher-inference-limits';
import { dispatcherOperationLimit as effectiveOperationLimit } from './dispatcher-operation-limits';
import { dispatcherCapacities, dispatcherCapacityKeys, pickDispatcherCapacities, validDispatcherCapacities,
  type DispatcherCapacityPolicy } from './dispatcher-capacity-limits';
import { dispatcherCapacityPolicySchema } from './dispatcher-capacity-schema';
import type { OperatorBrowserSummary } from './browser-activity';
import type { BoundaryActionBinding } from './boundary-action-trust';
import type { OperatorExecutionAuthority } from './execution-context';
import { z } from 'zod';
import { ApplicationStateStore, ApplicationStateError, sameCoordinationScope, type ApplicationCoordinationScope, type ApplicationStateValue, type ApplicationStateBinding, type ApplicationStateRequest } from './application-state';
import { hasApplicationWorkflow, type RuntimeApplicationStateBinding, type ApplicationExecutionAuthority,
  type ApplicationCoordinationAuthority, type ApplicationCoordinationFacts, type ApplicationExecutionRequest, type ApplicationExecutionFacts, type ApplicationExecutionRetirement } from './application-workflow';
import { applicationWriteRepositories } from './application-configuration';
import { activateApplicationSchedule as activateSchedule, applicationScheduleStatus as scheduleStatus, runApplicationSchedules } from './application-schedule';
import { canInvokeOperator, canManageOperator, resolveBucketName } from '../lib/access';
import { callApplicationRecovery, inspectRecoveryRecord, recoveryInventoryPage, applicationRecoveryPrefix,
  recoveryDigest, releaseApplicationState, recoveryEntries, parseRecoveryCursor, type RecoveryInspection, type RecoveryFactsRequest, type RecoveryFacts } from './application-recovery';
import { createRawCapture, createOwnerRawCaptureStorage, captureRawInteraction, type RawCapture, type RawCaptureBinding, type RawCaptureReceipt } from './raw-capture-storage';
import { captureError, hashDiagnostic } from './dispatcher-diagnostics-wire';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import type { OperatorExecutionContext } from './execution-context';
import { operatorOwnerKey } from './browser-activity';
import type { Env } from '../types';
import { requireOwnerRawReader, parseOwnerRawReadRequest, readOwnerRawCapturePage, ownerRawReadUnavailable,
  type OwnerRawReadCredential, type OwnerRawReadRequest } from './raw-capture-read';

/** Historical record shapes only; application policy and decoding live in the package. */
type LegacyRepositoryIdentity = { repository: string; repositoryId: number; baseBranch: string };
type LegacyRetryTarget = { repositoryId: number; pullRequest: number; head: string; createdAt: string };
const scanId = /^[A-Za-z0-9_-]{1,128}$/;
const workingActivity = (status: OperatorBrowserSummary['executionStatus']): boolean =>
  status === 'queued' || status === 'running' || status === 'waiting'
  || status === 'cancel-requested' || status === 'unknown';

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
export interface ManagementPolicy { capabilities: string[]; resourceProfileId: string | null; sourceResponseBytes?: number;
  /** Omission preserves legacy managed-only inference; native requires explicit approval at both scopes. */
  inference?: OperatorPolicy['inference'];
}
interface ManagementOperatorPolicy extends ManagementPolicy, DispatcherCapacityPolicy { inferenceRequestBytes?: number; inferenceAttemptLimit?: number; submissionAttemptLimit?: number; operationLimit?: number; loggingEnabled?: boolean }
export interface ManagementRelease {
  id: string; operatorId: string; githubReleaseId: number; sourceCommit: string;
  manifestDigest: string; bundleDigest: string; interfaceVersion: 1; approved: boolean;
  repositoryId: number; sourceRevision: number; coreVersion: string; intentVersion: string;
  requestedCapabilities: string[];
  /** Verified GitHub release metadata. Absent on records acquired before display metadata was retained. */
  tagName?: string; publishedAt?: string;
  /** Verified manifest metadata projected for display, never persisted into the immutable release identity. */
  name?: string; description?: string;
  /** Bounded manifest JSON stays text across RPC, like configurationJson and manifestJson. */
  applicationJson?: string;
  assets: Array<{ id: number; name: string; digest: string }>;
  provenance: { compilerCommit?: string; workflowId: number; workflowRef: string; runId: number; runAttempt: number; artifactId: number; artifactDigest: string };
}
export interface ManagementReleaseCandidate { release: ManagementRelease; manifestJson: string; bundleBytes: Uint8Array }
export interface ManagementControls {
  revision: number; managers: ManagementGrant;
  ceiling: { capabilities: string[]; resourceProfileIds: string[]; sourceResponseBytes?: number };
  /** Target repository trust, never the operator package's approved build workflow. */
  boundaryActions?: Array<Omit<BoundaryActionBinding, 'controlsRevision'>>;
}

export interface BoundaryPreparation {
  repositoryId: number; pullRequest: number; contextDigest: string; ownerKey: string;
  /** Authenticated PR base and exact configured binding frozen at reservation. */
  protectedRef: string;
  roundGeneration?: number;
  installationId: string; operatorId: string; deadline: number; activityId: string; phase: 'pending' | 'prepared' | 'claimed';
  revision: { head: string; base: string; mergeBase: string };
  controlsRevision: number; installationRevision: number; operatorRevision: number;
  releaseId: string; bundleDigest: string; workflowId: number; workflowDigest: string;
  /** Signed workflow commit captured with the one-time Action claim; legacy claims cannot prepare packets. */
  claimedWorkflowSha?: string;
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
/** The parent validates these explicit choices against the current verified manager catalog. */
export interface ManagementGatewaySelection { operatorRevision: number; routeId: string | null; reasoningLevel: PiReasoningLevel | null }
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

/** Compatibility metadata only; the selected immutable release remains the code authority. */


interface ProspectiveSelectionPin {
  controlsRevision: number; installationRevision: number; operatorRevision: number; releaseId: string; bundleDigest: string;
}
const dispatcherDelegationSchema = z.strictObject({ version: z.literal(1),
  routingGroups: z.array(z.string().min(1).max(256)).max(1024) });
type DispatcherDelegation = z.infer<typeof dispatcherDelegationSchema>;
interface ProspectiveRegistration extends LegacyRepositoryIdentity, ProspectiveSelectionPin {
  scope?: 'installation'; nextObservationAt?: number; delegation?: DispatcherDelegation;
  registrationId: string; installationId: string; ownerKey: string; bucket: string; sessionId: string;
  sessionGeneration: number; revision: number; context: OperatorExecutionContext; repetitionIntervalSeconds: number;
}
export interface ProspectiveAdmission extends LegacyRepositoryIdentity, ProspectiveSelectionPin {
  activityId: string; installationId: string; admittedAt?: number; attempt?: number; previousActivityId?: string;
  pullRequest: number; head: string; createdAt: string; activatedAt: string; ownerKey: string;
  actor: { registrationId: string; bucket: string; sessionId: string; sessionGeneration: number;
    subject: string; issuer: string; email: string; audiences: readonly string[] };
}
/** Root-only data carrier: retention provenance, never execution or renewal authority. */
export interface ProspectiveObservationCapture {
  registrationId: string;
  binding: RawCaptureBinding;
  parentCaptureId?: string;
  loggingEnabled?: boolean;
}
export interface CurrentProspectiveRegistration extends LegacyRepositoryIdentity, ProspectiveSelectionPin {
  scope?: 'installation'; delegation?: DispatcherDelegation;
  registrationId: string; installationId: string; activatedAt: string; bucket: string;
  sessionId: string; sessionGeneration: number; human: VerifiedHumanAccessClaims; accessJwt: string; repetitionIntervalSeconds: number;
  /** Parent-selected transport capacities and original authority deadline; never caller policy. */
  sourceTimeoutMs: number; sourceResponseBytes: number; deadline: number;
  /** Parent-validated original policy; an absent older RPC field never enables capture. */
  loggingEnabled?: boolean;
}
export type ProspectiveRegistrationObservation =
  | { status: 'current'; registration: CurrentProspectiveRegistration }
  | { status: 'unavailable' } | { status: 'denied' };
export interface ManagementCatalogQuery {
  email: string; issuer: string; groups: string[]; platformAdmin: boolean; limit: number; cursor: string | null;
  profile?: string; realm?: string; state?: string; search?: string;
  /** Activity reads may include invokers, without expanding the management catalog. */
  includeInvokers?: boolean; managersEligible?: boolean;
}
export interface DispatcherConnectionMetadata {
  installationId: string; releaseId: string; connectionRevision: number;
  workerName: string; workerVersionId: string; sourceCommit: string; compilerCommit: string;
  manifestDigest: string; bundleDigest: string;
}
interface DispatcherConnectionRecord extends DispatcherConnectionMetadata {
  connectionSecretCiphertext: string; controlOrigin: string;
}
export interface ManagementInstallation {
  id: string; operatorId: string; name: string; releaseId: string | null;
  revision: number; enabled: boolean; policy: ManagementPolicy;
  /** JSON object bytes cross the Durable Object RPC boundary as a string. */
  configurationJson: string;
  /** Absent means inherit the execution owner's saved Pi reasoning preference. */
  piReasoningOverride?: PiReasoningLevel;
  approvedSourceRevision: number | null;
  dispatcherConnection?: DispatcherConnectionMetadata;
}
interface ManagementOperatorState {
  id: string; revision: number; repositoryUrl: string; repositoryId: number;
  githubPatCiphertext: string; profile: ManagementOperatorProfile; realm: ManagementOperatorRealm;
  managers: ManagementGrant; invokers: ManagementGrant;
  policy: ManagementOperatorPolicy; approvedWorkflow: { id: number; ref: string };
  sourceRevision: number;
}
export interface ManagementOperatorProjection {
  id: string; operatorId: string; revision: number; repositoryUrl: string; repositoryId: number;
  name?: string; description?: string; installedGithubReleaseId?: number; installedTagName?: string; installedPublishedAt?: string; installationCount?: number;
  profile: ManagementOperatorProfile; realm: ManagementOperatorRealm; enabled: boolean;
  managers: ManagementGrant; invokers: ManagementGrant; policy: ManagementOperatorPolicy;
  source: { kind: 'github-release'; repositoryUrl: string; repositoryId: number;
    credentialConfigured: boolean; approvedWorkflow: { id: number; ref: string } | null };
}
type ManagementAcquisition = ManagementOperatorState;

function managementProjection(value: ManagementOperatorState, enabled = false): ManagementOperatorProjection {
  return {
    id: value.id, operatorId: value.id, revision: value.revision, repositoryUrl: value.repositoryUrl,
    repositoryId: value.repositoryId, profile: value.profile, realm: value.realm, enabled,
    managers: structuredClone(value.managers), invokers: structuredClone(value.invokers), policy: { ...structuredClone(value.policy), loggingEnabled: value.policy.loggingEnabled ?? true },
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
export class OperatorRegistry extends DurableObject<{ ENCRYPTION_KEY?: string; OPERATOR_ACTIVITY?: Env['OPERATOR_ACTIVITY'] }> {
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
      CREATE TABLE IF NOT EXISTS operator_invoker_acl (principal TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(principal,id));
      CREATE TABLE IF NOT EXISTS operator_search (gram TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(gram,id));
      CREATE TABLE IF NOT EXISTS operator_search_schema (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS operator_releases (id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, data TEXT NOT NULL, manifest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operator_release_owner ON operator_releases(operator_id,id);
      CREATE TABLE IF NOT EXISTS operator_dispatcher_abort_connections (installation_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(installation_id,revision));
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
    if (!this.ctx.storage.sql.exec('SELECT version FROM operator_search_schema WHERE version=1').toArray().length) {
      for (const row of this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_catalog').toArray()) {
        this.indexManagementSearch(JSON.parse(row.data) as ManagementOperatorState);
      }
      this.ctx.storage.sql.exec('INSERT INTO operator_search_schema VALUES(1)');
    }
    if (!this.ctx.storage.sql.exec('SELECT version FROM operator_search_schema WHERE version=2').toArray().length) {
      for (const row of this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_catalog').toArray()) {
        this.indexManagementInvokers(JSON.parse(row.data) as ManagementOperatorState);
      }
      this.ctx.storage.sql.exec('INSERT INTO operator_search_schema VALUES(2)');
    }
  }

  private managementControls(): ManagementControls {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_management_controls WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.data) : { revision: 0, managers: { users: [], groups: [] }, ceiling: { capabilities: [], resourceProfileIds: [] } };
  }

  async getManagementControls(): Promise<ManagementControls> { return this.managementControls(); }

  async getBoundaryAction(repositoryId: number, protectedRef: string): Promise<BoundaryActionBinding | null> {
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0
      || !/^refs\/heads\/(main|master|develop)$/.test(protectedRef)) return null;
    const controls = this.managementControls();
    const matches = controls.boundaryActions?.filter(value => value.repositoryId === repositoryId
      && value.protectedRef === protectedRef && value.enabled !== false) ?? [];
    return matches.length === 1 ? { ...structuredClone(matches[0]), controlsRevision: controls.revision } : null;
  }

  /** Atomic PR-revision reservation; never returns an Action start credential. */
  async reserveBoundaryPreparation(input: Omit<BoundaryPreparation, 'activityId' | 'phase'> & {
    expectedContextDigest?: string | null;
  }): Promise<OperatorRegistryResult<{ activityId: string; created: boolean }>> {
    if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
      || !Number.isSafeInteger(input.pullRequest) || input.pullRequest <= 0
      || !/^refs\/heads\/(main|master|develop)$/.test(input.protectedRef)
      || (input.roundGeneration !== undefined && (!Number.isSafeInteger(input.roundGeneration) || input.roundGeneration < 1))
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
      const actions = this.managementControls().boundaryActions?.filter(binding => binding.enabled !== false
        && binding.repositoryId === input.repositoryId
        && binding.protectedRef === input.protectedRef) ?? [];
      const action = actions.length === 1 ? actions[0] : null;
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
        if (previous.protectedRef !== input.protectedRef || previous.ownerKey !== input.ownerKey
          || previous.session?.bucket !== input.session.bucket
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
        contextDigest: input.contextDigest, ownerKey: input.ownerKey, protectedRef: input.protectedRef,
        ...(input.roundGeneration !== undefined ? { roundGeneration: input.roundGeneration } : {}),
        installationId: input.installationId,
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
    const actions = controls.boundaryActions?.filter(binding => binding.enabled !== false
      && binding.repositoryId === current.repositoryId
      && binding.protectedRef === current.protectedRef) ?? [];
    const action = actions.length === 1 ? actions[0] : null;
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
    generation: number; contextDigest: string; workflowSha: string | null;
    session: BoundaryPreparation['session'] } | null> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(activityId)) return null;
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>(
      "SELECT data FROM operator_boundary_preparations WHERE json_extract(data,'$.activityId')=? LIMIT 1", activityId).toArray()[0];
    if (!row) return null;
    const current = JSON.parse(row.data) as BoundaryPreparation;
    const action = this.managementControls().boundaryActions?.find(binding => binding.enabled !== false
      && binding.repositoryId === current.repositoryId && binding.protectedRef === current.protectedRef);
    const handoff = this.ctx.storage.sql.exec<{ consumed: number; run_id: number | null; run_attempt: number | null }>(
      'SELECT consumed,run_id,run_attempt FROM operator_boundary_handoffs WHERE activity_id=?', activityId).toArray()[0];
    return { claimed: action?.verified === true && /^[a-f0-9]{40}$/.test(action.runtimeSha ?? '')
      && current.phase === 'claimed' && handoff?.consumed === 1
      && handoff.run_id != null && handoff.run_attempt != null && current.deadline > Date.now()
      && this.boundarySelectionCurrent(current), repositoryId: current.repositoryId, pullRequest: current.pullRequest,
      head: current.revision.head, base: current.revision.base, mergeBase: current.revision.mergeBase,
      workflowId: current.workflowId, runId: handoff?.run_id ?? 0, runAttempt: handoff?.run_attempt ?? 0,
      generation: current.session.generation, contextDigest: current.contextDigest,
      workflowSha: current.claimedWorkflowSha ?? null, session: structuredClone(current.session) };
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
    mergeBase: string; workflowId: number; runId: number; runAttempt: number;
    workflowSha?: string }): Promise<OperatorRegistryResult<{
      activityId: string; startCapability: string; repositoryId: number; pullRequest: number;
      head: string; base: string; mergeBase: string; workflowId: number; runId: number;
      runAttempt: number; generation: number; session: BoundaryPreparation['session'] }>> {
    if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0
      || !Number.isSafeInteger(input.pullRequest) || input.pullRequest <= 0
      || ![input.head, input.base, input.mergeBase].every(sha => /^[a-f0-9]{40}$/i.test(sha))
      || ![input.workflowId, input.runId, input.runAttempt].every(n => Number.isSafeInteger(n) && n > 0)
      || input.workflowSha !== undefined && !/^[a-f0-9]{40}$/.test(input.workflowSha)) {
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
        || (current.roundGeneration !== undefined && current.roundGeneration !== 1)
        || current.revision.head !== input.head || current.revision.base !== input.base
        || current.revision.mergeBase !== input.mergeBase || current.workflowId !== input.workflowId
        || !this.boundarySelectionCurrent(current)) return null;
      const handoff = this.ctx.storage.sql.exec<{ ciphertext: string; expires_at: number; consumed: number }>(
        'SELECT ciphertext,expires_at,consumed FROM operator_boundary_handoffs WHERE activity_id=?', current.activityId).toArray()[0];
      if (!handoff || handoff.consumed || handoff.expires_at <= Date.now()) return null;
      this.ctx.storage.sql.exec('UPDATE operator_boundary_handoffs SET consumed=1,run_id=?,run_attempt=? WHERE activity_id=? AND consumed=0',
        input.runId, input.runAttempt, current.activityId);
      this.ctx.storage.sql.exec('UPDATE operator_boundary_preparations SET data=? WHERE repository_id=? AND pull_request=?',
        JSON.stringify({ ...current, phase: 'claimed',
          ...(input.workflowSha ? { claimedWorkflowSha: input.workflowSha } : {}) }),
        input.repositoryId, input.pullRequest);
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
      const actions = this.managementControls().boundaryActions?.filter(binding => binding.enabled !== false
        && binding.repositoryId === repositoryId
        && binding.protectedRef === current.protectedRef) ?? [];
      const action = actions.length === 1 ? actions[0] : null;
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
  async setManagementControls(input: ManagementControls, actor: { email: string; expiresAt: number },
    trustedInstallation = false): Promise<OperatorRegistryResult<ManagementControls>> {
    this.managementSchema();
    if (input.ceiling.sourceResponseBytes !== undefined && (!Number.isInteger(input.ceiling.sourceResponseBytes)
      || input.ceiling.sourceResponseBytes < 1 || input.ceiling.sourceResponseBytes > MAX_SOURCE_RESPONSE_BYTES)) {
      throw new ValidationError('Invalid management source response byte ceiling');
    }
    if (input.boundaryActions !== undefined) {
      const seen = new Set<string>();
      if (!Array.isArray(input.boundaryActions) || input.boundaryActions.length > 100) throw new ValidationError('Invalid boundary Action bindings');
      for (const action of input.boundaryActions) {
        if (!action || !Number.isSafeInteger(action.repositoryId) || action.repositoryId <= 0
          || seen.has(`${action.repositoryId}:${action.protectedRef}`) || !Number.isSafeInteger(action.workflowId) || action.workflowId <= 0
          || !/^[A-Za-z0-9_-]{1,128}$/.test(action.installationId)
          || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(action.workflowPath)
          || !/^refs\/heads\/(main|master|develop)$/.test(action.protectedRef)
          || !/^[a-f0-9]{64}$/i.test(action.workflowDigest)
          || action.enabled === true || (action.verified === true && !trustedInstallation)
          || (action.verified === true && !/^[a-f0-9]{40}$/i.test(action.runtimeSha ?? ''))
          || !Array.isArray(action.events) || action.events.length === 0
          || action.events.some(event => event !== 'pull_request_target' && event !== 'pull_request' && event !== 'push')) {
          throw new ValidationError('Invalid boundary Action binding');
        }
        seen.add(`${action.repositoryId}:${action.protectedRef}`);
      }
    }
    return this.ctx.storage.transactionSync(() => {
      if (!Number.isFinite(actor.expiresAt) || actor.expiresAt <= Date.now()) return { ok: false, reason: 'authority-expired' };
      const current = this.managementControls();
      if (current.revision !== input.revision) return { ok: false, reason: 'revision-conflict' };
      if (!trustedInstallation && input.boundaryActions !== undefined && current.boundaryActions?.some(a => a.verified)) {
        return { ok: false, reason: 'revision-conflict' };
      }
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
    const bytes = effectiveSourceResponseBytes(policy);
    return (policy.inference === undefined || inferencePolicySchema.safeParse(policy.inference).success)
      && controls.revision > 0 && policy.capabilities.every(value => controls.ceiling.capabilities.includes(value))
      && (policy.resourceProfileId === null || controls.ceiling.resourceProfileIds.includes(policy.resourceProfileId))
      && Number.isInteger(bytes) && bytes >= 1 && bytes <= MAX_SOURCE_RESPONSE_BYTES
      && bytes <= effectiveSourceResponseBytes(controls.ceiling);
  }

  private managementState(id: string): ManagementOperatorState | null {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_catalog WHERE id=?', id).toArray()[0];
    const state = row ? JSON.parse(row.data) as ManagementOperatorState : null;
    if (state?.policy.inference !== undefined && !inferencePolicySchema.safeParse(state.policy.inference).success) {
      throw new ValidationError('Invalid operator inference policy');
    }
    return state;
  }

  private indexManagementSearch(state: ManagementOperatorState): void {
    const sql = this.ctx.storage.sql;
    const facts = this.managementCatalogFacts(state.id);
    const search = [state.repositoryUrl, state.id, facts.name, facts.description].filter(Boolean).join(' ').toLowerCase();
    sql.exec('UPDATE operator_catalog SET search=? WHERE id=?', search, state.id);
    sql.exec('DELETE FROM operator_search WHERE id=?', state.id);
    const grams = new Set<string>();
    for (let n = 1; n <= 3; n++) for (let i = 0; i <= search.length - n; i++) grams.add(search.slice(i, i + n));
    for (const gram of grams) sql.exec('INSERT INTO operator_search VALUES(?,?)', gram, state.id);
  }

  private indexManagementInvokers(state: ManagementOperatorState): void {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM operator_invoker_acl WHERE id=?', state.id);
    for (const principal of new Set([...state.invokers.users.map(user => `u:${user.trim().toLowerCase()}`),
      ...state.invokers.groups.map(group => `g:${JSON.stringify([group.issuer, group.id])}`)])) {
      sql.exec('INSERT INTO operator_invoker_acl VALUES(?,?)', principal, state.id);
    }
  }

  private saveManagement(state: ManagementOperatorState, insertOnly = false): ManagementOperatorProjection {
    const sql = this.ctx.storage.sql;
    const enabled = sql.exec('SELECT id FROM operator_installations WHERE operator_id=? AND enabled=1 LIMIT 1', state.id).toArray().length > 0;
    sql.exec(`${insertOnly ? 'INSERT' : 'INSERT OR REPLACE'} INTO operator_catalog VALUES(?,?,?,?,?,?)`, state.id, state.profile, state.realm, Number(enabled), '', JSON.stringify(state));
    sql.exec('DELETE FROM operator_acl WHERE id=?', state.id);
    for (const principal of new Set([...state.managers.users.map(user => `u:${user.trim().toLowerCase()}`),
      ...state.managers.groups.map(group => `g:${JSON.stringify([group.issuer, group.id])}`)])) {
      sql.exec('INSERT INTO operator_acl VALUES(?,?)', principal, state.id);
    }
    this.indexManagementSearch(state);
    this.indexManagementInvokers(state);
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
      if (this.managementState(id)) return { ok: false, reason: 'revision-conflict' };
      const state: ManagementOperatorState = { id, revision: 1, sourceRevision: 1, repositoryUrl: input.repositoryUrl,
        repositoryId: input.repositoryId, githubPatCiphertext, profile: input.profile, realm: input.realm,
        managers: input.managers, invokers: input.invokers, policy: input.policy, approvedWorkflow: input.approvedWorkflow };
      return { ok: true, value: this.saveManagement(state, true) };
    });
  }

  /** Project only an unambiguous pinned version or a sole discovered package description. */
  private managementCatalogFacts(operatorId: string): Pick<ManagementOperatorProjection, 'name' | 'description' | 'installedGithubReleaseId' | 'installedTagName' | 'installedPublishedAt' | 'installationCount'> {
    const installations = this.ctx.storage.sql.exec<{ data: string }>(
      'SELECT data FROM operator_installations WHERE operator_id=? LIMIT 100', operatorId).toArray()
      .map(row => JSON.parse(row.data) as ManagementInstallation);
    const enabled = installations.filter(item => item.enabled);
    const selectedId = enabled.length === 1 ? enabled[0].releaseId : installations.length === 1 ? installations[0].releaseId : null;
    const releases = selectedId
      ? this.ctx.storage.sql.exec<{ data: string; manifest: string }>('SELECT data,manifest FROM operator_releases WHERE id=? AND operator_id=?', selectedId, operatorId).toArray()
      : installations.length === 0
        ? this.ctx.storage.sql.exec<{ data: string; manifest: string }>('SELECT data,manifest FROM operator_releases WHERE operator_id=? LIMIT 2', operatorId).toArray()
        : [];
    if (releases.length !== 1) return { installationCount: installations.length };
    const release = releases[0];
    const manifest = JSON.parse(release.manifest) as { name?: unknown; description?: unknown };
    if (typeof manifest.name !== 'string' || typeof manifest.description !== 'string') throw new ValidationError('Operator description unavailable');
    const pinned = selectedId ? JSON.parse(release.data) as ManagementRelease : undefined;
    return { name: manifest.name, description: manifest.description, installationCount: installations.length,
      ...(pinned ? { installedGithubReleaseId: pinned.githubReleaseId, installedTagName: pinned.tagName,
        installedPublishedAt: pinned.publishedAt } : {}) };
  }

  /** Permission/search/filter indexes are applied before keyset pagination. No global scan or hidden totals. */
  async listManagementOperators(query: ManagementCatalogQuery): Promise<{ items: ManagementOperatorProjection[]; cursor: string | null }> {
    this.managementSchema();
    const principals = [`u:${query.email.trim().toLowerCase()}`, ...query.groups.map(id => `g:${JSON.stringify([query.issuer, id])}`)];
    const params: (string | number)[] = [];
    const clauses: string[] = [];
    if (!query.platformAdmin) {
      const selections: string[] = [];
      if (!query.includeInvokers || query.managersEligible) {
        selections.push('SELECT id FROM operator_acl WHERE principal IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify(principals));
      }
      if (query.includeInvokers) {
        selections.push('SELECT id FROM operator_invoker_acl WHERE principal IN (SELECT value FROM json_each(?))');
        params.push(JSON.stringify(principals));
      }
      clauses.push(`c.id IN (${selections.join(' UNION ')})`);
    }
    clauses.push('c.id>?'); params.push(query.cursor ?? '');
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
    const items = rows.slice(0, query.limit).map(row => ({ ...managementProjection(JSON.parse(row.data), Boolean(row.enabled)),
      ...this.managementCatalogFacts(row.id) }));
    return { items, cursor: rows.length > query.limit ? items[items.length - 1].id : null };
  }

  async getManagementOperator(operatorId: string): Promise<OperatorRegistryResult<ManagementOperatorProjection>> {
    const state = this.managementState(operatorId);
    if (!state) return { ok: false, reason: 'not-found' };
    const enabled = this.ctx.storage.sql.exec('SELECT id FROM operator_installations WHERE operator_id=? AND enabled=1 LIMIT 1', operatorId).toArray().length > 0;
    return { ok: true, value: { ...managementProjection(state, enabled), ...this.managementCatalogFacts(operatorId) } };
  }

  /** Parent-only: the acquisition PAT never enters release, installation or activity records. */
  async getManagementAcquisition(operatorId: string): Promise<OperatorRegistryResult<ManagementAcquisition>> {
    const state = this.managementState(operatorId);
    return state ? { ok: true, value: state } : { ok: false, reason: 'not-found' };
  }

  async getManagementReleases(operatorId: string): Promise<ManagementRelease[]> {
    this.managementSchema();
    return this.ctx.storage.sql.exec<{ data: string; manifest: string }>('SELECT data,manifest FROM operator_releases WHERE operator_id=? ORDER BY id LIMIT 100', operatorId)
      .toArray().map(row => {
        const manifest = JSON.parse(row.manifest) as { name?: unknown; description?: unknown; application?: OperatorManifest['application'] };
        if (typeof manifest.name !== 'string' || typeof manifest.description !== 'string') throw new ValidationError('Operator description unavailable');
        return { ...JSON.parse(row.data) as ManagementRelease, name: manifest.name, description: manifest.description,
          ...(manifest.application ? { applicationJson: JSON.stringify(manifest.application) } : {}) };
      });
  }

  async getManagementInstallations(operatorId: string): Promise<ManagementInstallation[]> {
    this.managementSchema();
    return this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE operator_id=? ORDER BY id LIMIT 100', operatorId)
      .toArray().map(row => this.parseManagementInstallation(row.data));
  }

  /** REQ-OPERATOR-086 AC2/5: page installation identities after current-human ACL selection. */
  async listManagementInstallationPage(query: Pick<ManagementCatalogQuery,
    'email' | 'issuer' | 'groups' | 'platformAdmin' | 'managersEligible' | 'cursor'>): Promise<{ items: ManagementInstallation[]; cursor: string | null }> {
    this.managementSchema();
    const params: string[] = [];
    const clauses: string[] = [];
    if (!query.platformAdmin) {
      const principals = JSON.stringify([`u:${query.email.trim().toLowerCase()}`,
        ...query.groups.map(id => `g:${JSON.stringify([query.issuer, id])}`)]);
      const selections = ['SELECT id FROM operator_invoker_acl WHERE principal IN (SELECT value FROM json_each(?))'];
      params.push(principals);
      if (query.managersEligible) {
        selections.push('SELECT id FROM operator_acl WHERE principal IN (SELECT value FROM json_each(?))');
        params.push(principals);
      }
      clauses.push(`i.operator_id IN (${selections.join(' UNION ')})`);
    }
    clauses.push('i.id>?'); params.push(query.cursor ?? '');
    const rows = this.ctx.storage.sql.exec<{ data: string }>(
      `SELECT i.data FROM operator_installations i WHERE ${clauses.join(' AND ')} ORDER BY i.id LIMIT 6`, ...params).toArray();
    const items = rows.slice(0, 5).map(row => this.parseManagementInstallation(row.data));
    return { items, cursor: rows.length > 5 ? items[items.length - 1].id : null };
  }

  private managementInstallation(id: string): ManagementInstallation | null {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE id=?', id).toArray()[0];
    return row ? this.parseManagementInstallation(row.data) : null;
  }

  private parseManagementInstallation(data: string): ManagementInstallation {
    const { dispatcherConnectionSecretCiphertext: _secret, dispatcherConnectionVerification: _verification, ...parsed } = JSON.parse(data) as ManagementInstallation & { configuration?: unknown; dispatcherConnectionSecretCiphertext?: string; dispatcherConnectionVerification?: DispatcherDeploymentVerification };
    if (parsed.policy.inference !== undefined && !inferencePolicySchema.safeParse(parsed.policy.inference).success) {
      throw new ValidationError('Invalid installation inference policy');
    }
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
    const previous = sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE id=?', value.id).toArray()[0];
    const secret = (value as ManagementInstallation & { dispatcherConnectionSecretCiphertext?: string }).dispatcherConnectionSecretCiphertext
      ?? (previous ? (JSON.parse(previous.data) as { dispatcherConnectionSecretCiphertext?: string }).dispatcherConnectionSecretCiphertext : undefined);
    const verification = Object.hasOwn(value, 'dispatcherConnectionVerification')
      ? (value as ManagementInstallation & { dispatcherConnectionVerification?: DispatcherDeploymentVerification | null }).dispatcherConnectionVerification
      : previous ? (JSON.parse(previous.data) as { dispatcherConnectionVerification?: DispatcherDeploymentVerification }).dispatcherConnectionVerification : undefined;
    const stored = { ...value, ...(secret ? { dispatcherConnectionSecretCiphertext: secret } : {}),
      ...(verification ? { dispatcherConnectionVerification: verification } : { dispatcherConnectionVerification: null }) };
    sql.exec('INSERT OR REPLACE INTO operator_installations VALUES(?,?,?,?,?)', value.id, value.operatorId, value.name.toLowerCase(), Number(value.enabled), JSON.stringify(stored));
    sql.exec('INSERT INTO operator_configuration_history VALUES(?,?,?)', value.id, value.revision, JSON.stringify(stored));
    sql.exec('UPDATE operator_catalog SET enabled=EXISTS(SELECT 1 FROM operator_installations WHERE operator_id=? AND enabled=1) WHERE id=?', value.operatorId, value.operatorId);
    const state = sql.exec<{ data: string }>('SELECT data FROM operator_catalog WHERE id=?', value.operatorId).one();
    this.indexManagementSearch(JSON.parse(state.data) as ManagementOperatorState);
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
          const enriched = { ...old, tagName: old.tagName ?? release.tagName,
            publishedAt: old.publishedAt ?? release.publishedAt };
          const previousIdentity = { ...old, approved: false,
            provenance: { ...old.provenance } };
          const candidateIdentity = { ...release, approved: false,
            provenance: { ...release.provenance } };
          delete previousIdentity.tagName; delete previousIdentity.publishedAt;
          delete candidateIdentity.tagName; delete candidateIdentity.publishedAt;
          // Releases acquired before compiler provenance was mandatory remain
          // immutable and usable. Never invent or persist a compiler identity;
          // only ignore the new field while comparing that exact legacy row.
          if (previousIdentity.provenance.compilerCommit === undefined) {
            delete candidateIdentity.provenance.compilerCommit;
          }
          if ((old.tagName !== undefined && old.tagName !== release.tagName)
            || (old.publishedAt !== undefined && old.publishedAt !== release.publishedAt)
            || JSON.stringify(previousIdentity) !== JSON.stringify(candidateIdentity)) {
            throw new ValidationError('Immutable release identity changed');
          }
          if (old.tagName !== enriched.tagName || old.publishedAt !== enriched.publishedAt) {
            this.ctx.storage.sql.exec('UPDATE operator_releases SET data=? WHERE id=?', JSON.stringify(enriched), release.id);
          }
          releases.push(enriched);
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
      && (policy.resourceProfileId === null || policy.resourceProfileId === ceiling.resourceProfileId)
      && effectiveSourceResponseBytes(policy) <= effectiveSourceResponseBytes(ceiling)
      && (policy.inference?.allowedSources ?? ['managed']).every(source => (ceiling.inference?.allowedSources ?? ['managed']).includes(source))
      && (policy.inference === undefined || ceiling.inference === undefined || (
        policy.inference.routeIds.every(route => ceiling.inference!.routeIds.includes(route))
        && policy.inference.reasoningLevels.every(level => ceiling.inference!.reasoningLevels.includes(level))
        && (!policy.inference.inheritUserDefaults || ceiling.inference.inheritUserDefaults)
      ));
  }

  async createManagementInstallation(operatorId: string, name: string, policy: ManagementPolicy, authority: ManagementAuthority, configurationJson = '{}', piReasoningOverride?: PiReasoningLevel): Promise<OperatorRegistryResult<ManagementInstallation>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const state = this.managementState(operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      if (!this.restrictivePolicy(policy, state!.policy)) throw new ValidationError('Installation exceeds operator policy');
      if (this.ctx.storage.sql.exec('SELECT id FROM operator_installations WHERE operator_id=? AND name=?', operatorId, name.toLowerCase()).toArray().length) return { ok: false, reason: 'already-exists' };
      if (this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM operator_installations WHERE operator_id=?', operatorId).one().n >= 100) throw new ValidationError('Installation limit reached');
      if (piReasoningOverride !== undefined && (state!.profile === 'dispatcher' || !isPiReasoningLevel(piReasoningOverride))) throw new ValidationError('Invalid Pi reasoning override');
      const value: ManagementInstallation = { id: crypto.randomUUID(), operatorId, name, releaseId: null, revision: 1,
        ...(piReasoningOverride !== undefined && { piReasoningOverride }),
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

  async setManagementInstallationEnabled(installationId: string, enabled: boolean, expectedRevision: number, authority: ManagementAuthority, verification?: DispatcherDeploymentVerification): Promise<OperatorRegistryResult<ManagementInstallation>> {
    this.managementSchema();
    const before = this.managementInstallation(installationId);
    let normal = false;
    if (enabled && before?.releaseId && this.managementState(before.operatorId)?.profile === 'dispatcher') {
      const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=? AND operator_id=?', before.releaseId, before.operatorId).toArray()[0];
      const release = row ? JSON.parse(row.data) as ManagementRelease : null;
      if (release) {
        const bytes = await this.getManagementBundle(release.bundleDigest);
        if (!bytes) return { ok: false, reason: 'artifact-unapproved' };
        // Historical approvals keep their original semantics; only schema2 introduces this deployment gate.
        let schema: unknown;
        try { schema = JSON.parse(new TextDecoder().decode(bytes)); } catch { /* opaque historical approval */ }
        normal = !!schema && typeof schema === 'object' && 'schemaVersion' in schema && schema.schemaVersion === 2;
        if (normal) await parseDispatcherBundle(bytes, release.bundleDigest);
      }
    }
    return this.ctx.storage.transactionSync(() => {
      const installation = this.managementInstallation(installationId);
      if (!installation) return { ok: false, reason: 'not-found' };
      const state = this.managementState(installation.operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      if (installation.revision !== expectedRevision) return { ok: false, reason: 'revision-conflict' };
      if (enabled) {
        if (normal && (!installation.dispatcherConnection || installation.dispatcherConnection.releaseId !== installation.releaseId
          || !verification || verification.connectionRevision !== installation.dispatcherConnection.connectionRevision
          || verification.bundleDigest !== installation.dispatcherConnection.bundleDigest
          || verification.workerVersionId !== installation.dispatcherConnection.workerVersionId
          || !/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(verification.controlOrigin))) return { ok: false, reason: 'artifact-unapproved' };
        if (!this.restrictivePolicy(installation.policy, state!.policy)) throw new ValidationError('Installation exceeds operator policy');
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
      this.saveInstallation(normal && enabled ? { ...value, dispatcherConnectionVerification: verification } as ManagementInstallation : value);
      if (normal && enabled && verification && installation.dispatcherConnection) {
        const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE id=?', installationId).toArray()[0];
        const secret = (JSON.parse(row.data) as { dispatcherConnectionSecretCiphertext?: string }).dispatcherConnectionSecretCiphertext;
        if (!secret) throw new Error('Dispatcher connection unavailable');
        // Installation revisions, never per-run credentials. Retired credentials authorize only fenced original abort.
        this.ctx.storage.sql.exec('INSERT INTO operator_dispatcher_abort_connections(installation_id,revision,data) VALUES(?,?,?) ON CONFLICT(installation_id,revision) DO NOTHING',
          installationId, installation.dispatcherConnection.connectionRevision, JSON.stringify({ ...installation.dispatcherConnection,
            connectionSecretCiphertext: secret, controlOrigin: verification.controlOrigin }));
      }
      return { ok: true, value };
    });
  }

  /** REQ-OPERATOR-046/049: an installation connection is revision-fenced, write-only and disables starts. */
  async configureManagementDispatcherConnection(installationId: string, input: {
    revision: number; connectionSecret: string; workerName: string; workerVersionId: string;
    releaseId: string; sourceCommit: string; compilerCommit: string; manifestDigest: string; bundleDigest: string;
  }, authority: ManagementAuthority): Promise<OperatorRegistryResult<ManagementInstallation>> {
    this.managementSchema();
    const ciphertext = await sealOperatorSecret(input.connectionSecret, this.env, { purpose: 'connection', recordId: installationId });
    return this.ctx.storage.transactionSync(() => {
      const installation = this.managementInstallation(installationId);
      if (!installation) return { ok: false, reason: 'not-found' };
      const state = this.managementState(installation.operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      if (installation.revision !== input.revision) return { ok: false, reason: 'revision-conflict' };
      const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_releases WHERE id=? AND operator_id=?', input.releaseId, installation.operatorId).toArray()[0];
      const release = row ? JSON.parse(row.data) as ManagementRelease : null;
      if (state!.profile !== 'dispatcher' || !release || !release.approved || installation.releaseId !== release.id
        || installation.approvedSourceRevision !== state!.sourceRevision || release.sourceRevision !== state!.sourceRevision
        || release.sourceCommit !== input.sourceCommit || release.provenance.compilerCommit !== input.compilerCommit
        || release.manifestDigest !== input.manifestDigest || release.bundleDigest !== input.bundleDigest) {
        return { ok: false, reason: 'artifact-unapproved' };
      }
      const { revision: _revision, connectionSecret: _secret, ...metadata } = input;
      const connection: DispatcherConnectionMetadata = { ...metadata, installationId,
        connectionRevision: (installation.dispatcherConnection?.connectionRevision ?? 0) + 1 };
      const value: ManagementInstallation = { ...installation, enabled: false,
        revision: installation.revision + 1, dispatcherConnection: connection };
      this.saveInstallation({ ...value, dispatcherConnectionSecretCiphertext: ciphertext, dispatcherConnectionVerification: null } as ManagementInstallation);
      return { ok: true, value };
    });
  }

  /** Parent-only unverified metadata for the authorized enablement boundary; never supplies an endpoint. */
  async getConfiguredDispatcherConnection(installationId: string): Promise<DispatcherConnectionMetadata | null> {
    return this.managementInstallation(installationId)?.dispatcherConnection ?? null;
  }

  /** Parent-only local read: endpoint and exact active version were verified before enablement. */
  async getManagementDispatcherConnection(installationId: string): Promise<DispatcherConnectionRecord | null> {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE id=?', installationId).toArray()[0];
    if (!row) return null;
    const stored = JSON.parse(row.data) as ManagementInstallation & { dispatcherConnectionSecretCiphertext?: string;
      dispatcherConnectionVerification?: DispatcherDeploymentVerification };
    const connection = stored.dispatcherConnection;
    const proof = stored.dispatcherConnectionVerification;
    if (!connection || !proof || !stored.dispatcherConnectionSecretCiphertext || connection.releaseId !== stored.releaseId
      || proof.connectionRevision !== connection.connectionRevision || proof.workerVersionId !== connection.workerVersionId
      || proof.bundleDigest !== connection.bundleDigest) return null;
    return { ...connection, connectionSecretCiphertext: stored.dispatcherConnectionSecretCiphertext, controlOrigin: proof.controlOrigin };
  }

  /** Parent-only historical installation credential. Never authorizes dispatch/read/effects or renews a run. */
  async getManagementDispatcherAbortConnection(installationId: string, revision: number): Promise<DispatcherConnectionRecord | null> {
    this.managementSchema();
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_dispatcher_abort_connections WHERE installation_id=? AND revision=?',
      installationId, revision).toArray()[0];
    return row ? JSON.parse(row.data) as DispatcherConnectionRecord : null;
  }

  async configureManagementInstallation(installationId: string, input: { policy: ManagementPolicy; configurationJson: string; revision: number; piReasoningOverride?: PiReasoningLevel; gatewaySelection?: ManagementGatewaySelection }, authority: ManagementAuthority): Promise<OperatorRegistryResult<ManagementInstallation>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const installation = this.managementInstallation(installationId);
      if (!installation) return { ok: false, reason: 'not-found' };
      const state = this.managementState(installation.operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      if (installation.revision !== input.revision) return { ok: false, reason: 'revision-conflict' };
      let operatorPolicy = state!.policy;
      let policy = input.policy;
      if (input.gatewaySelection !== undefined) {
        const selection = input.gatewaySelection;
        if (!Number.isSafeInteger(selection.operatorRevision) || selection.operatorRevision < 1
          || selection.operatorRevision !== state!.revision) return { ok: false, reason: 'revision-conflict' };
        if (state!.profile !== 'dispatcher'
          || (selection.routeId !== null && (typeof selection.routeId !== 'string' || selection.routeId.length < 1
            || selection.routeId.length > 128 || selection.routeId.trim() !== selection.routeId))
          || (selection.reasoningLevel !== null && (!isPiReasoningLevel(selection.reasoningLevel) || selection.routeId === null))) {
          throw new ValidationError('Invalid Gateway selection');
        }
        const approve = (previous: ManagementPolicy['inference'], defaults: boolean): NonNullable<ManagementPolicy['inference']> => {
          const base = previous ?? { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false };
          return { ...base,
            ...(selection.routeId === null ? {} : { allowedSources: [...new Set([...(base.allowedSources ?? ['managed']), 'managed'] as const)] }),
            routeIds: [...new Set([...base.routeIds, ...(selection.routeId === null ? [] : [selection.routeId])])],
            reasoningLevels: [...new Set([...base.reasoningLevels, ...(selection.reasoningLevel === null ? [] : [selection.reasoningLevel])])],
            ...(defaults ? { defaultRouteId: selection.routeId, defaultReasoningLevel: selection.reasoningLevel, inheritUserDefaults: false } : {}) };
        };
        // Intent approves only the explicit pair, never permissions smuggled in input.policy.inference.
        operatorPolicy = selection.routeId === null ? state!.policy : { ...state!.policy, inference: approve(state!.policy.inference, false) };
        policy = { ...input.policy, inference: approve(installation.policy.inference, true) };
        if (!this.withinManagementCeiling(operatorPolicy)) throw new ValidationError('Operator exceeds management ceiling');
      }
      if (!this.restrictivePolicy(policy, operatorPolicy)) throw new ValidationError('Installation exceeds operator policy');
      if (input.piReasoningOverride !== undefined && (state!.profile === 'dispatcher' || !isPiReasoningLevel(input.piReasoningOverride))) throw new ValidationError('Invalid Pi reasoning override');
      const { piReasoningOverride: _previous, ...inherited } = installation;
      const value: ManagementInstallation = { ...inherited, ...(input.piReasoningOverride !== undefined && { piReasoningOverride: input.piReasoningOverride }), policy, configurationJson: this.managementConfiguration(input.configurationJson), revision: installation.revision + 1, enabled: false };
      if (JSON.stringify(operatorPolicy) !== JSON.stringify(state!.policy)) {
        const rows = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE operator_id=? AND enabled=1', installation.operatorId).toArray();
        for (const row of rows) {
          const other = this.parseManagementInstallation(row.data);
          if (other.id !== installationId) this.saveInstallation({ ...other, revision: other.revision + 1, enabled: false });
        }
        this.saveManagement({ ...state!, revision: state!.revision + 1, policy: operatorPolicy });
      }
      this.saveInstallation(value);
      return { ok: true, value };
    });
  }

  async setManagementCapabilities(operatorId: string, capabilities: string[], authority: ManagementAuthority, sourceResponseBytes?: number, inferenceRequestBytes?: number, operationLimit?: number, loggingEnabled?: boolean, inferenceAttemptLimit?: number, submissionAttemptLimit?: number, capacityPolicy: DispatcherCapacityPolicy = {}, inference?: OperatorPolicy['inference']): Promise<OperatorRegistryResult<ManagementOperatorProjection>> {
    this.managementSchema();
    return this.ctx.storage.transactionSync(() => {
      const state = this.managementState(operatorId);
      const fence = this.managementFence(state, authority);
      if (fence) return fence;
      if (inferenceRequestBytes !== undefined && (state!.profile !== 'dispatcher'
        || !Number.isSafeInteger(inferenceRequestBytes) || inferenceRequestBytes < 1)) {
        throw new ValidationError('Invalid operator inference request byte limit');
      }
      if (operationLimit !== undefined && (state!.profile !== 'dispatcher'
        || !Number.isSafeInteger(operationLimit) || operationLimit < 1)) {
        throw new ValidationError('Invalid Dispatcher operation limit');
      }
      if (inferenceAttemptLimit !== undefined && (state!.profile !== 'dispatcher'
        || !Number.isSafeInteger(inferenceAttemptLimit) || inferenceAttemptLimit < 1)) {
        throw new ValidationError('Invalid Dispatcher inference attempt limit');
      }
      if (submissionAttemptLimit !== undefined && (state!.profile !== 'dispatcher'
        || !Number.isSafeInteger(submissionAttemptLimit) || submissionAttemptLimit < 1)) {
        throw new ValidationError('Invalid Dispatcher submission attempt limit');
      }
      if (loggingEnabled !== undefined && typeof loggingEnabled !== 'boolean') throw new ValidationError('Invalid operator logging setting');
      if ((Object.keys(capacityPolicy).length > 0 && state!.profile !== 'dispatcher')
        || !dispatcherCapacityPolicySchema.safeParse(capacityPolicy).success
        || !validDispatcherCapacities({ ...pickDispatcherCapacities(state!.policy), ...capacityPolicy })) {
        throw new ValidationError('Invalid Dispatcher capacity limits');
      }
      const policy = { ...state!.policy, ...capacityPolicy, capabilities,
        ...(inference === undefined ? {} : { inference }),
        ...(sourceResponseBytes === undefined ? {} : { sourceResponseBytes }),
        ...(inferenceRequestBytes === undefined ? {} : { inferenceRequestBytes }),
        ...(operationLimit === undefined ? {} : { operationLimit }),
        ...(inferenceAttemptLimit === undefined ? {} : { inferenceAttemptLimit }),
        ...(submissionAttemptLimit === undefined ? {} : { submissionAttemptLimit }),
        ...(loggingEnabled === undefined ? {} : { loggingEnabled }) };
      if (!this.withinManagementCeiling(policy)) throw new ValidationError('Operator capabilities exceed management ceiling');
      const limits = dispatcherCapacities(policy), storedLimits = dispatcherCapacities(state!.policy);
      if (capabilities.length === state!.policy.capabilities.length
        && capabilities.every(value => state!.policy.capabilities.includes(value))
        && effectiveSourceResponseBytes(policy) === effectiveSourceResponseBytes(state!.policy)
        && effectiveInferenceRequestBytes(policy) === effectiveInferenceRequestBytes(state!.policy)
        && effectiveOperationLimit(policy) === effectiveOperationLimit(state!.policy)
        && effectiveInferenceAttemptLimit(policy) === effectiveInferenceAttemptLimit(state!.policy)
        && effectiveSubmissionAttemptLimit(policy) === effectiveSubmissionAttemptLimit(state!.policy)
        && dispatcherCapacityKeys.every(key => limits[key] === storedLimits[key])
        && JSON.stringify(policy.inference) === JSON.stringify(state!.policy.inference)
        && (policy.loggingEnabled ?? true) === (state!.policy.loggingEnabled ?? true)) return { ok: true, value: this.saveManagement(state!) };
      const rows = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_installations WHERE operator_id=? AND enabled=1', operatorId).toArray();
      for (const row of rows) {
        const installation = this.parseManagementInstallation(row.data);
        this.saveInstallation({ ...installation, revision: installation.revision + 1, enabled: false });
      }
      return { ok: true, value: this.saveManagement({ ...state!, revision: state!.revision + 1, policy }) };
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

  /** Read-only pinned configuration support; never an execution-admission check. */
  async resolveManagementConfiguration(installationId: string): Promise<OperatorRegistryResult<ManagementExecutionSelection>> {
    return this.managementSelection(installationId);
  }

  private managementExecution(installationId: string): OperatorRegistryResult<ManagementExecutionSelection> {
    const installation = this.managementInstallation(installationId);
    if (installation && !installation.enabled) return { ok: false, reason: 'disabled' };
    return this.managementSelection(installationId);
  }

  private managementSelection(installationId: string): OperatorRegistryResult<ManagementExecutionSelection> {
    const installation = this.managementInstallation(installationId);
    if (!installation) return { ok: false, reason: 'not-found' };
    const state = this.managementState(installation.operatorId);
    if (!state) return { ok: false, reason: 'disabled' };
    const row = this.ctx.storage.sql.exec<{ data: string; manifest: string }>('SELECT data,manifest FROM operator_releases WHERE id=? AND operator_id=?', installation.releaseId ?? '', installation.operatorId).toArray()[0];
    if (!row || installation.approvedSourceRevision !== state.sourceRevision || !this.restrictivePolicy(installation.policy, state.policy)) return { ok: false, reason: 'artifact-unapproved' };
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

  /** REQ-OPERATOR-107 AC5: immutable original admissions across every connection revision.
   * The Root caller owns current management authorization; this inventory grants no execution authority.
   */
  async listManagementDispatcherAdmissions(installationId: string, workerName: string, after?: string): Promise<{
    items: Array<{ activityId: string; connection: DispatcherConnectionMetadata }>; next: string | null;
  }> {
    if (!scanId.test(installationId) || !workerName || workerName.length > 128
      || (after !== undefined && !scanId.test(after))) throw new ValidationError('Invalid Dispatcher admission inventory');
    this.managementSchema();
    const rows = this.ctx.storage.sql.exec<{ activity_id: string; connection: string }>(
      `SELECT activity_id,json_extract(data,'$.selection.installation.dispatcherConnection') AS connection
       FROM operator_admissions WHERE activity_id>?
       AND json_extract(data,'$.installationId')=?
       AND json_extract(data,'$.selection.installation.dispatcherConnection.workerName')=?
       ORDER BY activity_id LIMIT 33`, after ?? '', installationId, workerName).toArray();
    const items = rows.slice(0, 32).map(row => ({ activityId: row.activity_id,
      connection: JSON.parse(row.connection) as DispatcherConnectionMetadata }));
    return { items, next: rows.length > 32 ? items[items.length - 1].activityId : null };
  }

  /** Reconciliation is read-only and grants no new human authority. */
  async getManagementAdmission(activityId: string, observation?: ProspectiveObservationCapture): Promise<ManagementAdmissionReceipt | null> {
    const archive = this.prospectiveObservationCapture(observation);
    let loggingEnabled = false;
    const capture = archive && { ...archive, record: (stage: string, value: () => unknown) => {
      // Requests belong to the current observation; historical row/result/error payloads need their original policy first.
      if (!loggingEnabled && (stage === 'registry-management-admission-row'
        || stage === 'registry-management-admission-response' || stage === 'registry-management-admission-error')) {
        archive.record(stage, () => ({ omitted: 'original-logging-policy' }));
      } else archive.record(stage, value);
    } };
    try { return await captureRawInteraction(capture, 'registry-management-admission', () => ({ activityId }), async () => {
      this.managementSchema();
      const query = 'SELECT data FROM operator_admissions WHERE activity_id=?';
      capture?.record('registry-management-admission-query', () => ({ query, parameters: [activityId] }));
      const row = this.ctx.storage.sql.exec<{ data: string }>(query, activityId).toArray()[0];
      const receipt: ManagementAdmissionReceipt | null = row ? JSON.parse(row.data) : null;
      try { loggingEnabled = !receipt || receipt.selection.operator.policy.loggingEnabled !== false; }
      catch { /* An unreadable original policy cannot authorize optional historical payload retention. */ }
      capture?.record('registry-management-admission-row', () => row);
      return receipt;
    }); } finally { try { await archive?.finish('complete'); } catch { /* Preserve immutable ledger read. */ } }
  }

  /** Current local management/ledger proof. No callback to the waiting Activity. */
  private applicationStateCurrent(binding: RuntimeApplicationStateBinding): boolean {
    if (binding.principal !== 'operator' || binding.sourceId !== String(binding.sourceRepositoryId)
      || !Number.isSafeInteger(binding.generation) || binding.generation < 1
      || !binding.deliveryToken || binding.deadline <= Date.now()
      || binding.human.expiresAt * 1000 < binding.deadline) return false;
    const selected = this.managementExecution(binding.installationId);
    if (!selected.ok) return false;
    const { installation, operator, release, controlsRevision, manifestJson } = selected.value;
    if (!hasApplicationWorkflow(manifestJson) || operator.id !== binding.operatorId
      || operator.repositoryId !== binding.sourceRepositoryId || operator.revision !== binding.operatorRevision
      || installation.revision !== binding.installationRevision || release.id !== binding.releaseId
      || release.bundleDigest !== binding.bundleDigest || controlsRevision !== binding.controlsRevision
      || !canInvokeOperator(binding.human, operator)) return false;
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_admissions WHERE activity_id=?', binding.activityId).toArray()[0];
    if (!row) return false;
    const original = JSON.parse(row.data) as ManagementAdmissionReceipt;
    return original.installationId === binding.installationId && original.intentDigest === binding.intentDigest
      && Math.floor(original.deadline / 1000) * 1000 === binding.deadline
      && original.expectedInstallationRevision === binding.installationRevision
      && original.expectedOperatorRevision === binding.operatorRevision
      && original.expectedControlsRevision === binding.controlsRevision;
  }

  private coordinationScope(selection: ManagementExecutionSelection): ApplicationCoordinationScope | undefined {
    const manifest = JSON.parse(selection.manifestJson);
    const repositories = applicationWriteRepositories(manifest.application, JSON.parse(selection.installation.configurationJson)).sort();
    return repositories.length ? { operatorId: selection.operator.id, repositories } : undefined;
  }

  /** Trusted legacy codec: identities are validated privately; only actual public fields are copied. */
  private async legacyCoordination(value: unknown, key: string, sourceId: string,
    scope: ApplicationCoordinationScope | undefined, buckets?: Map<string, string>): Promise<ApplicationStateValue | undefined> {
    if (!scope) return undefined;
    const parsed = z.object({ activityId: z.string().regex(scanId), installationId: z.string().regex(scanId),
      ownerKey: z.string().regex(/^[a-f0-9]{64}$/), repositoryId: z.number().int().positive(),
      repository: z.string().optional(), baseBranch: z.string().optional(), pullRequest: z.number().int().positive(),
      head: z.string().regex(/^[a-f0-9]{40,64}$/), createdAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
      activatedAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
      operatorRevision: z.number().int().positive().optional(), installationRevision: z.number().int().positive().optional(),
      controlsRevision: z.number().int().nonnegative().optional(), releaseId: z.string().regex(scanId).optional(),
      bundleDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      admittedAt: z.number().int().positive().optional(), attempt: z.number().int().positive().optional(),
      actor: z.object({ subject: z.string(), issuer: z.string(), email: z.string().email(),
        audiences: z.array(z.string()), bucket: z.string(), registrationId: z.string(),
        sessionId: z.string(), sessionGeneration: z.number().int().nonnegative() }),
    }).safeParse(value);
    if (!parsed.success) return undefined;
    const record = parsed.data;
    const pinFields = ['repository', 'baseBranch', 'operatorRevision', 'installationRevision', 'controlsRevision', 'releaseId', 'bundleDigest'] as const;
    const presentPins = pinFields.filter(field => record[field] !== undefined);
    if (presentPins.length !== 0 && presentPins.length !== pinFields.length) return undefined;
    let repository = record.repository;
    if (repository === undefined) {
      // No historical repository-ID special cases: use only the original
      // immutable admission's declared configuration, never today's selection.
      const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_admissions WHERE activity_id=?', record.activityId).toArray()[0];
      const ledger = row ? JSON.parse(row.data) as ManagementAdmissionReceipt : null;
      if (!ledger || ledger.activityId !== record.activityId || ledger.installationId !== record.installationId
        || ledger.selection.operator.id !== scope.operatorId || String(ledger.selection.operator.repositoryId) !== sourceId
        || typeof ledger.selection.manifestJson !== 'string') return undefined;
      const originalScope = this.coordinationScope(ledger.selection);
      if (!originalScope || originalScope.repositories.length !== 1) return undefined;
      repository = originalScope.repositories[0];
    }
    const installation = this.managementInstallation(record.installationId);
    const operator = installation && this.managementState(installation.operatorId);
    if (!operator || operator.id !== scope.operatorId || String(operator.repositoryId) !== sourceId
      || !scope.repositories.includes(repository.toLowerCase())
      || key !== `renovate:head:${record.repositoryId}:${record.pullRequest}:${record.head}`
      || record.ownerKey !== await operatorOwnerKey(record.actor)
      || record.actor.bucket !== (buckets ? buckets.get(record.actor.email) : await resolveBucketName(this.env as Env, record.actor.email))) return undefined;
    const projection: Record<string, ApplicationStateValue> = { kind: 'legacy-admission', repositoryId: record.repositoryId,
      pullRequest: record.pullRequest, head: record.head, createdAt: record.createdAt, activatedAt: record.activatedAt };
    for (const field of ['repository', 'baseBranch', 'admittedAt', 'attempt'] as const) {
      if (record[field] !== undefined) projection[field] = record[field]!;
    }
    return projection;
  }

  private async coordinationInspection(storage: Pick<DurableObjectStorage, 'get'>, key: string,
    sourceId: string, ownerKey: string, scope: ApplicationCoordinationScope | undefined,
    privateLegacy: (value: Record<string, unknown>) => Promise<string | null> = async () => 'scope-unavailable',
    buckets?: Map<string, string>) {
    return inspectRecoveryRecord(storage, key, sourceId, ownerKey, privateLegacy, async (raw, legacy) => {
      if (legacy) return this.legacyCoordination(raw, key, sourceId, scope, buckets);
      if (raw.sourceId !== sourceId || !Object.hasOwn(raw, 'coordination')
        || !sameCoordinationScope(raw.coordinationScope as ApplicationCoordinationScope | undefined, scope)) return undefined;
      const installation = this.managementInstallation(raw.installationId as string);
      const operator = installation && this.managementState(installation.operatorId);
      if (!operator || operator.id !== scope!.operatorId || String(operator.repositoryId) !== sourceId) return undefined;
      return raw.coordination as ApplicationStateValue;
    });
  }

  private async applyCoordinationExecution(binding: RuntimeApplicationStateBinding,
    request: Extract<ApplicationExecutionRequest, { operation: 'read-coordination' | 'release-coordination' }>): Promise<unknown> {
    try {
      z.strictObject({ operation: z.enum(['read-coordination', 'release-coordination']),
        key: z.string().min(1).refine(key => new TextEncoder().encode(key).byteLength <= 1024),
        version: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request);
      const selected = this.managementSelection(binding.installationId);
      const scope = selected.ok ? this.coordinationScope(selected.value) : undefined;
      if (!scope || !this.applicationStateCurrent(binding) || binding.ownerKey !== await operatorOwnerKey(binding.human)) {
        return { status: 'unavailable' };
      }
      if (binding.delegation) {
        const raw = await (this.env as Env).KV.get(`user:${binding.human.email.trim().toLowerCase()}`);
        if (!raw || JSON.parse(raw).role !== 'admin') return { status: 'unavailable' };
      }
      const buckets = new Map<string, string>();
      const aliasKey = request.key.startsWith('renovate:head:') ? `renovate-admission:${request.key.slice('renovate:head:'.length)}` : null;
      if (aliasKey) {
        const alias = await this.ctx.storage.get<ProspectiveAdmission>(aliasKey);
        if (typeof alias?.actor?.email === 'string') buckets.set(alias.actor.email, await resolveBucketName(this.env as Env, alias.actor.email));
      }
      const inspect = async (storage: Pick<DurableObjectStorage, 'get'>) => {
        // Same live authorization and owner Activity fence as ordinary state.
        if (!this.applicationStateCurrent(binding) || binding.ownerKey !== await operatorOwnerKey(binding.human)) return null;
        const current = this.managementSelection(binding.installationId);
        if (!current.ok || !sameCoordinationScope(this.coordinationScope(current.value), scope)) return null;
        const summary = await storage.get<OperatorBrowserSummary>(`owner-activity:${binding.ownerKey}:${binding.activityId}`);
        if (!summary || summary.operatorId !== binding.operatorId || !['queued', 'running'].includes(summary.executionStatus)) return null;
        return this.coordinationInspection(storage, request.key, binding.sourceId, binding.ownerKey, scope, undefined, buckets);
      };
      const item = await inspect(this.ctx.storage);
      if (item?.record.reason === 'scope-unavailable') return { status: 'held', reason: 'scope-unavailable' };
      if (!item || !item.original || item.record.coordination === undefined) return { status: 'unavailable' };
      if (item.record.version !== request.version || item.raw?.recovery?.phase === 'vacant') return { status: 'conflict' };
      const original = item.original;
      const ledger = await this.getManagementAdmission(original.activityId);
      if (!ledger && !original.legacy) return { status: 'held', reason: 'ledger-unavailable' };
      const installation = ledger?.selection.installation ?? this.managementInstallation(original.installationId);
      const operator = ledger?.selection.operator ?? (installation && this.managementState(installation.operatorId));
      if (!operator || operator.id !== binding.operatorId || operator.repositoryId !== binding.sourceRepositoryId
        || ledger && (ledger.activityId !== original.activityId || ledger.installationId !== original.installationId)) return { status: 'unavailable' };
      const legacy = original.legacy ? z.object({ operatorRevision: z.number().int().positive(),
        installationRevision: z.number().int().positive(), controlsRevision: z.number().int().nonnegative(),
        releaseId: z.string().regex(scanId), bundleDigest: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(original.value) : null;
      const authority: ApplicationCoordinationAuthority = { version: 1, current: binding,
        original: { activityId: original.activityId, installationId: original.installationId, operatorId: operator.id,
          sourceRepositoryId: operator.repositoryId, ownerKey: original.ownerKey,
          ...(original.owner ? { owner: original.owner } : {}),
          binding: original.legacy ? 'legacy' : 'activity',
          pins: ledger ? { operatorRevision: ledger.expectedOperatorRevision,
            installationRevision: ledger.expectedInstallationRevision, controlsRevision: ledger.expectedControlsRevision,
            releaseId: ledger.selection.release.id, bundleDigest: ledger.selection.release.bundleDigest }
            : legacy?.success ? legacy.data : null,
          ...(item.raw?.originDelivery ? { delivery: item.raw.originDelivery, generation: item.raw.generation } : {}) },
        ledger: { ok: true, receipt: ledger } };
      const activity: {
        readRecoveryFacts(request: RecoveryFactsRequest): Promise<RecoveryFacts>;
        readApplicationCoordinationFacts(authority: ApplicationCoordinationAuthority): Promise<ApplicationCoordinationFacts>;
      } | undefined = (this.env as Env).OPERATOR_ACTIVITY?.getByName(original.activityId);
      if (!activity) return { status: 'unavailable' };
      const facts = async (): Promise<{ safe: ApplicationCoordinationFacts; origin?: { generation: number; deadline: number }; digest?: string }> => {
        if (item.raw?.originDelivery) {
          const response = await activity.readApplicationCoordinationFacts(authority);
          const safe: ApplicationCoordinationFacts = response.status === 'safe'
            && ['completed', 'failed', 'never-started'].includes(response.outcome)
            && response.fenced === true && response.noExternalWrites === true
            && Number.isSafeInteger(response.terminalAt) && response.terminalAt > 0 && response.terminalAt <= Date.now()
            ? { status: 'safe', outcome: response.outcome, terminalAt: response.terminalAt, fenced: true, noExternalWrites: true }
            : response.status === 'held' ? { status: 'held', reason: response.reason } : { status: 'unavailable' };
          if (safe.status !== 'unavailable') return { safe, origin: { generation: item.raw.generation, deadline: item.raw.deadline },
            digest: await recoveryDigest(JSON.stringify(safe)) };
        }
        const proof = await activity.readRecoveryFacts({ human: binding.human, deadline: binding.deadline,
          original: authority.original, ledger: authority.ledger });
        if (!proof.resettable) return { safe: { status: 'held', reason: proof.reason } };
        // A fenced no-write UNKNOWN attempt needs explicit abandonment, not an
        // automatic retry based on an invented failed settlement.
        if (proof.reason !== 'never-started') return { safe: { status: 'held', reason: 'explicit-recovery-required' } };
        const terminalAt = proof.origin.terminalAt;
        if (!Number.isSafeInteger(terminalAt) || terminalAt! <= 0 || terminalAt! > Date.now()) {
          return { safe: { status: 'held', reason: 'closure-time-unavailable' } };
        }
        return { safe: { status: 'safe', outcome: 'never-started',
          terminalAt: terminalAt!, fenced: true, noExternalWrites: true }, origin: proof.origin, digest: proof.proofDigest };
      };
      const proof = await facts();
      const current = await inspect(this.ctx.storage);
      if (!current || current.record.version !== request.version) return { status: 'conflict' };
      if (request.operation === 'read-coordination' || proof.safe.status !== 'safe') return proof.safe;
      const fresh = await facts();
      if (fresh.safe.status !== 'safe' || fresh.digest !== proof.digest) return { status: 'held', reason: 'facts-changed' };
      return await this.ctx.storage.transaction(async tx => {
        const latest = await inspect(tx);
        if (!latest || latest.record.version !== request.version) return { status: 'conflict' };
        const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM operator_admissions WHERE activity_id=?', original.activityId).toArray()[0];
        if (JSON.stringify(row ? JSON.parse(row.data) : null) !== JSON.stringify(ledger)) return { status: 'conflict' };
        const { version } = await releaseApplicationState(tx, latest, { sourceId: binding.sourceId, actorHash: binding.ownerKey,
          requestId: crypto.randomUUID(), proofDigest: fresh.digest!, origin: fresh.origin!, value: null, scope });
        if (!this.applicationStateCurrent(binding)) throw new Error('Authority changed');
        return { key: request.key, status: 'vacant', version };
      });
    } catch { return { status: 'unavailable' }; }
  }

  /** Keep recursive JSON opaque on the RPC surface; the owning adapter validates
   * actual data before any mutation. This is not a new storage or authority port. */
  async applyApplicationState(binding: RuntimeApplicationStateBinding, request: unknown): Promise<unknown> {
    return this.#applyApplicationState(binding, request as ApplicationStateRequest);
  }

  async #applyApplicationState(binding: RuntimeApplicationStateBinding, request: ApplicationStateRequest) {
    try {
      this.managementSchema();
      const keys = request.operation === 'read' ? request.keys : request.expected.map(entry => entry.key);
      let legacyOwnerBucket: string | undefined;
      if (keys.some(key => key.startsWith('renovate:head:'))) {
        if (binding.ownerKey !== await operatorOwnerKey(binding.human) || !this.applicationStateCurrent(binding)) {
          throw new ApplicationStateError('denied');
        }
        // Resolve through the existing collision-safe owner service, outside
        // storage transactions and without calling the waiting Activity back.
        legacyOwnerBucket = await resolveBucketName(this.env as Env, binding.human.email);
      }
      if (binding.ownerKey !== await operatorOwnerKey(binding.human) || !this.applicationStateCurrent(binding)) {
        throw new ApplicationStateError('denied');
      }
      const selected = this.managementSelection(binding.installationId);
      const coordinationScope = selected.ok ? this.coordinationScope(selected.value) : undefined;
      const legacyProjections = new Map<string, { encoded: string; projection: ApplicationStateValue }>();
      for (const key of keys) {
        if (!/^renovate:head:[1-9][0-9]*:[1-9][0-9]*:[a-f0-9]{40,64}$/.test(key)) continue;
        const value = await this.ctx.storage.get(`renovate-admission:${key.slice('renovate:head:'.length)}`);
        const projection = await this.legacyCoordination(value, key, binding.sourceId, coordinationScope);
        if (projection !== undefined) legacyProjections.set(key, { encoded: JSON.stringify(value), projection });
      }
      const base: ApplicationStateBinding = { sourceId: binding.sourceId, installationId: binding.installationId,
        ownerKey: binding.ownerKey, activityId: binding.activityId, generation: binding.generation, deadline: binding.deadline,
        ...(coordinationScope ? { coordinationScope } : {}),
        ...(binding.originDelivery ? { originDelivery: binding.originDelivery } : {}) };
      const store = new ApplicationStateStore(this.ctx.storage, base, {
        authorize: async () => {
          if (binding.ownerKey !== await operatorOwnerKey(binding.human) || !this.applicationStateCurrent(binding)) return false;
          if (binding.delegation) {
            const raw = await (this.env as Env).KV.get(`user:${binding.human.email.trim().toLowerCase()}`);
            const user: unknown = raw ? JSON.parse(raw) : null;
            if (!user || typeof user !== 'object' || !('role' in user) || user.role !== 'admin') return false;
          }
          return true;
        },
        validateSnapshot: async tx => {
          if (!this.applicationStateCurrent(binding)) return false;
          const selected = this.managementSelection(binding.installationId);
          if (!selected.ok || JSON.stringify(this.coordinationScope(selected.value)) !== JSON.stringify(coordinationScope)) return false;
          const summary = await tx.get<OperatorBrowserSummary>(`owner-activity:${binding.ownerKey}:${binding.activityId}`);
          return !!summary && summary.operatorId === binding.operatorId
            && ['queued', 'running'].includes(summary.executionStatus);
        },
        resolveLegacy: key => {
          // Historical format alias only. Application code interprets the payload;
          // ownership and source membership are checked before exposing any bytes.
          if (!key.startsWith('renovate:head:')) return null;
          const suffix = key.slice('renovate:head:'.length);
          if (!/^[1-9][0-9]*:[1-9][0-9]*:[a-f0-9]{40,64}$/.test(suffix)) return null;
          return { storageKey: `renovate-admission:${suffix}`,
            coordination: value => (value as { ownerKey: string }).ownerKey !== binding.ownerKey
              ? legacyProjections.get(key)?.projection : undefined,
            validate: value => {
              const prepared = legacyProjections.get(key);
              if (prepared?.encoded === JSON.stringify(value)) {
                const installation = this.managementInstallation((value as ProspectiveAdmission).installationId);
                const operator = installation && this.managementState(installation.operatorId);
                if (!operator || operator.id !== coordinationScope?.operatorId
                  || operator.repositoryId !== binding.sourceRepositoryId) return 'conflict';
                return 'owned';
              }
              if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unavailable';
              const record = value as Record<string, unknown>;
              if (typeof record.ownerKey !== 'string' || typeof record.installationId !== 'string'
                || typeof record.activityId !== 'string') return 'unavailable';
              if (record.ownerKey !== binding.ownerKey) return 'conflict';
              const installation = this.managementInstallation(record.installationId);
              const operator = installation && this.managementState(installation.operatorId);
              if (!operator || operator.repositoryId !== binding.sourceRepositoryId) return 'conflict';
              if (`${record.repositoryId}:${record.pullRequest}:${record.head}` !== suffix) return 'unavailable';
              const actor = record.actor;
              if (!actor || typeof actor !== 'object' || Array.isArray(actor)) return 'unavailable';
              const identity = actor as Record<string, unknown>;
              if (identity.bucket !== legacyOwnerBucket
                || identity.subject !== binding.human.subject || identity.issuer !== binding.human.issuer
                || typeof identity.email !== 'string' || identity.email.toLowerCase() !== binding.human.email.toLowerCase()
                || !Array.isArray(identity.audiences) || !identity.audiences.every(item => typeof item === 'string')
                || JSON.stringify([...identity.audiences].sort()) !== JSON.stringify([...binding.human.audiences].sort())) return 'unavailable';
              return 'owned';
            } };
        },
      });
      return request.operation === 'read' ? { entries: await store.read(request.keys) }
        : await store.compareExchange({ expected: request.expected, writes: request.writes });
    } catch (error) {
      const failure = error instanceof ApplicationStateError ? error : new ApplicationStateError('unavailable');
      return { error: { status: failure.status, code: `application-state-${failure.code}` } };
    }
  }

  /** Human-only recovery; no admission, scheduling, cancellation or SDK runtime calls. */
  async recoverApplication(input: { installationId: string; revision: number; human: VerifiedHumanAccessClaims;
    authority: ManagementAuthority; platformAdmin: boolean;
    operation: 'preview' | 'reset'; after?: string; scopeCursor?: string;
    requestId?: string; entries?: Array<{ key: string; version: string }> }): Promise<unknown> {
    this.managementSchema();
    const conflict = (): never => { throw new AppError('CONFLICT', 409, 'Application recovery conflict'); };
    const denied = (): never => { throw new AppError('NOT_FOUND', 404, 'Operator not found'); };
    const human = structuredClone(input.human);
    const ownerKey = await operatorOwnerKey(human);
    const selected = this.managementSelection(input.installationId);
    if (!selected.ok) return conflict();
    const selection = selected.value;
    const manifestValue = JSON.parse(selection.manifestJson);
    const { url: _artifactUrl, ...artifact } = manifestValue.artifact;
    const manifest = parseOperatorManifest(JSON.stringify({ ...manifestValue, artifact }), 'https://recovery.invalid');
    const descriptor = manifest.application?.recovery;
    if (!descriptor) return conflict();
    const currentLocal = (requireRevision = true) => {
      const latest = this.managementSelection(input.installationId);
      if (!latest.ok) return denied();
      if (Date.now() >= input.authority.expiresAt || human.expiresAt * 1000 <= Date.now()) denied();
      if (!input.platformAdmin && !canManageOperator(human, latest.value.operator, this.managementControls().managers)) denied();
      if (requireRevision && latest.value.installation.revision !== input.revision
        || latest.value.operator.revision !== input.authority.operatorRevision
        || latest.value.controlsRevision !== input.authority.controlsRevision
        || JSON.stringify(latest.value) !== JSON.stringify(selection)) conflict();
    };
    const current = async (requireRevision = true) => {
      currentLocal(requireRevision);
      if (input.platformAdmin) {
        const raw = await (this.env as Env).KV.get(`user:${human.email.trim().toLowerCase()}`);
        if (!raw || JSON.parse(raw).role !== 'admin') denied();
      }
      currentLocal(requireRevision);
    };
    // Inspecting an already-applied request requires current authority, but may
    // return its original result after an installation revision has changed.
    await current(false);
    const sourceId = String(selection.operator.repositoryId);
    const prefix = await applicationRecoveryPrefix(sourceId);
    const requestId = input.operation === 'reset' ? z.string().uuid().parse(input.requestId) : crypto.randomUUID();
    const entries = input.operation === 'reset' ? recoveryEntries.parse(input.entries) : [];
    const requestDigest = await recoveryDigest(JSON.stringify({ installationId: input.installationId,
      revision: input.revision, entries, scopeCursor: input.scopeCursor }));
    const requestKey = `${prefix}request:${await recoveryDigest(JSON.stringify([ownerKey, requestId]))}`;
    type Result = { requestId: string; reset: number; skipped: Array<{ key: string; reason: string }> };
    const replay = async (storage: Pick<DurableObjectStorage, 'get'>) => {
      const previous = await storage.get<{ digest: string; result: Result }>(requestKey);
      if (previous && previous.digest !== requestDigest) conflict();
      return previous?.result;
    };
    if (input.operation === 'reset') {
      const previous = await replay(this.ctx.storage);
      if (previous) return previous;
    }
    await current();
    const connection = await this.getManagementDispatcherConnection(input.installationId);
    if (!connection || connection.releaseId !== selection.release.id
      || connection.sourceCommit !== selection.release.sourceCommit || connection.bundleDigest !== selection.release.bundleDigest
      || connection.manifestDigest !== selection.release.manifestDigest
      || connection.compilerCommit !== selection.release.provenance.compilerCommit) return conflict();
    const ownerBucket = await resolveBucketName(this.env as Env, human.email);
    const coordinationScope = this.coordinationScope(selection);
    const buckets = new Map<string, string>();
    const inspect = async (storage: Pick<DurableObjectStorage, 'get'>, key: string) => {
      if (storage === this.ctx.storage && key.startsWith('renovate:head:')) {
        const alias = await storage.get<ProspectiveAdmission>(`renovate-admission:${key.slice('renovate:head:'.length)}`);
        if (typeof alias?.actor?.email === 'string') buckets.set(alias.actor.email, await resolveBucketName(this.env as Env, alias.actor.email));
      }
      return this.coordinationInspection(storage, key, sourceId, ownerKey, coordinationScope, async record => {
        if (typeof record.ownerKey !== 'string' || typeof record.installationId !== 'string' || typeof record.activityId !== 'string'
          || !record.actor || typeof record.actor !== 'object' || Array.isArray(record.actor)) return 'malformed';
        const actor = record.actor as Record<string, unknown>;
        if (typeof actor.subject !== 'string' || typeof actor.issuer !== 'string' || typeof actor.email !== 'string'
          || typeof actor.bucket !== 'string' || !Array.isArray(actor.audiences)
          || !actor.audiences.every(item => typeof item === 'string')) return 'malformed';
        // Closed failure categories only. Recompute internally using the unchanged
        // canonical algorithm; neither identity values nor hashes leave this gate.
        const canonical = await operatorOwnerKey({ subject: actor.subject, issuer: actor.issuer,
          email: actor.email, audiences: actor.audiences });
        if (record.ownerKey !== canonical) return 'legacy-owner-key-inconsistent';
        if (coordinationScope) {
          if (actor.bucket !== buckets.get(actor.email)) return 'legacy-owner-bucket-mismatch';
          const installation = this.managementInstallation(record.installationId);
          const operator = installation && this.managementState(installation.operatorId);
          if (!operator || operator.id !== coordinationScope.operatorId || String(operator.repositoryId) !== sourceId) return 'source-mismatch';
          if (key !== `renovate:head:${record.repositoryId}:${record.pullRequest}:${record.head}`) return 'malformed';
          if (typeof record.repository === 'string'
            && !coordinationScope.repositories.includes(record.repository.toLowerCase())) return 'work-repository-mismatch';
          // The codec could not prove historical scope. Requester identity cannot
          // supply that evidence or authorize private fallback/release.
          return 'scope-unavailable';
        }
        if (actor.subject !== human.subject || actor.issuer !== human.issuer) return 'legacy-owner-identity-mismatch';
        if (actor.email.toLowerCase() !== human.email.toLowerCase()) return 'legacy-owner-email-mismatch';
        if (JSON.stringify([...actor.audiences].sort()) !== JSON.stringify([...human.audiences].sort())) return 'legacy-owner-audience-mismatch';
        if (actor.bucket !== ownerBucket) return 'legacy-owner-bucket-mismatch';
        if (record.ownerKey !== ownerKey) return 'legacy-owner-identity-mismatch';
        const installation = this.managementInstallation(record.installationId);
        const operator = installation && this.managementState(installation.operatorId);
        return !operator || String(operator.repositoryId) !== sourceId ? 'source-mismatch' : null;
      }, buckets);
    };
    const originalLedgers = new Map<string, string>();
    const facts = async (item: RecoveryInspection): Promise<RecoveryFacts> => {
      if (!item.original || item.record.status !== 'owned') return { resettable: false, reason: item.record.reason };
      const original = item.original;
      const ledger = await this.getManagementAdmission(original.activityId);
      originalLedgers.set(original.activityId, JSON.stringify(ledger));
      const installation = this.managementInstallation(original.installationId);
      const operator = ledger?.selection.operator ?? (installation && this.managementState(installation.operatorId));
      if (!operator || String(operator.repositoryId) !== sourceId
        || item.record.coordination !== undefined && operator.id !== selection.operator.id
        || ledger && ledger.installationId !== original.installationId) return { resettable: false, reason: 'source-mismatch' };
      if (!ledger && !original.legacy) return { resettable: false, reason: 'ledger-unavailable' };
      const legacyPins = z.object({ operatorRevision: z.number().int().positive(), installationRevision: z.number().int().positive(),
        controlsRevision: z.number().int().nonnegative(), releaseId: z.string().regex(scanId), bundleDigest: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(original.value);
      const authority: RecoveryFactsRequest = { human, deadline: Math.min(human.expiresAt * 1000, input.authority.expiresAt),
        original: { activityId: original.activityId, installationId: original.installationId, operatorId: operator.id,
          sourceRepositoryId: operator.repositoryId, ownerKey: original.ownerKey,
          ...(original.owner ? { owner: original.owner } : {}),
          binding: original.legacy ? 'legacy' : 'activity',
          pins: ledger ? { operatorRevision: ledger.expectedOperatorRevision, installationRevision: ledger.expectedInstallationRevision,
            controlsRevision: ledger.expectedControlsRevision, releaseId: ledger.selection.release.id,
            bundleDigest: ledger.selection.release.bundleDigest } : legacyPins.success ? legacyPins.data : null,
          ...(item.raw?.originDelivery ? { delivery: item.raw.originDelivery, generation: item.raw.generation } : {}) },
        ledger: { ok: true, receipt: ledger } };
      const namespace = (this.env as Env).OPERATOR_ACTIVITY;
      if (!namespace) return { resettable: false, reason: 'facts-unavailable' };
      const activity = namespace.getByName(original.activityId);
      return activity.readRecoveryFacts(authority);
    };
    const ownedCandidates = async (keys: string[]) => {
      const owned: RecoveryInspection[] = [];
      for (const key of keys) {
        if (!key.startsWith(descriptor.prefix)) continue;
        const item = await inspect(this.ctx.storage, key);
        if (item.record.status === 'owned') owned.push(item);
      }
      return owned;
    };
    const selectScope = async (owned: RecoveryInspection[]) => {
      if (!owned.length) return undefined;
      const response = await callApplicationRecovery(this.env as Env, connection, 'scope', JSON.parse(selection.installation.configurationJson),
        owned.map(item => item.record), requestId, current);
      if (!response.scope) return undefined;
      const scope = response.scope;
      const anchor = owned.find(item => item.record.key === scope.anchorKey);
      if (!scope.prefix.startsWith(descriptor.prefix) || scope.prefix.length <= descriptor.prefix.length
        || !scope.anchorKey.startsWith(scope.prefix) || !anchor) return conflict();
      return { scope, anchor: { key: anchor.record.key, version: anchor.record.version } };
    };
    const progress = parseRecoveryCursor(input.operation === 'preview' ? input.after : input.scopeCursor);
    if (input.operation === 'reset' && input.scopeCursor !== undefined && progress.phase !== 'records') return conflict();
    let selectedScope: Awaited<ReturnType<typeof selectScope>>;
    let page: { keys: string[]; nextCursor: string | null };
    if (input.operation === 'preview' && progress.phase === 'scope') {
      const discovery = await recoveryInventoryPage(this.ctx.storage, sourceId, progress.after);
      selectedScope = await selectScope(await ownedCandidates(discovery.keys));
      if (!selectedScope) {
        await current();
        return { items: [], nextCursor: discovery.nextCursor
          ? JSON.stringify({ phase: 'scope', after: discovery.nextCursor }) : null };
      }
      // Earlier discovery pages disclosed no rows; traverse records once from
      // the beginning so conflicts preceding a late owned anchor are included.
      page = progress.after ? await recoveryInventoryPage(this.ctx.storage, sourceId) : discovery;
    } else {
      if (progress.phase === 'records') {
        const owned = await ownedCandidates([progress.anchor.key]);
        if (input.operation === 'preview' && owned[0]?.record.version !== progress.anchor.version) return conflict();
        selectedScope = await selectScope(owned);
      } else {
        // Direct reset callers can use their selected entries as scope witnesses.
        // The browser also retains its preview witness for malformed entries.
        selectedScope = await selectScope(await ownedCandidates(entries.map(item => item.key)));
      }
      if (!selectedScope) return conflict();
      page = input.operation === 'preview'
        ? await recoveryInventoryPage(this.ctx.storage, sourceId, progress.after)
        : { keys: entries.map(item => item.key), nextCursor: null };
    }
    const { scope, anchor } = selectedScope;
    const anchorVersion = anchor.version;
    const scopeCursor = JSON.stringify({ phase: 'records', anchor });
    const approvedScope = scope;
    const inspected: RecoveryInspection[] = [];
    const proofs = new Map<string, RecoveryFacts>();
    for (const key of page.keys) {
      if (!key.startsWith(scope.prefix)) {
        if (input.operation === 'reset') return conflict();
        continue;
      }
      const item = await inspect(this.ctx.storage, key);
      const proof = await facts(item);
      proofs.set(key, proof);
      if (item.record.status === 'owned') {
        item.record = { ...item.record, resettable: proof.resettable, reason: proof.reason,
          ...(item.record.coordination === undefined && proof.resettable && proof.invocation !== undefined ? { invocation: proof.invocation } : {}) };
      }
      inspected.push(item);
    }
    const response = inspected.length ? await callApplicationRecovery(this.env as Env, connection, 'reset', JSON.parse(selection.installation.configurationJson),
      inspected.map(item => item.record), requestId, current) : { items: [] };
    const choices = new Map(response.items.map(item => [item.key, item]));
    if (input.operation === 'preview') {
      await current();
      return { items: inspected.map(item => {
        const choice = choices.get(item.record.key);
        return { key: item.record.key, version: item.record.version, label: choice?.label ?? item.record.key,
          status: item.record.resettable && choice?.disposition === 'reset' ? 'resettable' : 'blocked',
          reason: item.record.resettable ? choice?.reason ?? 'package-declined' : item.record.reason };
      }), nextCursor: page.nextCursor ? JSON.stringify({ phase: 'records', anchor, after: page.nextCursor }) : null,
      scopeCursor };
    }
    // The old generation is already irreversibly fenced. Re-read its proof before
    // entering the local CAS transaction; the transaction never calls an actor.
    for (const item of inspected) {
      const original = proofs.get(item.record.key);
      if (original?.resettable) {
        const fresh = await facts(item);
        if (!fresh.resettable || fresh.proofDigest !== original.proofDigest) proofs.set(item.record.key, { resettable: false, reason: 'facts-changed' });
      }
    }
    await current();
    return this.ctx.storage.transaction(async tx => {
      currentLocal();
      const previous = await replay(tx);
      if (previous) return previous;
      const anchor = await inspect(tx, approvedScope.anchorKey);
      if (anchor.record.status !== 'owned' || anchor.record.version !== anchorVersion) return conflict();
      const result: Result = { requestId, reset: 0, skipped: [] };
      let bytes = 0;
      for (const entry of entries) {
        const old = inspected.find(item => item.record.key === entry.key)!;
        const latest = await inspect(tx, entry.key);
        const proof = proofs.get(entry.key);
        const choice = choices.get(entry.key);
        const ledgerRow = latest.original && this.ctx.storage.sql.exec<{ data: string }>(
          'SELECT data FROM operator_admissions WHERE activity_id=?', latest.original.activityId).toArray()[0];
        if (entry.version !== old.record.version || latest.record.version !== entry.version
          || latest.record.status !== 'owned' || !latest.original
          || JSON.stringify(ledgerRow ? JSON.parse(ledgerRow.data) : null) !== originalLedgers.get(latest.original.activityId)) { result.skipped.push({ key: entry.key, reason: 'version-or-owner-changed' }); continue; }
        if (!proof?.resettable || choice?.disposition !== 'reset' || choice.value === undefined) {
          result.skipped.push({ key: entry.key, reason: proof?.resettable ? choice?.reason ?? 'package-declined' : proof?.reason ?? 'facts-unavailable' }); continue;
        }
        const released = await releaseApplicationState(tx, latest, { sourceId, actorHash: ownerKey, requestId,
          proofDigest: proof.proofDigest, origin: proof.origin, value: choice.value, scope: coordinationScope });
        bytes += released.bytes;
        if (bytes > 1024 * 1024) return conflict();
        result.reset++;
      }
      currentLocal();
      await tx.put(requestKey, { digest: requestDigest, result });
      return result;
    });
  }

  /** Read/fence an original owned execution, never wake or observe an old SDK job. */
  async applyApplicationExecution(binding: RuntimeApplicationStateBinding, request: ApplicationExecutionRequest): Promise<unknown> {
    if (!('activityId' in request)) {
      return this.applyCoordinationExecution(binding, request);
    }
    const unavailable = () => ({ status: 'unavailable' as const, activityId: request.activityId });
    try {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.activityId) || request.activityId === binding.activityId
        || !/^[a-f0-9]{64}$/.test(request.version)) return unavailable();
      if (!['read', 'read-delivery', 'retire'].includes(request.operation)) return unavailable();
      const storageKey = `${await applicationRecoveryPrefix(binding.sourceId)}${await recoveryDigest(request.key)}`;
      const readCurrent = async () => {
        if (!this.applicationStateCurrent(binding)) return null;
        const read = await this.#applyApplicationState(binding, { operation: 'read', keys: [request.key] });
        if (!('entries' in read) || !read.entries) return null;
        const entry = read.entries[0];
        if (entry?.status !== 'value' || entry.version !== request.version) return null;
        // The public value is application-authored. Only the actual private
        // envelope, in this same current/version guard, can select a delivery.
        return this.ctx.storage.transaction(async tx => {
          if (!this.applicationStateCurrent(binding)) return null;
          const summary = await tx.get<OperatorBrowserSummary>(`owner-activity:${binding.ownerKey}:${binding.activityId}`);
          if (!summary || summary.operatorId !== binding.operatorId || !['queued', 'running'].includes(summary.executionStatus)) return null;
          const raw = await tx.get<import('./application-state').StateRecord>(storageKey);
          if (raw !== undefined) {
            if (await recoveryDigest(`record:${JSON.stringify(raw)}`) !== request.version
              || raw.schemaVersion !== 1 || raw.sourceId !== binding.sourceId || raw.key !== request.key
              || raw.ownerKey !== binding.ownerKey) return null;
          } else {
            if (request.operation === 'read-delivery' || !request.key.startsWith('renovate:head:')) return null;
            const aliasKey = `renovate-admission:${request.key.slice('renovate:head:'.length)}`;
            const alias = await tx.get(aliasKey);
            if (alias === undefined || await recoveryDigest(JSON.stringify(['legacy', binding.sourceId, request.key,
              { storageKey: aliasKey, version: await recoveryDigest(JSON.stringify(alias)) }])) !== request.version) return null;
          }
          return this.applicationStateCurrent(binding) ? { entry, raw } : null;
        });
      };
      const current = await readCurrent();
      if (!current) return { status: 'conflict' as const, activityId: request.activityId };
      const { entry, raw: actualStateRecord } = current;
      const value = entry.value;
      if (request.operation === 'read-delivery') {
        if (!actualStateRecord || actualStateRecord.activityId !== request.activityId
          || !actualStateRecord.originDelivery) return unavailable();
      } else if (!value || typeof value !== 'object' || Array.isArray(value) || value.activityId !== request.activityId) return unavailable();
      const ledger = await this.getManagementAdmission(request.activityId);
      let legacy: Record<string, unknown> | undefined;
      if (request.key.startsWith('renovate:head:')) {
        const key = `renovate-admission:${request.key.slice('renovate:head:'.length)}`;
        const original = await this.ctx.storage.get<Record<string, unknown>>(key);
        if (original && JSON.stringify(original) === JSON.stringify(value)) legacy = original;
      }
      // Only a verified immutable legacy record may prove a never-admitted ID.
      // An application-written activityId is not authority over an absent Activity.
      if (!ledger && !legacy) return unavailable();
      if (request.operation === 'read-delivery' && (!ledger || actualStateRecord?.installationId !== ledger.installationId)) return unavailable();
      const installationId = ledger?.installationId ?? legacy?.installationId;
      if (typeof installationId !== 'string' || request.operation === 'retire' && installationId !== binding.installationId) return unavailable();
      const installation = request.operation === 'read-delivery' && ledger
        ? ledger.selection.installation : this.managementInstallation(installationId);
      const operator = ledger?.selection.operator ?? (installation && this.managementState(installation.operatorId));
      if (!installation || !operator || operator.repositoryId !== binding.sourceRepositoryId) return unavailable();
      if (request.operation === 'read-delivery' && (ledger!.activityId !== request.activityId
        || installation.id !== installationId || installation.operatorId !== operator.id
        || ledger!.selection.release.operatorId !== operator.id)) return unavailable();
      const pins = ledger ? {
        operatorRevision: ledger.expectedOperatorRevision, installationRevision: ledger.expectedInstallationRevision,
        controlsRevision: ledger.expectedControlsRevision, releaseId: ledger.selection.release.id,
        bundleDigest: ledger.selection.release.bundleDigest,
      } : null;
      const legacyPins = !pins && legacy ? z.object({ operatorRevision: z.number().int().positive(),
        installationRevision: z.number().int().positive(), controlsRevision: z.number().int().nonnegative(),
        releaseId: z.string().regex(scanId), bundleDigest: z.string().regex(/^[a-f0-9]{64}$/) }).safeParse(legacy) : null;
      const authority: ApplicationExecutionAuthority = { version: 1, current: binding,
        original: { activityId: request.activityId, installationId, operatorId: operator.id,
          sourceRepositoryId: operator.repositoryId, ownerKey: binding.ownerKey,
          owner: { subject: binding.human.subject, email: binding.human.email, issuer: binding.human.issuer,
            audiences: [...binding.human.audiences] }, binding: legacy ? 'legacy' : 'activity',
          pins: pins ?? (legacyPins?.success ? legacyPins.data : null),
          ...(request.operation === 'read-delivery' ? { delivery: actualStateRecord!.originDelivery!,
            generation: actualStateRecord!.generation } : {}) },
        ledger: { ok: true, receipt: ledger } };
      // Only the current immutable admission may enable observation. This flag
      // is not original policy and never grants execution or historical capture.
      try {
        const current = await this.getManagementAdmission(binding.activityId);
        const logging = current?.selection.operator.policy.loggingEnabled;
        authority.observationLoggingEnabled = !!current && (logging === undefined || logging === true);
      } catch { /* Unproven observation policy withholds capture, not execution facts. */ }
      // Actual JSON is validated by the owning Activity. Keep opaque payloads
      // behind a narrow RPC port instead of recursively mapping their type graph.
      const activity: {
        readApplicationExecutionFacts(authority: ApplicationExecutionAuthority): Promise<ApplicationExecutionFacts>;
        retireApplicationExecution(authority: ApplicationExecutionAuthority): Promise<ApplicationExecutionRetirement>;
      } | undefined = (this.env as Env).OPERATOR_ACTIVITY?.getByName(request.activityId);
      if (!activity) return unavailable();
      if (!await readCurrent()) return { status: 'conflict' as const, activityId: request.activityId };
      const facts = await activity.readApplicationExecutionFacts(authority);
      if (!await readCurrent()) return { status: 'conflict' as const, activityId: request.activityId };
      if (request.operation === 'read-delivery') return facts.status === 'delivery' ? facts : unavailable();
      if (request.operation === 'read') {
        if (facts.status === 'never-started') return { status: 'value' as const, activityId: request.activityId, terminal: null };
        if (facts.status !== 'value') return unavailable();
        const { status: _status, activityId: _activityId, ...terminal } = facts;
        return { status: 'value' as const, activityId: request.activityId, terminal };
      }
      if (facts.status !== 'never-started') return { status: 'held' as const, activityId: request.activityId };
      const result = await activity.retireApplicationExecution({ ...authority, proofVersion: facts.proofVersion });
      if (!await readCurrent()) return { status: 'conflict' as const, activityId: request.activityId };
      return { status: result.status, activityId: request.activityId };
    } catch { return unavailable(); }
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
  async upsertOwnedActivity(ownerKey: string, summary: OperatorBrowserSummary,
    observed?: OperatorBrowserSummary): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(ownerKey) || !/^[A-Za-z0-9_-]{1,128}$/.test(summary.activityId)) return;
    await this.ctx.storage.transaction(async tx => {
      const indexKey = `owner-activities:${ownerKey}`;
      const summaryKey = `owner-activity:${ownerKey}:${summary.activityId}`;
      const countKey = `owner-working-count:${ownerKey}`;
      const current = await tx.get<string[]>(indexKey) ?? [];
      const prior = await tx.get<OperatorBrowserSummary>(summaryKey);
      if (observed) {
        if (!prior) return;
        // Refresh only the row actually observed, including when publications share a timestamp.
        const fields = Object.keys({ ...prior, ...observed }) as (keyof OperatorBrowserSummary)[];
        if (fields.some(key => key === 'resultSummary'
          ? (['assessed', 'merged', 'notMerged', 'deferred', 'unknown'] as const)
            .some(field => prior.resultSummary?.[field] !== observed.resultSummary?.[field])
          : key === 'inferenceSelection' || key === 'authFailure'
            ? JSON.stringify(prior[key]) !== JSON.stringify(observed[key])
            : prior[key] !== observed[key])) return;
      }
      let count = await tx.get<number>(countKey);
      if (count === undefined) {
        // Existing owner summaries may outlive the 100-entry display index. Rebuild once,
        // then maintain the count transactionally across subsequent evictions and updates.
        count = 0;
        let startAfter: string | undefined;
        for (;;) {
          const saved = await tx.list<OperatorBrowserSummary>({ prefix: `owner-activity:${ownerKey}:`, limit: 256,
            ...(startAfter ? { startAfter } : {}) });
          for (const item of saved.values()) if (workingActivity(item.executionStatus)) count++;
          if (saved.size < 256) break;
          startAfter = [...saved.keys()].at(-1);
        }
      }
      const wasWorking = prior ? workingActivity(prior.executionStatus) : false;
      const isWorking = workingActivity(summary.executionStatus);
      if (wasWorking !== isWorking) count += isWorking ? 1 : -1;
      // Status updates do not change admission order, even after a row leaves the index.
      if (prior) {
        await tx.put(summaryKey, structuredClone(summary));
        await tx.put(countKey, count);
        return;
      }
      // Retain at most 20 visible rows per operator.
      const candidates = [summary.activityId, ...current];
      const seen = new Map<string, number>();
      const ids: string[] = [];
      for (const id of candidates) {
        const item = id === summary.activityId ? summary
          : await tx.get<OperatorBrowserSummary>(`owner-activity:${ownerKey}:${id}`);
        if (!item) continue;
        const size = seen.get(item.operatorId) ?? 0;
        if (size >= 20) continue;
        seen.set(item.operatorId, size + 1);
        ids.push(id);
        if (ids.length === 100) break;
      }
      if (!prior) {
        const sequence = (await tx.get<number>(`owner-admissions:${ownerKey}`) ?? 0) + 1;
        await tx.put(`owner-admissions:${ownerKey}`, sequence);
      }
      await tx.put(indexKey, ids);
      await tx.put(summaryKey, structuredClone(summary));
      await tx.put(countKey, count);
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
    const counts = new Map<string, number>();
    return [...uncertain, ...existing].filter(item => {
      const count = counts.get(item.operatorId) ?? 0;
      if (count >= 20) return false;
      counts.set(item.operatorId, count + 1);
      return true;
    }).slice(0, 100);
  }

  /** Reading the dropdown acknowledges only the admissions observed by that browser. */
  async acknowledgeOwnedActivities(ownerKey: string, through: number): Promise<{ unreadCount: number }> {
    if (!/^[0-9a-f]{64}$/.test(ownerKey) || !Number.isSafeInteger(through) || through < 0) return { unreadCount: 0 };
    return this.ctx.storage.transaction(async tx => {
      const latest = await tx.get<number>(`owner-admissions:${ownerKey}`) ?? 0;
      const key = `owner-admissions-read:${ownerKey}`;
      const seen = await tx.get<number>(key) ?? 0;
      const read = Math.max(seen, Math.min(through, latest));
      await tx.put(key, read);
      return { unreadCount: Math.max(0, latest - read) };
    });
  }

  /** Cursor names the last seen row in this owner's retained browsing index. */
  async listOwnedActivityPage(ownerKey: string, after: string | null): Promise<{
    items: OperatorBrowserSummary[]; nextCursor: string | null; workingCount: number;
    unreadCount: number; latestSequence: number }> {
    // Bound acknowledgment to admissions known before collecting this page.
    const latestSequence = await this.ctx.storage.get<number>(`owner-admissions:${ownerKey}`) ?? 0;
    const items = await this.listOwnedActivities(ownerKey);
    const position = after === null ? 0 : items.findIndex(item => item.activityId === after) + 1;
    if (after !== null && position === 0) throw new Error('Activity history changed');
    const page = items.slice(position, position + 5);
    const savedCount = await this.ctx.storage.get<number>(`owner-working-count:${ownerKey}`);
    const lastRead = await this.ctx.storage.get<number>(`owner-admissions-read:${ownerKey}`) ?? 0;
    const indexedWorking = items.filter(item => workingActivity(item.executionStatus)).length;
    return { items: page, nextCursor: position + 5 < items.length ? page.at(-1)!.activityId : null,
      workingCount: Number.isSafeInteger(savedCount) && savedCount! >= 0
        ? Math.max(savedCount!, indexedWorking) : indexedWorking,
      unreadCount: Math.max(0, latestSequence - lastRead), latestSequence };
  }

  private applicationScheduleContext(): Parameters<typeof runApplicationSchedules>[0] {
    return { storage: this.ctx.storage, env: this.env as Env,
      resolve: installationId => this.resolveManagementExecution(installationId),
      waitUntil: work => this.ctx.waitUntil(work), runtimeContext: this.ctx };
  }

  async activateApplicationSchedule(input: { installationId: string; revision: number; authority: OperatorExecutionAuthority }) {
    return activateSchedule(this.applicationScheduleContext(), input);
  }

  async applicationScheduleStatus(installationId: string, ownerKey: string) {
    return scheduleStatus(this.applicationScheduleContext(), installationId, ownerKey);
  }

  async alarm(): Promise<void> {
    await runApplicationSchedules(this.applicationScheduleContext());
  }

  private prospectiveObservationCapture(observation?: ProspectiveObservationCapture): (RawCapture & { binding: RawCaptureBinding }) | undefined {
    if (observation?.loggingEnabled !== true || observation.binding.scope.kind !== 'observation') return;
    try {
    const { registrationId } = observation;
    const binding = { ...observation.binding, captureId: crypto.randomUUID() };
    let authorized = false;
    const capture = createRawCapture({ enabled: true, binding,
      storage: () => createOwnerRawCaptureStorage(this.env as Env, this.ctx.storage, async () => {
        // Pin provenance before the first protected write. Later supersession does not erase
        // already observed evidence or transfer its owner; this confers no execution authority.
        if (authorized) return;
        const record = await this.ctx.storage.get<ProspectiveRegistration>(`renovate-registration:${registrationId}`);
        if (!record || record.ownerKey !== binding.ownerKey || record.installationId !== binding.installationId
          || record.releaseId !== binding.releaseId) throw Error('Raw observation owner unavailable');
        authorized = true;
      }), schedule: work => this.ctx.waitUntil(work) });
    capture.record('observation-parent', () => observation);
    return { ...capture, binding, finish: async termination => {
      const receipt = await capture.finish(termination);
      if (receipt.status !== 'complete') try {
        console.log(JSON.stringify({ module: 'operator-execution', message: 'raw-capture-incomplete',
          data: { captureId: binding.captureId, parentCaptureId: observation.binding.captureId, status: 'incomplete' } }));
      } catch { /* Original outcomes do not depend on delivery acknowledgement. */ }
      return receipt;
    } };
    } catch { return; } // Setup cannot replace a business result or error.
  }

  /** Private observation reads belong to Registry, including Actor-relayed pre-admission evidence. */
  async readOwnerRawCaptures(credential: OwnerRawReadCredential, input: OwnerRawReadRequest): Promise<Response> {
    try {
      const request = parseOwnerRawReadRequest(input);
      const reader = await requireOwnerRawReader(this.env as Env, credential);
      if (request.scope.kind !== 'observation') return ownerRawReadUnavailable();
      // Authenticated encrypted locators pin historical provenance. No current registration,
      // Activity admission, execution authority or mutable logging setting is consulted.
      const storage = await createOwnerRawCaptureStorage(this.env as Env, this.ctx.storage, reader.guard);
      return await readOwnerRawCapturePage({ request, ownerKey: reader.ownerKey,
        storage: { ...storage, authorizePass: reader.authorize } });
    } catch { return ownerRawReadUnavailable(); }
  }

  /** Trusted Root-only persistence for pre-admission observations; never an installed SDK/browser capability. */
  async retainRawObservation(input: { binding: RawCaptureBinding; records: Array<{ stage: string; value: unknown }>;
    termination: RawCaptureReceipt['termination']; failed: boolean; observation?: ProspectiveObservationCapture }): Promise<RawCaptureReceipt> {
    if (input.binding.scope.kind !== 'observation') throw new Error('Raw observation unavailable');
    // Existing authenticated route callers own their binding. Reconciliation relays additionally
    // prove their parent registration, and each batch gets its own immutable child archive.
    const capture = input.observation ? this.prospectiveObservationCapture(input.observation)
      : createRawCapture({ enabled: true, binding: input.binding,
        storage: () => createOwnerRawCaptureStorage(this.env as Env, this.ctx.storage, async () => {}),
        schedule: work => this.ctx.waitUntil(work) });
    if (!capture) throw new Error('Raw observation unavailable');
    for (const record of input.records) capture.record(record.stage, () => record.value);
    const receipt = await capture.finish(input.termination);
    return input.failed ? { ...receipt, status: 'incomplete' } : receipt;
  }

  /** Legacy RPC compatibility is refusal-only. Application policy now runs in its package. */
  async activateProspectiveRenovate(_input: unknown): Promise<
    { ok: true; activatedAt: string; registrationId: string } | { ok: false; reason: string }> {
    return { ok: false, reason: 'application-upgrade-required' };
  }
  async prospectiveRenovateStatus(_installationId: string, _ownerKey: string): Promise<'inactive'> { return 'inactive'; }
  async observeProspectiveRenovateRegistration(_registrationId: string, _observation?: ProspectiveObservationCapture): Promise<ProspectiveRegistrationObservation> {
    return { status: 'denied' };
  }
  async currentProspectiveRenovateRegistration(_registrationId: string, _observation?: ProspectiveObservationCapture): Promise<CurrentProspectiveRegistration | null> { return null; }
  async reserveProspectiveRenovateActivity(_input: unknown, _observation?: ProspectiveObservationCapture): Promise<
    { ok: true; activityId: string; actor: ProspectiveAdmission['actor'] } | { ok: false; reason: string }> {
    return { ok: false, reason: 'application-upgrade-required' };
  }
  async retainedProspectiveRenovateRetryTargets(_registrationId: string, _observation?: ProspectiveObservationCapture): Promise<LegacyRetryTarget[]> { return []; }

  async readProspectiveRenovateAdmission(activityId: string, observation?: ProspectiveObservationCapture): Promise<ProspectiveAdmission | null> {
    const capture = this.prospectiveObservationCapture(observation);
    capture?.record('registry-original-admission-request', () => ({ key: `renovate-activity:${activityId}` }));
    if (!scanId.test(activityId)) {
      try { await capture?.finish('complete'); } catch { /* Preserve invalid-ID refusal. */ }
      return null;
    }
    const trace = (outcome: 'started' | 'completed' | 'failed', proofPresent?: boolean, error?: unknown) => {
      try {
        createLogger('operator-registry').info('Prospective Renovate admission boundary', {
          boundary: 'registry-proof-storage', outcome,
          admissionDigest: hashDiagnostic(JSON.stringify(['prospective-renovate-admission:v1', activityId])),
          ...(outcome === 'completed' ? { proofPresent } : {}),
          ...(outcome === 'failed' ? { error: captureError(error) } : {}),
        });
      } catch { /* Diagnostic hashing/capture/logging cannot change the proof read. */ }
    };
    trace('started');
    try {
      const proof = await this.ctx.storage.get<ProspectiveAdmission>(`renovate-activity:${activityId}`) ?? null;
      capture?.record('registry-original-admission-response', () => !proof || proof.ownerKey === observation?.binding.ownerKey ? proof : { foreignOwner: true });
      trace('completed', !!proof);
      return proof;
    } catch (error) {
      capture?.record('registry-original-admission-error', () => error);
      trace('failed', undefined, error);
      throw error;
    } finally { try { await capture?.finish('complete'); } catch { /* Preserve proof or original error. */ } }
  }

  async getOwnedActivity(ownerKey: string, activityId: string): Promise<OperatorBrowserSummary | null> {
    if (!/^[0-9a-f]{64}$/.test(ownerKey) || !/^[A-Za-z0-9_-]{1,128}$/.test(activityId)) return null;
    return await this.ctx.storage.get<OperatorBrowserSummary>(`owner-activity:${ownerKey}:${activityId}`) ?? null;
  }
}
