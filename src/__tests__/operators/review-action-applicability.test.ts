import { describe, expect, it } from 'vitest';
import { resolveBoundaryAction } from '../../operators/boundary-action-trust';

const action = { repositoryId: 138, installationId: 'review-install', workflowId: 531,
  workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
  workflowDigest: 'a'.repeat(64), events: ['pull_request'], controlsRevision: 4 };
const repository = { id: 138, full_name: 'owner/repo', default_branch: 'main' };
const workflow = { id: 531, path: action.workflowPath, state: 'active' };
const branch = { name: 'main', protected: true };
const contents = { sha256: action.workflowDigest, ref: 'refs/heads/main' };

describe('REQ-OPERATOR-053: approved target Action applicability, not release provenance', () => {
  it('selects remote only when numeric repository, protected workflow identity and immutable bytes agree', async () => {
    expect(await resolveBoundaryAction({ action, repository, workflow, branch, contents, event: 'pull_request' }))
      .toEqual({ selection: 'remote', installationId: 'review-install', controlsRevision: 4 });
  });
  it('distinguishes confirmed absence from unavailable or tampered target workflow', async () => {
    expect(await resolveBoundaryAction({ action: null, repository, workflow: null, branch, contents: null,
      event: 'pull_request', workflowLookup: 'not-found' })).toEqual({ selection: 'local' });
    for (const candidate of [
      { action: null, workflowLookup: 'unavailable' },
      { action: null, workflowLookup: 'found' },
      { action, workflow: { ...workflow, state: 'disabled_manually' } },
      { action, workflow: { ...workflow, id: 532 } },
      { action, branch: { ...branch, protected: false } },
      { action, repository: { ...repository, id: 139 } },
      { action, contents: { ...contents, sha256: 'b'.repeat(64) } },
      { action, contents: null },
    ]) {
      expect(await resolveBoundaryAction({ action, repository, workflow, branch, contents,
        event: 'pull_request', ...candidate })).toEqual({ selection: 'unavailable' });
    }
  });
});
