import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, type AuthVariables } from '../../middleware/auth';
import { AppError } from '../../lib/error-types';
import { verifyAccessJWT, verifyHumanAccessJWT, resetJWKSCache } from '../../lib/jwt';
import { authenticateRequest, getUserFromRequest, requireOperatorHumanContext, resetAuthConfigCache } from '../../lib/access';
import { createMockKV } from '../helpers/mock-kv';
import { SETUP_KEYS } from '../../lib/kv-keys';
import type { Env } from '../../types';

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

// REQ-AUTH-001: Two authentication modes

describe('JWT verification / REQ-AUTH-003 (CF Access JWT validation + JWKS caching)', () => {
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

  it.each([
    { label: 'first', logins: 1 },
    { label: 'concurrent first', logins: 2 },
  ])('REQ-AUTH-006 AC2 / REQ-ENTERPRISE-010 AC1/AC4: $label Access login normalizes identity before group-gated JIT persistence', async ({ logins }) => {
    resetAuthConfigCache();
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.AUTH_DOMAIN, TEST_AUTH_DOMAIN);
    kv._store.set(SETUP_KEYS.ACCESS_AUD, TEST_AUD);
    kv._store.set(SETUP_KEYS.ENTERPRISE_ACCESS_GROUP, 'engineers');
    const initialState = Object.fromEntries(kv._store);
    const userReads: string[] = [];
    const read = kv.get.getMockImplementation()!;
    kv.get.mockImplementation(async (key, type) => {
      if (key.startsWith('user:')) userReads.push(key);
      return read(key, type);
    });
    const owners = new Map<string, string>();
    const env = {
      KV: kv, ENTERPRISE_MODE: 'active', CLOUDFLARE_WORKER_NAME: 'codeflare',
      CONTAINER: {
        idFromName: (name: string) => name,
        get: (id: string) => ({ claimBucketOwner: async (email: string, allowInitial: boolean) => {
          const owner = owners.get(id);
          if (owner === email) return 'owned';
          if (owner) return 'conflict';
          if (!allowInitial) return 'ambiguous';
          owners.set(id, email);
          return 'owned';
        } }),
      },
    } as unknown as Env;
    const now = Math.floor(Date.now() / 1000);
    const token = await createTestJWT({
      aud: [TEST_AUD], email: '  Mixed.User@Example.com  ', sub: 'idp-subject-not-an-email',
      iss: `https://${TEST_AUTH_DOMAIN}`, iat: now - 60, exp: now + 3600,
    }, testKeyPair.privateKey, testKeyPair.kid);
    const groupObservations: Array<{ cookie: string | null; reads: string[]; record: string | undefined }> = [];
    const outbound: string[] = [];
    let releaseGroup!: () => void;
    const groupGate = new Promise<void>(resolve => { releaseGroup = resolve; });
    const certFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      outbound.push(request.url);
      if (request.url === `https://${TEST_AUTH_DOMAIN}/cdn-cgi/access/certs`) return certFetch(input, init);
      if (request.url !== `https://${TEST_AUTH_DOMAIN}/cdn-cgi/access/get-identity`) {
        throw new Error('Unexpected external I/O during authentication');
      }
      groupObservations.push({
        cookie: request.headers.get('Cookie'), reads: [...userReads],
        record: kv._store.get('user:mixed.user@example.com'),
      });
      if (groupObservations.length === logins) releaseGroup();
      await groupGate;
      return Response.json({ groups: [{ name: 'engineers' }] });
    };

    const results = await Promise.all(Array.from({ length: logins }, () => authenticateRequest(
      new Request('https://app.example.com/api/user', {
        headers: { 'cf-access-jwt-assertion': token, 'cf-access-authenticated-user-email': 'spoof@example.com' },
      }), env,
    )));
    for (const result of results) {
      expect(result).toMatchObject({
        user: { email: 'mixed.user@example.com', authenticated: true, role: 'user',
          accessTier: 'advanced', subscriptionTier: 'unlimited', subscribedMode: 'advanced' },
        bucketName: 'codeflare-mixed-user-example-com',
      });
    }
    expect(groupObservations).toHaveLength(logins);
    for (const observation of groupObservations) {
      expect(observation.cookie).toBe(`CF_Authorization=${token}`);
      expect(observation.reads.length).toBeGreaterThan(0);
      expect(new Set(observation.reads)).toEqual(new Set(['user:mixed.user@example.com']));
      expect(observation.record).toBeUndefined();
    }
    const record = await kv.get('user:mixed.user@example.com', 'json');
    expect(record).toEqual({
      addedBy: 'enterprise-jit', addedAt: expect.any(String), role: 'user',
      accessTier: 'advanced', subscriptionTier: 'unlimited', subscribedMode: 'advanced',
    });
    expect(Object.fromEntries(kv._store)).toEqual({ ...initialState, 'user:mixed.user@example.com': JSON.stringify(record) });
    expect([...owners]).toEqual([['bucket-owner:codeflare-mixed-user-example-com', 'mixed.user@example.com']]);
    expect(outbound.every(url => [
      `https://${TEST_AUTH_DOMAIN}/cdn-cgi/access/certs`,
      `https://${TEST_AUTH_DOMAIN}/cdn-cgi/access/get-identity`,
    ].includes(url))).toBe(true);
  });

  it('REQ-AUTH-003 AC2: protected HTTP requests revalidate a repeated Access credential and refuse invalid or expired credentials', async () => {
    resetAuthConfigCache();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    try {
      const kv = createMockKV();
      kv._store.set(SETUP_KEYS.AUTH_DOMAIN, TEST_AUTH_DOMAIN);
      kv._store.set(SETUP_KEYS.ACCESS_AUD, TEST_AUD);
      kv._set(`user:${TEST_EMAIL}`, { addedBy: 'setup', addedAt: '2024-01-01', role: 'user' });
      const initialState = Object.fromEntries(kv._store);
      const bucketName = 'codeflare-user-example-com';
      const env = {
        KV: kv,
        CONTAINER: {
          idFromName: (name: string) => name,
          get: (id: string) => ({ claimBucketOwner: async (email: string) =>
            id === `bucket-owner:${bucketName}` && email === TEST_EMAIL ? 'owned' : 'conflict' }),
        },
      } as unknown as Env;
      const now = Math.floor(Date.now() / 1000);
      const token = await createTestJWT({
        aud: [TEST_AUD], email: TEST_EMAIL, iss: `https://${TEST_AUTH_DOMAIN}`,
        iat: now - 60, exp: now + 60,
      }, testKeyPair.privateKey, testKeyPair.kid);
      const [header, payload, signature] = token.split('.');
      const invalidToken = `${header}.${payload}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
      const delivered: Array<{ readId: string; email: string; bucketName: string; content: string }> = [];
      // Same Hono middleware/response seam as middleware/auth.test.ts, without its auth mock.
      const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
      app.use('*', authMiddleware);
      app.get('/protected/:readId', c => {
        const resource = {
          readId: c.req.param('readId'), email: c.get('user').email,
          bucketName: c.get('bucketName'), content: 'protected-resource-canary',
        };
        delivered.push(resource);
        return c.json(resource);
      });
      app.onError((error, c) => error instanceof AppError
        ? c.json(error.toJSON(), error.statusCode as 400 | 401 | 403 | 404)
        : c.json({ error: 'Unexpected error' }, 500));
      const request = (readId: string, credential: string) => app.request(`https://example.test/protected/${readId}`, {
        headers: {
          Cookie: `CF_Authorization=${credential}`,
          'cf-access-authenticated-user-email': TEST_EMAIL,
        },
      }, env);
      const expectedDelivered = ['first', 'repeat'].map(readId => ({
        readId, email: TEST_EMAIL, bucketName, content: 'protected-resource-canary',
      }));
      for (const [index, expected] of expectedDelivered.entries()) {
        clock.mockReturnValue(1_800_000_000_000 + index * 10_000);
        const response = await request(expected.readId, token);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
      }
      expect(delivered).toEqual(expectedDelivered);

      for (const [readId, credential, time] of [
        ['invalid', invalidToken, 1_800_000_020_000],
        ['expired', token, 1_800_000_061_000],
      ] as const) {
        clock.mockReturnValue(time);
        const response = await request(readId, credential);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Authentication required', code: 'AUTH_ERROR' });
        expect(delivered).toEqual(expectedDelivered);
      }
      expect(Object.fromEntries(kv._store)).toEqual(initialState);
    } finally {
      clock.mockRestore();
      resetAuthConfigCache();
    }
  });

  describe('REQ-OPERATOR-001: verified human Access context', () => {
    const humanClaims = () => {
      const now = Math.floor(Date.now() / 1000);
      return {
        aud: [TEST_AUD], email: TEST_EMAIL, sub: 'human-subject', type: 'app',
        iss: `https://${TEST_AUTH_DOMAIN}`, iat: now - 60, exp: now + 3600,
      };
    };
    const sign = (claims: Record<string, unknown>) => createTestJWT(
      claims, testKeyPair.privateKey, testKeyPair.kid,
    );

    it.each(['absent groups', 'malformed groups', 'revoked', 'unavailable', 'wrong subject', 'wrong email'])(
      'REQ-OPERATOR-045 AC3: signed human management context distinguishes live %s from valid empty membership', async state => {
        resetAuthConfigCache();
        const claims = humanClaims();
        const token = await sign(claims);
        const kv = createMockKV();
        kv._store.set(SETUP_KEYS.AUTH_DOMAIN, TEST_AUTH_DOMAIN);
        kv._store.set(SETUP_KEYS.ACCESS_AUD, TEST_AUD);
        const env = { ENTERPRISE_MODE: 'active', KV: kv } as unknown as Env;
        const certFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          if (request.url.endsWith('/cdn-cgi/access/certs')) return certFetch(input, init);
          if (request.url !== `${claims.iss}/cdn-cgi/access/get-identity`) throw Error('Unexpected identity destination');
          if (state === 'revoked' || state === 'unavailable') return new Response(null, { status: state === 'revoked' ? 401 : 503 });
          return Response.json({ user_uuid: state === 'wrong subject' ? 'other-human' : claims.sub,
            email: state === 'wrong email' ? 'other@example.test' : claims.email,
            ...(state === 'malformed groups' ? { groups: null } : {}) });
        });
        try {
          const context = requireOperatorHumanContext(new Request('https://codeflare.test/api/operator-management', {
            headers: { 'cf-access-jwt-assertion': token },
          }), env, claims.email);
          if (state === 'absent groups') expect(await context).toMatchObject({ human: { subject: claims.sub, groups: [] }, accessJwt: token });
          else await expect(context).rejects.toThrow();
        } finally { resetAuthConfigCache(); }
      },
    );

    it('returns verified human claims and actual expiry without returning the credential', async () => {
      const claims = humanClaims();
      const token = await sign(claims);
      expect(await verifyHumanAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toEqual({
        subject: claims.sub, email: claims.email, issuer: claims.iss,
        audiences: claims.aud, issuedAt: claims.iat, expiresAt: claims.exp,
      });
      expect(await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
    });

    it('binds signed stable group claims to the verified issuer without returning credentials', async () => {
      const claims = { ...humanClaims(), groups: ['group-1', 'group-1', 'group-2'] };
      const token = await sign(claims);
      expect(await verifyHumanAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toMatchObject({ issuer: claims.iss, groups: ['group-1', 'group-2'] });
      expect(await verifyHumanAccessJWT(token, 'another-team.cloudflareaccess.com', TEST_AUD)).toBeNull();
    });

    it.each([[['group-1', 42]], [[{ name: 'group-1' }]], [[' group-1 ']], ['group-1']])('does not infer IDs from malformed signed groups %j', async groups => {
      const token = await sign({ ...humanClaims(), groups });
      expect(await verifyHumanAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toMatchObject({ groups: [] });
    });

    it.each([
      ['missing subject', { sub: undefined }],
      ['empty subject', { sub: '' }],
      ['blank subject', { sub: '   ' }],
      ['non-string subject', { sub: 42 }],
      ['missing email', { email: undefined }],
      ['empty email', { email: '' }],
      ['blank email', { email: '   ' }],
      ['missing token type', { type: undefined }],
      ['organization token', { type: 'org' }],
      ['service identity with human-looking claims', { common_name: 'service.access' }],
      ['malformed service identity', { common_name: null }],
    ])('rejects %s', async (_label, overrides) => {
      const token = await sign({ ...humanClaims(), ...overrides });
      expect(await verifyHumanAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
    });

    it.each([
      ['wrong audience', { aud: ['other-app'] }],
      ['wrong issuer', { iss: 'https://other.cloudflareaccess.com' }],
      ['expired token', { exp: 1 }],
      ['future issuance', { iat: Math.floor(Date.now() / 1000) + 3600 }],
      ['future not-before', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
    ])('rejects signed claims with %s', async (_label, overrides) => {
      const token = await sign({ ...humanClaims(), ...overrides });
      expect(await verifyHumanAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
    });

    it('rejects a forged human payload while retaining the original signature', async () => {
      const token = await sign({ ...humanClaims(), sub: '', common_name: 'service.access' });
      const [header, , signature] = token.split('.');
      const forged = `${header}.${base64UrlEncode(JSON.stringify(humanClaims()))}.${signature}`;
      expect(await verifyHumanAccessJWT(forged, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
    });

    it('preserves legacy email authentication without granting operator eligibility', async () => {
      const claims = humanClaims();
      const legacy = await sign({ ...claims, sub: undefined, type: undefined });
      expect(await verifyAccessJWT(legacy, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      expect(await verifyHumanAccessJWT(legacy, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
      const service = await sign({ ...claims, common_name: 'service.access' });
      expect(await verifyAccessJWT(service, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      expect(await verifyHumanAccessJWT(service, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
    });
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

  describe('REQ-AUTH-003: request-owned JWKS reads and completed snapshots', () => {
    function deferred<T>() {
      let resolve!: (value: T) => void;
      let reject!: (reason: Error) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    }

    async function independently<T>(operation: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Independent request stalled behind held I/O')), 2000);
        })]);
      } finally { clearTimeout(timer); }
    }

    const response = (keys: TestKeyPair[]) => Response.json(createMockJWKSResponse(keys.map(key => key.publicKeyJWK)));
    const sign = (key = testKeyPair, domain = TEST_AUTH_DOMAIN, overrides: Record<string, unknown> = {}) => {
      const now = Math.floor(Date.now() / 1000);
      return createTestJWT({ aud: [TEST_AUD], email: TEST_EMAIL, exp: now + 7200,
        iat: now - 60, iss: `https://${domain}`, sub: 'human', type: 'app', ...overrides }, key.privateKey, key.kid);
    };

    afterEach(() => { vi.restoreAllMocks(); resetAuthConfigCache(); });

    it('reuses completed keys without I/O and preserves signature, issuer, audience and time checks', async () => {
      const token = await sign();
      expect(await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      globalThis.fetch = vi.fn(async () => { throw new Error('Transport unavailable'); });
      expect(await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      const otherKey = await generateTestKeyPair(testKeyPair.kid);
      for (const invalid of [
        await sign(otherKey), await sign(testKeyPair, 'wrong.cloudflareaccess.com'),
        await sign(testKeyPair, TEST_AUTH_DOMAIN, { aud: ['wrong'] }),
        await sign(testKeyPair, TEST_AUTH_DOMAIN, { exp: 1 }),
        await sign(testKeyPair, TEST_AUTH_DOMAIN, { iat: Math.floor(Date.now() / 1000) + 100 }),
        await sign(testKeyPair, TEST_AUTH_DOMAIN, { nbf: Math.floor(Date.now() / 1000) + 100 }),
      ]) expect(await verifyAccessJWT(invalid, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
    });

    it('keeps completed keys for one hour, then reads the current key set', async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const oldToken = await sign();
      expect(await verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      const rotated = await generateTestKeyPair(testKeyPair.kid);
      const newToken = await sign(rotated);
      globalThis.fetch = vi.fn(async () => response([rotated]));
      clock.mockReturnValue(1_000_000 + 3_600_000 - 1);
      expect(await verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      expect(await verifyAccessJWT(newToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
      clock.mockReturnValue(1_000_000 + 3_600_000);
      expect(await verifyAccessJWT(newToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      expect(await verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
    });

    it('reset replaces completed keys even when the replacement uses the same kid', async () => {
      const oldToken = await sign();
      expect(await verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      const rotated = await generateTestKeyPair(testKeyPair.kid);
      const newToken = await sign(rotated);
      globalThis.fetch = vi.fn(async () => response([rotated]));
      resetJWKSCache();
      expect(await verifyAccessJWT(newToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      expect(await verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
    });

    it.each(['cold', 'expired'] as const)('a held %s fetch does not stall another request', async state => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const token = await sign();
      if (state === 'expired') {
        expect(await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
        clock.mockReturnValue(1_000_000 + 3_600_000);
      }
      const started = deferred<void>();
      const held = deferred<Response>();
      let hold = true;
      globalThis.fetch = vi.fn(async () => {
        if (hold) { hold = false; started.resolve(); return held.promise; }
        return response([testKeyPair]);
      });
      const first = verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      await started.promise;
      try {
        expect(await independently(verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD))).toBe(TEST_EMAIL);
      } finally { held.resolve(response([testKeyPair])); expect(await first).toBe(TEST_EMAIL); }
    });

    it('a rejected request cannot poison an independent request or its completed keys', async () => {
      const token = await sign();
      const started = deferred<void>();
      const held = deferred<Response>();
      let hold = true;
      globalThis.fetch = vi.fn(async () => {
        if (hold) { hold = false; started.resolve(); return held.promise; }
        return response([testKeyPair]);
      });
      const first = verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD);
      await started.promise;
      try {
        expect(await independently(verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD))).toBe(TEST_EMAIL);
      } finally { held.reject(new Error('Request ended')); expect(await first).toBeNull(); }
      globalThis.fetch = vi.fn(async () => { throw new Error('Transport unavailable'); });
      expect(await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
    });

    it('reset fences an older in-flight key set from replacing newer completed keys', async () => {
      const oldToken = await sign();
      const rotated = await generateTestKeyPair(testKeyPair.kid);
      const newToken = await sign(rotated);
      const started = deferred<void>();
      const held = deferred<Response>();
      let hold = true;
      globalThis.fetch = vi.fn(async () => {
        if (hold) { hold = false; started.resolve(); return held.promise; }
        return response([rotated]);
      });
      const first = verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD);
      await started.promise;
      resetJWKSCache();
      try {
        expect(await independently(verifyAccessJWT(newToken, TEST_AUTH_DOMAIN, TEST_AUD))).toBe(TEST_EMAIL);
      } finally { held.resolve(response([testKeyPair])); expect(await first).toBe(TEST_EMAIL); }
      globalThis.fetch = vi.fn(async () => { throw new Error('Transport unavailable'); });
      expect(await verifyAccessJWT(newToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      expect(await verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
    });

    it('switching domains never relabels cached keys while the new-domain request is held', async () => {
      const domain = 'other-team.cloudflareaccess.com';
      const otherKey = await generateTestKeyPair(testKeyPair.kid);
      const token = await sign();
      expect(await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      const otherToken = await sign(otherKey, domain);
      const wrongSigner = await sign(testKeyPair, domain);
      const started = deferred<void>();
      const held = deferred<Response>();
      let hold = true;
      globalThis.fetch = vi.fn(async () => {
        if (hold) { hold = false; started.resolve(); return held.promise; }
        return response([otherKey]);
      });
      const first = verifyAccessJWT(otherToken, domain, TEST_AUD);
      await started.promise;
      try {
        expect(await independently(verifyAccessJWT(wrongSigner, domain, TEST_AUD))).toBeNull();
        expect(await independently(verifyAccessJWT(otherToken, domain, TEST_AUD))).toBe(TEST_EMAIL);
      } finally { held.resolve(response([otherKey])); expect(await first).toBe(TEST_EMAIL); }
    });

    it('an old-domain completion cannot displace the current domain snapshot', async () => {
      const domain = 'other-team.cloudflareaccess.com';
      const otherKey = await generateTestKeyPair(testKeyPair.kid);
      const oldToken = await sign();
      const otherToken = await sign(otherKey, domain);
      const started = deferred<void>();
      const held = deferred<Response>();
      globalThis.fetch = vi.fn(async input => {
        if (String(input) === `https://${TEST_AUTH_DOMAIN}/cdn-cgi/access/certs`) {
          started.resolve(); return held.promise;
        }
        return response([otherKey]);
      });
      const first = verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD);
      await started.promise;
      try {
        expect(await independently(verifyAccessJWT(otherToken, domain, TEST_AUD))).toBe(TEST_EMAIL);
      } finally { held.resolve(response([testKeyPair])); expect(await first).toBe(TEST_EMAIL); }
      globalThis.fetch = vi.fn(async () => { throw new Error('Transport unavailable'); });
      expect(await verifyAccessJWT(otherToken, domain, TEST_AUD)).toBe(TEST_EMAIL);
      expect(await verifyAccessJWT(await sign(testKeyPair, domain), domain, TEST_AUD)).toBeNull();
    });

    it('unknown kids stay rejected for 30 seconds, then concurrent rotation reads remain independent', async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const oldToken = await sign();
      expect(await verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      const rotated = await generateTestKeyPair('rotated-kid');
      const newToken = await sign(rotated);
      const started = deferred<void>();
      const held = deferred<Response>();
      let hold = true;
      globalThis.fetch = vi.fn(async () => {
        if (hold) { hold = false; started.resolve(); return held.promise; }
        return response([rotated]);
      });
      clock.mockReturnValue(1_030_000);
      expect(await verifyAccessJWT(newToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
      clock.mockReturnValue(1_030_001);
      const first = verifyAccessJWT(newToken, TEST_AUTH_DOMAIN, TEST_AUD);
      await started.promise;
      try {
        expect(await independently(verifyAccessJWT(newToken, TEST_AUTH_DOMAIN, TEST_AUD))).toBe(TEST_EMAIL);
      } finally { held.resolve(response([testKeyPair])); expect(await first).toBeNull(); }
      globalThis.fetch = vi.fn(async () => { throw new Error('Transport unavailable'); });
      expect(await verifyAccessJWT(newToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      expect(await verifyAccessJWT(oldToken, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
    });

    it.each(['HTTP error', 'invalid JSON', 'invalid schema', 'transport rejection'])(
      'recovers from %s without caching failed JWKS', async failure => {
        const token = await sign();
        globalThis.fetch = vi.fn(async () => {
          if (failure === 'HTTP error') return new Response(null, { status: 503 });
          if (failure === 'invalid JSON') return new Response('not json');
          if (failure === 'invalid schema') return Response.json({ keys: 'invalid' });
          throw new Error('Transport unavailable');
        });
        expect(await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBeNull();
        globalThis.fetch = vi.fn(async () => response([testKeyPair]));
        expect(await verifyAccessJWT(token, TEST_AUTH_DOMAIN, TEST_AUD)).toBe(TEST_EMAIL);
      },
    );

    it('REQ-SEC-016 AC4: concurrent auth config loads use their own complete domain and audience snapshot', async () => {
      resetAuthConfigCache();
      const otherDomain = 'other-team.cloudflareaccess.com';
      const oldToken = await sign();
      const newToken = await sign(testKeyPair, otherDomain, { aud: ['new-audience'] });
      globalThis.fetch = vi.fn(async () => response([testKeyPair]));
      const started = deferred<void>();
      const held = deferred<string | null>();
      const oldEnv = { KV: { get: async (key: string) => {
        if (key === SETUP_KEYS.AUTH_DOMAIN) return TEST_AUTH_DOMAIN;
        if (key === SETUP_KEYS.ACCESS_AUD_LIST) { started.resolve(); return held.promise; }
        return key === SETUP_KEYS.ACCESS_AUD ? TEST_AUD : null;
      } } } as unknown as Env;
      const newEnv = { KV: { get: async (key: string) => {
        if (key === SETUP_KEYS.AUTH_DOMAIN) return otherDomain;
        if (key === SETUP_KEYS.ACCESS_AUD_LIST) return JSON.stringify(['new-audience']);
        return null;
      } } } as unknown as Env;
      const request = (token: string) => new Request('https://example.test/protected', {
        headers: { 'cf-access-jwt-assertion': token },
      });
      const first = getUserFromRequest(request(oldToken), oldEnv);
      await started.promise;
      try {
        expect(await independently(getUserFromRequest(request(newToken), newEnv))).toMatchObject({ authenticated: true, email: TEST_EMAIL });
      } finally { held.resolve(null); expect(await first).toMatchObject({ authenticated: true, email: TEST_EMAIL }); }
      expect(await getUserFromRequest(request(newToken), newEnv)).toMatchObject({ authenticated: true, email: TEST_EMAIL });
      expect(await getUserFromRequest(request(oldToken), newEnv)).toMatchObject({ authenticated: false, email: '' });
    });
  });

  describe('CF-022: runtime JWKS schema validation', () => {
    it('returns email when JWKS response has the expected shape (valid)', async () => {
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

    it('returns null when JWKS response is malformed (keys not an array)', async () => {
      // Mock the certs endpoint to return a structurally invalid JWKS document.
      // The Zod schema rejects it; verifyAccessJWT swallows the throw and returns null.
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/cdn-cgi/access/certs')) {
          return new Response(JSON.stringify({ keys: 'not-an-array' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof globalThis.fetch;

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
      expect(result).toBeNull();
    });

    it('returns null when a JWK entry is missing the modulus field', async () => {
      // JWKS with a key entry that omits the required `n` (modulus) field.
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/cdn-cgi/access/certs')) {
          return new Response(JSON.stringify({
            keys: [{ kid: testKeyPair.kid, kty: 'RSA', e: 'AQAB', alg: 'RS256', use: 'sig' }],
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof globalThis.fetch;

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
      expect(result).toBeNull();
    });
  });
});
