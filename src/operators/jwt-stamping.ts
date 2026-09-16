/**
 * Automatic Access assertion policy and request preparation.
 *
 * This parent-only adapter normalizes Off/list/All configuration and decides
 * whether an HTTPS destination receives the already verified human assertion.
 * It strips caller-supplied assertion headers and preserves specialized
 * Authorization. It does not grant network access, follow redirects or renew JWTs.
 */
import { z } from 'zod';
import { ForbiddenError, ValidationError } from '../lib/error-types';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';

const destination = z.string().max(253).toLowerCase().refine(rule => {
  const host = rule.startsWith('*.') ? rule.slice(2) : rule;
  return host.includes('.') && !/^[\d.]+$/.test(host) && host.split('.')
    .every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
});
export const jwtStampingPolicySchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('off'), destinations: z.tuple([]) }),
  z.strictObject({ mode: z.literal('all'), destinations: z.tuple([]) }),
  z.strictObject({ mode: z.literal('list'), destinations: z.array(destination).min(1).max(128)
    .refine(values => new Set(values).size === values.length) }),
]);

export type JwtStampingPolicy = z.infer<typeof jwtStampingPolicySchema>;

export function parseJwtStampingPolicy(input: unknown): JwtStampingPolicy {
  try { return jwtStampingPolicySchema.parse(input); }
  catch { throw new ValidationError('Invalid automatic JWT stamping policy'); }
}

function match(rule: string, host: string): boolean {
  return rule.startsWith('*.') ? host !== rule.slice(2) && host.endsWith(`.${rule.slice(2)}`) : host === rule;
}

export function shouldStampAccessJwt(policy: JwtStampingPolicy, url: URL): boolean {
  if (url.protocol !== 'https:' || policy.mode === 'off') return false;
  if (policy.mode === 'all') return true;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return policy.destinations.some(rule => match(rule, host));
}

export function prepareJwtStampedRequest(request: Request, policy: JwtStampingPolicy,
  authority: { human: VerifiedHumanAccessClaims; accessJwt: string }): Request {
  const headers = new Headers(request.headers);
  headers.delete('cf-access-jwt-assertion');
  if (shouldStampAccessJwt(policy, new URL(request.url))) {
    if (!Number.isFinite(authority.human.expiresAt) || authority.human.expiresAt * 1000 <= Date.now()) {
      throw new ForbiddenError('Human authority expired');
    }
    if (!authority.accessJwt || new TextEncoder().encode(authority.accessJwt).byteLength > 64 * 1024) {
      throw new ForbiddenError('Human authority unavailable');
    }
    headers.set('cf-access-jwt-assertion', authority.accessJwt);
  }
  return new Request(request, { headers, redirect: 'manual' });
}
