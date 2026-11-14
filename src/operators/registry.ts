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
import { ValidationError } from '../lib/error-types';
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
import { z } from 'zod';
import { SETUP_KEYS } from '../lib/kv-keys';
import { canInvokeOperator, observeOperatorAccessIdentity, parseAccessGroups } from '../lib/access';
import { listProspectiveRenovatePrs } from './renovate-prospective';
import { createRawCapture, createOwnerRawCaptureStorage, captureRawInteraction, captureRawTransaction, type RawCapture, type RawCaptureBinding, type RawCaptureReceipt } from './raw-capture-storage';
import { bindOperatorRuntimeCapability, prepareOperatorActivity, runOperatorActivity } from './orchestrator';
import { captureError, hashDiagnostic, activityRpcReceiverDigest } from './dispatcher-diagnostics-wire';
import type { FailureObservation } from './dispatcher-diagnostics-store';
import { D1SessionRepository } from '../lib/session-repository';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { createOperatorExecutionContext, openOperatorExecutionAccess,
  type OperatorExecutionContext } from './execution-context';
import { operatorOwnerKey } from './browser-activity';
import type { Env } from '../types';
import { requireOwnerRawReader, parseOwnerRawReadRequest, readOwnerRawCapturePage, ownerRawReadUnavailable,
  type OwnerRawReadCredential, type OwnerRawReadRequest } from './raw-capture-read';

import { parseRenovateRunSettings, renovateRepositoryIdentity, prospectiveRenovatePackageSupported,
  type RenovateRunSettings, type RenovateRepositoryIdentity } from './renovate-run-settings';
export { prospectiveRenovatePackageSupported } from './renovate-run-settings';
import { prospectiveRenovateRetryProof,
  type ProspectiveRenovateRetryProof,
  type RetainedRenovateRetryTarget } from './renovate-retry-proof';
const scanId = /^[A-Za-z0-9_-]{1,128}$/;
const sha = /^[0-9a-f]{40}$/;
const scanSession = /^[a-z0-9]{8,24}$/;
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


/** GitHub UTC seconds and parent UTC milliseconds denote the same canonical instant. */
export function prospectiveRenovateTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  const milliseconds = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  return Number.isFinite(time) && new Date(time).toISOString() === milliseconds ? time : null;
}

interface ProspectiveSelectionPin {
  controlsRevision: number; installationRevision: number; operatorRevision: number; releaseId: string; bundleDigest: string;
}
interface ProspectiveActivation extends RenovateRepositoryIdentity { installationId: string; activatedAt: string }
export const dispatcherDelegationSchema = z.strictObject({ version: z.literal(1),
  routingGroups: z.array(z.string().min(1).max(256)).max(1024) });
export type DispatcherDelegation = z.infer<typeof dispatcherDelegationSchema>;
interface ProspectiveRegistration extends RenovateRepositoryIdentity, ProspectiveSelectionPin {
  scope?: 'installation'; nextObservationAt?: number; delegation?: DispatcherDelegation;
  registrationId: string; installationId: string; ownerKey: string; bucket: string; sessionId: string;
  sessionGeneration: number; revision: number; context: OperatorExecutionContext; repetitionIntervalSeconds: number;
}
export interface ProspectiveAdmission extends RenovateRepositoryIdentity, ProspectiveSelectionPin {
  activityId: string; installationId: string; admittedAt?: number; attempt?: number; previousActivityId?: string;
  pullRequest: number; head: string; createdAt: string; activatedAt: string; ownerKey: string;
  actor: { registrationId: string; bucket: string; sessionId: string; sessionGeneration: number;
    subject: string; issuer: string; email: string; audiences: readonly string[] };
}
const persistedProspectiveIdentity = z.object({ activityId: z.string().regex(scanId), installationId: z.string().regex(scanId),
  repositoryId: z.number().int().positive().safe(), pullRequest: z.number().int().positive().safe(), head: z.string().regex(sha),
  createdAt: z.string(), activatedAt: z.string(), ownerKey: z.string().regex(/^[0-9a-f]{64}$/),
  actor: z.object({ registrationId: z.string().regex(scanId), bucket: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    sessionId: z.string(), sessionGeneration: z.number().int().nonnegative().safe(),
    subject: z.string().min(1), issuer: z.string().min(1), email: z.string().min(1), audiences: z.array(z.string().min(1)).min(1) }),
});
const persistedProspectivePins = z.object({ ...renovateRepositoryIdentity.shape,
  controlsRevision: z.number().int().nonnegative().safe(), installationRevision: z.number().int().positive().safe(),
  operatorRevision: z.number().int().positive().safe(), releaseId: z.string().regex(scanId),
  bundleDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
/** The two source-proven persisted layouts; absence is not permission to fill partial pins. */
export function prospectiveAdmissionLayout(value: ProspectiveAdmission): 'legacy' | 'pinned' | null {
  if (!persistedProspectiveIdentity.safeParse(value).success) return null;
  const created = prospectiveRenovateTimestamp(value.createdAt), cutoff = prospectiveRenovateTimestamp(value.activatedAt);
  if (created === null || cutoff === null || created <= cutoff
    || !(value.actor.sessionId === '' && value.actor.sessionGeneration === 0
      || scanSession.test(value.actor.sessionId) && value.actor.sessionGeneration > 0)
    || Object.hasOwn(value, 'admittedAt') && (!Number.isSafeInteger(value.admittedAt) || value.admittedAt! <= 0)
    || Object.hasOwn(value, 'attempt') && (!Number.isSafeInteger(value.attempt) || value.attempt! < 1)
    || Object.hasOwn(value, 'previousActivityId') && (typeof value.previousActivityId !== 'string' || !scanId.test(value.previousActivityId))) return null;
  const pinKeys = ['repository', 'baseBranch', 'controlsRevision', 'installationRevision', 'operatorRevision', 'releaseId', 'bundleDigest'];
  if (pinKeys.every(key => !Object.hasOwn(value, key))) {
    // 2160810c used this fixed numeric repository, session authority and no reservation timestamp.
    return value.repositoryId === 973175879 && scanSession.test(value.actor.sessionId)
      && !['admittedAt', 'attempt', 'previousActivityId'].some(key => Object.hasOwn(value, key)) ? 'legacy' : null;
  }
  return persistedProspectivePins.safeParse(value).success ? 'pinned' : null;
}
/** Root-only data carrier: retention provenance, never execution or renewal authority. */
export interface ProspectiveObservationCapture {
  registrationId: string;
  binding: RawCaptureBinding;
  parentCaptureId?: string;
  loggingEnabled?: boolean;
}
export interface CurrentProspectiveRegistration extends RenovateRepositoryIdentity, ProspectiveSelectionPin {
  scope?: 'installation'; delegation?: DispatcherDelegation;
  registrationId: string; installationId: string; activatedAt: string; bucket: string;
  sessionId: string; sessionGeneration: number; human: VerifiedHumanAccessClaims; accessJwt: string; repetitionIntervalSeconds: number;
  /** Parent-validated original policy; an absent older RPC field never enables capture. */
  loggingEnabled?: boolean;
}
export type ProspectiveRegistrationObservation =
  | { status: 'current'; registration: CurrentProspectiveRegistration }
  | { status: 'unavailable' } | { status: 'denied' };
type ProspectiveAuthorityObservation =
  | { status: 'current'; authority: { human: VerifiedHumanAccessClaims; accessJwt: string }; loggingEnabled: boolean; routingGroups?: string[] }
  | { status: 'unavailable' } | { status: 'denied' };
interface ProspectiveObservationDiagnostic {
  outcome: 'authority-denied' | 'authority-unavailable' | 'claim-lost' | 'binding-unavailable'
    | 'discovery-failure' | 'observed' | 'stale-authority' | 'observation-failure' | 'handoff-failure';
  stage: 'authority' | 'claim' | 'binding' | 'discovery' | 'reservation' | 'handoff';
  candidates: number; reservationDenied: number; retainedOtherRegistration: number;
  /** An existing reservation is not proof of a safe retry or a quarantined Activity. */
  retainedExisting: number; handoffAttempts: number;
  error?: ReturnType<typeof captureError>;
  failureStage?: 'authority' | 'plan' | 'preparation' | 'detail' | 'binding' | 'drive';
  admissionDigest?: string;
  receiverDigest?: string;
}
class ProspectiveDependencyUnavailable extends Error {}
/** Only failures of dependency I/O, never malformed data or denied selections. */
async function observeDependency<T>(read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError || error instanceof TypeError
      || error instanceof RangeError || error instanceof ReferenceError
      || error instanceof Error && ['ForbiddenError', 'ZodError'].includes(error.name)) throw error;
    throw new ProspectiveDependencyUnavailable();
  }
}
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
        const manifest = JSON.parse(row.manifest) as { name?: unknown; description?: unknown };
        if (typeof manifest.name !== 'string' || typeof manifest.description !== 'string') throw new ValidationError('Operator description unavailable');
        return { ...JSON.parse(row.data) as ManagementRelease, name: manifest.name, description: manifest.description };
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

  private managementConfiguration(input: string, renovate = false): string {
    if (new TextEncoder().encode(input).byteLength > 64 * 1024) throw new ValidationError('Installation configuration exceeds the size limit');
    try {
      const parsed = JSON.parse(input) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      if (renovate) parseRenovateRunSettings(input);
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
        enabled: false, policy, configurationJson: this.managementConfiguration(configurationJson, state!.profile === 'dispatcher' && state!.repositoryUrl.replace(/\.git$/i, '').toLowerCase() === 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher'), approvedSourceRevision: null };
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
      const value: ManagementInstallation = { ...inherited, ...(input.piReasoningOverride !== undefined && { piReasoningOverride: input.piReasoningOverride }), policy, configurationJson: this.managementConfiguration(input.configurationJson, state!.profile === 'dispatcher' && state!.repositoryUrl.replace(/\.git$/i, '').toLowerCase() === 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher'), revision: installation.revision + 1, enabled: false };
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

  private async observeProspectiveAuthority(registration: ProspectiveRegistration, captureRoutingGroups = false,
    trace?: { observation?: ProspectiveObservationCapture; capture?: RawCapture }): Promise<ProspectiveAuthorityObservation> {
    trace?.capture?.record('registry-authority-request', () => ({ registration, captureRoutingGroups }));
    const result = await (async (): Promise<ProspectiveAuthorityObservation> => {
    const app = this.env as Env;
    const expiresAt = registration.context?.expiresAt;
    if (registration.scope === 'installation' && !registration.nextObservationAt
      || !Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= Date.now()
      || !app.USAGE_DB || !app.KV) return { status: 'denied' };
    try {
      // Presence is intentional: corrupt/unsupported metadata cannot downgrade to live authority.
      const delegation = Object.hasOwn(registration, 'delegation')
        ? dispatcherDelegationSchema.parse(registration.delegation) : undefined;
      if (delegation && (registration.scope !== 'installation' || registration.sessionId !== ''
        || registration.sessionGeneration !== 0)) return { status: 'denied' };
      const authority = await captureRawInteraction(trace?.capture, 'registry-authority-open', () => registration.context,
        () => openOperatorExecutionAccess(registration.context, this.env));
      if (delegation && !Array.isArray(authority.human.groups)) return { status: 'denied' };
      const [session, rawUser, selected] = await Promise.all([
        registration.scope === 'installation' ? Promise.resolve(null)
          : observeDependency(() => captureRawInteraction(trace?.capture, 'registry-authority-session',
            () => ({ bucket: registration.bucket, sessionId: registration.sessionId }),
            () => new D1SessionRepository(app.USAGE_DB!).getSession(registration.bucket, registration.sessionId))),
        observeDependency(() => captureRawInteraction(trace?.capture, 'registry-authority-initial-user',
          () => `user:${authority.human.email.toLowerCase()}`, () => app.KV!.get(`user:${authority.human.email.toLowerCase()}`))),
        observeDependency(() => captureRawInteraction(trace?.capture, 'registry-authority-initial-selection',
          () => registration.installationId, () => this.resolveManagementExecution(registration.installationId))),
      ]);
      if (trace) {
        if (trace.observation && trace.observation.loggingEnabled === undefined && selected.ok) {
          trace.observation.loggingEnabled = selected.value.operator.policy.loggingEnabled !== false;
          trace.capture ??= this.prospectiveObservationCapture(trace.observation);
          trace.capture?.record('registry-registration-request', () => ({ registrationId: registration.registrationId }));
          trace.capture?.record('registry-authority-request', () => ({ registration, captureRoutingGroups }));
          trace.capture?.record('registry-authority-open-response', () => authority);
        }
        trace.capture?.record('registry-authority-initial-response', () => ({ session, rawUser, selected }));
      }
      const user: unknown = rawUser ? JSON.parse(rawUser) : null;
      if (!user || typeof user !== 'object' || (user as { role?: unknown }).role !== 'admin'
        || registration.scope !== 'installation' && (session?.lifecycleState !== 'running' || session.lifecycleGeneration !== registration.sessionGeneration)
        || !selected.ok || selected.value.operator.profile !== 'dispatcher'
        || selected.value.controlsRevision !== registration.controlsRevision
        || selected.value.installation.revision !== registration.installationRevision
        || selected.value.operator.revision !== registration.operatorRevision
        || selected.value.release.id !== registration.releaseId
        || selected.value.release.bundleDigest !== registration.bundleDigest
        || selected.value.installation.policy.resourceProfileId !== null
        || !prospectiveRenovatePackageSupported(selected.value.manifestJson)) return { status: 'denied' };
      const configured = parseRenovateRunSettings(selected.value.installation.configurationJson);
      if (!configured?.automaticRuns || configured.repository !== registration.repository
        || configured.repetitionIntervalSeconds !== registration.repetitionIntervalSeconds
        || !renovateRepositoryIdentity.safeParse({ repository: registration.repository,
          repositoryId: registration.repositoryId, baseBranch: registration.baseBranch }).success) return { status: 'denied' };
      // Issuance is live even for installation scope; only persisted server-issued grants skip Access.
      const configuredGroups = captureRoutingGroups
        ? parseAccessGroups(await observeDependency(() => captureRawInteraction(trace?.capture, 'registry-authority-routing-groups',
          () => SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, () => app.KV.get(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP)))) : undefined;
      const refreshed = delegation ? { status: 'current' as const, groups: authority.human.groups!, routingGroups: delegation.routingGroups }
        : await captureRawInteraction(trace?.capture, 'registry-authority-identity', () => ({ authority, configuredGroups }),
          () => observeOperatorAccessIdentity(authority.human, authority.accessJwt, configuredGroups));
      trace?.capture?.record('registry-authority-configured', () => ({ configured, configuredGroups, delegation, refreshed }));
      if (refreshed.status !== 'current') return refreshed;
      const human = { ...authority.human, groups: refreshed.groups };
      const finalUser = await captureRawInteraction(trace?.capture, 'registry-authority-user', () => `user:${authority.human.email.toLowerCase()}`,
        () => observeDependency(() => app.KV!.get(`user:${authority.human.email.toLowerCase()}`)));
      if (!finalUser || (JSON.parse(finalUser) as { role?: string }).role !== 'admin'
        || registration.ownerKey !== await operatorOwnerKey(human)) return { status: 'denied' };
      const final = await captureRawInteraction(trace?.capture, 'registry-authority-selection', () => registration.installationId,
        () => observeDependency(() => this.resolveManagementExecution(registration.installationId)));
      if (!final.ok || final.value.controlsRevision !== registration.controlsRevision
        || final.value.installation.revision !== registration.installationRevision
        || final.value.operator.revision !== registration.operatorRevision
        || final.value.release.id !== registration.releaseId
        || final.value.release.bundleDigest !== registration.bundleDigest) return { status: 'denied' };
      return expiresAt * 1000 > Date.now() && canInvokeOperator(human, final.value.operator)
        ? { status: 'current', authority: { human, accessJwt: authority.accessJwt },
          loggingEnabled: final.value.operator.policy.loggingEnabled !== false,
          ...(captureRoutingGroups ? { routingGroups: refreshed.routingGroups } : {}) }
        : { status: 'denied' };
    } catch (error) {
      trace?.capture?.record('registry-authority-error', () => error);
      return { status: expiresAt * 1000 > Date.now()
        && error instanceof ProspectiveDependencyUnavailable ? 'unavailable' : 'denied' };
    }
    })();
    trace?.capture?.record('registry-authority-response', () => result);
    try { await trace?.capture?.flush?.(); } catch { /* Preserve authority observation. */ }
    return result;
  }


  /** Local revision/configuration check only; never network I/O inside storage transactions. */
  private async prospectiveSelectionCurrent(record: ProspectiveRegistration, capture?: RawCapture): Promise<boolean> {
    const selected = await captureRawInteraction(capture, 'registry-selection-current', () => record,
      () => this.resolveManagementExecution(record.installationId));
    if (!selected.ok || record.context.expiresAt * 1000 <= Date.now()) return false;
    const value = selected.value;
    const settings = parseRenovateRunSettings(value.installation.configurationJson);
    return value.controlsRevision === record.controlsRevision && value.installation.revision === record.installationRevision
      && value.operator.revision === record.operatorRevision && value.release.id === record.releaseId
      && value.release.bundleDigest === record.bundleDigest && settings?.automaticRuns === true
      && settings.repository === record.repository && settings.repetitionIntervalSeconds === record.repetitionIntervalSeconds;
  }

  /** Safe owner projection, not a replacement for current authorization at each protected operation. */
  async prospectiveRenovateStatus(installationId: string, ownerKey: string): Promise<'active' | 'expired' | 'inactive' | 'unconfirmed'> {
    const records = await this.ctx.storage.list<ProspectiveRegistration>({ prefix: 'renovate-registration:' });
    let expired = false, unavailable = false;
    for (const record of records.values()) {
      if (record.installationId !== installationId || record.ownerKey !== ownerKey || record.scope !== 'installation') continue;
      if (record.context.expiresAt * 1000 <= Date.now()) { expired = true; continue; }
      const observed = await this.observeProspectiveRenovateRegistration(record.registrationId);
      if (observed.status === 'current' && record.nextObservationAt && await this.ctx.storage.getAlarm() !== null) return 'active';
      if (observed.status === 'unavailable' || observed.status === 'current') unavailable = true;
    }
    return unavailable ? 'unconfirmed' : expired ? 'expired' : 'inactive';
  }

  /** Bounded parent observation, independent of user sessions and of Flue's own execution persistence. */
  async alarm(): Promise<void> {
    const records = await this.ctx.storage.list<ProspectiveRegistration>({ prefix: 'renovate-registration:' });
    if (records.size > 32) return; // Corrupt/legacy over-limit state is not autonomous authority.
    const captures: Array<{ capture: RawCapture; ownerKey: string }> = [];
    try {
    for (const record of records.values()) {
      if (record.scope !== 'installation' || !record.nextObservationAt) continue;
      if (record.nextObservationAt > Date.now()) continue;
      const diagnostic: ProspectiveObservationDiagnostic = { outcome: 'observation-failure', stage: 'authority',
        candidates: 0, reservationDenied: 0, retainedOtherRegistration: 0, retainedExisting: 0, handoffAttempts: 0 };
      let failure: unknown;
      let observation: ProspectiveObservationCapture | undefined;
      try {
        const captureId = crypto.randomUUID();
        observation = { registrationId: record.registrationId,
          binding: { ownerKey: record.ownerKey, installationId: record.installationId, releaseId: record.releaseId,
            captureId, scope: { kind: 'observation', observationId: captureId } } };
      } catch { /* Optional correlation setup cannot change an alarm. */ }
      let capture: RawCapture | undefined;
      try {
        const observed = await this.observeProspectiveRenovateRegistration(record.registrationId, observation);
        if (observation && observation.loggingEnabled === undefined && observed.status === 'current') {
          observation.loggingEnabled = observed.registration.loggingEnabled === true;
        }
        capture = this.prospectiveObservationCapture(observation);
        capture?.record('registry-alarm-input', () => [...records].filter(([, value]) => value.ownerKey === record.ownerKey));
        capture?.record('registry-alarm-authority-response', () => observed);
        if (observed.status === 'denied') {
          diagnostic.outcome = 'authority-denied';
          await this.retireProspectiveObservation(record, capture); continue;
        }
        diagnostic.stage = 'claim';
        // Advance before I/O: delivery retries cannot turn lost execution acknowledgements into replay.
        const next = Math.min(Date.now() + record.repetitionIntervalSeconds * 1000, record.context.expiresAt * 1000);
        const claimed = await captureRawInteraction(capture, 'registry-alarm-claim', () => ({ record, next }),
          () => captureRawTransaction(capture, capture => this.ctx.storage.transaction(async tx => {
          const latest = await captureRawInteraction(capture, 'registry-alarm-latest', () => record.registrationId,
            () => tx.get<ProspectiveRegistration>(`renovate-registration:${record.registrationId}`));
          if (latest?.revision !== record.revision || latest.nextObservationAt !== record.nextObservationAt) return false;
          await captureRawInteraction(capture, 'registry-alarm-write', () => ({ key: `renovate-registration:${record.registrationId}`, value: { ...latest, nextObservationAt: next } }),
            () => tx.put(`renovate-registration:${record.registrationId}`, { ...latest, nextObservationAt: next }));
          return true;
        })));
        if (!claimed || observed.status !== 'current') {
          diagnostic.outcome = !claimed ? 'claim-lost' : 'authority-unavailable'; continue;
        }
        try { await this.observeProspectiveWork(observed.registration, diagnostic, observation); }
        catch (error) {
          failure = error;
          // The callee updates this stage across its awaits; retain its declared union here.
          diagnostic.outcome = (diagnostic.stage as ProspectiveObservationDiagnostic['stage']) === 'discovery'
            ? 'discovery-failure' : 'observation-failure';
          /* Incomplete observation supplies no work authority; retry only at the saved interval. */
        }
      } catch (error) {
        failure = error; throw error;
      } finally {
        capture?.record('registry-alarm-response', () => ({ diagnostic, failure }));
        if (capture) captures.push({ capture, ownerKey: record.ownerKey });
        // Diagnostics cannot replace a response, exception or saved scheduling decision.
        try {
          createLogger('operator-registry').info('Prospective Renovate observation', {
            context: 'registry-alarm', observationDigest: hashDiagnostic(JSON.stringify([
              'registry-alarm:prospective-observation:v1', record.registrationId, record.revision, record.nextObservationAt,
            ])), ...diagnostic, ...(failure === undefined || diagnostic.error !== undefined ? {} : { error: captureError(failure) }),
          });
        } catch { /* Best-effort parent-owned metadata only. */ }
      }
    }
    const scheduled = await this.ctx.storage.transaction(async tx => {
      const remaining = await tx.list<ProspectiveRegistration>({ prefix: 'renovate-registration:' });
      const next = [...remaining.values()].filter(record => record.scope === 'installation' && record.nextObservationAt
        && record.context.expiresAt * 1000 > Date.now()).map(record => record.nextObservationAt!);
      // Include a concurrent explicit activation's due time, never overwrite it with a later observation.
      const alarm = next.length ? Math.max(Date.now() + 1, Math.min(...next)) : null;
      if (alarm !== null) await tx.setAlarm(alarm);
      else await tx.deleteAlarm();
      return { remaining, alarm };
    });
    for (const { capture, ownerKey } of captures) {
      capture.record('registry-alarm-schedule-state', () => [...scheduled.remaining].filter(([, record]) => record.ownerKey === ownerKey));
      capture.record('registry-alarm-schedule-write', () => ({ alarm: scheduled.alarm }));
    }
    } catch (error) {
      for (const { capture } of captures) capture.record('registry-alarm-error', () => error);
      throw error;
    } finally {
      for (const { capture } of captures) try { await capture.finish('complete'); } catch { /* Preserve alarm outcome. */ }
    }
  }

  private async retireProspectiveObservation(record: ProspectiveRegistration, capture?: RawCapture): Promise<void> {
    await captureRawTransaction(capture, capture => this.ctx.storage.transaction(async tx => {
      const key = `renovate-registration:${record.registrationId}`;
      const latest = await captureRawInteraction(capture, 'registry-alarm-retire-read', () => key, () => tx.get<ProspectiveRegistration>(key));
      if (latest?.revision === record.revision) await captureRawInteraction(capture, 'registry-alarm-retire-write',
        () => ({ key, value: { ...latest, nextObservationAt: undefined } }), () => tx.put(key, { ...latest, nextObservationAt: undefined }));
    }));
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

  private async observeProspectiveWork(initial: CurrentProspectiveRegistration, diagnostic: ProspectiveObservationDiagnostic,
    observation?: ProspectiveObservationCapture): Promise<void> {
    const app = this.env as Env;
    const exports = (this.ctx as unknown as { exports?: Record<string,
      (input: { props: Record<string, unknown> }) => Fetcher> }).exports;
    diagnostic.stage = 'binding';
    if (!exports || !app.OPERATOR_ACTIVITY) { diagnostic.outcome = 'binding-unavailable'; return; }
    diagnostic.stage = 'discovery';
    let capture: RawCapture | undefined;
    if (initial.loggingEnabled === true) try {
      const captureId = observation?.binding.captureId ?? crypto.randomUUID();
      const ownerKey = await operatorOwnerKey(initial.human);
      observation ??= { registrationId: initial.registrationId, loggingEnabled: true,
        binding: { ownerKey, installationId: initial.installationId, releaseId: initial.releaseId,
          captureId, scope: { kind: 'observation', observationId: captureId } } };
      observation.loggingEnabled ??= true;
      capture = createRawCapture({ enabled: true, binding: observation.binding,
        storage: () => createOwnerRawCaptureStorage(app, this.ctx.storage, async () => {
          // Retaining already observed evidence grants no new execution or human authority.
          const owned = await this.ctx.storage.get<ProspectiveRegistration>(`renovate-registration:${initial.registrationId}`);
          if (!owned || owned.ownerKey !== ownerKey || owned.bucket !== initial.bucket
            || owned.installationId !== initial.installationId || owned.releaseId !== initial.releaseId
            || owned.bundleDigest !== initial.bundleDigest || owned.operatorRevision !== initial.operatorRevision) {
            throw Error('Raw capture owner changed');
          }
        }), schedule: work => this.ctx.waitUntil(work) });
      capture.record('discovery-observation', () => initial);
    } catch { /* Capture setup cannot change authorized observation. */ }
    const observe = (stage: string, value: () => unknown) => {
      try { capture?.record(stage, value); } catch { /* Preserve the original observation and handoff. */ }
    };
    const invoke = async <T>(boundary: string, request: unknown, work: () => Promise<T>): Promise<T> => {
      observe(`${boundary}-request`, () => request);
      try {
        try { await capture?.flush?.(); } catch { /* Keep the original interaction. */ }
        const result = await work();
        observe(`${boundary}-response`, () => {
          if (boundary === 'prospective-reservation') {
            const reserved = result as Awaited<ReturnType<OperatorRegistry['reserveProspectiveRenovateActivity']>>;
            // The inner Registry boundary retains full same-owner history. An outer caller
            // cannot attribute another registration's private actor without that proof.
            if (reserved.ok && reserved.actor.registrationId !== initial.registrationId) return { retainedOtherRegistration: true };
          }
          return result;
        });
        try { await capture?.flush?.(); } catch { /* Keep the original result. */ }
        return result;
      } catch (error) { observe(`${boundary}-error`, () => error); throw error; }
    };
    const current = () => invoke('prospective-current', { registrationId: initial.registrationId },
      () => this.currentProspectiveRenovateRegistration(initial.registrationId, observation));
    const inFlight: Promise<unknown>[] = [];
    let terminal: 'complete' | 'failed' = 'failed';
    let backgroundFailed = false;
    let candidates: Awaited<ReturnType<typeof listProspectiveRenovatePrs>>;
    try {
      const retainedRetryTargets = await invoke('prospective-retained-history', { registrationId: initial.registrationId },
        () => this.retainedProspectiveRenovateRetryTargets(initial.registrationId, observation));
      candidates = await listProspectiveRenovatePrs({ env: app, exports, registration: initial,
        retainedRetryTargets, capture, current: async () => !!await current() });
      diagnostic.candidates = candidates.length;
      diagnostic.outcome = 'observed';
      for (const candidate of candidates) {
        diagnostic.stage = 'reservation';
        if (!await current()) { diagnostic.outcome = 'stale-authority'; return; }
        const activityId = `scan-${crypto.randomUUID()}`;
        const reservation = { ...candidate, registrationId: initial.registrationId, activityId };
        const reserved = await invoke('prospective-reservation', reservation, () => this.reserveProspectiveRenovateActivity(reservation, observation));
        if (!reserved.ok) { diagnostic.reservationDenied++; continue; }
        if (reserved.actor.registrationId !== initial.registrationId) { diagnostic.retainedOtherRegistration++; continue; }
        if (reserved.activityId !== activityId) diagnostic.retainedExisting++;
        diagnostic.stage = 'handoff';
        const activity = app.OPERATOR_ACTIVITY.getByName(reserved.activityId);
        let stage: NonNullable<ProspectiveObservationDiagnostic['failureStage']> = 'authority';
        let admissionDigest: string | undefined;
        let receiverDigest: string | undefined;
        try {
          if (scanId.test(reserved.activityId)) admissionDigest = hashDiagnostic(JSON.stringify([
            'prospective-renovate-admission:v1', reserved.activityId,
          ]));
          receiverDigest = activityRpcReceiverDigest(activity.id);
        } catch { /* Correlation is best-effort, never admission authority. */ }
        const fenceHandoff = async (failure: FailureObservation) => {
          try {
            // The Activity atomically refuses this fence once any drive has begun, including a concurrent winner.
            await invoke('prospective-fence', { activityId: reserved.activityId, failure },
              () => activity.fenceRuntimeFailure(undefined, failure, { onlyBeforeDrive: true }));
          } catch (error) {
            try {
              createLogger('operator-registry').warn('Prospective Renovate handoff fence unavailable', {
                stage, category: 'fence-unavailable', admissionDigest,
                ...(receiverDigest ? { receiverDigest } : {}), error: captureError(error),
              });
            } catch { /* A secondary fence/logging failure cannot replace the original handoff outcome. */ }
          }
        };
        const handoffCurrent = async () => {
          stage = 'authority';
          const observed = await invoke('prospective-authority', { registrationId: initial.registrationId },
            () => this.observeProspectiveRenovateRegistration(initial.registrationId, observation));
          if (observed.status === 'current') return observed.registration;
          diagnostic.outcome = 'stale-authority';
          await fenceHandoff({ boundary: 'admission',
            code: observed.status === 'denied' ? 'authority-denied' : 'platform-evidence-required' });
          return null;
        };
        try {
          const winner = await handoffCurrent(); if (!winner) return;
          stage = 'plan';
          let plan = await invoke('prospective-plan', { activityId: reserved.activityId }, () => activity.getRuntimePlan());
          // Unknown/prepared outcomes belong to the original Activity; never prepare a replacement.
          if (!plan && !await invoke('prospective-detail', { activityId: reserved.activityId }, () => activity.getBrowserDetail())) {
            stage = 'preparation';
            observe('prospective-preparation-request', () => ({ activityId: reserved.activityId, winner }));
            const prepared = await prepareOperatorActivity({ installationId: initial.installationId,
              invocation: { repository: winner.repository } }, { human: winner.human, accessJwt: winner.accessJwt }, app,
            { activityId: reserved.activityId, prospectiveAdmissionId: reserved.activityId,
              expectedManagement: { controlsRevision: winner.controlsRevision,
              installationRevision: winner.installationRevision, operatorRevision: winner.operatorRevision,
              releaseId: winner.releaseId, bundleDigest: winner.bundleDigest } });
            if (!await handoffCurrent()) return;
            observe('prospective-preparation-response', () => prepared);
            try { await invoke<Awaited<ReturnType<typeof activity.start>>>('prospective-start', { activityId: reserved.activityId, capability: prepared.startCapability },
              () => activity.start(prepared.startCapability)); } catch { /* Read the same Activity below. */ }
            stage = 'plan';
            plan = await invoke('prospective-plan', { activityId: reserved.activityId }, () => activity.getRuntimePlan());
          }
          if (!plan || plan.activityId !== reserved.activityId) {
            await fenceHandoff({ boundary: 'construction', code: 'startup-failed' }); continue;
          }
          if (!await handoffCurrent()) continue;
          stage = 'detail';
          let detail = await invoke('prospective-detail', { activityId: reserved.activityId },
            () => activity.getBrowserDetail()) as { executionStatus: string } | null;
          if (detail?.executionStatus === 'waiting') {
            await invoke('prospective-collection', { activityId: reserved.activityId }, () => activity.collectBrowserResult());
            detail = await invoke('prospective-detail', { activityId: reserved.activityId },
              () => activity.getBrowserDetail()) as { executionStatus: string } | null;
          }
          if (!detail) {
            await fenceHandoff({ boundary: 'construction', code: 'startup-failed' }); continue;
          }
          if (detail.executionStatus === 'queued' && await handoffCurrent()) {
            stage = 'binding';
            const bindCapability = bindOperatorRuntimeCapability(this.ctx);
            stage = 'drive';
            // Count the handoff attempt, not background SDK admission or completion.
            diagnostic.handoffAttempts++;
            const work = invoke('prospective-drive', { activityId: reserved.activityId },
              () => runOperatorActivity(reserved.activityId, app, bindCapability)).then(
              // A null runtime plan is also a refused handoff. A begun drive makes this fence a no-op.
              () => fenceHandoff({ boundary: 'construction', code: 'startup-failed' }),
              error => { backgroundFailed = true; terminal = 'failed'; return fenceHandoff({ boundary: 'construction', code: 'startup-failed',
                error: captureError(error), origin: 'catching' }); },
            );
            inFlight.push(work);
            this.ctx.waitUntil(work);
          }
        } catch (error) {
          observe('prospective-handoff-error', () => ({ activityId: reserved.activityId, stage, error }));
          const captured = captureError(error);
          diagnostic.outcome = 'handoff-failure';
          if (diagnostic.error === undefined) {
            diagnostic.error = captured;
            diagnostic.failureStage = stage;
            diagnostic.admissionDigest = admissionDigest;
            if (receiverDigest) diagnostic.receiverDigest = receiverDigest;
          }
          await fenceHandoff({ boundary: stage === 'authority' ? 'admission' : 'construction',
            code: stage === 'authority' ? 'platform-evidence-required' : 'startup-failed',
            error: captured, origin: 'catching' });
        }
      }
      terminal = diagnostic.outcome === 'observed' && !backgroundFailed ? 'complete' : 'failed';
    } catch (error) {
      observe('prospective-observation-error', () => error);
      throw error;
    } finally {
      if (capture) try {
        const archive = capture;
        this.ctx.waitUntil(Promise.allSettled(inFlight).then(() => archive.finish(terminal)).then(receipt => {
          try { console.log(JSON.stringify({ module: 'operator-execution', message: 'raw-capture-receipt', data: receipt })); }
          catch { /* A receipt is not execution or persistence authority. */ }
        }).catch(() => {}));
      } catch { /* Persistence lifetime cannot replace the original observation. */ }
    }
  }

  private async prospectiveAuthority(registration: ProspectiveRegistration, capture?: RawCapture): Promise<{
    human: VerifiedHumanAccessClaims; accessJwt: string;
  } | null> {
    const observed = await this.observeProspectiveAuthority(registration, false, { capture });
    return observed.status === 'current' ? observed.authority : null;
  }


  async activateProspectiveRenovate(input: { installationId: string; bucket: string; sessionId: string;
    sessionGeneration: number; scope?: 'installation'; human: VerifiedHumanAccessClaims; accessJwt: string;
    repository: RenovateRepositoryIdentity; expectedManagement?: ProspectiveSelectionPin }): Promise<
      { ok: true; activatedAt: string; registrationId: string } & RenovateRepositoryIdentity
      | { ok: false; reason: string }> {
    const app = this.env as Env;
    const target = renovateRepositoryIdentity.safeParse(input.repository);
    if (!target.success || !scanId.test(input.installationId) || !/^[A-Za-z0-9._-]{1,128}$/.test(input.bucket)
      || (input.scope === 'installation' ? input.sessionId !== '' || input.sessionGeneration !== 0
        : !scanSession.test(input.sessionId) || !Number.isSafeInteger(input.sessionGeneration) || input.sessionGeneration < 1)
      || !app.USAGE_DB || !app.KV
      || input.human.expiresAt * 1000 <= Date.now()) return { ok: false, reason: 'not-authorized' };
    if (input.scope !== 'installation' && await this.ctx.storage.get(`renovate-installation-scope:${input.installationId}`)) {
      return { ok: false, reason: 'explicit-installation-activation-required' };
    }
    const selected = await this.resolveManagementExecution(input.installationId);
    if (!selected.ok || selected.value.operator.profile !== 'dispatcher'
      || selected.value.installation.policy.resourceProfileId !== null
      || !prospectiveRenovatePackageSupported(selected.value.manifestJson)) return { ok: false, reason: 'installation-unavailable' };
    let configured: RenovateRunSettings | null;
    try { configured = parseRenovateRunSettings(selected.value.installation.configurationJson); }
    catch { return { ok: false, reason: 'configuration-unavailable' }; }
    if (!configured?.automaticRuns || configured.repository !== target.data.repository) return { ok: false, reason: 'configuration-unavailable' };
    const pins: ProspectiveSelectionPin = { controlsRevision: selected.value.controlsRevision,
      installationRevision: selected.value.installation.revision, operatorRevision: selected.value.operator.revision,
      releaseId: selected.value.release.id, bundleDigest: selected.value.release.bundleDigest };
    if (input.expectedManagement && Object.entries(pins).some(([key, value]) =>
      value !== input.expectedManagement![key as keyof ProspectiveSelectionPin])) return { ok: false, reason: 'stale-selection' };
    const ownerKey = await operatorOwnerKey(input.human);
    const rawId = JSON.stringify([ownerKey, input.bucket, input.sessionId, input.sessionGeneration,
      input.installationId, pins, target.data, configured.repetitionIntervalSeconds, input.accessJwt, input.scope, input.human.expiresAt]);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawId)));
    let registrationId = `scan-${Array.from(digest).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const provisional: ProspectiveRegistration = { registrationId, installationId: input.installationId,
      ...target.data, ...pins, repetitionIntervalSeconds: configured.repetitionIntervalSeconds,
      ownerKey, bucket: input.bucket, sessionId: input.sessionId, sessionGeneration: input.sessionGeneration,
      ...(input.scope === 'installation' ? { scope: input.scope, nextObservationAt: Math.min(Date.now() + 1000, input.human.expiresAt * 1000) } : {}),
      revision: 0, context: await createOperatorExecutionContext({ activityId: registrationId,
        operatorId: selected.value.operator.operatorId, artifactDigest: pins.bundleDigest,
        policyDigest: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
          new TextEncoder().encode(JSON.stringify(selected.value.installation.policy)))))
          .map(byte => byte.toString(16).padStart(2, '0')).join(''),
        human: input.human, accessJwt: input.accessJwt }, this.env) };
    if ((await this.observeProspectiveAuthority(provisional, input.scope === 'installation')).status !== 'current') {
      return { ok: false, reason: 'not-authorized' };
    }
    const registrations = await this.ctx.storage.list<ProspectiveRegistration>({ prefix: 'renovate-registration:' });
    const inactive: Array<{ key: string; revision: number }> = [];
    for (const [key, record] of registrations) {
      if (record.context.expiresAt * 1000 <= Date.now()
        || input.scope === 'installation' && record.installationId === input.installationId
          && (record.scope !== 'installation' || record.ownerKey === ownerKey && record.registrationId !== registrationId)) {
        inactive.push({ key, revision: record.revision }); continue;
      }
      if (record.scope === 'installation') continue;
      try {
        const session = await new D1SessionRepository(app.USAGE_DB).getSession(record.bucket, record.sessionId);
        if (session && (session.lifecycleGeneration !== record.sessionGeneration
          || session.lifecycleState === 'stopped' || session.lifecycleState === 'stopping')) inactive.push({ key, revision: record.revision });
      } catch { /* Unavailable lifecycle is not proof of retirement. */ }
    }
    const verified = await this.observeProspectiveAuthority(provisional, input.scope === 'installation');
    if (verified.status !== 'current') return { ok: false, reason: 'stale-selection' };
    if (input.scope === 'installation') {
      const delegation = dispatcherDelegationSchema.safeParse({ version: 1, routingGroups: verified.routingGroups });
      if (!delegation.success) return { ok: false, reason: 'not-authorized' };
      const consent = JSON.stringify([rawId, delegation.data, verified.authority.human.groups]);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(consent)));
      registrationId = `scan-${Array.from(digest).map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
      // Mark only after BOTH live checks, and seal final verified memberships, not input claims.
      provisional.registrationId = registrationId;
      provisional.context = await createOperatorExecutionContext({ activityId: registrationId,
        operatorId: provisional.context.operatorId, artifactDigest: provisional.context.artifactDigest,
        policyDigest: provisional.context.policyDigest, ...verified.authority }, this.env);
      provisional.delegation = delegation.data;
      if ((await this.observeProspectiveAuthority(provisional)).status !== 'current') {
        return { ok: false, reason: 'stale-selection' };
      }
    }
    return this.ctx.storage.transaction(async tx => {
      if (!await this.prospectiveSelectionCurrent(provisional)) return { ok: false, reason: 'stale-selection' } as const;
      const before = await tx.list<ProspectiveRegistration>({ prefix: 'renovate-registration:' });
      for (const { key, revision } of inactive) if (key !== `renovate-registration:${registrationId}` && before.get(key)?.revision === revision) { await tx.delete(key); before.delete(key); }
      if (before.size >= 32 && !before.has(`renovate-registration:${registrationId}`)) return { ok: false, reason: 'registration-limit' } as const;
      if (input.scope !== 'installation' && await tx.get(`renovate-installation-scope:${input.installationId}`)) return { ok: false, reason: 'explicit-installation-activation-required' } as const;
      const previous = await tx.get<ProspectiveActivation>('renovate-activation');
      if (previous && previous.installationId !== input.installationId) return { ok: false, reason: 'activation-conflict' } as const;
      const identityKey = `renovate-repository:${input.installationId}:${target.data.repository.toLowerCase()}`;
      const retainedIdentity = await tx.get<number>(identityKey);
      if (retainedIdentity !== undefined && retainedIdentity !== target.data.repositoryId) return { ok: false, reason: 'repository-changed' } as const;
      const cutoffKey = `renovate-cutoff:${input.installationId}:${target.data.repositoryId}`;
      const cutoff = await tx.get<string>(cutoffKey) ?? (previous?.repositoryId === target.data.repositoryId ? previous.activatedAt : new Date(Date.now()).toISOString());
      const activation: ProspectiveActivation = { installationId: input.installationId, ...target.data, activatedAt: cutoff };
      const current = await tx.get<ProspectiveRegistration>(`renovate-registration:${registrationId}`);
      await tx.put(identityKey, target.data.repositoryId);
      await tx.put(cutoffKey, cutoff);
      await tx.put('renovate-activation', activation);
      // Lost acknowledgements repeat this exact consent, not its observation or lifetime.
      const record = current && (current.scope !== 'installation' || current.nextObservationAt)
        ? current : { ...provisional, revision: (current?.revision ?? 0) + 1 };
      if (input.scope === 'installation') {
        await tx.put(`renovate-installation-scope:${input.installationId}`, true);
        // Fence concurrent legacy activation and the same owner's superseded assertion atomically.
        for (const [key, other] of before) {
          if (other.installationId === input.installationId && other.registrationId !== registrationId
            && (other.scope !== 'installation' || other.ownerKey === ownerKey)) await tx.delete(key);
        }
      }
      await tx.put(`renovate-registration:${registrationId}`, record);
      if (record.scope === 'installation' && record.nextObservationAt) {
        const alarm = await tx.getAlarm();
        if (alarm === null || alarm > record.nextObservationAt) await tx.setAlarm(record.nextObservationAt);
      }
      await tx.put('renovate-election-revision', (await tx.get<number>('renovate-election-revision') ?? 0) + 1);
      return { ok: true, activatedAt: cutoff, registrationId, ...target.data } as const;
    });
  }

  async observeProspectiveRenovateRegistration(registrationId: string, observation?: ProspectiveObservationCapture): Promise<ProspectiveRegistrationObservation> {
    const trace: { observation?: ProspectiveObservationCapture; capture?: RawCapture } = { observation };
    let owned = true;
    const result = await (async (): Promise<ProspectiveRegistrationObservation> => {
    if (!scanId.test(registrationId)) return { status: 'denied' };
    try {
      const [activation, record] = await Promise.all([
        observeDependency(() => this.ctx.storage.get<ProspectiveActivation>('renovate-activation')),
        observeDependency(() => this.ctx.storage.get<ProspectiveRegistration>(`renovate-registration:${registrationId}`)),
      ]);
      owned = !record || !observation || record.ownerKey === observation.binding.ownerKey;
      if (owned) trace.capture = this.prospectiveObservationCapture(observation);
      trace.capture?.record('registry-registration-request', () => ({ registrationId }));
      trace.capture?.record('registry-registration-state', () => ({ activation, record }));
      if (record?.scope !== 'installation' && record && await captureRawInteraction(trace.capture, 'registry-registration-scope',
        () => `renovate-installation-scope:${record.installationId}`,
        () => this.ctx.storage.get(`renovate-installation-scope:${record.installationId}`))) return { status: 'denied' };
      if (!activation || !record || activation.installationId !== record.installationId
        || activation.repository !== record.repository || activation.repositoryId !== record.repositoryId
        || activation.baseBranch !== record.baseBranch) return { status: 'denied' };
      const observed = await this.observeProspectiveAuthority(record, false, owned ? trace : undefined);
      trace.capture?.record('registry-registration-state', () => ({ activation, record }));
      const latest = await captureRawInteraction(trace.capture, 'registry-registration-latest', () => registrationId,
        () => this.ctx.storage.get<ProspectiveRegistration>(`renovate-registration:${registrationId}`));
      if (!latest || latest.revision !== record.revision || record.scope === 'installation' && !latest.nextObservationAt) return { status: 'denied' };
      if (record.context.expiresAt * 1000 <= Date.now()) return { status: 'denied' };
      if (observed.status !== 'current') return observed;
      const current = observed.authority;
      return { status: 'current', registration: { ...(record.scope ? { scope: record.scope } : {}),
        ...(record.delegation ? { delegation: record.delegation } : {}), registrationId, installationId: record.installationId,
        repository: record.repository, repositoryId: record.repositoryId, baseBranch: record.baseBranch,
        repetitionIntervalSeconds: record.repetitionIntervalSeconds, activatedAt: activation.activatedAt,
        bucket: record.bucket, sessionId: record.sessionId, sessionGeneration: record.sessionGeneration,
        controlsRevision: record.controlsRevision, installationRevision: record.installationRevision,
        operatorRevision: record.operatorRevision, releaseId: record.releaseId, bundleDigest: record.bundleDigest,
        loggingEnabled: observed.loggingEnabled, ...current } };
    } catch (error) {
      trace.capture?.record('registry-registration-error', () => error);
      return { status: error instanceof ProspectiveDependencyUnavailable ? 'unavailable' : 'denied' };
    }
    })();
    trace.capture?.record('registry-registration-response', () => owned ? result : { foreignOwner: true });
    try { await trace.capture?.finish('complete'); } catch { /* Preserve the exact observation. */ }
    return result;
  }

  async currentProspectiveRenovateRegistration(registrationId: string, observation?: ProspectiveObservationCapture): Promise<CurrentProspectiveRegistration | null> {
    const observed = await this.observeProspectiveRenovateRegistration(registrationId, observation);
    return observed.status === 'current' ? observed.registration : null;
  }

  /** Trusted parent passes its authenticated GitHub observation, not route/child data. */
  async reserveProspectiveRenovateActivity(input: { registrationId: string; repositoryId: number;
    pullRequest: number; head: string; createdAt: string; activityId: string }, observation?: ProspectiveObservationCapture): Promise<
      { ok: true; activityId: string; actor: ProspectiveAdmission['actor'] } | { ok: false; reason: string }> {
    const archive = this.prospectiveObservationCapture(observation);
    const childObservation = observation && archive ? { ...observation,
      parentCaptureId: observation.binding.captureId, binding: archive.binding } : observation;
    let owned = true;
    const capture = archive && { ...archive, record: (stage: string, value: () => unknown) => {
      if ((stage === 'registry-reservation-response' || stage === 'registry-reservation-transaction-response') && !owned) archive.record(stage, () => ({ retainedForeignOwner: true }));
      else archive.record(stage, value);
    } };
    try { return await captureRawInteraction(capture, 'registry-reservation', () => input, async (): Promise<
      { ok: true; activityId: string; actor: ProspectiveAdmission['actor'] } | { ok: false; reason: string }> => {
    if (!scanId.test(input.registrationId) || !scanId.test(input.activityId)
      || !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1 || !Number.isSafeInteger(input.pullRequest)
      || input.pullRequest < 1 || !sha.test(input.head)) return { ok: false, reason: 'invalid-target' };
    const activation = await captureRawInteraction(capture, 'registry-reservation-activation', () => 'renovate-activation',
      () => this.ctx.storage.get<ProspectiveActivation>('renovate-activation'));
    const created = prospectiveRenovateTimestamp(input.createdAt);
    const cutoff = activation ? prospectiveRenovateTimestamp(activation.activatedAt) : null;
    if (created === null) return { ok: false, reason: 'invalid-target' };
    if (!activation || activation.repositoryId !== input.repositoryId || cutoff === null || created <= cutoff) {
      return { ok: false, reason: 'pre-activation' };
    }
    const key = `renovate-admission:${input.repositoryId}:${input.pullRequest}:${input.head}`;
    capture?.record('registry-reservation-existing-request', () => key);
    const existing = await this.ctx.storage.get<ProspectiveAdmission>(key);
    owned = !existing || !observation || existing.ownerKey === observation.binding.ownerKey;
    capture?.record('registry-reservation-existing', () => owned ? existing : { retainedForeignOwner: true });
    const existingLayout = existing ? prospectiveAdmissionLayout(existing) : null;
    capture?.record('registry-reservation-layout', () => ({ existingLayout, created, cutoff }));
    if (existing && (!existingLayout || existing.createdAt !== input.createdAt)) return { ok: false, reason: 'invalid-target' };
    const retry = existing ? await this.prospectiveRetryProof(existing, owned ? capture : undefined, owned ? childObservation : undefined) : null;
    if (existing && !retry && existing.actor.registrationId === input.registrationId) {
      return { ok: true, activityId: existing.activityId, actor: existing.actor };
    }
    const election = await captureRawInteraction(capture, 'registry-reservation-election', () => 'renovate-election-revision',
      () => this.ctx.storage.get<number>('renovate-election-revision')) ?? 0;
    capture?.record('registry-reservation-registrations-request', () => ({ prefix: 'renovate-registration:' }));
    const registrations = await this.ctx.storage.list<ProspectiveRegistration>({ prefix: 'renovate-registration:' });
    capture?.record('registry-reservation-registrations', () => [...registrations].filter(([, record]) => record.ownerKey === observation?.binding.ownerKey));
    if (registrations.size > 32) return { ok: false, reason: 'registration-limit' };
    const candidates: Array<{ record: ProspectiveRegistration; human: VerifiedHumanAccessClaims; loggingEnabled: boolean }> = [];
    for (const record of registrations.values()) {
      if (record.installationId !== activation.installationId || record.repositoryId !== activation.repositoryId
        || record.repository !== activation.repository || record.baseBranch !== activation.baseBranch) continue;
      const observed = await this.observeProspectiveAuthority(record, false,
        record.ownerKey === observation?.binding.ownerKey ? { observation, capture } : undefined);
      if (observed.status === 'current') candidates.push({ record, human: observed.authority.human, loggingEnabled: observed.loggingEnabled });
    }
    candidates.sort((left, right) =>
      `${left.human.issuer}:${left.human.subject}:${left.record.sessionId}:${left.record.sessionGeneration}`
        .localeCompare(`${right.human.issuer}:${right.human.subject}:${right.record.sessionId}:${right.record.sessionGeneration}`));
    const winner = candidates[0];
    capture?.record('registry-reservation-candidates', () => candidates.filter(candidate => candidate.record.ownerKey === observation?.binding.ownerKey));
    if (!winner) return { ok: false, reason: 'no-current-admin' };
    if (observation && winner.record.ownerKey !== observation.binding.ownerKey) owned = false;
    if (existing && retry && !this.prospectiveRetryDue(existing, retry, winner.record.repetitionIntervalSeconds)) {
      return { ok: true, activityId: existing.activityId, actor: existing.actor };
    }
    let retiredPreparation = false;
    if (existing && !retry) {
      // Reactivation removes superseded registrations, not their immutable Activity history.
      // Only the elected, same-owner/scope caller may retire that exact old preparation.
      // Upgrades may select new pins for a NEW Activity; the old Activity must prove its own pins.
      // Preserve the original short-circuit order; diagnostics never inspect skipped evidence.
      const refusal = input.registrationId !== winner.record.registrationId ? 'caller-not-elected'
        : registrations.has(`renovate-registration:${existing.actor.registrationId}`) ? 'original-registration-present'
        : winner.record.scope !== 'installation' ? 'winner-not-installation'
        : winner.record.delegation?.version !== 1 ? 'delegation-unavailable'
        : winner.record.sessionId !== '' ? 'winner-session-id'
        : winner.record.sessionGeneration !== 0 ? 'winner-session-generation'
        : existing.ownerKey !== winner.record.ownerKey ? 'owner-mismatch'
        : existing.actor.bucket !== winner.record.bucket ? 'bucket-mismatch'
        : existing.actor.subject !== winner.human.subject ? 'subject-mismatch'
        : existing.actor.issuer !== winner.human.issuer ? 'issuer-mismatch'
        : existing.actor.email.toLowerCase() !== winner.human.email.toLowerCase() ? 'email-mismatch'
        : JSON.stringify([...existing.actor.audiences].sort()) !== JSON.stringify([...winner.human.audiences].sort()) ? 'audience-mismatch'
        : existing.installationId !== activation.installationId ? 'installation-mismatch'
        : existing.repositoryId !== input.repositoryId ? 'repository-id-mismatch'
        : !(existingLayout === 'legacy' ? activation.repository === 'nikolanovoselec/komodo'
          : existing.repository === activation.repository && existing.baseBranch === activation.baseBranch) ? 'repository-scope-mismatch'
        : existing.pullRequest !== input.pullRequest ? 'pull-request-mismatch'
        : existing.head !== input.head ? 'head-mismatch'
        : existing.activatedAt !== activation.activatedAt ? 'cutoff-mismatch'
        : !this.env.OPERATOR_ACTIVITY ? 'activity-binding-unavailable' : null;
      const trace = (reason: NonNullable<typeof refusal> | 'retirement-refused' | 'retirement-rpc-failed') => {
        capture?.record('registry-reservation-retention', () => ({ reason }));
        if (!winner.loggingEnabled) return;
        try {
          createLogger('operator-registry').info('Prospective Renovate preparation retained', {
            reason, admissionDigest: hashDiagnostic(JSON.stringify(['prospective-renovate-admission:v1', existing.activityId])),
          });
        } catch { /* Optional diagnostics cannot change reservation or retirement. */ }
      };
      if (refusal) trace(refusal);
      else {
        try {
          // This RPC fences atomically against beginDrive; a status GET cannot prove no effects.
          retiredPreparation = await captureRawInteraction(capture, 'registry-retirement', () => existing,
            () => this.env.OPERATOR_ACTIVITY!.getByName(existing.activityId)
              .retireProspectiveRenovatePreparation(existing, childObservation)) === true;
          if (!retiredPreparation) trace('retirement-refused');
        } catch { trace('retirement-rpc-failed'); } // Missing/uncertain evidence retains the reservation.
      }
      if (!retiredPreparation) return { ok: true, activityId: existing.activityId, actor: existing.actor };
    }
    const actor: ProspectiveAdmission['actor'] = { registrationId: winner.record.registrationId,
      bucket: winner.record.bucket, sessionId: winner.record.sessionId,
      sessionGeneration: winner.record.sessionGeneration, subject: winner.human.subject,
      issuer: winner.human.issuer, email: winner.human.email, audiences: [...winner.human.audiences] };
    if (!await this.prospectiveAuthority(winner.record, owned ? capture : undefined)) return { ok: false, reason: 'stale-election' };
    return captureRawInteraction(owned ? capture : undefined, 'registry-reservation-transaction', () => ({ key, actor }),
      () => captureRawTransaction(owned ? capture : undefined, capture => this.ctx.storage.transaction(async tx => {
      const prior = await tx.get<ProspectiveAdmission>(key);
      if (prior && observation && prior.ownerKey !== observation.binding.ownerKey) owned = false;
      capture?.record('registry-reservation-prior', () => !prior || prior.ownerKey === observation?.binding.ownerKey ? prior : { retainedForeignOwner: true });
      // The head entry is only a pointer; original Activity admissions are immutable.
      // A concurrent winner (or uncertain new preparation) always retains its actor/attempt.
      if (prior && (!existing || prior.activityId !== existing.activityId || !retry && !retiredPreparation)) {
        return { ok: true, activityId: prior.activityId, actor: prior.actor } as const;
      }
      if (existing && (!prior || retry && !this.prospectiveRetryDue(prior, retry, winner.record.repetitionIntervalSeconds))) {
        return { ok: false, reason: 'stale-retry' } as const;
      }
      if (existing && retiredPreparation) {
        const originalRegistration = await tx.get<ProspectiveRegistration>(`renovate-registration:${existing.actor.registrationId}`);
        capture?.record('registry-reservation-original-registration', () => !originalRegistration
          || originalRegistration.ownerKey === observation?.binding.ownerKey ? originalRegistration : { foreignOwner: true });
        if (originalRegistration) return { ok: false, reason: 'stale-election' } as const;
      }
      const [stillActivated, stillRegistered, collision, currentElection] = await Promise.all([
        tx.get<ProspectiveActivation>('renovate-activation'),
        tx.get<ProspectiveRegistration>(`renovate-registration:${actor.registrationId}`),
        tx.get<ProspectiveAdmission>(`renovate-activity:${input.activityId}`),
        tx.get<number>('renovate-election-revision'),
      ]);
      capture?.record('registry-reservation-commit-inputs', () => ({ stillActivated,
        stillRegistered: !stillRegistered || stillRegistered.ownerKey === observation?.binding.ownerKey ? stillRegistered : { foreignOwner: true },
        collision: !collision || collision.ownerKey === observation?.binding.ownerKey ? collision : { foreignOwner: true }, currentElection }));
      if (collision) return { ok: false, reason: 'activity-conflict' } as const;
      if (stillActivated?.activatedAt !== activation.activatedAt || stillActivated.repositoryId !== activation.repositoryId
        || stillActivated.repository !== activation.repository || stillActivated.baseBranch !== activation.baseBranch
        || stillActivated.installationId !== activation.installationId
        || currentElection !== election || !stillRegistered || stillRegistered.revision !== winner.record.revision
        || stillRegistered.scope === 'installation' && !stillRegistered.nextObservationAt
        || !await this.prospectiveSelectionCurrent(stillRegistered, capture)) return { ok: false, reason: 'stale-election' } as const;
      const admission: ProspectiveAdmission = { activityId: input.activityId, admittedAt: Date.now(),
        attempt: (existing?.attempt ?? (existing ? 1 : 0)) + 1,
        ...(existing ? { previousActivityId: existing.activityId } : {}),
        installationId: activation.installationId, repository: activation.repository, repositoryId: activation.repositoryId,
        baseBranch: activation.baseBranch, controlsRevision: winner.record.controlsRevision,
        installationRevision: winner.record.installationRevision, operatorRevision: winner.record.operatorRevision,
        releaseId: winner.record.releaseId, bundleDigest: winner.record.bundleDigest,
        pullRequest: input.pullRequest, head: input.head, createdAt: input.createdAt,
        activatedAt: activation.activatedAt, ownerKey: winner.record.ownerKey, actor };
      await captureRawInteraction(capture, 'registry-reservation-write', () => ({ key, value: admission }), () => tx.put(key, admission));
      await captureRawInteraction(capture, 'registry-reservation-write', () => ({ key: `renovate-activity:${input.activityId}`, value: admission }),
        () => tx.put(`renovate-activity:${input.activityId}`, admission));
      return { ok: true, activityId: input.activityId, actor } as const;
    })));
    }); } finally { try { await archive?.finish('complete'); } catch { /* Preserve reservation. */ } }
  }

  private async prospectiveRetryProof(admission: ProspectiveAdmission, capture?: RawCapture,
    observation?: ProspectiveObservationCapture): Promise<ProspectiveRenovateRetryProof | null> {
    if (!this.env.OPERATOR_ACTIVITY) return null;
    try {
      const request = { repositoryId: admission.repositoryId, pullRequest: admission.pullRequest, head: admission.head };
      const value = await captureRawInteraction(capture, 'registry-retry-proof', () => ({ activityId: admission.activityId, request }),
        () => this.env.OPERATOR_ACTIVITY!.getByName(admission.activityId).readProspectiveRenovateRetryProof(request, observation));
      const parsed = prospectiveRenovateRetryProof.safeParse(value);
      capture?.record('registry-retry-validation', () => parsed);
      if (!parsed.success) return null;
      const proof = parsed.data;
      return proof.activityId === admission.activityId && proof.repositoryId === admission.repositoryId
        && proof.repository === admission.repository && proof.baseBranch === admission.baseBranch
        && proof.pullRequest === admission.pullRequest && proof.head === admission.head
        && proof.createdAt === admission.createdAt && proof.artifactDigest === admission.bundleDigest
        && proof.terminalAt <= Date.now() ? proof : null;
    } catch (error) {
      capture?.record('registry-retry-error', () => error);
      return null; // Unknown/uncollected history cannot elect replacement work.
    }
  }

  private prospectiveRetryDue(admission: ProspectiveAdmission, proof: ProspectiveRenovateRetryProof, interval: number): boolean {
    // Legacy admissions lack a reservation timestamp; use their proven terminal time conservatively.
    const started = admission.admittedAt ?? proof.terminalAt;
    return Number.isSafeInteger(started) && started >= 0 && started <= proof.terminalAt
      && Date.now() >= started + interval * 1000;
  }

  /** Exact retained heads only. Complete authenticated discovery must still re-observe every target. */
  async retainedProspectiveRenovateRetryTargets(registrationId: string, observation?: ProspectiveObservationCapture): Promise<RetainedRenovateRetryTarget[]> {
    const capture = this.prospectiveObservationCapture(observation);
    try { return await captureRawInteraction(capture, 'registry-retained-targets', () => ({ registrationId }), async () => {
    const current = await this.currentProspectiveRenovateRegistration(registrationId, observation);
    if (!current) return [];
    capture?.record('registry-retained-admissions-request', () => ({ prefix: 'renovate-activity:' }));
    const admissions = await this.ctx.storage.list<ProspectiveAdmission>({ prefix: 'renovate-activity:' });
    capture?.record('registry-retained-admissions', () => [...admissions].filter(([, admission]) => admission.ownerKey === observation?.binding.ownerKey));
    try { await capture?.flush?.(); } catch { /* Keep the existing history scan. */ }
    const targets: RetainedRenovateRetryTarget[] = [];
    for (const admission of admissions.values()) {
      const created = prospectiveRenovateTimestamp(admission.createdAt);
      const cutoff = prospectiveRenovateTimestamp(current.activatedAt);
      if (created === null || cutoff === null || created <= cutoff
        || admission.installationId !== current.installationId || admission.repositoryId !== current.repositoryId
        || admission.repository !== current.repository || admission.baseBranch !== current.baseBranch) continue;
      const latest = await this.ctx.storage.get<ProspectiveAdmission>(
        `renovate-admission:${admission.repositoryId}:${admission.pullRequest}:${admission.head}`);
      capture?.record('registry-retained-head', () => ({ request: { repositoryId: admission.repositoryId,
        pullRequest: admission.pullRequest, head: admission.head }, value: !latest || latest.ownerKey === observation?.binding.ownerKey ? latest : { foreignOwner: true } }));
      if (latest?.activityId !== admission.activityId) continue;
      const proof = await this.prospectiveRetryProof(admission, admission.ownerKey === observation?.binding.ownerKey ? capture : undefined,
        admission.ownerKey === observation?.binding.ownerKey ? observation : undefined);
      if (proof && this.prospectiveRetryDue(admission, proof, current.repetitionIntervalSeconds)) {
        targets.push({ repositoryId: admission.repositoryId, pullRequest: admission.pullRequest,
          head: admission.head, createdAt: admission.createdAt });
      }
    }
    return await this.currentProspectiveRenovateRegistration(registrationId, observation) ? targets : [];
    }); } finally { try { await capture?.finish('complete'); } catch { /* Preserve retained targets. */ } }
  }

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
