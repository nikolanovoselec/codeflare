import { CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER, ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER } from './constants';

type CloudflareCredentials = 'managed' | 'bearer' | 'key-email' | 'invalid';

/** Select credential ownership without looking up, refreshing or interpreting a token's account. */
export function classifyCloudflareCredentials(
  headers: Headers,
  gateway: boolean,
  placeholder: string,
): CloudflareCredentials {
  // Gateway Authorization belongs to the upstream provider, not to Cloudflare.
  const authorization = headers.get(gateway ? 'cf-aig-authorization' : 'authorization');
  const bearer = authorization?.match(/^Bearer[ \t]+([^\s,]+)$/i)?.[1];
  if (authorization !== null && !bearer) return 'invalid';
  if ((bearer === CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER || bearer === ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER)
    && bearer !== placeholder) return 'invalid';

  if (!gateway && (headers.has('x-auth-key') || headers.has('x-auth-email'))) {
    const key = headers.get('x-auth-key')?.trim();
    const email = headers.get('x-auth-email')?.trim();
    if (!key || !email || key === CLOUDFLARE_OAUTH_TOKEN_PLACEHOLDER || key === ENTERPRISE_BROWSER_TOKEN_PLACEHOLDER
      || /[\s,]/.test(key) || !/^[^\s@,]+@[^\s@,]+$/.test(email)) return 'invalid';
    // A managed placeholder may accompany the pair, but two real identities are ambiguous.
    return authorization === null || bearer === placeholder ? 'key-email' : 'invalid';
  }
  return authorization === null || bearer === placeholder ? 'managed' : 'bearer';
}
