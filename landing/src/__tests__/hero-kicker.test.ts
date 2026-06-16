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

  it('keeps the active word strongest and fades queued words as they climb', () => {
    expect(getHeroKickerOpacity(0)).toBe('1');
    expect(Number(getHeroKickerOpacity(1))).toBeGreaterThan(Number(getHeroKickerOpacity(3)));
  });

  it('builds one accessible sentence from the static parts and the rotating capability set', () => {
    expect(buildHeroKickerLabel('The enterprise agentic', ['coding', 'operations', 'knowledge'], 'engine'))
      .toBe('The enterprise agentic coding, operations, and knowledge engine');
  });
});
