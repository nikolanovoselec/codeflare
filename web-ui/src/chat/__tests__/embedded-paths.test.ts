import { describe, expect, it } from 'vitest';
import { isSafeDashboardPath } from '../upstream/dashboard-plugin-runtime/src/embedded-app-shell';

// Compatibility contract for the lint-only rewrite of this owned primitive:
// reject the same raw/decoded characters, not a broader Unicode control class.
describe('Embedded path character allowlist', () => {
  it('refuses every ASCII control and DEL in raw or percent-decoded paths, queries and fragments', () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      const character = String.fromCharCode(code);
      for (const separator of ['/', '?q=', '#']) {
        expect(isSafeDashboardPath(`/session${separator}${character}`)).toBe(false);
        expect(isSafeDashboardPath(`/session${separator}${encodeURIComponent(character)}`)).toBe(false);
      }
    }
  });
  it('continues refusing backslashes and whitespace before and after decoding', () => {
    for (const character of ['\\', ' ', '\t', '\n', '\u00a0', '\ufeff']) {
      expect(isSafeDashboardPath(`/session/${character}`)).toBe(false);
      expect(isSafeDashboardPath(`/session/${encodeURIComponent(character)}`)).toBe(false);
    }
  });
  it('retains valid punctuation and non-whitespace C1 characters adjacent to the forbidden ranges', () => {
    for (const character of ['!', '~', '\u0080', '\u0085']) {
      expect(isSafeDashboardPath(`/session/${character}`)).toBe(true);
      expect(isSafeDashboardPath(`/session/${encodeURIComponent(character)}`)).toBe(true);
    }
  });
});
