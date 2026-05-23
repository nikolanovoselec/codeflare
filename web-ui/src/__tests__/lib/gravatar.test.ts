/**
 * REQ-AUTH-017 AC3: getGravatarUrl uses MD5 hash of the (lowercased, trimmed)
 * email per the Gravatar protocol, so the same user gets a stable avatar
 * regardless of capitalization or surrounding whitespace.
 */
import { describe, it, expect } from 'vitest';
import { getGravatarUrl } from '../../lib/gravatar';

describe('getGravatarUrl / REQ-AUTH-017 AC3 (MD5 of email used for Gravatar lookup)', () => {
  // Known-answer vectors from the Gravatar docs (MD5 of normalized email).
  // Reference: https://en.gravatar.com/site/implement/hash/
  it('returns the documented Gravatar URL shape with MD5 hash for a known address', () => {
    const url = getGravatarUrl('MyEmailAddress@example.com');
    // MD5("myemailaddress@example.com") = "0bc83cb571cd1c50ba6f3e8a78ef1346"
    expect(url).toBe(
      'https://www.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=32&d=404'
    );
  });

  it('normalizes by lowercasing AND trimming whitespace before hashing', () => {
    const a = getGravatarUrl('user@example.com');
    const b = getGravatarUrl('  USER@Example.COM  ');
    expect(a).toBe(b);
  });

  it('honors the size parameter in the query string (default 32, override 128)', () => {
    expect(getGravatarUrl('a@b.c')).toContain('?s=32&d=404');
    expect(getGravatarUrl('a@b.c', 128)).toContain('?s=128&d=404');
  });

  it('uses d=404 fallback so the caller can detect "no Gravatar" via image error and render the outline-icon fallback (REQ-AUTH-017 AC2)', () => {
    // The 404 contract is what makes AC2 possible: without it the browser
    // would just show Gravatar's default identicon and the fallback branch
    // would never run.
    expect(getGravatarUrl('a@b.c')).toMatch(/[?&]d=404\b/);
  });
});
