import { describe, it, expect } from 'vitest';
import { flipTransform } from '../scripts/flip-transform';

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe('flip-transform', () => {
  it('returns the identity transform when first and last rects match', () => {
    expect(flipTransform(rect(10, 20, 300, 200), rect(10, 20, 300, 200))).toBe(
      'translate(0px, 0px) scale(1, 1)'
    );
  });

  it('inverts a pure offset (FLIP: element laid out at last appears at first)', () => {
    expect(flipTransform(rect(0, 0, 100, 100), rect(40, 60, 100, 100))).toBe(
      'translate(-40px, -60px) scale(1, 1)'
    );
  });

  it('inverts a pure scale around the top-left origin', () => {
    expect(flipTransform(rect(0, 0, 200, 100), rect(0, 0, 100, 50))).toBe(
      'translate(0px, 0px) scale(2, 2)'
    );
  });

  it('combines offset and scale (real split: full pane shrinks into a grid cell)', () => {
    const first = rect(0, 120, 864, 480);
    const last = rect(0, 120, 432, 240);
    expect(flipTransform(first, last)).toBe('translate(0px, 0px) scale(2, 2)');

    const offsetCell = rect(432, 360, 432, 240);
    const transform = flipTransform(first, offsetCell);
    expect(transform).toBe('translate(-432px, -240px) scale(2, 2)');
  });

  it('round-trips: inverting first/last yields reciprocal scales and mirrored offsets', () => {
    const a = rect(10, 10, 400, 300);
    const b = rect(110, 60, 200, 150);
    expect(flipTransform(a, b)).toBe('translate(-100px, -50px) scale(2, 2)');
    expect(flipTransform(b, a)).toBe('translate(100px, 50px) scale(0.5, 0.5)');
  });
});
