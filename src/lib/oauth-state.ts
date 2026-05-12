/**
 * Stateless OAuth state token (HMAC-signed nonce + timestamp).
 *
 * Replaces the cookie-based double-submit pattern. Cookie state was
 * unreliable on iOS WebKit (Safari + Brave), where ITP suppressed the
 * SameSite=Lax cookie on the github.com -> codeflare.ch bounce-back
 * for first-time first-party visitors. The signed-state-in-URL pattern
 * has no cookie dependency, so the OAuth handshake works identically
 * in private browsing, ITP-aggressive engines, and ephemeral storage.
 *
 * Format: `nonce.iat.sig` where sig = HMAC-SHA256(secret, DOMAIN || `:${nonce}:${iat}`).
 *
 * The DOMAIN prefix is a tag that prevents cross-protocol confusion
 * with session JWTs (signed with the same OAUTH_JWT_SECRET). Without
 * it, a future change to either signed format could let one signature
 * verify in the other context. Bumping the version segment invalidates
 * all in-flight tokens — only do that under intentional rotation.
 *
 * CSRF protection: attacker cannot forge a state without OAUTH_JWT_SECRET,
 * and the iat timestamp bounds the replay window.
 */

const DOMAIN = 'oauth-state:v1';
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  if (!B64URL_RE.test(s)) throw new Error('invalid base64url');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/** Sign a fresh OAuth state token. */
export async function signOauthState(secret: string): Promise<string> {
  const nonce = crypto.randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const payload = `${DOMAIN}:${nonce}:${iat}`;
  const key = await hmacKey(secret, 'sign');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return `${nonce}.${iat}.${b64url(sig)}`;
}

/**
 * Verify an OAuth state token.
 *
 * Returns true iff: parses cleanly, iat is non-negative and not in the future
 * by more than CLOCK_SKEW_SEC, age <= maxAgeSec, and HMAC signature matches.
 *
 * Default window of 30 minutes (1800s) covers slow first-time GitHub
 * registrations including email verification + 2FA setup.
 */
const CLOCK_SKEW_SEC = 60;

export async function verifyOauthState(state: string, secret: string, maxAgeSec = 1800): Promise<boolean> {
  const parsed = parseOauthState(state);
  if (!parsed) return false;
  const { nonce, iat, sigB64 } = parsed;
  const now = Math.floor(Date.now() / 1000);
  const age = now - iat;
  if (age < -CLOCK_SKEW_SEC || age > maxAgeSec) return false;
  const payload = `${DOMAIN}:${nonce}:${iat}`;
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64urlDecode(sigB64);
  } catch {
    return false;
  }
  const key = await hmacKey(secret, 'verify');
  return crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(payload));
}

/**
 * Parse a state token without verifying the signature.
 * Returns null on any structural problem. The caller MUST still call
 * verifyOauthState — this helper exists only so the caller can extract
 * the nonce for replay-tracking after verification has succeeded.
 */
export function parseOauthState(state: string): { nonce: string; iat: number; sigB64: string } | null {
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [nonce, iatStr, sigB64] = parts;
  if (!nonce || !iatStr || !sigB64) return null;
  const iat = Number(iatStr);
  if (!Number.isFinite(iat) || iat < 0) return null;
  return { nonce, iat, sigB64 };
}

/**
 * KV-backed single-use enforcement for OAuth state nonces.
 *
 * Closes the replay window: even within the 30-minute iat validity,
 * a state token can only be redeemed once. This prevents OAuth-CSRF
 * attacks that rely on capturing a state token (browser history,
 * referrer leak, server log) and racing the legitimate user to
 * /callback with the attacker's own GitHub authorization code.
 *
 * Returns true on first claim, false on replay. Uses KV's atomic
 * `expirationTtl` for automatic cleanup.
 *
 * Race window: KV reads have eventual-consistency (~60s), so two
 * concurrent /callback requests with the same state could theoretically
 * both pass the get() check before either put() lands. In practice the
 * GitHub authorization code is single-use at GitHub's end, so a true
 * concurrent double-redeem is bounded by GitHub rejecting the second
 * code-exchange. The state nonce check raises the bar from "no replay
 * defense" to "replay defense up to KV propagation latency".
 */
export async function claimOauthNonce(kv: KVNamespace, nonce: string, ttlSec: number): Promise<boolean> {
  const key = `oauth-nonce:${nonce}`;
  const seen = await kv.get(key);
  if (seen !== null) return false;
  // Floor at the minimum TTL KV accepts (60s) to avoid put() rejection
  // for tiny windows. Doesn't apply at our 1800s default but defends
  // against future callers passing small windows.
  const ttl = Math.max(60, Math.ceil(ttlSec));
  await kv.put(key, '1', { expirationTtl: ttl });
  return true;
}
