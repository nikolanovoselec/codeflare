/**
 * KV encryption primitives — AES-256-GCM via Web Crypto API.
 *
 * Encrypts/decrypts credential values stored in KV (llm-keys, deploy-keys, r2token).
 * When ENCRYPTION_KEY is not set, all operations fall back to plaintext JSON.
 *
 * Ciphertext format: "v1:" + base64(12-byte IV + ciphertext+tag)
 * The "v1:" prefix distinguishes encrypted values from plaintext JSON.
 * AAD (Additional Authenticated Data) binds ciphertext to the KV key name.
 */

import { Buffer } from 'node:buffer';

/** Module-level cache for imported CryptoKey */
let cachedKey: CryptoKey | null = null;
let cachedKeySource: string | null = null;

/** Ciphertext version prefix */
const V1_PREFIX = 'v1:';

/**
 * Decode a base64 string strictly, validating format and length.
 */
function decodeBase64Key(base64: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(Buffer.from(base64, 'base64'));
  } catch {
    throw new Error('ENCRYPTION_KEY must be valid base64');
  }
  if (raw.byteLength !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to exactly 32 bytes, got ${raw.byteLength}`);
  }
  return raw;
}

/**
 * Import a base64-encoded 256-bit key as an AES-GCM CryptoKey.
 * Validates that the key decodes to exactly 32 bytes.
 */
export async function importEncryptionKey(base64: string): Promise<CryptoKey> {
  const raw = decodeBase64Key(base64);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns "v1:" + base64(12-byte IV + ciphertext+tag).
 * AAD binds the ciphertext to the KV key name.
 */
export async function encryptForKV(plaintext: string, key: CryptoKey, kvKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(kvKey);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return V1_PREFIX + Buffer.from(combined).toString('base64');
}

/**
 * Decrypt an AES-256-GCM encrypted value.
 * Input: base64(12-byte IV + ciphertext+tag) — without the v1: prefix.
 * AAD must match the KV key name used during encryption.
 */
export async function decryptFromKV(encrypted: string, key: CryptoKey, kvKey: string): Promise<string> {
  let combined: Uint8Array;
  try {
    combined = new Uint8Array(Buffer.from(encrypted, 'base64'));
  } catch {
    throw new Error('Invalid encrypted payload: not base64');
  }
  // 12-byte IV + at least 16-byte GCM auth tag
  if (combined.byteLength < 28) {
    throw new Error('Invalid encrypted payload: too short');
  }
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const aad = new TextEncoder().encode(kvKey);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

/**
 * Read a KV entry, decrypting if a key is provided.
 * Handles transparent migration: if the value is plaintext JSON and a crypto key
 * is present, it re-encrypts the value in place (fire-and-forget write-back) so
 * subsequent reads use the fast decrypt path.
 * Returns null if the entry doesn't exist or is corrupted.
 */
export async function getAndDecrypt<T>(
  kv: KVNamespace,
  kvKey: string,
  cryptoKey: CryptoKey | null,
): Promise<T | null> {
  if (!cryptoKey) {
    return kv.get<T>(kvKey, 'json');
  }

  const stored = await kv.get(kvKey, 'text');
  if (!stored) return null;

  // v1: prefix means encrypted — decrypt directly
  if (stored.startsWith(V1_PREFIX)) {
    try {
      const plaintext = await decryptFromKV(stored.slice(V1_PREFIX.length), cryptoKey, kvKey);
      return JSON.parse(plaintext) as T;
    } catch {
      return null;
    }
  }

  // No v1: prefix — try JSON.parse (plaintext legacy entry)
  let parsed: T;
  try {
    parsed = JSON.parse(stored) as T;
  } catch {
    return null;
  }

  // Fire-and-forget migration: re-encrypt so subsequent reads use the fast path
  // Never block the return on write-back — transient KV errors must not hide valid data
  encryptForKV(stored, cryptoKey, kvKey)
    .then(encrypted => kv.put(kvKey, encrypted))
    .catch(() => { /* migration will retry on next read */ });

  return parsed;
}

/**
 * Store a value in KV, encrypting if a key is provided.
 */
export async function encryptAndStore(
  kv: KVNamespace,
  kvKey: string,
  value: unknown,
  cryptoKey: CryptoKey | null,
): Promise<void> {
  if (!cryptoKey) {
    await kv.put(kvKey, JSON.stringify(value));
    return;
  }

  const encrypted = await encryptForKV(JSON.stringify(value), cryptoKey, kvKey);
  await kv.put(kvKey, encrypted);
}

/**
 * Get or import the encryption key from environment.
 * Returns null if ENCRYPTION_KEY is not set.
 * Caches the imported key for the lifetime of the Worker isolate.
 */
export async function getOrImportKey(
  env: { ENCRYPTION_KEY?: string },
): Promise<CryptoKey | null> {
  if (!env.ENCRYPTION_KEY) return null;

  // Return cached key if the source matches
  if (cachedKey && cachedKeySource === env.ENCRYPTION_KEY) {
    return cachedKey;
  }

  cachedKey = await importEncryptionKey(env.ENCRYPTION_KEY);
  cachedKeySource = env.ENCRYPTION_KEY;
  return cachedKey;
}
