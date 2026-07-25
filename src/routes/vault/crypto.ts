/**
 * Vault encryption-key derivation (CF-024a; REQ-VAULT-021).
 *
 * The key is derived deterministically from the server master secret
 * (`ENCRYPTION_KEY`) and the user's R2 bucket name via HKDF-SHA256, so EVERY
 * session for a given bucket gets the SAME key. This is load-bearing for vault
 * persistence: SilverBullet hashes the encryption key into its IndexedDB names and
 * encrypts the browser-local cache with it, so a per-session key (the old design —
 * 32 random bytes minted in the container DO, wiped on destroy) changed the DB name
 * AND made any persisted cache undecryptable, forcing a full re-index on every open.
 *
 * Security note: this key only protects the browser-LOCAL IndexedDB cache (the
 * SilverBullet "primary" space). The "secondary" store (the container FS, synced to
 * R2) is NOT encrypted with it — a new session reads the secondary in plaintext and
 * rebuilds the local cache — so deriving a bucket-stable key does not affect data at
 * rest in R2. The tradeoff is the per-session forward secrecy of the local cache:
 * the key is recomputable for the bucket, so a later session of the same vault could
 * decrypt a prior session's leftover local cache (same user, same browser, same
 * bucket). The salt/info below namespace this derivation away from the KV credential
 * crypto that also uses ENCRYPTION_KEY.
 */

const HKDF_SALT = 'codeflare-vault-encryption-key';

export async function getVaultEncryptionKey(
  env: { ENCRYPTION_KEY?: string },
  bucketName: string,
): Promise<string> {
  const master = env.ENCRYPTION_KEY;
  if (!master) {
    throw new Error('ENCRYPTION_KEY must be configured to derive the vault encryption key');
  }
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(master),
    'HKDF',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(HKDF_SALT),
      info: new TextEncoder().encode(bucketName),
    },
    baseKey,
    256,
  );
  // Base64 of 32 raw bytes — the exact format SilverBullet's `Ze` key decoder expects
  // (matches the legacy DO key, which was 32 random bytes base64-encoded via btoa).
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
