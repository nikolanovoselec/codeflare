import { configuredRenovateInvocation, prospectiveRenovatePackageSupported } from './renovate-run-settings';
import { z } from 'zod';
import { captureError, type Boundary, type ReasonCode } from './dispatcher-diagnostics-wire';
import type { Env } from '../types';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { AppError, ValidationError } from '../lib/error-types';
import { getContainerId } from '../lib/container-helpers';
import { canInvokeOperator, loadEnterpriseRouteConfig, requireOperatorHumanContext,
  resolveBucketName, resolveSessionAccessGroup } from '../lib/access';
import { createOperatorExecutionContext, openOperatorExecutionAccess } from './execution-context';
import { openOperatorSecret } from './protected-secrets';
import { parseDispatcherBundle, parseOperatorBundle, parseOperatorManifest } from './distribution';
import { fetchOperatorBundle } from './distribution-client';
import { driveDispatcherRuntime, driveOperatorRuntime } from './runtime';
import { dispatcherCapacities, pickDispatcherCapacities } from './dispatcher-capacity-limits';
import { createOperatorIntentDigest, type BoundaryActivityBinding, type OperatorRuntimePlan } from './activity';
import type { ManagementAdmissionReceipt, ManagementExecutionSelection, OperatorAdmissionReceipt,
  OperatorExecutionSelection, OperatorRegistryResult } from './registry';
import { parseOperatorConsumerInvocation } from './consumer-contracts';
import { projectOperatorPackageResources, type OperatorPackageResourceProjection } from './package-resources';
import { bindClaimedConductorInvocation } from './conductor-production';
import { createOwnerNativePiProfileReader } from './native-pi-profile';
import { resolveOperatorInference, type NativeOperatorInference } from './inference-selection';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const invocationSchema = z.json();
const ownerSourceBody = z.strictObject({ sessionId: z.string().regex(/^[a-z0-9]{8,24}$/),
  sessionGeneration: z.number().int().positive().safe() }).optional();
const preparationSchema = z.union([
  z.strictObject({ operatorId: ID, invocation: invocationSchema }),
  z.strictObject({ installationId: ID, invocation: invocationSchema, sourceSession: ownerSourceBody }),
]);
const MAX_INVOCATION_BYTES = 64 * 1024;

function isManagementReceipt(receipt: OperatorAdmissionReceipt | ManagementAdmissionReceipt): receipt is ManagementAdmissionReceipt {
  return 'selection' in receipt;
}

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function capability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function boundedInvocation(value: unknown): unknown {
  const parsed = invocationSchema.safeParse(value);
  if (!parsed.success) throw new ValidationError('Invalid operator invocation');
  const json = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(json).byteLength > MAX_INVOCATION_BYTES) {
    throw new ValidationError('Operator invocation exceeds the size limit');
  }
  return JSON.parse(json) as unknown;
}
export interface PreparedOperatorActivity {
  activityId: string;
  startCapability: string;
  startExpiresAt: number;
}

/** Request-attached preparation only; it creates no scheduler or child session. */
export async function prepareOperatorActivity(input: unknown, authority: {
  human: VerifiedHumanAccessClaims; accessJwt: string;
}, env: Env, parentReservation?: { activityId: string; boundary?: BoundaryActivityBinding; expectedManagement?: {
  controlsRevision: number; installationRevision: number; operatorRevision: number;
  releaseId: string; bundleDigest: string;
} }): Promise<PreparedOperatorActivity> {
  const parsed = preparationSchema.safeParse(input);
  if (!parsed.success || !env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY
    || (parentReservation && !ID.safeParse(parentReservation.activityId).success)) {
    throw new ValidationError('Invalid operator activity request');
  }
  // Only the parent passes a Registry-reserved ID. The caller's invocation cannot choose it.
  const activityId = parentReservation?.activityId ?? crypto.randomUUID();
  let bounded = boundedInvocation(parsed.data.invocation);
  const registry = env.OPERATOR_REGISTRY.getByName('registry');
  const installationId = 'installationId' in parsed.data ? parsed.data.installationId : null;
  const requestedOperatorId = 'operatorId' in parsed.data ? parsed.data.operatorId : null;
  if (requestedOperatorId === 'codeflare-gate1-fixture') {
    throw new AppError('NOT_FOUND', 404, 'Operator is not available for execution');
  }
  let managementSelection: ManagementExecutionSelection | null = null;
  if (installationId) {
    const management: OperatorRegistryResult<ManagementExecutionSelection> =
      await registry.resolveManagementExecution(installationId);
    if (management.ok !== true) {
      throw new AppError('NOT_FOUND', 404, 'Operator installation is not available for execution');
    }
    const selection = management.value;
    const pinned = parentReservation?.expectedManagement;
    if (pinned && (selection.controlsRevision !== pinned.controlsRevision
      || selection.installation.revision !== pinned.installationRevision
      || selection.operator.revision !== pinned.operatorRevision
      || selection.release.id !== pinned.releaseId
      || selection.release.bundleDigest !== pinned.bundleDigest)) {
      throw new AppError('CONFLICT', 409, 'Operator installation changed during boundary preparation');
    }
    managementSelection = selection;
    if (!canInvokeOperator(authority.human, selection.operator)) {
      throw new AppError('NOT_FOUND', 404, 'Operator installation is not available for execution');
    }
  }
  const operatorId = managementSelection ? managementSelection.operator.operatorId : requestedOperatorId!;
  if (operatorId === 'codeflare-gate1-fixture') {
    throw new AppError('NOT_FOUND', 404, 'Operator is not available for execution');
  }
  const requiresSourceHost = managementSelection?.operator.profile === 'dispatcher'
    && managementSelection.operator.policy.capabilities.includes('inference')
    && managementSelection.installation.policy.capabilities.includes('inference');
  if (requiresSourceHost && !('sourceSession' in parsed.data && parsed.data.sourceSession)) {
    throw new ValidationError('Select an existing ordinary source Host before preparing configured inference');
  }
  let ownerSource: { bucket: string; sessionId: string; sessionGeneration: number } | undefined;
  if ('sourceSession' in parsed.data && parsed.data.sourceSession && managementSelection?.operator.profile === 'dispatcher') {
    const source = parsed.data.sourceSession;
    const bucket = await resolveBucketName(env, authority.human.email);
    const reference = { bucket, sessionId: source.sessionId, email: authority.human.email };
    const container = env.CONTAINER.getByName(getContainerId(bucket, source.sessionId)) as unknown as {
      getPersonalPiSession(input: typeof reference, ordinaryOnly?: boolean): Promise<{ generation: number }> };
    if ((await container.getPersonalPiSession(reference, true)).generation !== source.sessionGeneration) {
      throw new AppError('CONFLICT', 409, 'Owner source session changed');
    }
    ownerSource = { bucket, ...source };
  }
  if (managementSelection?.operator.profile === 'dispatcher' && prospectiveRenovatePackageSupported(managementSelection.manifestJson)) {
    bounded = configuredRenovateInvocation(managementSelection.installation.configurationJson, bounded);
  }
  const usesConsumerContract = managementSelection?.operator.profile === 'conductor';
  const deadline = authority.human.expiresAt * 1000;
  const invocation = usesConsumerContract
    ? await (async () => {
      const consumer = parseOperatorConsumerInvocation(bounded);
      if (consumer.operatorId !== operatorId) throw new ValidationError('Invalid operator invocation');
      const requested = consumer.resources.inference;
      // Verified boundary preparation already resolved its owner selection before reserving the Activity.
      if (requested && 'source' in requested && !parentReservation?.boundary) {
        const pinned = managementSelection!;
        if (Date.now() >= deadline) throw new AppError('FORBIDDEN', 403, 'Human authority expired');
        const ownerBucket = await resolveBucketName(env, authority.human.email);
        let selected: NativeOperatorInference | undefined;
        const authorizeInference = async () => {
          const request = new Request('https://operator.internal/', {
            headers: { 'cf-access-jwt-assertion': authority.accessJwt },
          });
          const current = await requireOperatorHumanContext(request, env, authority.human.email);
          if (current.human.subject !== authority.human.subject
            || current.human.email.toLowerCase() !== authority.human.email.toLowerCase()
            || current.human.issuer !== authority.human.issuer
            || JSON.stringify(current.human.audiences) !== JSON.stringify(authority.human.audiences)
            || Math.min(deadline, current.human.expiresAt * 1000) <= Date.now()) {
            throw new AppError('FORBIDDEN', 403, 'Conductor inference authority changed');
          }
          const latest = await registry.resolveManagementExecution(pinned.installation.id);
          if (!latest.ok || latest.value.controlsRevision !== pinned.controlsRevision
            || latest.value.installation.id !== pinned.installation.id
            || latest.value.installation.revision !== pinned.installation.revision
            || latest.value.operator.operatorId !== pinned.operator.operatorId
            || latest.value.operator.revision !== pinned.operator.revision
            || latest.value.operator.profile !== 'conductor'
            || latest.value.release.id !== pinned.release.id
            || latest.value.release.bundleDigest !== pinned.release.bundleDigest
            || !canInvokeOperator(current.human, latest.value.operator)
            || await resolveBucketName(env, current.human.email) !== ownerBucket) {
            throw new AppError('FORBIDDEN', 403, 'Conductor inference authority changed');
          }
          const groups = await resolveSessionAccessGroup(request, env);
          const eligible = await loadEnterpriseRouteConfig(env, groups);
          if (eligible.allowPersonalPiProviders !== true) {
            throw new AppError('FORBIDDEN', 403, 'Conductor native source unavailable');
          }
          for (const policy of [pinned.operator.policy, pinned.installation.policy,
            latest.value.operator.policy, latest.value.installation.policy]) {
            const restriction = policy.inference;
            if (!restriction?.allowedSources?.includes('pi-native')) {
              throw new AppError('FORBIDDEN', 403, 'Conductor native source not approved');
            }
            if (selected) {
              try { resolveOperatorInference({ policy: { inference: restriction }, trusted: selected,
                eligible: { routeIds: eligible.routeCatalog, defaultRouteId: eligible.defaultRoute,
                  defaultReasoningLevel: eligible.defaultReasoning, allowPersonalPiProviders: true } }); }
              catch { throw new ValidationError('Conductor native selection is not eligible'); }
            }
          }
          if (Date.now() >= deadline) throw new AppError('FORBIDDEN', 403, 'Human authority expired');
        };
        const reader = await createOwnerNativePiProfileReader({ env, ownerBucket, deadline, authorize: authorizeInference });
        selected = await reader.resolveSelection(pinned.installation.piReasoningOverride);
        if (requested.provider !== selected.provider || requested.model !== selected.model
          || requested.api !== selected.api || requested.reasoningLevel !== selected.reasoningLevel
          || requested.profileDigest !== selected.profileDigest) {
          throw new ValidationError('Conductor native selection conflicts with the owner profile');
        }
        await authorizeInference();
        consumer.resources.inference = selected;
      }
      return parseOperatorConsumerInvocation({ ...consumer, operatorId, activityId });
    })()
    : bounded;
  let legacySelection: OperatorExecutionSelection | null = null;
  if (!installationId) {
    const legacy = await registry.resolveForExecution(operatorId);
    if (!legacy.ok || !('value' in legacy)) {
      throw new AppError('CONFLICT', 409, 'Operator is not available for execution');
    }
    legacySelection = legacy.value;
  }
  const startCapability = capability();
  const startVerifier = await digest(startCapability);
  const startExpiresAt = Math.min(deadline, Date.now() + 5 * 60_000);
  const artifactDigest = managementSelection ? managementSelection.release.bundleDigest : legacySelection!.artifactDigest;
  const policyJson = managementSelection ? JSON.stringify(managementSelection.installation.policy) : legacySelection!.policyJson;
  const policyDigest = await digest(policyJson);
  const invocationJson = JSON.stringify(invocation);
  const intentDigest = await createOperatorIntentDigest(operatorId, activityId, invocationJson);
  const executionContext = await createOperatorExecutionContext({ activityId, operatorId,
    artifactDigest, policyDigest, human: authority.human, accessJwt: authority.accessJwt }, env);
  const intent = managementSelection ? {
    operatorId, installationId: installationId!, activityId, intentDigest,
    expectedRevision: managementSelection.operator.revision,
    expectedInstallationRevision: managementSelection.installation.revision,
    expectedControlsRevision: managementSelection.controlsRevision,
    deadline, startExpiresAt, startVerifier,
  } : { operatorId, activityId, intentDigest, expectedRevision: legacySelection!.revision,
    deadline, startExpiresAt, startVerifier };
  const activity = env.OPERATOR_ACTIVITY.getByName(activityId);
  const prepared = parentReservation?.boundary
    ? await activity.prepareAuthorized(intent, executionContext, invocationJson, parentReservation.boundary)
    : await activity.prepareAuthorized(intent, executionContext, invocationJson);
  if (!prepared.ok) throw new AppError('CONFLICT', 409, 'Operator activity could not be prepared');
  if (ownerSource && !await activity.bindDispatcherOwnerSource(ownerSource)) {
    throw new AppError('CONFLICT', 409, 'Owner source could not be bound');
  }
  return { activityId, startCapability, startExpiresAt };
}

function parsePinnedManifest(manifestJson: string, endpoint: string) {
  let stored: Record<string, unknown>;
  try {
    const value = JSON.parse(manifestJson) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manifest');
    stored = value as Record<string, unknown>;
  } catch { throw new ValidationError('Invalid pinned operator manifest'); }
  const storedArtifact = stored.artifact;
  if (!storedArtifact || typeof storedArtifact !== 'object' || Array.isArray(storedArtifact)) {
    throw new ValidationError('Invalid pinned operator manifest');
  }
  const { url, ...artifact } = storedArtifact as Record<string, unknown>;
  const manifest = parseOperatorManifest(JSON.stringify({ ...stored, artifact }), endpoint);
  if (url !== manifest.artifact.url) throw new ValidationError('Invalid pinned operator manifest');
  return manifest;
}

export type OperatorCapabilityBinder = (activityId: string, generation: number, driveDeadline: number) => Fetcher;
type OperatorRuntimeExports = { OperatorRuntimeCapability(input: {
  props: { activityId: string; generation: number; driveDeadline: number };
}): Fetcher };

/** Resolve the platform loopback export before an activity is allowed to start. */
export function bindOperatorRuntimeCapability(ctx: unknown): OperatorCapabilityBinder {
  const runtimeExports = (ctx as unknown as { exports?: OperatorRuntimeExports }).exports;
  if (!runtimeExports?.OperatorRuntimeCapability) {
    throw new AppError('UNAVAILABLE', 503, 'Operator runtime capability unavailable');
  }
  return (activityId, generation, driveDeadline) =>
    runtimeExports.OperatorRuntimeCapability({ props: { activityId, generation, driveDeadline } });
}

/** One request-attached direct drive. Any uncertain attempt is durably fenced and never replayed here. */
export async function runOperatorActivity(
  activityId: string,
  env: Env,
  bindCapability: OperatorCapabilityBinder,
  expectedGeneration?: number,
): Promise<void> {
  const requestedAt = Date.now();
  if (!env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY) return;
  const activity = env.OPERATOR_ACTIVITY.getByName(activityId);
  const plan = await activity.getRuntimePlan() as OperatorRuntimePlan | null;
  if (!plan) return;
  const capacityPolicy = isManagementReceipt(plan.receipt) && plan.receipt.selection.operator.profile === 'dispatcher'
    ? pickDispatcherCapacities(plan.receipt.selection.operator.policy) : undefined;
  const attemptDeadline = Math.min(plan.deadline,
    requestedAt + (capacityPolicy === undefined ? 25_000 : dispatcherCapacities(capacityPolicy).driveTimeoutMs));
  let failureBoundary: Boundary = 'construction';
  let failureCode: ReasonCode = 'startup-failed';
  try {
    if (!env.LOADER) throw new Error('Operator Loader unavailable');
    failureBoundary = 'artifact'; failureCode = 'artifact-unavailable';
    const registry = env.OPERATOR_REGISTRY.getByName('registry');
    let bundle;
    let resources: OperatorPackageResourceProjection | null = null;
    if (isManagementReceipt(plan.receipt)) {
      const bytes = await registry.getManagementBundle(plan.receipt.selection.release.bundleDigest);
      if (!bytes) throw new Error('Pinned runtime input unavailable');
      if (plan.receipt.selection.operator.profile === 'dispatcher') {
        const artifactDigest = plan.receipt.selection.release.bundleDigest;
        failureCode = 'artifact-mismatch';
        const dispatcher = await parseDispatcherBundle(bytes, artifactDigest);
        if (dispatcher.sourceCommit !== plan.receipt.selection.release.sourceCommit) {
          throw new Error('Pinned Dispatcher source mismatch');
        }
        failureBoundary = 'admission'; failureCode = 'admission-denied';
        const driven = await driveDispatcherRuntime({ activity, deadline: attemptDeadline,
          bundle: dispatcher, artifactDigest, invocation: JSON.parse(plan.invocationJson), expectedGeneration });
        if (!driven.ok && driven.reason === 'authority-expired') await activity.fenceRuntimeFailure(expectedGeneration,
          { boundary: 'admission', code: 'authority-expired' });
        return;
      }
      bundle = await parseOperatorBundle(bytes, plan.receipt.selection.release.bundleDigest);
      resources = await projectOperatorPackageResources(bundle, plan.receipt.selection.release.bundleDigest);
      if (resources) await activity.savePackageResources(resources);
    } else {
      const distribution = await registry.getPinnedDistribution(activityId);
      if (!distribution || !plan.receipt.manifestJson) throw new Error('Pinned runtime input unavailable');
      const authority = await openOperatorExecutionAccess(plan.executionContext, env);
      const connectionSecret = await openOperatorSecret(distribution.connectionSecretCiphertext, env,
        { purpose: 'connection', recordId: plan.receipt.operatorId });
      const manifest = parsePinnedManifest(plan.receipt.manifestJson, distribution.endpoint);
      if (manifest.id !== plan.receipt.operatorId || manifest.artifact.sha256 !== plan.receipt.artifactDigest) {
        throw new Error('Pinned runtime identity mismatch');
      }
      bundle = await fetchOperatorBundle(distribution.endpoint, manifest, { ...authority, connectionSecret },
        attemptDeadline);
      resources = await projectOperatorPackageResources(bundle, plan.receipt.artifactDigest);
      if (resources) await activity.savePackageResources(resources);
    }
    const invocation = JSON.parse(plan.invocationJson) as unknown;
    const driven = await driveOperatorRuntime({ activity, activityId, deadline: attemptDeadline, loader: env.LOADER, bundle,
      invocation, expectedGeneration, capacityPolicy,
      bind: async (generation, driveDeadline) => {
        if (isManagementReceipt(plan.receipt) && plan.receipt.selection.operator.profile === 'conductor') {
          const bound = await bindClaimedConductorInvocation({ env, plan, activity, resources, generation, driveDeadline });
          // Mutate only this drive's parsed copy, never the persisted invocation or intent digest.
          if (bound) Object.assign(invocation as object, bound);
        }
        return { capability: bindCapability(activityId, generation, driveDeadline), outbound: null };
      },
    });
    if (!driven.ok && driven.reason === 'authority-expired') await activity.fenceRuntimeFailure(expectedGeneration,
      { boundary: 'admission', code: 'authority-expired' });
  } catch (error) {
    // Sanitize the original throw at its actual host source before the existing fence transformation.
    await activity.fenceRuntimeFailure(expectedGeneration, { boundary: failureBoundary, code: failureCode,
      error: captureError(error) }).catch(() => {});
  }
}
