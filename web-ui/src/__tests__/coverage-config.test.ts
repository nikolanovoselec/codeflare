import { describe, expect, it } from 'vitest';
import config from '../../vitest.config';

describe('frontend coverage output contract', () => {
  it('emits both the fail-closed text summary and changed-line LCOV evidence', () => {
    const resolved = config as { test?: { coverage?: { reporter?: unknown } } };
    expect(resolved.test?.coverage?.reporter).toEqual(['text', 'lcov']);
  });
});
