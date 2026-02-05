import { describe, it, expect } from 'vitest';
import { md5 } from '../../lib/md5';

describe('md5', () => {
  it('hashes empty string correctly', () => {
    // Well-known MD5 of empty string
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('hashes "hello" correctly', () => {
    expect(md5('hello')).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  it('hashes "Hello World" correctly', () => {
    expect(md5('Hello World')).toBe('b10a8db164e0754105b7a99be72e3fe5');
  });

  it('hashes "abc" correctly', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('hashes email for Gravatar (typical use case)', () => {
    // Gravatar uses lowercase trimmed email hashed with MD5
    const email = 'test@example.com';
    const hash = md5(email.trim().toLowerCase());
    expect(hash).toBe('55502f40dc8b7c769880b10874abc9d0');
  });

  it('produces different hashes for different inputs', () => {
    const hash1 = md5('hello');
    const hash2 = md5('world');
    expect(hash1).not.toBe(hash2);
  });

  it('produces consistent hashes for same input', () => {
    const hash1 = md5('deterministic');
    const hash2 = md5('deterministic');
    expect(hash1).toBe(hash2);
  });

  it('handles long strings (> 64 chars)', () => {
    const longString = 'a'.repeat(200);
    const hash = md5(longString);
    // Should be 32 hex chars
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('returns 32 character lowercase hex string', () => {
    const hash = md5('any input');
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });
});
