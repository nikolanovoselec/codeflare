import { describe, expect, it } from 'vitest';
import { resolveBoundaryAction } from '../../operators/boundary-action-trust';

const action = { repositoryId: 138, installationId: 'review-install', workflowId: 531,
  workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
  workflowDigest: '08758fded8a2aa973ac14c14171697eaf2057a53691ba4231dd2d11a8ca3e990',
  events: ['pull_request'], controlsRevision: 4 };
const repository = { id: 138, full_name: 'owner/repo', default_branch: 'main' };
const workflow = { id: 531, path: action.workflowPath, state: 'active' };
const branch = { name: 'main', protected: true, commit: { sha: 'c'.repeat(40) } };
const contents = { content: btoa('name: Boundary Reviews\non: pull_request\njobs: {}\n'),
  encoding: 'base64' };

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
      { action, contents: { ...contents, content: btoa('name: Tampered\non: pull_request\njobs: {}\n') } },
      { action, contents: null },
    ] as const) {
      expect(await resolveBoundaryAction({ repository, workflow, branch, contents,
        event: 'pull_request', ...candidate })).toEqual({ selection: 'unavailable' });
    }
  });
});
