import { describe, expect, it } from 'vitest';
import {
  dashboardPath,
  parseSessionPath,
  sessionPath,
} from '../../lib/session-path';

describe('REQ-TERM-025 AC7 / REQ-SEC-024 AC4: canonical session paths', () => {
  it('builds the one canonical pathname from a valid session ID', () => {
    expect(sessionPath('abcdef0123456789')).toBe('/app/session/abcdef0123456789');
    expect(dashboardPath()).toBe('/app/');
  });

  it('parses only an exact canonical pathname', () => {
    expect(parseSessionPath('/app/session/abcdef0123456789')).toBe('abcdef0123456789');
    for (const path of [
      '/app/',
      '/app/session/',
      '/app/session/short',
      '/app/session/ABCDEF01',
      '/app/session/abcdef0123456789/extra',
      '/app/session/abcdef0123456789?query=1',
      'https://attacker.example/app/session/abcdef0123456789',
      '//attacker.example/app/session/abcdef0123456789',
      '/app/session/../../admin',
    ]) {
      expect(parseSessionPath(path)).toBeUndefined();
    }
  });

  it('rejects invalid IDs before constructing a pathname', () => {
    for (const id of ['', 'short', 'UPPERCASE', 'has/slash', 'x'.repeat(25)]) {
      expect(() => sessionPath(id)).toThrow();
    }
  });
});
