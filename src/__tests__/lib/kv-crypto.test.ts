/**
 * KV encryption primitives — AES-256-GCM via Web Crypto API
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockKV } from '../helpers/mock-kv';

import {
  importEncryptionKey,
  encryptForKV,
  decryptFromKV,
  getAndDecrypt,
  encryptAndStore,
  getOrImportKey,
} from '../../lib/kv-crypto';

// Generate a real AES-256 key as base64 for tests
async function generateTestKeyBase64(): Promise<string> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...rawKey));
}

describe('kv-crypto', () => {
  describe('importEncryptionKey', () => {
    it('converts base64 string to AES-256-GCM CryptoKey', async () => {
      const base64Key = await generateTestKeyBase64();
      const cryptoKey = await importEncryptionKey(base64Key);

      expect(cryptoKey).toBeInstanceOf(CryptoKey);
      expect(cryptoKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
      expect(cryptoKey.usages).toContain('encrypt');
      expect(cryptoKey.usages).toContain('decrypt');
    });

    it('rejects key that decodes to less than 32 bytes', async () => {
      const shortKey = btoa(String.fromCharCode(...new Uint8Array(16)));
      await expect(importEncryptionKey(shortKey)).rejects.toThrow('exactly 32 bytes');
    });

    it('rejects key that decodes to more than 32 bytes', async () => {
      const longKey = btoa(String.fromCharCode(...new Uint8Array(48)));
      await expect(importEncryptionKey(longKey)).rejects.toThrow('exactly 32 bytes');
    });

    it('rejects invalid base64', async () => {
      await expect(importEncryptionKey('not!valid!base64!!!')).rejects.toThrow();
    });
  });

  describe('encryptForKV / decryptFromKV', () => {
    it('produces a v1: prefixed string different from input', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const plaintext = 'hello world';

      const encrypted = await encryptForKV(plaintext, key, 'test-key');

      expect(typeof encrypted).toBe('string');
      expect(encrypted).not.toBe(plaintext);
      expect(encrypted.startsWith('v1:')).toBe(true);
    });

    it('round-trips: encrypt then decrypt returns original', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const plaintext = '{"openaiApiKey":"sk-test123","geminiApiKey":"AIza-xyz"}';

      const encrypted = await encryptForKV(plaintext, key, 'my-kv-key');
      const decrypted = await decryptFromKV(encrypted.slice(3), key, 'my-kv-key');

      expect(decrypted).toBe(plaintext);
    });

    it('produces unique ciphertext per encryption (random IV)', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const plaintext = 'same input every time';

      const encrypted1 = await encryptForKV(plaintext, key, 'k');
      const encrypted2 = await encryptForKV(plaintext, key, 'k');

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('throws on wrong key', async () => {
      const key1 = await importEncryptionKey(await generateTestKeyBase64());
      const key2 = await importEncryptionKey(await generateTestKeyBase64());

      const encrypted = await encryptForKV('secret data', key1, 'k');

      await expect(decryptFromKV(encrypted.slice(3), key2, 'k')).rejects.toThrow();
    });

    it('throws when AAD (kvKey) does not match', async () => {
      const key = await importEncryptionKey(await generateTestKeyBase64());

      const encrypted = await encryptForKV('secret', key, 'key-a');

      await expect(decryptFromKV(encrypted.slice(3), key, 'key-b')).rejects.toThrow();
    });

    it('rejects payload shorter than IV + GCM tag (28 bytes)', async () => {
      const key = await importEncryptionKey(await generateTestKeyBase64());
      const shortPayload = btoa('tooshort');

      await expect(decryptFromKV(shortPayload, key, 'k')).rejects.toThrow('too short');
    });
  });

  describe('getAndDecrypt', () => {
    let mockKV: ReturnType<typeof createMockKV>;

    beforeEach(() => {
      mockKV = createMockKV();
    });

    it('with v1: encrypted value + correct key -> returns parsed JSON', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const data = { openaiApiKey: 'sk-test', geminiApiKey: 'AIza-test' };

      const encrypted = await encryptForKV(JSON.stringify(data), key, 'test-key');
      await mockKV.put('test-key', encrypted);

      const result = await getAndDecrypt<typeof data>(mockKV as any, 'test-key', key);

      expect(result).toEqual(data);
    });

    it('with corrupted v1: value + key -> returns null (no throw)', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);

      await mockKV.put('test-key', 'v1:not-valid-encrypted-data');

      const result = await getAndDecrypt(mockKV as any, 'test-key', key);

      expect(result).toBeNull();
    });

    it('with non-JSON non-v1: garbage + key -> returns null', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);

      await mockKV.put('test-key', 'this-is-not-encrypted-or-json');

      const result = await getAndDecrypt(mockKV as any, 'test-key', key);

      expect(result).toBeNull();
    });

    it('with null key -> returns JSON.parse of stored value (plaintext mode)', async () => {
      const data = { openaiApiKey: 'sk-plain', geminiApiKey: 'AIza-plain' };
      mockKV._set('test-key', data);

      const result = await getAndDecrypt<typeof data>(mockKV as any, 'test-key', null);

      expect(result).toEqual(data);
    });

    it('with missing key in KV -> returns null', async () => {
      const key = await importEncryptionKey(await generateTestKeyBase64());

      const result = await getAndDecrypt(mockKV as any, 'nonexistent', key);

      expect(result).toBeNull();
    });

    it('with missing key in KV + null crypto key -> returns null', async () => {
      const result = await getAndDecrypt(mockKV as any, 'nonexistent', null);

      expect(result).toBeNull();
    });

    it('plaintext JSON + encryption key -> returns data AND re-encrypts (migration)', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const data = { openaiApiKey: 'sk-migrate-me', geminiApiKey: 'AIza-migrate' };

      // Store as plaintext JSON (pre-encryption legacy entry)
      mockKV._set('test-key', data);

      // Read with encryption key — should trigger migration
      const result = await getAndDecrypt<typeof data>(mockKV as any, 'test-key', key);

      // Should return the correct data
      expect(result).toEqual(data);

      // Wait for fire-and-forget migration write-back
      await new Promise(resolve => setTimeout(resolve, 50));

      // The stored value should now be encrypted (v1: prefix)
      const rawStored = mockKV._store.get('test-key');
      expect(rawStored).toBeDefined();
      expect(rawStored!.startsWith('v1:')).toBe(true);

      // Verify the re-encrypted value can be decrypted
      const decrypted = await decryptFromKV(rawStored!.slice(3), key, 'test-key');
      expect(JSON.parse(decrypted)).toEqual(data);
    });

    it('plaintext JSON + encryption key + write-back failure -> still returns data', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const data = { openaiApiKey: 'sk-keep-me' };

      // Store as plaintext JSON
      mockKV._set('test-key', data);

      // Make kv.put throw to simulate transient KV error
      const originalPut = mockKV.put;
      mockKV.put = vi.fn().mockRejectedValue(new Error('KV write failed'));

      // Should still return the parsed data despite migration failure
      const result = await getAndDecrypt<typeof data>(mockKV as any, 'test-key', key);
      expect(result).toEqual(data);

      // Restore
      mockKV.put = originalPut;
    });
  });

  describe('encryptAndStore', () => {
    let mockKV: ReturnType<typeof createMockKV>;

    beforeEach(() => {
      mockKV = createMockKV();
    });

    it('with key -> stores v1: prefixed encrypted string', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const data = { openaiApiKey: 'sk-secret' };

      await encryptAndStore(mockKV as any, 'test-key', data, key);

      const stored = mockKV._store.get('test-key');
      expect(stored).toBeDefined();
      expect(stored!.startsWith('v1:')).toBe(true);
      // Should not be valid JSON (it's encrypted)
      expect(() => JSON.parse(stored!)).toThrow();
    });

    it('without key -> stores JSON.stringify(value)', async () => {
      const data = { openaiApiKey: 'sk-plain' };

      await encryptAndStore(mockKV as any, 'test-key', data, null);

      const stored = mockKV._store.get('test-key');
      expect(stored).toBe(JSON.stringify(data));
    });

    it('round-trips with getAndDecrypt when encrypted', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const data = { openaiApiKey: 'sk-test', geminiApiKey: 'AIza-test' };

      await encryptAndStore(mockKV as any, 'test-key', data, key);
      const result = await getAndDecrypt<typeof data>(mockKV as any, 'test-key', key);

      expect(result).toEqual(data);
    });
  });

  describe('getOrImportKey', () => {
    it('returns null when ENCRYPTION_KEY not set', async () => {
      const result = await getOrImportKey({});
      expect(result).toBeNull();
    });

    it('returns CryptoKey when ENCRYPTION_KEY is set', async () => {
      const base64Key = await generateTestKeyBase64();
      const result = await getOrImportKey({ ENCRYPTION_KEY: base64Key });

      expect(result).toBeInstanceOf(CryptoKey);
    });

    it('returns null for undefined ENCRYPTION_KEY', async () => {
      const result = await getOrImportKey({ ENCRYPTION_KEY: undefined });
      expect(result).toBeNull();
    });
  });
});
