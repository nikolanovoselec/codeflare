import { describe, it, expect } from 'vitest';
import { isPrBoundaryTrigger, isPrBoundaryCommand, classifyReviewFiles, isGeneratedArtifactPath, isGeneratedOnlyDiff, prUrlFromText, enforcedHeadDecision } from '../../../preseed/agents/pi/extensions/review-helpers';

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

/**
 * REQ-AGENT-040 AC2: a diff that touches ONLY the generated graphify-out/ knowledge graph must
 * classify to zero review lanes so the PR-boundary auto-acknowledges — that checked-in graph is
 * machine-authored and carries no reviewable behavior. A diff that MIXES generated artifacts with
 * real source/sdd/docs is still classified by the non-generated files (the generated ones are
 * skipped, not allowed to suppress a real review).
 */
describe('classifyReviewFiles generated-artifact handling', () => {
  it('classifies a graphify-out-only diff to zero lanes (auto-ack)', () => {
    expect(classifyReviewFiles(['graphify-out/graph.json'])).toEqual([]);
    expect(classifyReviewFiles(['graphify-out/graph.json', 'graphify-out/memory/q1.md'])).toEqual([]);
  });

  it('still classifies the non-generated files when a diff mixes them with graphify-out', () => {
    expect(classifyReviewFiles(['graphify-out/graph.json', 'src/lib/access.ts'])).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles(['graphify-out/graph.json', 'sdd/spec/agents.md'])).toEqual(['spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles(['graphify-out/graph.json', 'documentation/lanes/architecture.md'])).toEqual(['doc-updater']);
  });

  it('preserves the undefined (unknowable diff -> full review) and empty (no change -> ack) contracts', () => {
    expect(classifyReviewFiles(undefined)).toEqual(['code-reviewer', 'spec-reviewer', 'doc-updater']);
    expect(classifyReviewFiles([])).toEqual([]);
  });
});

describe('isGeneratedArtifactPath / isGeneratedOnlyDiff', () => {
  it('matches only the top-level graphify-out/ generated tree', () => {
    expect(isGeneratedArtifactPath('graphify-out/graph.json')).toBe(true);
    expect(isGeneratedArtifactPath('graphify-out/memory/q.md')).toBe(true);
    expect(isGeneratedArtifactPath('src/graphify-out/x')).toBe(false);
    expect(isGeneratedArtifactPath('src/lib/access.ts')).toBe(false);
  });

  it('isGeneratedOnlyDiff is true only for a non-empty, all-generated diff', () => {
    expect(isGeneratedOnlyDiff(['graphify-out/graph.json'])).toBe(true);
    expect(isGeneratedOnlyDiff(['graphify-out/graph.json', 'src/b.ts'])).toBe(false);
    expect(isGeneratedOnlyDiff([])).toBe(false);
    expect(isGeneratedOnlyDiff(undefined)).toBe(false);
  });
});

/**
 * REQ-AGENT-058 AC5: the PR-URL fallback recovers a missed `gh pr create` boundary by spotting
 * the PR URL the command printed even when the command text itself was not parsed as a boundary.
 */
describe('prUrlFromText', () => {
  it('extracts the first GitHub PR URL from tool output', () => {
    expect(prUrlFromText('Creating pull request for feature into main\nhttps://github.com/owner/repo/pull/512\n')).toBe('https://github.com/owner/repo/pull/512');
  });

  it('returns undefined for output without a PR URL', () => {
    expect(prUrlFromText('https://github.com/owner/repo/issues/3')).toBeUndefined();
    expect(prUrlFromText('no url here')).toBeUndefined();
    expect(prUrlFromText(undefined)).toBeUndefined();
  });
});

/**
 * enforcedHeadDecision is the pure decision behind resolveEnforcedHead (REQ-AGENT-058 AC3).
 * The load-bearing safety property is that an UNPUSHED local commit (descends from the reported
 * head but localPushed=false) must NOT be enforced — otherwise passive reconciliation arms a
 * review for a commit the PR never had. These fail if that gate, or the metadata-lag tolerance
 * it guards, regresses.
 */
describe('enforcedHeadDecision (REQ-AGENT-058 AC3)', () => {
  const lagging = {
    prHead: 'aaaaaaa',
    local: 'bbbbbbb',
    onPrBranch: true,
    localDescendsFromPrHead: true,
    localPushed: true,
  };

  it('enforces the pushed local head when gh metadata still lags behind the push', () => {
    expect(enforcedHeadDecision(lagging)).toBe('local');
  });

  it('does NOT enforce an unpushed local WIP commit — falls back to the reported PR head', () => {
    expect(enforcedHeadDecision({ ...lagging, localPushed: false })).toBe('prHead');
  });

  it('does NOT enforce a local head on a different branch even if pushed and descending', () => {
    expect(enforcedHeadDecision({ ...lagging, onPrBranch: false })).toBe('prHead');
  });

  it('does NOT enforce a local head that does not descend from the reported head (diverged)', () => {
    expect(enforcedHeadDecision({ ...lagging, localDescendsFromPrHead: false })).toBe('prHead');
  });

  it('trusts the reported PR head when it equals local HEAD', () => {
    expect(enforcedHeadDecision({ ...lagging, prHead: 'ccccccc', local: 'ccccccc', localDescendsFromPrHead: false })).toBe('prHead');
  });

  it('falls back to local only when there is no reported PR head at all', () => {
    expect(enforcedHeadDecision({ ...lagging, prHead: '', localDescendsFromPrHead: false })).toBe('local');
  });

  it('trusts the reported PR head when there is no local checkout', () => {
    expect(enforcedHeadDecision({ ...lagging, local: '', localDescendsFromPrHead: false, localPushed: false })).toBe('prHead');
  });
});
