import { describe, expect, it } from 'vitest';
import { verifyGithubPrBoundary } from '../../operators/github-pr-boundary';

const head = 'a'.repeat(40); const base = 'b'.repeat(40); const mergeBase = 'c'.repeat(40);
const push = { owner: 'owner', repository: 'repo', ref: 'refs/heads/feature', head, pullRequest: 34 };
const evidence = { repository: { id: 138, full_name: 'owner/repo' }, pullRequest: { number: 34,
  state: 'open', head: { sha: head, ref: 'feature', repo: { id: 138 } },
  base: { sha: base, ref: 'main', repo: { id: 138 } } },
  compare: { merge_base_commit: { sha: mergeBase } }, matchingPulls: [34] };

describe('REQ-OPERATOR-053: independent numeric GitHub PR context', () => {
  it('binds repository, single open PR, exact pushed head, current base and actual merge base', async () => {
    expect(await verifyGithubPrBoundary(push, evidence)).toEqual({ repositoryId: 138, pullRequest: 34,
      head, base, mergeBase });
  });
  it('rejects a different head, fork, moved base, competing PR, merge queue or incomplete GitHub response', () => {
    for (const changed of [
      { pullRequest: { ...evidence.pullRequest, head: { ...evidence.pullRequest.head, sha: 'd'.repeat(40) } } },
      { pullRequest: { ...evidence.pullRequest, head: { ...evidence.pullRequest.head, repo: { id: 139 } } } },
      { pullRequest: { ...evidence.pullRequest, base: { ...evidence.pullRequest.base, ref: 'gh-readonly-queue/main/pr-34' } } },
      { matchingPulls: [34, 35] }, { compare: null }, { repository: { ...evidence.repository, id: 139 } },
    ]) expect(() => verifyGithubPrBoundary(push, { ...evidence, ...changed })).toThrow();
  });
});
