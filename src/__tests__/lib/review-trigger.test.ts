import { describe, it, expect } from 'vitest';
import { isPrBoundaryTrigger, isPrBoundaryCommand } from '../../../preseed/agents/pi/extensions/review-helpers';

/**
 * isPrBoundaryTrigger is the single "should this command start a review?" predicate.
 * The load-bearing safety property is that `gh pr merge` is NOT a trigger (it is the
 * merge gate) while it IS still a low-level boundary word — these tests fail if that
 * distinction regresses, or if the main/master base gate on `gh pr create` is dropped.
 */
describe('isPrBoundaryTrigger', () => {
  it('treats git push as a boundary', () => {
    expect(isPrBoundaryTrigger('git push origin develop')).toBe(true);
    expect(isPrBoundaryTrigger('git -C /repo push')).toBe(true);
  });

  it('treats gh repo sync as a boundary', () => {
    expect(isPrBoundaryTrigger('gh repo sync')).toBe(true);
  });

  it('treats gh pr update-branch as a boundary', () => {
    expect(isPrBoundaryTrigger('gh pr update-branch')).toBe(true);
  });

  it('treats gh pr create targeting main/master (or default base) as a boundary', () => {
    expect(isPrBoundaryTrigger('gh pr create --base main --title x')).toBe(true);
    expect(isPrBoundaryTrigger('gh pr create --base master')).toBe(true);
    expect(isPrBoundaryTrigger('gh pr create --title x')).toBe(true);
  });

  it('does NOT treat gh pr create targeting a non-main base as a boundary', () => {
    expect(isPrBoundaryTrigger('gh pr create --base develop --title x')).toBe(false);
  });

  it('does NOT treat gh pr merge as a trigger, but the word matcher still sees it as a boundary', () => {
    expect(isPrBoundaryTrigger('gh pr merge 501 --squash')).toBe(false);
    expect(isPrBoundaryCommand('gh pr merge 501 --squash')).toBe(true);
  });

  it('finds the boundary inside a compound command', () => {
    expect(isPrBoundaryTrigger('cd /repo && git add -A && git commit -m x && git push')).toBe(true);
  });

  it('returns false for non-boundary commands', () => {
    expect(isPrBoundaryTrigger('git status')).toBe(false);
    expect(isPrBoundaryTrigger('git commit -m "wip"')).toBe(false);
    expect(isPrBoundaryTrigger('ls -la')).toBe(false);
  });
});
