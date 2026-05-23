/**
 * R2 SSE-C (Server-Side Encryption with Customer-Provided Keys) header generation
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { getSseHeaders, getSseCopyHeaders } from '../../lib/r2-sse';

// Generate a test base64 key (32 bytes = 256 bits for AES-256)
function generateTestKeyBase64(): string {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...rawKey));
}

describe('r2-sse / REQ-SEC-005 (R2 credentials never logged or exposed)', () => {
  describe('getSseHeaders', () => {
    it('returns 3 SSE-C headers when ENCRYPTION_KEY is set', () => {
      const key = generateTestKeyBase64();
      const headers = getSseHeaders({ ENCRYPTION_KEY: key });

      expect(Object.keys(headers)).toHaveLength(3);
      expect(headers['x-amz-server-side-encryption-customer-algorithm']).toBe('AES256');
      expect(headers['x-amz-server-side-encryption-customer-key']).toBe(key);
      expect(headers['x-amz-server-side-encryption-customer-key-MD5']).toBeDefined();
      expect(typeof headers['x-amz-server-side-encryption-customer-key-MD5']).toBe('string');
    });

    it('returns empty object when ENCRYPTION_KEY is not set', () => {
      const headers = getSseHeaders({});
      expect(headers).toEqual({});
    });

    it('returns empty object when ENCRYPTION_KEY is undefined', () => {
      const headers = getSseHeaders({ ENCRYPTION_KEY: undefined });
      expect(headers).toEqual({});
    });

    it('MD5 value is a valid base64 string of 16 bytes', () => {
      const key = generateTestKeyBase64();
      const headers = getSseHeaders({ ENCRYPTION_KEY: key });
      const md5Value = headers['x-amz-server-side-encryption-customer-key-MD5'];

      expect(() => atob(md5Value)).not.toThrow();
      expect(atob(md5Value).length).toBe(16);
    });

    it('same key produces same headers (deterministic)', () => {
      const key = generateTestKeyBase64();
      const h1 = getSseHeaders({ ENCRYPTION_KEY: key });
      const h2 = getSseHeaders({ ENCRYPTION_KEY: key });

      expect(h1).toEqual(h2);
    });

    it('produces correct MD5 for known 32-byte key (known-answer vector)', () => {
      // 32 bytes of 0x42 ('B')
      const rawKey = new Uint8Array(32).fill(0x42);
      const base64Key = btoa(String.fromCharCode(...rawKey));

      // Compute expected MD5 using node:crypto as reference
      const expectedMd5 = createHash('md5').update(Buffer.from(rawKey)).digest('base64');

      const headers = getSseHeaders({ ENCRYPTION_KEY: base64Key });
      expect(headers['x-amz-server-side-encryption-customer-key-MD5']).toBe(expectedMd5);
    });

    it('produces correct MD5 for all-zeros 32-byte key', () => {
      const rawKey = new Uint8Array(32).fill(0x00);
      const base64Key = btoa(String.fromCharCode(...rawKey));
      const expectedMd5 = createHash('md5').update(Buffer.from(rawKey)).digest('base64');

      const headers = getSseHeaders({ ENCRYPTION_KEY: base64Key });
      expect(headers['x-amz-server-side-encryption-customer-key-MD5']).toBe(expectedMd5);
    });

    it('produces correct MD5 for sequential-byte 32-byte key', () => {
      const rawKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) rawKey[i] = i;
      const base64Key = btoa(String.fromCharCode(...rawKey));
      const expectedMd5 = createHash('md5').update(Buffer.from(rawKey)).digest('base64');

      const headers = getSseHeaders({ ENCRYPTION_KEY: base64Key });
      expect(headers['x-amz-server-side-encryption-customer-key-MD5']).toBe(expectedMd5);
    });

    it('rejects key that decodes to wrong length', () => {
      const shortKey = btoa(String.fromCharCode(...new Uint8Array(16)));
      expect(() => getSseHeaders({ ENCRYPTION_KEY: shortKey })).toThrow('exactly 32 bytes');
    });
  });

  describe('getSseCopyHeaders', () => {
    it('returns 3 copy-source SSE-C headers when ENCRYPTION_KEY is set', () => {
      const key = generateTestKeyBase64();
      const headers = getSseCopyHeaders({ ENCRYPTION_KEY: key });

      expect(Object.keys(headers)).toHaveLength(3);
      expect(headers['x-amz-copy-source-server-side-encryption-customer-algorithm']).toBe('AES256');
      expect(headers['x-amz-copy-source-server-side-encryption-customer-key']).toBe(key);
      expect(headers['x-amz-copy-source-server-side-encryption-customer-key-MD5']).toBeDefined();
    });

    it('returns empty object when ENCRYPTION_KEY is not set', () => {
      const headers = getSseCopyHeaders({});
      expect(headers).toEqual({});
    });

    it('MD5 matches getSseHeaders MD5 for same key', () => {
      const key = generateTestKeyBase64();
      const sseHeaders = getSseHeaders({ ENCRYPTION_KEY: key });
      const copyHeaders = getSseCopyHeaders({ ENCRYPTION_KEY: key });

      expect(copyHeaders['x-amz-copy-source-server-side-encryption-customer-key-MD5'])
        .toBe(sseHeaders['x-amz-server-side-encryption-customer-key-MD5']);
    });
  });
});
