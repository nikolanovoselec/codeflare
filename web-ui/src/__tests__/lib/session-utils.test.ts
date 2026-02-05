import { describe, it, expect } from 'vitest';
import { generateSessionName } from '../../lib/session-utils';

describe('generateSessionName', () => {
  it('should include # separator in session name', () => {
    expect(generateSessionName('claude-unleashed', [])).toBe('Claude Unleashed #1');
  });

  it('should start at #1 with no existing sessions', () => {
    expect(generateSessionName('bash', [])).toBe('Bash #1');
  });

  it('should find the lowest available number', () => {
    const existing = [{ name: 'Bash #1' }, { name: 'Bash #3' }];
    expect(generateSessionName('bash', existing)).toBe('Bash #2');
  });

  it('should increment past all taken numbers', () => {
    const existing = [{ name: 'Bash #1' }, { name: 'Bash #2' }, { name: 'Bash #3' }];
    expect(generateSessionName('bash', existing)).toBe('Bash #4');
  });

  it('should use "Session" label when agentType is undefined', () => {
    expect(generateSessionName(undefined, [])).toBe('Session #1');
  });
});
