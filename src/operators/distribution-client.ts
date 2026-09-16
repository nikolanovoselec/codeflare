import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import type { OperatorManifest } from './distribution';

/** Parent-owned, already-verified human context; never expose to operator code. */
export interface OperatorDistributionCredentials {
  readonly human: VerifiedHumanAccessClaims;
  readonly accessJwt: string;
  readonly connectionSecret: string;
}

/** REQ-OPERATOR-010 transport boundary under behavioral TDD; not production-wired. */
export async function fetchOperatorManifest(
  _endpoint: string,
  _credentials: OperatorDistributionCredentials,
): Promise<OperatorManifest> {
  throw new Error('Operator discovery transport is not implemented');
}
