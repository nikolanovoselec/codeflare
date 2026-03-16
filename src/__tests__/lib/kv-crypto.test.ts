/**
 * KV encryption primitives — AES-256-GCM via Web Crypto API
 */
import { describe, it, expect, beforeEach } from 'vitest';
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
  });

  describe('encryptForKV / decryptFromKV', () => {
    it('produces a base64 string different from plaintext input', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const plaintext = 'hello world';

      const encrypted = await encryptForKV(plaintext, key);

      expect(typeof encrypted).toBe('string');
      expect(encrypted).not.toBe(plaintext);
      // Should be valid base64
      expect(() => atob(encrypted)).not.toThrow();
    });

    it('round-trips: encrypt then decrypt returns original', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const plaintext = '{"openaiApiKey":"sk-test123","geminiApiKey":"AIza-xyz"}';

      const encrypted = await encryptForKV(plaintext, key);
      const decrypted = await decryptFromKV(encrypted, key);

      expect(decrypted).toBe(plaintext);
    });

    it('produces unique ciphertext per encryption (random IV)', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const plaintext = 'same input every time';

      const encrypted1 = await encryptForKV(plaintext, key);
      const encrypted2 = await encryptForKV(plaintext, key);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('throws on wrong key', async () => {
      const key1Base64 = await generateTestKeyBase64();
      const key2Base64 = await generateTestKeyBase64();
      const key1 = await importEncryptionKey(key1Base64);
      const key2 = await importEncryptionKey(key2Base64);

      const encrypted = await encryptForKV('secret data', key1);

      await expect(decryptFromKV(encrypted, key2)).rejects.toThrow();
    });
  });

  describe('getAndDecrypt', () => {
    let mockKV: ReturnType<typeof createMockKV>;

    beforeEach(() => {
      mockKV = createMockKV();
    });

    it('with encrypted value + correct key -> returns parsed JSON', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const data = { openaiApiKey: 'sk-test', geminiApiKey: 'AIza-test' };

      // Manually encrypt and store
      const encrypted = await encryptForKV(JSON.stringify(data), key);
      await mockKV.put('test-key', encrypted);

      const result = await getAndDecrypt<typeof data>(mockKV as any, 'test-key', key);

      expect(result).toEqual(data);
    });

    it('with corrupted/invalid value + key -> returns null (no throw)', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);

      await mockKV.put('test-key', 'this-is-not-encrypted-data');

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
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);

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

      // The stored value should now be encrypted (no longer valid JSON)
      const rawStored = mockKV._store.get('test-key');
      expect(rawStored).toBeDefined();
      let isValidJson = true;
      try { JSON.parse(rawStored!); } catch { isValidJson = false; }
      expect(isValidJson).toBe(false);

      // Verify the re-encrypted value can be decrypted
      const decrypted = await decryptFromKV(rawStored!, key);
      expect(JSON.parse(decrypted)).toEqual(data);
    });
  });

  describe('encryptAndStore', () => {
    let mockKV: ReturnType<typeof createMockKV>;

    beforeEach(() => {
      mockKV = createMockKV();
    });

    it('with key -> stores encrypted string (not valid JSON)', async () => {
      const base64Key = await generateTestKeyBase64();
      const key = await importEncryptionKey(base64Key);
      const data = { openaiApiKey: 'sk-secret' };

      await encryptAndStore(mockKV as any, 'test-key', data, key);

      const stored = mockKV._store.get('test-key');
      expect(stored).toBeDefined();
      // Should not be valid JSON (it's encrypted base64)
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
