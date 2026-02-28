import { describe, it, expect } from 'vitest';
import { validateKey, MAX_KEY_LENGTH } from '../../routes/storage/validation';

describe('validateKey', () => {
  it('rejects empty key', () => {
    expect(() => validateKey('')).toThrow('key is required');
  });

  it('rejects oversized key', () => {
    const longKey = 'a'.repeat(MAX_KEY_LENGTH + 1);
    expect(() => validateKey(longKey)).toThrow(`key must be at most ${MAX_KEY_LENGTH} characters`);
  });

  it('accepts key at max length', () => {
    const maxKey = 'a'.repeat(MAX_KEY_LENGTH);
    expect(() => validateKey(maxKey)).not.toThrow();
  });

  it('rejects path traversal with ..', () => {
    expect(() => validateKey('foo/../bar')).toThrow('path traversal not allowed');
  });

  it('rejects encoded traversal %2e%2e%2f decoded to ..', () => {
    // The key itself contains ".." after user supplies it
    expect(() => validateKey('foo/..%2fbar')).toThrow('path traversal not allowed');
    expect(() => validateKey('..hidden')).toThrow('path traversal not allowed');
  });

  it('rejects leading slash', () => {
    expect(() => validateKey('/foo/bar')).toThrow('must not start with /');
  });

  it('rejects protected paths', () => {
    expect(() => validateKey('.claude/config')).toThrow('Cannot access protected path');
    expect(() => validateKey('.ssh/id_rsa')).toThrow('Cannot access protected path');
    expect(() => validateKey('.anthropic/key')).toThrow('Cannot access protected path');
    expect(() => validateKey('workspace/.config/test')).toThrow('Cannot access protected path');
  });

  it('accepts valid keys', () => {
    expect(() => validateKey('workspace/file.ts')).not.toThrow();
    expect(() => validateKey('my-project/README.md')).not.toThrow();
    expect(() => validateKey('a')).not.toThrow();
  });

  it('uses custom label in error messages', () => {
    expect(() => validateKey('', 'source')).toThrow('source is required');
    expect(() => validateKey('/bad', 'destination')).toThrow('Invalid destination');
  });

  it('rejects null bytes before protected paths', () => {
    // Null byte before '.claude/' bypasses .includes() check — must be stripped
    expect(() => validateKey('workspace/\0.claude/secret')).toThrow('Cannot access protected path');
  });

  it('strips null bytes and validates the cleaned key', () => {
    // 'foo\0bar' after stripping becomes 'foobar' which is a valid key
    expect(() => validateKey('foo\0bar')).not.toThrow();
  });

  it('returns the sanitized key string without null bytes', () => {
    const result = validateKey('foo\0bar');
    expect(result).toBe('foobar');
  });

  it('returns the original key when no sanitization needed', () => {
    const result = validateKey('workspace/file.ts');
    expect(result).toBe('workspace/file.ts');
  });
});
