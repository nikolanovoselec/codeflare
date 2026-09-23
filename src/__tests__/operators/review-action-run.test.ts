import { describe, expect, it } from 'vitest';
import { verifyBoundaryActionRun } from '../../operators/review-boundary-claim';

const sha = (character: string) => character.repeat(40);
const prepared = { repositoryId: 138, pullRequest: 34, revision: {
  head: sha('a'), base: sha('b'), mergeBase: sha('c'),
}, workflowId: 531 };
const oidc = { repositoryId: 138, repository: 'owner/repo', eventName: 'pull_request_target' as const,
  workflowRef: 'owner/repo/.github/workflows/boundary-reviews.yml@refs/heads/main',
  workflowSha: sha('d'), runId: 87, runAttempt: 1 };
const action = { repositoryId: 138, workflowId: 531,
  workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
  branchSha: oidc.workflowSha, applicable: true };
const github = { repository: { id: 138, full_name: 'owner/repo' },
  run: { id: 87, run_attempt: 1, workflow_id: 531, event: 'pull_request_target',
    path: '.github/workflows/boundary-reviews.yml', head_sha: sha('e'),
    repository: { id: 138 }, pull_requests: [{ number: 34 }] },
  pullRequest: { number: 34, state: 'open', head: { sha: prepared.revision.head, repo: { id: 138 } },
    base: { sha: prepared.revision.base, repo: { id: 138 } } },
  compare: { merge_base_commit: { sha: prepared.revision.mergeBase } },
  headPullRequests: [34], matchingPullRequests: [34] };
const input = { prepared, oidc, action, github };

describe('REQ-OPERATOR-054: protected Action run and fresh GitHub PR context', () => {
  it('accepts only a signed protected workflow run bound to the sole current PR and exact prepared revision', () => {
    expect(verifyBoundaryActionRun(input)).toEqual({
      repositoryId: 138, pullRequest: 34, head: prepared.revision.head,
      base: prepared.revision.base, mergeBase: prepared.revision.mergeBase,
      workflowId: 531, runId: 87, runAttempt: 1,
    });
  });

  it('rejects a candidate workflow, changed protected workflow or mismatched run and attempt', () => {
    for (const change of [
      { oidc: { ...oidc, eventName: 'pull_request' } },
      { oidc: { ...oidc, workflowSha: sha('e') } },
      { oidc: { ...oidc, workflowRef: 'owner/repo/.github/workflows/boundary-reviews.yml@refs/heads/feature' } },
      { action: { ...action, applicable: false } },
      { action: { ...action, branchSha: sha('f') } },
      { github: { ...github, run: { ...github.run, id: 88 } } },
      { github: { ...github, run: { ...github.run, run_attempt: 2 } } },
      { github: { ...github, run: { ...github.run, event: 'pull_request' } } },
      { github: { ...github, run: { ...github.run, workflow_id: 532 } } },
      { github: { ...github, run: { ...github.run, path: '.github/workflows/other.yml' } } },
    ]) expect(verifyBoundaryActionRun({ ...input, ...change })).toBeNull();
  });

  it('rejects moved PR head/base/merge-base, ambiguous shared head and wrong repository', () => {
    for (const change of [
      { github: { ...github, repository: { ...github.repository, id: 139 } } },
      { github: { ...github, run: { ...github.run, repository: { id: 139 } } } },
      { github: { ...github, pullRequest: { ...github.pullRequest, state: 'closed' } } },
      { github: { ...github, pullRequest: { ...github.pullRequest,
        head: { ...github.pullRequest.head, sha: sha('e') } } } },
      { github: { ...github, pullRequest: { ...github.pullRequest,
        base: { ...github.pullRequest.base, sha: sha('e') } } } },
      { github: { ...github, compare: { merge_base_commit: { sha: sha('e') } } } },
      { github: { ...github, headPullRequests: [34, 35] } },
      { github: { ...github, matchingPullRequests: [] } },
      { github: { ...github, run: { ...github.run, pull_requests: [{ number: 35 }] } } },
    ]) expect(verifyBoundaryActionRun({ ...input, ...change })).toBeNull();
  });
});
