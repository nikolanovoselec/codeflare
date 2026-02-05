/**
 * JWT verification module for Cloudflare Access tokens.
 * Uses Web Crypto API (available in Cloudflare Workers) for RS256 verification.
 */

// Types
interface JWTHeader {
  alg: string;
  kid: string;
  typ: string;
}

interface JWTPayload {
  aud: string[];
  email: string;
  exp: number;
  iat: number;
  nbf?: number;
  iss: string;
  sub: string;
  type: string;
  country: string;
}

interface JWKS {
  keys: JWK[];
}

interface JWK {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg: string;
  use: string;
}

// Module-level JWKS cache
let cachedJWKS: JWKS | null = null;
let cachedJWKSAuthDomain: string | null = null;
let cacheExpiry: number = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Track when JWKS was last fetched for cache-bust on kid miss
let lastJWKSFetchTime: number = 0;
const JWKS_FRESHNESS_THRESHOLD = 30 * 1000; // 30 seconds

// Promise deduplication: if a JWKS fetch is already in progress, reuse it
let pendingJWKSFetch: Promise<JWKS> | null = null;

/**
 * Base64url decode a string to Uint8Array.
 * Handles the URL-safe alphabet and padding.
 */
function base64UrlDecode(str: string): Uint8Array {
  // Replace URL-safe characters with standard base64
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if needed
  const pad = base64.length % 4;
  if (pad === 2) {
    base64 += '==';
  } else if (pad === 3) {
    base64 += '=';
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Fetch and cache JWKS from Cloudflare Access.
 * Fetches from https://{authDomain}/cdn-cgi/access/certs
 * Caches for 1 hour, invalidates if authDomain changes.
 */
async function getPublicKeys(authDomain: string): Promise<JWKS> {
  const now = Date.now();

  // Return cached keys if valid and same auth domain
  if (cachedJWKS && cachedJWKSAuthDomain === authDomain && now < cacheExpiry) {
    return cachedJWKS;
  }

  // If a fetch is already in progress for the same domain, reuse it
  // This prevents thundering herd when multiple concurrent requests
  // all discover an expired cache at the same time
  if (pendingJWKSFetch && cachedJWKSAuthDomain === authDomain) {
    return pendingJWKSFetch;
  }

  const url = `https://${authDomain}/cdn-cgi/access/certs`;

  pendingJWKSFetch = (async () => {
    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`Failed to fetch JWKS from ${url}: ${response.status}`);
      }

      const jwks = (await response.json()) as JWKS;

      // Update cache
      cachedJWKS = jwks;
      cachedJWKSAuthDomain = authDomain;
      cacheExpiry = Date.now() + CACHE_TTL;
      lastJWKSFetchTime = Date.now();

      return jwks;
    } finally {
      pendingJWKSFetch = null;
    }
  })();

  // Update domain tracker so concurrent callers can match
  cachedJWKSAuthDomain = authDomain;

  return pendingJWKSFetch;
}

/**
 * Verify a Cloudflare Access JWT token.
 *
 * @param token - The JWT string from cf-access-jwt-assertion header
 * @param authDomain - The CF Access auth domain (e.g., "myteam.cloudflareaccess.com")
 * @param expectedAud - The expected audience tag from the Access application
 * @returns The verified email address, or null if verification fails
 */
export async function verifyAccessJWT(
  token: string,
  authDomain: string,
  expectedAud: string
): Promise<string | null> {
  try {
    // 1. Split token into header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // 2. Decode header, find matching key by kid
    const headerJson = new TextDecoder().decode(base64UrlDecode(headerB64));
    const header = JSON.parse(headerJson) as JWTHeader;

    if (header.alg !== 'RS256') {
      return null;
    }

    let jwks = await getPublicKeys(authDomain);
    let matchingKey = jwks.keys.find((key) => key.kid === header.kid);

    // SEC8: Cache-bust on kid miss — re-fetch JWKS if cache is stale
    if (!matchingKey && Date.now() - lastJWKSFetchTime > JWKS_FRESHNESS_THRESHOLD) {
      cachedJWKS = null;
      jwks = await getPublicKeys(authDomain);
      matchingKey = jwks.keys.find((key) => key.kid === header.kid);
    }

    if (!matchingKey) {
      return null;
    }

    // 3. Import public key using Web Crypto (RS256 / RSASSA-PKCS1-v1_5 with SHA-256)
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: matchingKey.kty,
        n: matchingKey.n,
        e: matchingKey.e,
        alg: matchingKey.alg,
        use: matchingKey.use,
      },
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['verify']
    );

    // 4. Verify signature using crypto.subtle.verify
    const signatureBytes = base64UrlDecode(signatureB64);
    const dataToVerify = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    const isValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signatureBytes,
      dataToVerify
    );

    if (!isValid) {
      return null;
    }

    // 5. Decode and validate claims
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    const payload = JSON.parse(payloadJson) as JWTPayload;

    const now = Math.floor(Date.now() / 1000);

    // Check audience
    if (!payload.aud || !payload.aud.includes(expectedAud)) {
      return null;
    }

    // Check issuer
    const expectedIssuer = `https://${authDomain}`;
    if (!payload.iss || payload.iss !== expectedIssuer) {
      return null;
    }

    // Check expiration
    if (!payload.exp || payload.exp <= now) {
      return null;
    }

    // Check issued at
    if (!payload.iat || payload.iat > now) {
      return null;
    }

    // Check not-before (SEC7)
    if (payload.nbf !== undefined && payload.nbf > now) {
      return null;
    }

    // 6. Return email if all checks pass
    return payload.email || null;
  } catch {
    // Any error during verification means the token is invalid
    return null;
  }
}

/**
 * Reset the JWKS cache. Primarily for testing.
 */
export function resetJWKSCache(): void {
  cachedJWKS = null;
  cachedJWKSAuthDomain = null;
  cacheExpiry = 0;
  pendingJWKSFetch = null;
  lastJWKSFetchTime = 0;
}
