import { describe, it, expect } from 'vitest';
import { signOauthState, verifyOauthState } from '../../lib/oauth-state';

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

  it('rejects malformed input (not three segments)', async () => {
    expect(await verifyOauthState('only.two', SECRET)).toBe(false);
    expect(await verifyOauthState('one', SECRET)).toBe(false);
    expect(await verifyOauthState('', SECRET)).toBe(false);
    expect(await verifyOauthState('a.b.c.d', SECRET)).toBe(false);
  });

  it('rejects tokens older than maxAgeSec', async () => {
    // Hand-craft a token with a stale iat — sign it correctly so only the age check fails
    const nonce = 'fixed-nonce';
    const iat = Math.floor(Date.now() / 1000) - 7200; // 2h ago
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${nonce}:${iat}`));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const stale = `${nonce}.${iat}.${sigB64}`;
    expect(await verifyOauthState(stale, SECRET, 1800)).toBe(false);
  });

  it('rejects tokens with iat in the far future (beyond clock skew)', async () => {
    const nonce = 'fixed-nonce';
    const iat = Math.floor(Date.now() / 1000) + 600; // 10min in the future, well beyond skew
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${nonce}:${iat}`));
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const futureToken = `${nonce}.${iat}.${sigB64}`;
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
