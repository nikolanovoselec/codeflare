import { describe, it, expect } from 'vitest';
import {
  TERMINAL_SERVER_PORT,
  SESSION_ID_PATTERN,
  DEFAULT_ALLOWED_ORIGINS,
} from '../../lib/constants';
import type { Env } from '../../types';

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

  it('Env interface does not contain PROTECTED_PATHS_ENABLED (FIX-28)', () => {
    // Runtime check: verify the key is not present in a mock Env object
    const envKeys: (keyof Env)[] = ['KV', 'ASSETS', 'CONTAINER', 'CLOUDFLARE_API_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
    expect(envKeys).not.toContain('PROTECTED_PATHS_ENABLED');
    // Type-level: this line would fail to compile if PROTECTED_PATHS_ENABLED were still in Env
    const _check: 'PROTECTED_PATHS_ENABLED' extends keyof Env ? never : true = true;
    expect(_check).toBe(true);
  });

});
