import { z } from 'zod';
import type { Env } from '../types';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { AppError, ValidationError } from '../lib/error-types';
import { canInvokeOperator } from '../lib/access';
import { createOperatorExecutionContext, openOperatorExecutionAccess } from './execution-context';
import { openOperatorSecret } from './protected-secrets';
import { parseDispatcherBundle, parseOperatorBundle, parseOperatorManifest } from './distribution';
import { fetchOperatorBundle } from './distribution-client';
import { driveDispatcherRuntime, driveOperatorRuntime } from './runtime';
import { createOperatorIntentDigest, type BoundaryActivityBinding, type OperatorRuntimePlan } from './activity';
import type { ManagementAdmissionReceipt, ManagementExecutionSelection, OperatorAdmissionReceipt,
  OperatorExecutionSelection, OperatorRegistryResult } from './registry';
import { parseOperatorConsumerInvocation } from './consumer-contracts';
import { projectOperatorPackageResources } from './package-resources';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const invocationSchema = z.json();
const preparationSchema = z.union([
  z.strictObject({ operatorId: ID, invocation: invocationSchema }),
  z.strictObject({ installationId: ID, invocation: invocationSchema }),
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
  const bounded = boundedInvocation(parsed.data.invocation);
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
  const usesConsumerContract = managementSelection?.operator.profile === 'conductor';
  const invocation = usesConsumerContract
    ? (() => {
      const consumer = parseOperatorConsumerInvocation(bounded);
      if (consumer.operatorId !== operatorId) throw new ValidationError('Invalid operator invocation');
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
  const deadline = authority.human.expiresAt * 1000;
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
  const requestDeadline = Date.now() + 25_000;
  if (!env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY) return;
  const activity = env.OPERATOR_ACTIVITY.getByName(activityId);
  const plan = await activity.getRuntimePlan() as OperatorRuntimePlan | null;
  if (!plan) return;
  const attemptDeadline = Math.min(plan.deadline, requestDeadline);
  try {
    if (!env.LOADER) throw new Error('Operator Loader unavailable');
    const registry = env.OPERATOR_REGISTRY.getByName('registry');
    let bundle;
    if (isManagementReceipt(plan.receipt)) {
      const bytes = await registry.getManagementBundle(plan.receipt.selection.release.bundleDigest);
      if (!bytes) throw new Error('Pinned runtime input unavailable');
      if (plan.receipt.selection.operator.profile === 'dispatcher') {
        const artifactDigest = plan.receipt.selection.release.bundleDigest;
        const dispatcher = await parseDispatcherBundle(bytes, artifactDigest);
        if (dispatcher.sourceCommit !== plan.receipt.selection.release.sourceCommit) {
          throw new Error('Pinned Dispatcher source mismatch');
        }
        const driven = await driveDispatcherRuntime({ activity, deadline: attemptDeadline,
          bundle: dispatcher, artifactDigest, invocation: JSON.parse(plan.invocationJson), expectedGeneration });
        if (!driven.ok && driven.reason === 'authority-expired') await activity.fenceRuntimeFailure(expectedGeneration);
        return;
      }
      bundle = await parseOperatorBundle(bytes, plan.receipt.selection.release.bundleDigest);
      const resources = await projectOperatorPackageResources(bundle, plan.receipt.selection.release.bundleDigest);
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
      const resources = await projectOperatorPackageResources(bundle, plan.receipt.artifactDigest);
      if (resources) await activity.savePackageResources(resources);
    }
    const invocation = JSON.parse(plan.invocationJson) as unknown;
    const driven = await driveOperatorRuntime({ activity, activityId, deadline: attemptDeadline, loader: env.LOADER, bundle,
      invocation, expectedGeneration,
      bind: async (generation, driveDeadline) => ({ capability: bindCapability(activityId, generation, driveDeadline), outbound: null }),
    });
    if (!driven.ok && driven.reason === 'authority-expired') await activity.fenceRuntimeFailure(expectedGeneration);
  } catch {
    await activity.fenceRuntimeFailure(expectedGeneration).catch(() => {});
  }
}
