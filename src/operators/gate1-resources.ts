import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { ValidationError } from '../lib/error-types';
import { parseOperatorContainerProfile, type OperatorContainerProfile } from '../container/operator-context';
import { parseOperatorConsumerInvocation, type OperatorConsumerInvocation } from './consumer-contracts';
import { resolveOperatorInference, type EffectiveOperatorInference, type EligibleInference } from './inference-selection';
import { decideOperatorStorage } from './interception-policy';
import { parseOperatorPolicy, type OperatorPolicy } from './policy';

export const GATE1_OPERATOR_ID = 'codeflare-gate1-fixture';
const GATE1_SESSION_PROFILE_ID = 'gate1-pi-file-v1';
const GATE1_STORAGE_SCOPE_ID = 'gate1-output-v1';
const OUTPUT_ROOT = 'Operators/';
const MARKER_DIRECTORY = 'Gate 1';
const MARKER_CONTENT = 'codeflare-gate1-marker-v1';

export interface Gate1Resources {
  profile: OperatorContainerProfile;
  effectiveInference: EffectiveOperatorInference;
  marker: { relativePath: string; storagePath: string; content: string; sha256: string };
}

export interface Gate1ResourceInput {
  invocation: OperatorConsumerInvocation;
  operatorId: string;
  activityId: string;
  ownerBucket: string;
  policy: OperatorPolicy;
  policyDigest: string;
  deadline: number;
  human: VerifiedHumanAccessClaims;
  eligibleInference: EligibleInference;
}

function invalid(): never {
  throw new ValidationError('Invalid Gate 1 resources');
}

async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** One code-owned acceptance profile; consumer handles select it but never supply its authority. */
export async function resolveGate1Resources(input: Gate1ResourceInput): Promise<Gate1Resources> {
  const invocation = parseOperatorConsumerInvocation(input.invocation);
  const policy = parseOperatorPolicy(input.policy);
  const scenario = invocation.input && typeof invocation.input === 'object' && !Array.isArray(invocation.input)
    ? (invocation.input as { scenario?: unknown }).scenario : undefined;
  if (input.operatorId !== GATE1_OPERATOR_ID || invocation.operatorId !== input.operatorId
    || invocation.activityId !== input.activityId || invocation.consumerId !== 'gate1-acceptance'
    || invocation.source.kind !== 'direct' || invocation.source.reference !== 'gate1-session-smoke'
    || invocation.revision.reference !== 'gate1-v1' || scenario !== 'session-smoke'
    || invocation.resources.session?.profileId !== GATE1_SESSION_PROFILE_ID
    || invocation.resources.storage?.scopeId !== GATE1_STORAGE_SCOPE_ID
    || !invocation.resources.inference) invalid();
  const authorityDeadline = input.human.expiresAt * 1000;
  if (!Number.isFinite(input.deadline) || input.deadline <= Date.now() || input.deadline > authorityDeadline
    || authorityDeadline <= Date.now()) throw new ValidationError('Gate 1 authority expired');

  const effectiveInference = resolveOperatorInference({
    eligible: input.eligibleInference,
    policy,
    trusted: invocation.resources.inference,
  });
  const sessionId = `gate1${(await sha256(input.activityId)).slice(0, 16)}`;
  const outputPrefix = OUTPUT_ROOT;
  const relativePath = `${MARKER_DIRECTORY}/gate1-marker-${input.activityId}.txt`;
  const storagePath = `${outputPrefix}${relativePath}`;
  const localMarkerPath = `/home/user/${storagePath}`;
  if (!decideOperatorStorage(policy, 'write', storagePath).allowed
    || !decideOperatorStorage(policy, 'read', storagePath).allowed) invalid();

  let issuer: string;
  try { issuer = new URL(input.human.issuer).href; } catch { invalid(); }
  const profile = parseOperatorContainerProfile({
    schemaVersion: 1,
    activityId: input.activityId,
    operatorId: input.operatorId,
    sessionId,
    ownerBucket: input.ownerBucket,
    policyDigest: input.policyDigest,
    deadline: input.deadline,
    outputPrefix,
    human: { subject: input.human.subject, email: input.human.email.toLowerCase(), issuer,
      audiences: [...input.human.audiences] },
    policy,
    jwtPolicy: { mode: 'off', destinations: [] },
    piProfile: {
      provider: 'codeflare-gateway',
      model: effectiveInference.routeId,
      thinkingLevel: effectiveInference.reasoningLevel ?? 'off',
      systemPrompt: 'Gate 1 uses the approved native Pi write tool through the structured operator interface.',
      tools: ['write'],
    },
  });
  return { profile, effectiveInference, marker: { relativePath, storagePath,
    content: MARKER_CONTENT, sha256: await sha256(MARKER_CONTENT) } };
}
