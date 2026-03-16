/**
 * KV encryption primitives — AES-256-GCM via Web Crypto API.
 *
 * Encrypts/decrypts credential values stored in KV (llm-keys, deploy-keys, r2token).
 * When KV_ENCRYPTION_KEY is not set, all operations fall back to plaintext JSON.
 */

/** Module-level cache for imported CryptoKey */
let cachedKey: CryptoKey | null = null;
let cachedKeySource: string | null = null;

/**
 * Import a base64-encoded 256-bit key as an AES-GCM CryptoKey.
 */
export async function importEncryptionKey(base64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Returns base64(12-byte IV + ciphertext).
 */
export async function encryptForKV(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt an AES-256-GCM encrypted value.
 * Input: base64(12-byte IV + ciphertext).
 */
export async function decryptFromKV(encrypted: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

/**
 * Read a KV entry, decrypting if a key is provided.
 * Handles transparent migration: if the value is plaintext JSON and a crypto key
 * is present, it re-encrypts the value in place (write-back) so subsequent reads
 * use the fast decrypt path.
 * Returns null if the entry doesn't exist or both decrypt and parse fail.
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

  // Try decrypt first (already encrypted)
  try {
    const plaintext = await decryptFromKV(stored, cryptoKey);
    return JSON.parse(plaintext) as T;
  } catch {
    // Decrypt failed — try JSON.parse (plaintext legacy entry)
  }

  // Migration: plaintext -> encrypted write-back
  try {
    const parsed = JSON.parse(stored) as T;
    // Re-encrypt and write back so subsequent reads use the fast path
    const encrypted = await encryptForKV(stored, cryptoKey);
    await kv.put(kvKey, encrypted);
    return parsed;
  } catch {
    // Neither decrypt nor JSON.parse worked — corrupted data
    return null;
  }
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

  const encrypted = await encryptForKV(JSON.stringify(value), cryptoKey);
  await kv.put(kvKey, encrypted);
}

/**
 * Get or import the encryption key from environment.
 * Returns null if KV_ENCRYPTION_KEY is not set.
 * Caches the imported key for the lifetime of the Worker isolate.
 */
export async function getOrImportKey(
  env: { KV_ENCRYPTION_KEY?: string },
): Promise<CryptoKey | null> {
  if (!env.KV_ENCRYPTION_KEY) return null;

  // Return cached key if the source matches
  if (cachedKey && cachedKeySource === env.KV_ENCRYPTION_KEY) {
    return cachedKey;
  }

  cachedKey = await importEncryptionKey(env.KV_ENCRYPTION_KEY);
  cachedKeySource = env.KV_ENCRYPTION_KEY;
  return cachedKey;
}
