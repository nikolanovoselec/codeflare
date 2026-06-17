import { describe, expect, it } from 'vitest';
import {
  buildHeroKickerLabel,
  getHeroKickerOpacity,
  getHeroKickerPosition,
} from '../lib/hero-kicker';

describe('hero kicker rotation model', () => {
  it('keeps the active word on the baseline and wraps the previous word to the top of the stack', () => {
    expect([0, 1, 2, 3].map((index) => getHeroKickerPosition(index, 1, 4))).toEqual([3, 0, 1, 2]);
  });

  it('keeps the active word solid, fades queued words linearly up the stack, and reaches fully transparent at the top', () => {
    const count = 8;
    // The active (bottom) word never fades.
    expect(getHeroKickerOpacity(0, count)).toBe('1');
    // The fade starts at the word above the active one and deepens up the stack.
    expect(Number(getHeroKickerOpacity(1, count))).toBeLessThan(1);
    expect(Number(getHeroKickerOpacity(1, count))).toBeGreaterThan(Number(getHeroKickerOpacity(3, count)));
    // The top of the stack is fully transparent.
    expect(Number(getHeroKickerOpacity(count - 1, count))).toBe(0);
  });

  it('builds one accessible sentence from the static parts and the rotating capability set', () => {
    expect(buildHeroKickerLabel('The enterprise agentic', ['coding', 'operations', 'knowledge'], 'engine'))
      .toBe('The enterprise agentic coding, operations, and knowledge engine');
  });
});
