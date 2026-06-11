import { describe, it, expect } from 'vitest';
import { buildDiff } from '../scripts/build-diff';
import { SHIFT } from '../content/site';

describe('build-diff', () => {
  it('pairs every assistant point with its engine counterpart in order', () => {
    const diff = buildDiff(SHIFT.assistant, SHIFT.engine);

    expect(diff).toHaveLength(SHIFT.assistant.points.length * 2);
    for (let pair = 0; pair < SHIFT.assistant.points.length; pair++) {
      const del = diff[pair * 2];
      const add = diff[pair * 2 + 1];
      expect(del).toEqual({ sign: '-', text: SHIFT.assistant.points[pair], pairIndex: pair });
      expect(add).toEqual({ sign: '+', text: SHIFT.engine.points[pair], pairIndex: pair });
    }
  });

  it('throws when the columns cannot be paired 1:1', () => {
    expect(() =>
      buildDiff({ title: 'a', points: ['one'] }, { title: 'b', points: ['one', 'two'] })
    ).toThrow(/pair/i);
  });

  it('the real site copy stays 1:1 pairable (diff contract on content)', () => {
    expect(SHIFT.assistant.points.length).toBe(SHIFT.engine.points.length);
  });
});
