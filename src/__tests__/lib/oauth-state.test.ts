import { describe, it, expect } from 'vitest';
import { signOauthState, verifyOauthState, parseOauthState, claimOauthNonce } from '../../lib/oauth-state';
import { createMockKV } from '../helpers/mock-kv';

const SECRET = 'test-secret-min-32-bytes-long-padding';

describe('oauth-state', () => {
  it('signs a token with three dot-separated segments', async () => {
    const token = await signOauthState(SECRET);
    expect(token.split('.')).toHaveLength(3);
  });

  it('verifies a freshly-signed token', async () => {
    const token = await signOauthState(SECRET);
    expect(await verifyOauthState(token, SECRET)).toBe(true);
  });

  it('verifies a bind-bound token only against the same bind value', async () => {
    const token = await signOauthState(SECRET, 'bucket-a');
    expect(await verifyOauthState(token, SECRET, 1800, 'bucket-a')).toBe(true);
    // A different bind (another user's bucket) must NOT verify — this is the
    // session binding that defeats the connect-flow token-fixation CSRF.
    expect(await verifyOauthState(token, SECRET, 1800, 'bucket-b')).toBe(false);
  });

  it('does not cross-verify between bound and unbound tokens', async () => {
    // An unbound (login-style) token must fail a bound verification...
    const unbound = await signOauthState(SECRET);
    expect(await verifyOauthState(unbound, SECRET, 1800, 'bucket-a')).toBe(false);
    // ...and a bound token must fail an unbound verification.
    const bound = await signOauthState(SECRET, 'bucket-a');
    expect(await verifyOauthState(bound, SECRET)).toBe(false);
  });

  it('rejects a bind containing the payload delimiter on both sign and verify', async () => {
    // ':' would make the DOMAIN:nonce:iat:bind payload ambiguous; bucket names
    // never contain it, so signing must fail loud and verification fail closed.
    await expect(signOauthState(SECRET, 'bucket:a')).rejects.toThrow();
    const token = await signOauthState(SECRET, 'bucket-a');
    expect(await verifyOauthState(token, SECRET, 1800, 'bucket:a')).toBe(false);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signOauthState(SECRET);
    expect(await verifyOauthState(token, 'different-secret')).toBe(false);
  });

  it('rejects a token with a forged signature', async () => {
    const token = await signOauthState(SECRET);
    const [nonce, iat] = token.split('.');
    const forged = `${nonce}.${iat}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(await verifyOauthState(forged, SECRET)).toBe(false);
  });

  it('rejects forged signatures of various invalid lengths', async () => {
    const token = await signOauthState(SECRET);
    const [nonce, iat] = token.split('.');
    expect(await verifyOauthState(`${nonce}.${iat}.AA`, SECRET)).toBe(false);
    expect(await verifyOauthState(`${nonce}.${iat}.${'A'.repeat(128)}`, SECRET)).toBe(false);
  });

  it('rejects sig segments containing non-base64url characters', async () => {
    const token = await signOauthState(SECRET);
    const [nonce, iat] = token.split('.');
    // '!' and '@' are outside the base64url alphabet — must be rejected
    expect(await verifyOauthState(`${nonce}.${iat}.abc!def`, SECRET)).toBe(false);
    expect(await verifyOauthState(`${nonce}.${iat}.abc@def`, SECRET)).toBe(false);
  });

  it('domain-separates state from session JWT (cross-protocol confusion resistance)', async () => {
    // A pure HMAC over `nonce:iat` (no DOMAIN prefix) must NOT verify as a state token,
    // even though it's signed with the same secret. This is the cross-protocol guard.
    const nonce = 'cross-protocol-nonce';
    const iat = Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    // Sign WITHOUT the DOMAIN prefix — simulates a session JWT-style signature
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${nonce}:${iat}`));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const naive = `${nonce}.${iat}.${sigB64}`;
    expect(await verifyOauthState(naive, SECRET)).toBe(false);
  });

  it('rejects malformed input (not three segments)', async () => {
    expect(await verifyOauthState('only.two', SECRET)).toBe(false);
    expect(await verifyOauthState('one', SECRET)).toBe(false);
    expect(await verifyOauthState('', SECRET)).toBe(false);
    expect(await verifyOauthState('a.b.c.d', SECRET)).toBe(false);
  });

  // Mirror the production DOMAIN prefix so age-only and skew-only tests
  // exercise their intended code path (signature passes, age/skew fails).
  const DOMAIN = 'oauth-state:v1';

  async function signWithIat(nonce: string, iat: number, secret: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${DOMAIN}:${nonce}:${iat}`));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${nonce}.${iat}.${sigB64}`;
  }

  it('rejects tokens older than maxAgeSec', async () => {
    const stale = await signWithIat('fixed-nonce', Math.floor(Date.now() / 1000) - 7200, SECRET);
    expect(await verifyOauthState(stale, SECRET, 1800)).toBe(false);
  });

  it('rejects tokens with iat in the far future (beyond clock skew)', async () => {
    const futureToken = await signWithIat('fixed-nonce', Math.floor(Date.now() / 1000) + 600, SECRET);
    expect(await verifyOauthState(futureToken, SECRET)).toBe(false);
  });

  it('rejects tokens with non-numeric iat', async () => {
    expect(await verifyOauthState('nonce.notanumber.AAAA', SECRET)).toBe(false);
  });

  it('rejects tokens with empty segments', async () => {
    expect(await verifyOauthState('.1700000000.sig', SECRET)).toBe(false);
    expect(await verifyOauthState('nonce..sig', SECRET)).toBe(false);
    expect(await verifyOauthState('nonce.1700000000.', SECRET)).toBe(false);
  });

  it('produces unique tokens on repeat calls (random nonce)', async () => {
    const a = await signOauthState(SECRET);
    const b = await signOauthState(SECRET);
    expect(a).not.toBe(b);
  });
});

describe('parseOauthState', () => {
  it('returns parsed segments for a well-formed token', async () => {
    const token = await signOauthState(SECRET);
    const parsed = parseOauthState(token);
    expect(parsed).not.toBeNull();
    expect(parsed!.nonce).toBeTruthy();
    expect(parsed!.iat).toBeGreaterThan(0);
    expect(parsed!.sigB64).toBeTruthy();
  });

  it('returns null for malformed input', () => {
    expect(parseOauthState('only.two')).toBeNull();
    expect(parseOauthState('')).toBeNull();
    expect(parseOauthState('a.b.c.d')).toBeNull();
    expect(parseOauthState('nonce..sig')).toBeNull();
    expect(parseOauthState('nonce.notanumber.sig')).toBeNull();
    expect(parseOauthState('nonce.-1.sig')).toBeNull();
  });
});

describe('claimOauthNonce', () => {
  it('returns true on first claim, false on replay', async () => {
    const kv = createMockKV();
    expect(await claimOauthNonce(kv as unknown as KVNamespace, 'nonce-1', 1800)).toBe(true);
    expect(await claimOauthNonce(kv as unknown as KVNamespace, 'nonce-1', 1800)).toBe(false);
  });

  it('different nonces are independent', async () => {
    const kv = createMockKV();
    expect(await claimOauthNonce(kv as unknown as KVNamespace, 'nonce-a', 1800)).toBe(true);
    expect(await claimOauthNonce(kv as unknown as KVNamespace, 'nonce-b', 1800)).toBe(true);
  });

  it('writes under the oauth-nonce: namespace', async () => {
    const kv = createMockKV();
    await claimOauthNonce(kv as unknown as KVNamespace, 'nonce-x', 1800);
    expect(await kv.get('oauth-nonce:nonce-x')).toBe('1');
  });

  it('floors TTL at 60s for tiny windows (KV minimum)', async () => {
    const kv = createMockKV();
    await claimOauthNonce(kv as unknown as KVNamespace, 'nonce-tiny', 5);
    // kv.put is a vitest Mock — inspect the third argument it was called with
    expect(kv.put).toHaveBeenCalledWith('oauth-nonce:nonce-tiny', '1', { expirationTtl: 60 });
  });

  it('passes through ceil-rounded TTL for windows above the floor', async () => {
    const kv = createMockKV();
    await claimOauthNonce(kv as unknown as KVNamespace, 'nonce-1800', 1800);
    expect(kv.put).toHaveBeenCalledWith('oauth-nonce:nonce-1800', '1', { expirationTtl: 1800 });
  });
});
