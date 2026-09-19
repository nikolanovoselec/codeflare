/**
 * Parent-owned operator execution identity.
 *
 * Navigation: boundary validation and encrypted capture are followed by protected
 * reopening and same-owner reauthentication. Children receive only the safe
 * projection; the Access assertion and encryption master key remain parent-side.
 * This module does not admit work, select a registration or renew user authority.
 */
import { z } from 'zod';
import { ForbiddenError, ValidationError } from '../lib/error-types';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { openOperatorSecret, sealOperatorSecret } from './protected-secrets';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const claimsSchema = z.strictObject({
  subject: z.string().min(1).max(512), email: z.string().email().max(320), issuer: z.string().url().max(2048),
  audiences: z.array(z.string().min(1).max(512)).min(1).max(16),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
});
const protectedPayloadSchema = z.strictObject({
  activityId: idSchema, operatorId: idSchema, artifactDigest: digestSchema, policyDigest: digestSchema,
  human: claimsSchema, accessJwt: z.string().min(1).max(65536),
});

export interface OperatorExecutionContext {
  schemaVersion: 1;
  activityId: string;
  operatorId: string;
  principal: 'operator';
  owner: { subject: string; email: string; issuer: string; audiences: readonly string[] };
  artifactDigest: string;
  policyDigest: string;
  expiresAt: number;
  protectedAccessCiphertext: string;
}

export type OperatorExecutionProjection = Omit<OperatorExecutionContext, 'protectedAccessCiphertext'>;
type ProtectedPayload = z.infer<typeof protectedPayloadSchema>;

function parseCurrentPayload(input: unknown): ProtectedPayload {
  const parsed = protectedPayloadSchema.safeParse(input);
  if (!parsed.success || parsed.data.human.issuedAt > parsed.data.human.expiresAt
    || parsed.data.human.expiresAt * 1000 <= Date.now()
    || new TextEncoder().encode(parsed.data.accessJwt).byteLength > 64 * 1024) {
    throw new ValidationError('Invalid operator execution authority');
  }
  return parsed.data;
}
function ownerOf(human: VerifiedHumanAccessClaims): OperatorExecutionContext['owner'] {
  return { subject: human.subject, email: human.email, issuer: human.issuer, audiences: [...human.audiences] };
}
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function sameOwner(context: OperatorExecutionContext, human: VerifiedHumanAccessClaims): boolean {
  return context.owner.subject === human.subject && context.owner.email.toLowerCase() === human.email.toLowerCase()
    && context.owner.issuer === human.issuer && sameStrings(context.owner.audiences, human.audiences);
}
function payloadMatches(context: OperatorExecutionContext, payload: ProtectedPayload): boolean {
  return context.activityId === payload.activityId && context.operatorId === payload.operatorId
    && context.artifactDigest === payload.artifactDigest && context.policyDigest === payload.policyDigest
    && context.expiresAt === payload.human.expiresAt && sameOwner(context, payload.human);
}
async function decryptPayload(context: OperatorExecutionContext, env: { ENCRYPTION_KEY?: string }): Promise<ProtectedPayload> {
  const plaintext = await openOperatorSecret(context.protectedAccessCiphertext, env,
    { purpose: 'human-access', recordId: context.activityId });
  let decoded: unknown;
  try { decoded = JSON.parse(plaintext); } catch { throw new ValidationError('Operator secret protection failed'); }
  const result = protectedPayloadSchema.safeParse(decoded);
  if (!result.success || !payloadMatches(context, result.data)) throw new ValidationError('Operator secret protection failed');
  return result.data;
}

/** Capture a currently verified human assertion under the exact activity identity. */
export async function createOperatorExecutionContext(input: {
  activityId: string; operatorId: string; artifactDigest: string; policyDigest: string;
  human: VerifiedHumanAccessClaims; accessJwt: string;
}, env: { ENCRYPTION_KEY?: string }): Promise<OperatorExecutionContext> {
  const payload = parseCurrentPayload(input);
  const protectedAccessCiphertext = await sealOperatorSecret(JSON.stringify(payload), env,
    { purpose: 'human-access', recordId: payload.activityId });
  return { schemaVersion: 1, activityId: payload.activityId, operatorId: payload.operatorId, principal: 'operator',
    owner: ownerOf(payload.human), artifactDigest: payload.artifactDigest, policyDigest: payload.policyDigest,
    expiresAt: payload.human.expiresAt, protectedAccessCiphertext };
}

/** Reopen the assertion only for an exact, still-current parent-owned activity. */
export async function openOperatorExecutionAccess(context: OperatorExecutionContext,
  env: { ENCRYPTION_KEY?: string }): Promise<{ human: VerifiedHumanAccessClaims; accessJwt: string }> {
  const payload = await decryptPayload(context, env);
  if (payload.human.expiresAt * 1000 <= Date.now()) throw new ForbiddenError('Human authority expired');
  return { human: payload.human, accessJwt: payload.accessJwt };
}

/** Replace authority only when the same verified human and application reauthenticate. */
export async function reauthenticateOperatorExecution(context: OperatorExecutionContext,
  human: VerifiedHumanAccessClaims, accessJwt: string,
  env: { ENCRYPTION_KEY?: string }): Promise<OperatorExecutionContext> {
  await decryptPayload(context, env);
  if (!sameOwner(context, human)) throw new ForbiddenError('Operator activity owner mismatch');
  return createOperatorExecutionContext({ activityId: context.activityId, operatorId: context.operatorId,
    artifactDigest: context.artifactDigest, policyDigest: context.policyDigest, human, accessJwt }, env);
}

/** Public/child-safe identity projection; never includes credential material. */
export function projectOperatorExecution(context: OperatorExecutionContext): OperatorExecutionProjection {
  const { protectedAccessCiphertext: _protected, ...projection } = context;
  return { ...projection, owner: { ...projection.owner, audiences: [...projection.owner.audiences] } };
}
