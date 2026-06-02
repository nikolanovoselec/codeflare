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

  it('allows previously protected paths (PROTECTED_PATHS is now empty)', () => {
    expect(() => validateKey('.claude/config')).not.toThrow();
    expect(() => validateKey('.ssh/id_rsa')).not.toThrow();
    expect(() => validateKey('.anthropic/key')).not.toThrow();
    expect(() => validateKey('workspace/.config/test')).not.toThrow();
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

  it('allows null bytes before previously protected paths (PROTECTED_PATHS is now empty)', () => {
    // Null bytes are still stripped, but .claude/ is no longer protected
    expect(() => validateKey('workspace/\0.claude/secret')).not.toThrow();
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

  // CF-066: single-decode traversal guard guarantees, and literal-key handling
  // of double-encoded input (the comment must not claim double-encode detection).
  describe('CF-066 path-traversal decode semantics', () => {
    it('rejects single-encoded traversal that decodes to ..', () => {
      // %2E%2E decodes once to '..'
      expect(() => validateKey('foo/%2E%2E/bar')).toThrow('path traversal not allowed');
      // %2E%2E%2F decodes once to '../'
      expect(() => validateKey('%2E%2E%2Fbar')).toThrow('path traversal not allowed');
      // literal '..' is rejected directly
      expect(() => validateKey('foo/../bar')).toThrow('path traversal not allowed');
    });

    it('accepts double-encoded input and returns the literal decoded-once key', () => {
      // %252E%252E decodes ONCE to the literal '%2E%2E' (no '..'), so it passes.
      // This documents that single-decode validation does NOT detect double-encoding.
      const result = validateKey('foo/%252E%252E/bar');
      // The returned key is the literal decoded-once string, used verbatim as the
      // R2 object key (getR2Url). It still contains '%2E%2E', never re-decoded to '..'.
      expect(result).toBe('foo/%2E%2E/bar');
      expect(result).not.toContain('..');
    });
  });
});
