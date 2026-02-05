import { describe, it, expect } from 'vitest';
import {
  TERMINAL_SERVER_PORT,
  SESSION_ID_PATTERN,
  DEFAULT_ALLOWED_ORIGINS,
} from '../../lib/constants';

describe('constants', () => {
  it('exports port constants', () => {
    expect(TERMINAL_SERVER_PORT).toBe(8080);
  });

  it('exports session ID validation pattern', () => {
    expect(SESSION_ID_PATTERN).toBeInstanceOf(RegExp);
  });

  it('SESSION_ID_PATTERN validates correctly', () => {
    expect(SESSION_ID_PATTERN.test('abc12345')).toBe(true);
    expect(SESSION_ID_PATTERN.test('validid123')).toBe(true);
    expect(SESSION_ID_PATTERN.test('short')).toBe(false); // too short
    expect(SESSION_ID_PATTERN.test('UPPERCASE')).toBe(false); // uppercase not allowed
    expect(SESSION_ID_PATTERN.test('has-dash')).toBe(false); // special chars
  });

  it('exports default allowed origins', () => {
    expect(DEFAULT_ALLOWED_ORIGINS).toContain('.workers.dev');
  });

});
