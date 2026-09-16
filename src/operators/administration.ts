/**
 * Registration orchestration
 * Registration, explicit discovery and digest-confirmed approval compose the lower-level services.
 * Callers establish human/admin authorization; this file checks expiry around protected I/O.
 * Network work stays outside registry transactions. No child code executes during administration.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../lib/error-types';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import type { OperatorRegistry } from './registry';
import { fetchOperatorManifest, fetchOperatorBundle } from './distribution-client';
import { openOperatorSecret } from './protected-secrets';
import { parseOperatorPolicy } from './policy';

/** Authenticated human-admin context supplied by the parent, never by the child. */
interface AdministrationContext {
  registry: Pick<OperatorRegistry, 'register' | 'getProtectedDistribution' | 'approveManifest'>;
  human: VerifiedHumanAccessClaims;
  accessJwt: string;
  encryption: { ENCRYPTION_KEY?: string };
}
function requireCurrentAuthority(context: AdministrationContext): void {
  if (!Number.isFinite(context.human.expiresAt) || context.human.expiresAt * 1000 <= Date.now()) {
    throw new ForbiddenError('Human authority expired');
  }
}

/**
 * REQ-OPERATOR-002: Authenticated discovery followed by atomic disabled registration.
 * Caller establishes enterprise/admin authorization and matching human identity.
 * Validate policy before network work; never execute discovered code or implicitly
 * approve it. Discovery failure leaves no registration. No HTTP framework dependency.
 */
export async function registerDiscoveredOperator(context: AdministrationContext, input: {
  endpoint: string; connectionSecret: string; policy: unknown;
}) {
  requireCurrentAuthority(context);
  const policy = parseOperatorPolicy(input.policy);
  const manifest = await fetchOperatorManifest(input.endpoint, { human: context.human,
    accessJwt: context.accessJwt, connectionSecret: input.connectionSecret });
  requireCurrentAuthority(context);
  return await context.registry.register(input.endpoint, input.connectionSecret, JSON.stringify(manifest), JSON.stringify(policy));
}

/** Explicit authenticated inspection; it neither persists approval nor executes code. */
export async function discoverRegisteredOperator(context: AdministrationContext, operatorId: string) {
  const { manifest } = await inspectRegisteredOperator(context, operatorId);
  return { manifestJson: JSON.stringify(manifest) };
}

/** Parent-only shared transport context for inspection and approval. */
async function inspectRegisteredOperator(context: AdministrationContext, operatorId: string) {
  requireCurrentAuthority(context);
  const distribution = await context.registry.getProtectedDistribution(operatorId);
  if (!distribution) throw new NotFoundError('Operator distribution');
  const connectionSecret = await openOperatorSecret(distribution.connectionSecretCiphertext, context.encryption,
    { purpose: 'connection', recordId: operatorId });
  const credentials = { human: context.human, accessJwt: context.accessJwt, connectionSecret };
  const manifest = await fetchOperatorManifest(distribution.endpoint, credentials);
  if (manifest.id !== operatorId) throw new ValidationError('Operator identity does not match registration');
  requireCurrentAuthority(context);
  return { manifest, distribution, credentials };
}

/**
 * Authenticate fresh metadata and exact requested artifact before revision-checked
 * approval. The advertised digest must equal the administrator's explicit choice;
 * no substitution, implicit enablement, loader call or retry. Current endpoint and
 * encrypted connection secret are parent-read; no agent-selected credentials/bucket.
 */
export async function approveRegisteredOperator(context: AdministrationContext, input: {
  operatorId: string; expectedRevision: number; artifactDigest: string;
}) {
  const { manifest, distribution, credentials } = await inspectRegisteredOperator(context, input.operatorId);
  if (manifest.artifact.sha256 !== input.artifactDigest) {
    throw new AppError('CONFLICT', 409, 'Operator artifact changed; review the advertised version');
  }
  await fetchOperatorBundle(distribution.endpoint, manifest, credentials);
  requireCurrentAuthority(context);
  return await context.registry.approveManifest(input.operatorId, JSON.stringify(manifest), input.expectedRevision);
}
