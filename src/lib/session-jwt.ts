/**
 * HMAC-SHA256 session JWT for GitHub OIDC (SaaS mode).
 *
 * Symmetric signing — the Worker secret IS the key. No JWKS, no key rotation.
 * Used for the `codeflare_session` cookie. Separate from jwt.ts which handles
 * CF Access RS256 tokens for non-SaaS mode.
 */

const DEFAULT_TTL_SECONDS = 3600; // 1 hour
const HEADER_B64 = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/** Cached CryptoKey per secret string (module-level, same pattern as kv-crypto.ts) */
let cachedKey: CryptoKey | null = null;
let cachedKeySecret: string | null = null;

interface SessionJWTPayload {
  email: string;
  sub: string;
  ghLogin: string;
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
 */
export async function verifySessionJWT(
  token: string,
  secret: string,
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

  return payload;
}

const REFRESH_THRESHOLD_SECONDS = 15 * 60; // 15 minutes

/**
 * Check if a JWT should be refreshed (< 15 minutes remaining).
 */
export function shouldRefreshJWT(payload: SessionJWTPayload): boolean {
  const now = Math.floor(Date.now() / 1000);
  return payload.exp > now && (payload.exp - now) < REFRESH_THRESHOLD_SECONDS;
}
