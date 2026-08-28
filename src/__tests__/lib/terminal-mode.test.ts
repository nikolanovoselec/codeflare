import { describe, expect, it } from 'vitest';
import { resolveTerminalMode } from '../../types';

describe('terminal mode resolution', () => {
  it.each([
    [undefined, 'classic'],
    [null, 'classic'],
    ['', 'classic'],
    ['classic', 'classic'],
    ['invalid', 'classic'],
    ['herdr', 'herdr'],
  ])('resolves %j to %s', (value, expected) => {
    expect(resolveTerminalMode(value)).toBe(expected);
  });
});
