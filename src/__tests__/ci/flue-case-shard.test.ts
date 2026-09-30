import { describe, expect, it } from 'vitest';
import { createFlueCaseShard } from '../operators/fixtures/flue-case-shard';

describe('REQ-OPS-003: parallel Flue case ownership', () => {
  it.each([1, 2, 3, 4, 39, 40])('executes all %i admitted cases exactly once across three isolated partitions', count => {
    const cases = Array.from({ length: count }, (_, index) => index);
    const partitions = [0, 1, 2].map(index => {
      const ownsNext = createFlueCaseShard(index, 3);
      return cases.filter(() => ownsNext());
    });
    const executed = partitions.flat();
    expect([...executed].sort((a, b) => a - b)).toEqual(cases);
    expect(new Set(executed).size).toBe(count);
    expect(Math.max(...partitions.map(part => part.length)) - Math.min(...partitions.map(part => part.length))).toBeLessThanOrEqual(1);
  });

  it('keeps table rows and individual declarations in one complete ownership sequence', () => {
    const declarations = [['single'], ['row-a', 'row-b', 'row-c', 'row-d'], ['last']];
    const executed = [0, 1, 2].flatMap(index => {
      const ownsNext = createFlueCaseShard(index, 3);
      return declarations.flatMap(rows => rows.filter(() => ownsNext()));
    });
    expect([...executed].sort()).toEqual(declarations.flat().sort());
  });

  it.each([[-1, 3], [3, 3], [0, 0], [0.5, 3], [0, 2.5], [0, NaN], [Infinity, 3]])(
    'fails closed for invalid partition %s/%s', (index, total) => {
      expect(() => createFlueCaseShard(index, total)).toThrow('Invalid Flue case shard');
    },
  );
});
