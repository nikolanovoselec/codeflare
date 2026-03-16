/**
 * R2 SSE-C (Server-Side Encryption with Customer-Provided Keys) header generation
 */
import { describe, it, expect } from 'vitest';

import { getSseHeaders, getSseCopyHeaders } from '../../lib/r2-sse';

// Generate a test base64 key (32 bytes = 256 bits for AES-256)
function generateTestKeyBase64(): string {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...rawKey));
}

describe('r2-sse', () => {
  describe('getSseHeaders', () => {
    it('returns 3 SSE-C headers when KV_ENCRYPTION_KEY is set', () => {
      const key = generateTestKeyBase64();
      const headers = getSseHeaders({ KV_ENCRYPTION_KEY: key });

      expect(Object.keys(headers)).toHaveLength(3);
      expect(headers['x-amz-server-side-encryption-customer-algorithm']).toBe('AES256');
      expect(headers['x-amz-server-side-encryption-customer-key']).toBe(key);
      expect(headers['x-amz-server-side-encryption-customer-key-MD5']).toBeDefined();
      expect(typeof headers['x-amz-server-side-encryption-customer-key-MD5']).toBe('string');
    });

    it('returns empty object when KV_ENCRYPTION_KEY is not set', () => {
      const headers = getSseHeaders({});
      expect(headers).toEqual({});
    });

    it('returns empty object when KV_ENCRYPTION_KEY is undefined', () => {
      const headers = getSseHeaders({ KV_ENCRYPTION_KEY: undefined });
      expect(headers).toEqual({});
    });

    it('MD5 value is a valid base64 string', () => {
      const key = generateTestKeyBase64();
      const headers = getSseHeaders({ KV_ENCRYPTION_KEY: key });
      const md5Value = headers['x-amz-server-side-encryption-customer-key-MD5'];

      // Should be valid base64 — decoding should not throw
      expect(() => atob(md5Value)).not.toThrow();
      // MD5 produces 16 bytes → 24 chars in base64 (with padding)
      // But base64 of 16 bytes = ceil(16/3)*4 = 24 chars
      expect(atob(md5Value).length).toBe(16);
    });

    it('same key produces same headers (deterministic)', () => {
      const key = generateTestKeyBase64();
      const h1 = getSseHeaders({ KV_ENCRYPTION_KEY: key });
      const h2 = getSseHeaders({ KV_ENCRYPTION_KEY: key });

      expect(h1).toEqual(h2);
    });
  });

  describe('getSseCopyHeaders', () => {
    it('returns 3 copy-source SSE-C headers when KV_ENCRYPTION_KEY is set', () => {
      const key = generateTestKeyBase64();
      const headers = getSseCopyHeaders({ KV_ENCRYPTION_KEY: key });

      expect(Object.keys(headers)).toHaveLength(3);
      expect(headers['x-amz-copy-source-server-side-encryption-customer-algorithm']).toBe('AES256');
      expect(headers['x-amz-copy-source-server-side-encryption-customer-key']).toBe(key);
      expect(headers['x-amz-copy-source-server-side-encryption-customer-key-MD5']).toBeDefined();
    });

    it('returns empty object when KV_ENCRYPTION_KEY is not set', () => {
      const headers = getSseCopyHeaders({});
      expect(headers).toEqual({});
    });

    it('MD5 matches getSseHeaders MD5 for same key', () => {
      const key = generateTestKeyBase64();
      const sseHeaders = getSseHeaders({ KV_ENCRYPTION_KEY: key });
      const copyHeaders = getSseCopyHeaders({ KV_ENCRYPTION_KEY: key });

      expect(copyHeaders['x-amz-copy-source-server-side-encryption-customer-key-MD5'])
        .toBe(sseHeaders['x-amz-server-side-encryption-customer-key-MD5']);
    });
  });
});
