import { describe, it, expect } from 'vitest';
import { activeSection } from '../scripts/scrollspy';

const ORDER = ['hero', 'shift', 'security', 'contact'];

describe('scrollspy', () => {
  it('picks the section with the highest visibility ratio', () => {
    expect(activeSection(ORDER, { hero: 0.1, shift: 0.8, security: 0.3 })).toBe('shift');
  });

  it('breaks ties by document order (topmost wins)', () => {
    expect(activeSection(ORDER, { shift: 0.5, security: 0.5 })).toBe('shift');
  });

  it('returns null when nothing is visible', () => {
    expect(activeSection(ORDER, {})).toBeNull();
    expect(activeSection(ORDER, { hero: 0 })).toBeNull();
  });

  it('ignores ids that are not part of the section order', () => {
    expect(activeSection(ORDER, { rogue: 1, security: 0.4 })).toBe('security');
  });

  it('is stable across small ratio jitter around a tie', () => {
    const before = activeSection(ORDER, { shift: 0.5004, security: 0.5 });
    const after = activeSection(ORDER, { shift: 0.5, security: 0.5003 });
    // Jitter below the comparison epsilon must not flip the active section.
    expect(before).toBe('shift');
    expect(after).toBe('shift');
  });
});
