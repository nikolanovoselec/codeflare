/**
 * Parent-owned operator execution identity.
 *
 * Navigation: boundary validation and encrypted capture are followed by protected
 * reopening and same-owner reauthentication. Children receive only the safe
 * projection; the Access assertion and encryption master key remain parent-side.
 * This module does not admit work, select a registration or renew user authority.
 */
import type { VerifiedHumanAccessClaims } from '../lib/jwt';

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

/** Capture a currently verified human assertion under the exact activity identity. */
export async function createOperatorExecutionContext(_input: {
  activityId: string;
  operatorId: string;
  artifactDigest: string;
  policyDigest: string;
  human: VerifiedHumanAccessClaims;
  accessJwt: string;
}, _env: { ENCRYPTION_KEY?: string }): Promise<OperatorExecutionContext> {
  throw new Error('Not implemented');
}

/** Reopen the assertion only for an exact, still-current parent-owned activity. */
export async function openOperatorExecutionAccess(_context: OperatorExecutionContext,
  _env: { ENCRYPTION_KEY?: string }): Promise<{ human: VerifiedHumanAccessClaims; accessJwt: string }> {
  throw new Error('Not implemented');
}

/** Replace expired-soon authority only when the same verified human reauthenticates. */
export async function reauthenticateOperatorExecution(_context: OperatorExecutionContext,
  _human: VerifiedHumanAccessClaims, _accessJwt: string,
  _env: { ENCRYPTION_KEY?: string }): Promise<OperatorExecutionContext> {
  throw new Error('Not implemented');
}

/** Public/child-safe identity projection; never includes credential material. */
export function projectOperatorExecution(_context: OperatorExecutionContext): OperatorExecutionProjection {
  throw new Error('Not implemented');
}
