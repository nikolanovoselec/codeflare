import { z } from 'zod';
import type { Env } from '../types';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { AppError, ValidationError } from '../lib/error-types';
import { createOperatorExecutionContext, openOperatorExecutionAccess } from './execution-context';
import { openOperatorSecret } from './protected-secrets';
import { parseOperatorManifest } from './distribution';
import { fetchOperatorBundle } from './distribution-client';
import { driveOperatorRuntime } from './runtime';
import { createOperatorIntentDigest } from './activity';

const ID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const preparationSchema = z.strictObject({ operatorId: ID, invocation: z.json() });
const MAX_INVOCATION_BYTES = 64 * 1024;

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function capability(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function boundedInvocation(value: unknown): unknown {
  const parsed = preparationSchema.shape.invocation.safeParse(value);
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
}, env: Env): Promise<PreparedOperatorActivity> {
  const parsed = preparationSchema.safeParse(input);
  if (!parsed.success || !env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY) {
    throw new ValidationError('Invalid operator activity request');
  }
  const invocation = boundedInvocation(parsed.data.invocation);
  const registry = env.OPERATOR_REGISTRY.getByName('registry');
  const resolved = await registry.resolveForExecution(parsed.data.operatorId);
  if (!resolved.ok) throw new AppError('CONFLICT', 409, 'Operator is not available for execution');
  const activityId = crypto.randomUUID();
  const startCapability = capability();
  const startVerifier = await digest(startCapability);
  const deadline = authority.human.expiresAt * 1000;
  const startExpiresAt = Math.min(deadline, Date.now() + 5 * 60_000);
  const policyDigest = await digest(resolved.value.policyJson);
  const invocationJson = JSON.stringify(invocation);
  const intentDigest = await createOperatorIntentDigest(parsed.data.operatorId, activityId, invocationJson);
  const executionContext = await createOperatorExecutionContext({ activityId, operatorId: parsed.data.operatorId,
    artifactDigest: resolved.value.artifactDigest, policyDigest, human: authority.human,
    accessJwt: authority.accessJwt }, env);
  const prepared = await env.OPERATOR_ACTIVITY.getByName(activityId).prepareAuthorized({
    operatorId: parsed.data.operatorId, activityId, intentDigest, expectedRevision: resolved.value.revision,
    deadline, startExpiresAt, startVerifier,
  }, executionContext, invocationJson);
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

function denyByDefaultCapability(activityId: string, generation: number): Fetcher {
  return { fetch: async () => new Response(JSON.stringify({ error: 'Capability unavailable',
    code: 'OPERATOR_CAPABILITY_DENIED', activityId, generation }), {
    status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  }) } as unknown as Fetcher;
}

/** One request-attached direct drive. Any uncertain attempt is durably fenced and never replayed here. */
export async function runOperatorActivity(activityId: string, env: Env): Promise<void> {
  const requestDeadline = Date.now() + 25_000;
  if (!env.OPERATOR_REGISTRY || !env.OPERATOR_ACTIVITY) return;
  const activity = env.OPERATOR_ACTIVITY.getByName(activityId);
  const plan = await activity.getRuntimePlan();
  if (!plan) return;
  const attemptDeadline = Math.min(plan.deadline, requestDeadline);
  try {
    if (!env.LOADER) throw new Error('Operator Loader unavailable');
    const registry = env.OPERATOR_REGISTRY.getByName('registry');
    const distribution = await registry.getPinnedDistribution(activityId);
    if (!distribution || !plan.receipt.manifestJson) throw new Error('Pinned runtime input unavailable');
    const authority = await openOperatorExecutionAccess(plan.executionContext, env);
    const connectionSecret = await openOperatorSecret(distribution.connectionSecretCiphertext, env,
      { purpose: 'connection', recordId: plan.receipt.operatorId });
    const manifest = parsePinnedManifest(plan.receipt.manifestJson, distribution.endpoint);
    if (manifest.id !== plan.receipt.operatorId || manifest.artifact.sha256 !== plan.receipt.artifactDigest) {
      throw new Error('Pinned runtime identity mismatch');
    }
    const bundle = await fetchOperatorBundle(distribution.endpoint, manifest, { ...authority, connectionSecret },
      attemptDeadline);
    const driven = await driveOperatorRuntime({ activity, activityId, deadline: attemptDeadline, loader: env.LOADER, bundle,
      invocation: JSON.parse(plan.invocationJson) as unknown,
      bind: generation => ({ capability: denyByDefaultCapability(activityId, generation), outbound: null }),
    });
    if (!driven.ok && driven.reason === 'authority-expired') await activity.fenceRuntimeFailure();
  } catch {
    await activity.fenceRuntimeFailure().catch(() => {});
  }
}
