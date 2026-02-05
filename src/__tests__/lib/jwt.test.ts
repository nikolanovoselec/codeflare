import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyAccessJWT, resetJWKSCache } from '../../lib/jwt';

/**
 * Test helpers for generating RSA key pairs and signing JWTs
 * using Web Crypto API (available in Cloudflare Workers runtime).
 */

interface TestJWK extends JsonWebKey {
  kid: string;
}

interface TestKeyPair {
  privateKey: CryptoKey;
  publicKeyJWK: TestJWK;
  kid: string;
}

async function generateTestKeyPair(kid: string = 'test-kid-1'): Promise<TestKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  ) as CryptoKeyPair;

  const publicKeyJWK = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

  return {
    privateKey: keyPair.privateKey,
    publicKeyJWK: { ...publicKeyJWK, kid, alg: 'RS256', use: 'sig' } as TestJWK,
    kid,
  };
}

function base64UrlEncode(data: Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = data;
  }

  const binary = String.fromCharCode(...bytes);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function createTestJWT(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string
): Promise<string> {
  const header = { alg: 'RS256', kid, typ: 'JWT' };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));

  const dataToSign = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, dataToSign);

  const signatureB64 = base64UrlEncode(new Uint8Array(signature));

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

function createMockJWKSResponse(publicKeyJWKs: TestJWK[]) {
  const keys = publicKeyJWKs.map((jwk) => ({
    kid: jwk.kid,
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
    alg: jwk.alg || 'RS256',
    use: jwk.use || 'sig',
  }));

  return { keys };
}

// Shared test fixtures
const TEST_AUTH_DOMAIN = 'test-team.cloudflareaccess.com';
const TEST_AUD = 'test-audience-tag-12345';
const TEST_EMAIL = 'user@example.com';

describe('JWT verification', () => {
  let testKeyPair: TestKeyPair;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    resetJWKSCache();
    testKeyPair = await generateTestKeyPair();

    // Save original fetch and mock it
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      if (url === `https://${TEST_AUTH_DOMAIN}/cdn-cgi/access/certs`) {
        const jwksResponse = createMockJWKSResponse([testKeyPair.publicKeyJWK]);
        return new Response(JSON.stringify(jwksResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('Not Found', { status: 404 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetJWKSCache();
  });

  describe('verifyAccessJWT', () => {
    it('returns email for a valid JWT', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          email: TEST_EMAIL,
          exp: now + 3600,
          iat: now - 60,
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBe(TEST_EMAIL);
    });

    it('returns null for an expired JWT', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          email: TEST_EMAIL,
          exp: now - 100, // expired
          iat: now - 3700,
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for wrong audience', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: ['wrong-audience'],
          email: TEST_EMAIL,
          exp: now + 3600,
          iat: now - 60,
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for invalid signature', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          email: TEST_EMAIL,
          exp: now + 3600,
          iat: now - 60,
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      // Tamper with the signature by modifying the last part
      const parts = token.split('.');
      const tamperedSignature = parts[2].substring(0, parts[2].length - 4) + 'AAAA';
      const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSignature}`;

      const result = await verifyAccessJWT(tamperedToken, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for a token signed with a different key', async () => {
      const differentKeyPair = await generateTestKeyPair('different-kid');

      // Mock JWKS to only contain the original key (not the different one)
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          email: TEST_EMAIL,
          exp: now + 3600,
          iat: now - 60,
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        differentKeyPair.privateKey,
        differentKeyPair.kid
      );

      // JWKS only has the original key, not the different one
      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for a malformed token (missing parts)', async () => {
      const result = await verifyAccessJWT('not.a.valid.jwt.token', TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for a token with only two parts', async () => {
      const result = await verifyAccessJWT('header.payload', TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for an empty string', async () => {
      const result = await verifyAccessJWT('', TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for a token with iat in the future', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          email: TEST_EMAIL,
          exp: now + 7200,
          iat: now + 3600, // issued in the future
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for a token with nbf in the future', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          email: TEST_EMAIL,
          exp: now + 7200,
          iat: now - 60,
          nbf: now + 3600, // not valid yet
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns email for a token with nbf in the past', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          email: TEST_EMAIL,
          exp: now + 3600,
          iat: now - 120,
          nbf: now - 60, // already valid
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBe(TEST_EMAIL);
    });

    it('returns null for a token with no email', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          exp: now + 3600,
          iat: now - 60,
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
          // email intentionally omitted
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for missing issuer', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          email: TEST_EMAIL,
          exp: now + 3600,
          iat: now - 60,
          // iss intentionally omitted
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns null for wrong issuer', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: [TEST_AUD],
          email: TEST_EMAIL,
          exp: now + 3600,
          iat: now - 60,
          iss: 'https://wrong-team.cloudflareaccess.com',
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBeNull();
    });

    it('returns email when aud is an array containing the expected aud among others', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT(
        {
          aud: ['other-aud', TEST_AUD, 'another-aud'],
          email: TEST_EMAIL,
          exp: now + 3600,
          iat: now - 60,
          iss: `https://${TEST_AUTH_DOMAIN}`,
          sub: 'user-id-123',
          type: 'app',
          country: 'US',
        },
        testKeyPair.privateKey,
        testKeyPair.kid
      );

      const result = await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      expect(result).toBe(TEST_EMAIL);
    });
  });

  describe('JWKS caching', () => {
    it('caches JWKS and reuses on second call', async () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        aud: [TEST_AUD],
        email: TEST_EMAIL,
        exp: now + 3600,
        iat: now - 60,
        iss: `https://${TEST_AUTH_DOMAIN}`,
        sub: 'user-id-123',
        type: 'app',
        country: 'US',
      };

      const token1 = await createTestJWT(payload, testKeyPair.privateKey, testKeyPair.kid);
      const token2 = await createTestJWT(payload, testKeyPair.privateKey, testKeyPair.kid);

      await verifyAccessJWT(token1, TEST_AUTH_DOMAIN, TEST_AUD);
      await verifyAccessJWT(token2, TEST_AUTH_DOMAIN, TEST_AUD);

      // fetch should have been called only once for JWKS
      const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const jwksCalls = fetchCalls.filter((call) => {
        const url = typeof call[0] === 'string' ? call[0] : call[0] instanceof URL ? call[0].toString() : call[0].url;
        return url.includes('/cdn-cgi/access/certs');
      });
      expect(jwksCalls.length).toBe(1);
    });

    it('resetJWKSCache causes re-fetch', async () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        aud: [TEST_AUD],
        email: TEST_EMAIL,
        exp: now + 3600,
        iat: now - 60,
        iss: `https://${TEST_AUTH_DOMAIN}`,
        sub: 'user-id-123',
        type: 'app',
        country: 'US',
      };

      const token1 = await createTestJWT(payload, testKeyPair.privateKey, testKeyPair.kid);
      const token2 = await createTestJWT(payload, testKeyPair.privateKey, testKeyPair.kid);

      await verifyAccessJWT(token1, TEST_AUTH_DOMAIN, TEST_AUD);
      resetJWKSCache();
      await verifyAccessJWT(token2, TEST_AUTH_DOMAIN, TEST_AUD);

      // fetch should have been called twice for JWKS
      const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const jwksCalls = fetchCalls.filter((call) => {
        const url = typeof call[0] === 'string' ? call[0] : call[0] instanceof URL ? call[0].toString() : call[0].url;
        return url.includes('/cdn-cgi/access/certs');
      });
      expect(jwksCalls.length).toBe(2);
    });

    it('invalidates cache when auth domain changes', async () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        aud: [TEST_AUD],
        email: TEST_EMAIL,
        exp: now + 3600,
        iat: now - 60,
        iss: `https://${TEST_AUTH_DOMAIN}`,
        sub: 'user-id-123',
        type: 'app',
        country: 'US',
      };

      const token = await createTestJWT(payload, testKeyPair.privateKey, testKeyPair.kid);

      // Update mock to also respond to a different domain
      const differentDomain = 'other-team.cloudflareaccess.com';
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/cdn-cgi/access/certs')) {
          const jwksResponse = createMockJWKSResponse([testKeyPair.publicKeyJWK]);
          return new Response(JSON.stringify(jwksResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof globalThis.fetch;

      // First call with original domain
      await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      // Second call with different domain - should re-fetch
      await verifyAccessJWT(token, differentDomain, TEST_AUD);

      const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const jwksCalls = fetchCalls.filter((call) => {
        const url = typeof call[0] === 'string' ? call[0] : call[0] instanceof URL ? call[0].toString() : call[0].url;
        return url.includes('/cdn-cgi/access/certs');
      });
      expect(jwksCalls.length).toBe(2);
    });

    it('re-fetches JWKS when kid not found and cache is stale', async () => {
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        aud: [TEST_AUD],
        email: TEST_EMAIL,
        exp: now + 3600,
        iat: now - 60,
        iss: `https://${TEST_AUTH_DOMAIN}`,
        sub: 'user-id-123',
        type: 'app',
        country: 'US',
      };

      // Generate a second key pair with a different kid
      const secondKeyPair = await generateTestKeyPair('rotated-kid');

      // First call: mock only returns the original key (caches JWKS without rotated-kid)
      const token1 = await createTestJWT(payload, testKeyPair.privateKey, testKeyPair.kid);
      await verifyAccessJWT(token1, TEST_AUTH_DOMAIN, TEST_AUD);

      // Now create a token signed with the rotated key
      const token2 = await createTestJWT(payload, secondKeyPair.privateKey, secondKeyPair.kid);

      // Update fetch mock to return BOTH keys (simulates Cloudflare key rotation)
      let fetchCallCount = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url === `https://${TEST_AUTH_DOMAIN}/cdn-cgi/access/certs`) {
          const jwksResponse = createMockJWKSResponse([testKeyPair.publicKeyJWK, secondKeyPair.publicKeyJWK]);
          return new Response(JSON.stringify(jwksResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof globalThis.fetch;

      // Simulate stale cache by advancing time past the freshness threshold (30s)
      const originalDateNow = Date.now;
      let timeOffset = 0;
      globalThis.Date.now = () => originalDateNow() + timeOffset;
      timeOffset = 31 * 1000; // 31 seconds past freshness threshold

      try {
        // This should trigger cache-bust: kid 'rotated-kid' not in cached JWKS, cache is stale
        const result = await verifyAccessJWT(token2, TEST_AUTH_DOMAIN, TEST_AUD);
        expect(result).toBe(TEST_EMAIL);

        // Verify that a re-fetch happened
        const newFetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
        const jwksCalls = newFetchCalls.filter((call) => {
          const url = typeof call[0] === 'string' ? call[0] : call[0] instanceof URL ? call[0].toString() : call[0].url;
          return url.includes('/cdn-cgi/access/certs');
        });
        expect(jwksCalls.length).toBe(1); // re-fetched once with the new mock
      } finally {
        globalThis.Date.now = originalDateNow;
      }
    });
  });
});
