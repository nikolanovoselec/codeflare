/**
 * Shared operator restriction decisions for direct Worker and container transports.
 *
 * Navigation: normalized destination matching, specialized GitHub authorization,
 * and storage operation authorization. Inputs are already parent-bound policy and
 * canonical transport facts; no caller identity, credential lookup or forwarding
 * occurs here. Empty declarations deny and these decisions never grant human access.
 */
import type { OperatorPolicy } from './policy';

export type OperatorPolicyDecision = { allowed: true } | { allowed: false; reason: string };

/** General Internet decision; specialized GitHub/storage/inference destinations never fall through. */
export function decideOperatorNetwork(_policy: OperatorPolicy, _hostname: string): OperatorPolicyDecision {
  throw new Error('Not implemented');
}

/** Repository/method decision made before a GitHub credential can be resolved. */
export function decideOperatorGithub(_policy: OperatorPolicy, _request: Request): OperatorPolicyDecision {
  throw new Error('Not implemented');
}

export type OperatorStorageOperation = 'read' | 'list' | 'write' | 'multipart-write'
  | 'multipart-abort' | 'copy' | 'delete' | 'control';

/** Owner-relative canonical path decision; bucket and operation identity remain parent-bound. */
export function decideOperatorStorage(_policy: OperatorPolicy, _operation: OperatorStorageOperation,
  _path: string, _ownedMultipart = false): OperatorPolicyDecision {
  throw new Error('Not implemented');
}
