/**
 * HMAC-SHA256 session JWT for GitHub OIDC (SaaS mode).
 *
 * Symmetric signing - the Worker secret IS the key. No JWKS, no key rotation.
 * Used for the `codeflare_session` cookie. Separate from jwt.ts which handles
 * CF Access RS256 tokens for non-SaaS mode.
 */

const DEFAULT_TTL_SECONDS = 3600; // 1 hour

/**
 * Audience claim for session JWTs. Minted on new tokens and enforced on verify
 * whenever an expectedAud is supplied - a token with no `aud`, or a mismatched
 * `aud`, is rejected.
 */
export const SESSION_JWT_AUD = 'codeflare-session';
const HEADER_B64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Cached CryptoKey per secret string (module-level, same pattern as kv-crypto.ts) */
let cachedKey: CryptoKey | null = null;
let cachedKeySecret: string | null = null;

interface SessionJWTPayload {
  email: string;
  sub: string;
  ghLogin: string;
  aud?: string;
  iat: number;
  exp: number;
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey && cachedKeySecret === secret) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  cachedKeySecret = secret;
  return cachedKey;
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.byteLength; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad === 2) base64 += '==';
  else if (pad === 3) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Sign a session JWT with HMAC-SHA256.
 * Returns: base64url(header).base64url(payload).base64url(signature)
 */
export async function signSessionJWT(
  payload: Omit<SessionJWTPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: SessionJWTPayload = {
    ...payload,
    iat: now,
    exp: now + ttlSeconds,
  };

  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(fullPayload)));

  const signingInput = `${HEADER_B64}.${payloadB64}`;
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify and decode a session JWT.
 * Returns null if signature invalid, expired, or malformed.
 *
 * When `expectedAud` is provided, the token's `aud` must equal it - a token
 * with no `aud` claim is rejected. The 2-arg form (no `expectedAud`) skips the
 * audience check entirely, so callers that do not care about aud stay valid.
 */
export async function verifySessionJWT(
  token: string,
  secret: string,
  expectedAud?: string,
): Promise<SessionJWTPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  let key: CryptoKey;
  try {
    key = await getHmacKey(secret);
  } catch {
    return null;
  }

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = base64UrlDecode(signatureB64);
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes,
    new TextEncoder().encode(signingInput),
  );
  if (!valid) return null;

  let payload: SessionJWTPayload;
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return null;

  // Enforce audience whenever an expectedAud is set. A token with no aud claim,
  // or with a mismatched aud, is rejected - an aud is required once one is expected.
  if (expectedAud && payload.aud !== expectedAud) {
    return null;
  }

  return payload;
}

/**
 * Build the `; Domain=<host>` cookie attribute from the configured custom
 * domain. Returns '' when no custom domain is set so workers.dev / preview
 * deployments keep host-only cookies (a Domain attribute pinned to the wrong
 * host would silently drop the cookie). A leading-dot prefix is stripped - a
 * bare host scopes the cookie to that host and its subdomains.
 */
export function cookieDomainAttr(customDomain: string | null | undefined): string {
  if (!customDomain) return '';
  const host = customDomain.replace(/^\./, '').trim();
  if (!host) return '';
  return `; Domain=${host}`;
}

const REFRESH_THRESHOLD_SECONDS = 15 * 60; // 15 minutes

/**
 * Check if a JWT should be refreshed (< 15 minutes remaining).
 */
export function shouldRefreshJWT(payload: SessionJWTPayload): boolean {
  const now = Math.floor(Date.now() / 1000);
  return payload.exp > now && (payload.exp - now) < REFRESH_THRESHOLD_SECONDS;
}
