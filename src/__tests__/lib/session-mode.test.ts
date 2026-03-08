import { describe, it, expect } from 'vitest';
import { resolveSessionMode } from '../../lib/session-mode';

describe('resolveSessionMode', () => {
  it('returns "default" when prefs is null', () => {
    expect(resolveSessionMode(null)).toBe('default');
  });

  it('returns "default" when prefs is empty object', () => {
    expect(resolveSessionMode({})).toBe('default');
  });

  it('returns "advanced" when sessionMode is "advanced"', () => {
    expect(resolveSessionMode({ sessionMode: 'advanced' })).toBe('advanced');
  });

  it('returns "default" when sessionMode is "default"', () => {
    expect(resolveSessionMode({ sessionMode: 'default' })).toBe('default');
  });
});
