/**
 * REQ-GITHUB-015 AC2: repository identities reported by a container are
 * untrusted input. The Worker boundary keeps only well-formed GitHub
 * repository/branch identities, drops duplicates, holds a bounded number, and
 * orders them stably; AC4 puts the session's own repository first.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_TRACKED_CLONES,
  normalizeTrackedClones,
  buildCloneTargets,
} from '../../lib/clone-targets';

describe('REQ-GITHUB-015 AC2: normalizeTrackedClones', () => {
  it('keeps well-formed entries and drops malformed ones', () => {
    expect(normalizeTrackedClones([
      { repo: 'octo/api', ref: 'develop' },
      { repo: 'octo/web' },
      { repo: 'no-slash' },
      { repo: 'octo/api/extra' },
      { repo: 'octo/..' },
      { repo: 'octo/bad', ref: '--upload-pack' },
      { repo: 'octo/spaced name' },
      { repo: 42 },
      'octo/string',
      null,
    ])).toEqual([
      { repo: 'octo/api', ref: 'develop' },
      { repo: 'octo/web' },
    ]);
  });

  it('returns nothing for a non-array or empty input', () => {
    expect(normalizeTrackedClones(undefined)).toEqual([]);
    expect(normalizeTrackedClones(null)).toEqual([]);
    expect(normalizeTrackedClones('octo/api')).toEqual([]);
    expect(normalizeTrackedClones([])).toEqual([]);
  });

  it('keeps one entry per repository, first occurrence wins', () => {
    expect(normalizeTrackedClones([
      { repo: 'octo/api', ref: 'develop' },
      { repo: 'octo/api', ref: 'main' },
    ])).toEqual([{ repo: 'octo/api', ref: 'develop' }]);
  });

  it('orders entries stably regardless of report order', () => {
    const input = [{ repo: 'octo/web' }, { repo: 'octo/api' }, { repo: 'acme/zeta' }];
    const reversed = [...input].reverse();

    expect(normalizeTrackedClones(input)).toEqual(normalizeTrackedClones(reversed));
    expect(normalizeTrackedClones(input).map((c) => c.repo)).toEqual(['acme/zeta', 'octo/api', 'octo/web']);
  });

  it(`retains at most ${MAX_TRACKED_CLONES} repositories`, () => {
    const many = Array.from({ length: MAX_TRACKED_CLONES + 5 }, (_, i) => ({
      repo: `octo/repo-${String(i).padStart(2, '0')}`,
    }));

    const kept = normalizeTrackedClones(many);

    expect(kept).toHaveLength(MAX_TRACKED_CLONES);
    expect(kept[0].repo).toBe('octo/repo-00');
  });
});

describe('REQ-GITHUB-015 AC4: buildCloneTargets', () => {
  it('puts the session repository first and appends the tracked ones', () => {
    expect(buildCloneTargets(
      [{ repo: 'octo/web' }, { repo: 'octo/api', ref: 'develop' }],
      { repo: 'octo/api', ref: 'develop' },
    )).toBe('octo/api#develop octo/web');
  });

  it('encodes a ref with # and omits it when absent', () => {
    expect(buildCloneTargets([{ repo: 'octo/api', ref: 'main' }, { repo: 'octo/web' }], undefined))
      .toBe('octo/api#main octo/web');
  });

  it('returns an empty string when there is nothing to restore', () => {
    expect(buildCloneTargets([], undefined)).toBe('');
    expect(buildCloneTargets(undefined, undefined)).toBe('');
  });

  it('emits the session repository alone when nothing is tracked yet', () => {
    expect(buildCloneTargets(undefined, { repo: 'octo/api' })).toBe('octo/api');
  });

  it('drops malformed entries instead of forwarding them to a clone', () => {
    expect(buildCloneTargets(
      [{ repo: 'bad' } as never, { repo: 'octo/web' }],
      { repo: 'also bad' } as never,
    )).toBe('octo/web');
  });
});
