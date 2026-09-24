/** Independently verified GitHub metadata, never a PR number inferred from a push response. */
const SHA = /^[a-f0-9]{40}$/i;
const REF = /^[A-Za-z0-9._/-]+$/;

export function verifyGithubPrBoundary(push: {
  owner: string; repository: string; ref: string; head: string; pullRequest: number;
}, evidence: {
  repository?: { id: number; full_name: string } | null;
  pullRequest?: { number: number; state: string; head: { sha: string; ref: string; repo: { id: number } };
    base: { sha: string; ref: string; repo: { id: number } } } | null;
  compare?: { merge_base_commit: { sha: string } } | null;
  matchingPulls?: number[];
}): { repositoryId: number; pullRequest: number; head: string; base: string; mergeBase: string } {
  const { repository, pullRequest: pr, compare, matchingPulls } = evidence;
  const branch = push.ref.startsWith('refs/heads/') ? push.ref.slice('refs/heads/'.length) : '';
  if (!repository || !pr || !compare || !Array.isArray(matchingPulls)
    || !Number.isSafeInteger(repository.id) || repository.id <= 0
    || !Number.isSafeInteger(push.pullRequest) || push.pullRequest <= 0
    || !/^[A-Za-z0-9_.-]+$/.test(push.owner) || !/^[A-Za-z0-9_.-]+$/.test(push.repository)
    || repository.full_name.toLowerCase() !== `${push.owner}/${push.repository}`.toLowerCase()
    || pr.state !== 'open' || pr.number !== push.pullRequest
    || matchingPulls.length !== 1 || matchingPulls[0] !== push.pullRequest
    || !SHA.test(push.head) || !SHA.test(pr.head.sha) || pr.head.sha !== push.head
    || !REF.test(branch) || pr.head.ref !== branch || pr.head.repo.id !== repository.id
    || !SHA.test(pr.base.sha) || !REF.test(pr.base.ref) || pr.base.ref.startsWith('gh-readonly-queue/')
    || pr.base.repo.id !== repository.id || !SHA.test(compare.merge_base_commit?.sha)) {
    throw new Error('GitHub PR revision could not be verified');
  }
  return { repositoryId: repository.id, pullRequest: pr.number,
    head: pr.head.sha, base: pr.base.sha, mergeBase: compare.merge_base_commit.sha };
}
