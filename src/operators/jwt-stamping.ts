/**
 * Automatic Access assertion policy and request preparation.
 *
 * This parent-only adapter normalizes Off/list/All configuration and decides
 * whether an HTTPS destination receives the already verified human assertion.
 * It strips caller-supplied assertion headers and preserves specialized
 * Authorization. It does not grant network access, follow redirects or renew JWTs.
 */
import type { VerifiedHumanAccessClaims } from '../lib/jwt';

export type JwtStampingPolicy = { mode: 'off' | 'all'; destinations: [] }
  | { mode: 'list'; destinations: string[] };

export function parseJwtStampingPolicy(_input: unknown): JwtStampingPolicy {
  throw new Error('Not implemented');
}

export function shouldStampAccessJwt(_policy: JwtStampingPolicy, _url: URL): boolean {
  throw new Error('Not implemented');
}

export function prepareJwtStampedRequest(_request: Request, _policy: JwtStampingPolicy,
  _authority: { human: VerifiedHumanAccessClaims; accessJwt: string }): Request {
  throw new Error('Not implemented');
}
