import { describe, expect, it } from 'vitest';
import { resolveBoundaryAction } from '../../operators/boundary-action-trust';

const action = { repositoryId: 138, installationId: 'review-install', workflowId: 531,
  workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
  workflowDigest: '5d25cbe537cab5e78efad44b51b472c4e278ca6510342b3eb34914dc6ee4e95d',
  events: ['pull_request_target'], controlsRevision: 4 };
const repository = { id: 138, full_name: 'owner/repo', default_branch: 'main' };
const workflow = { id: 531, path: action.workflowPath, state: 'active' };
const branch = { name: 'main', protected: true, commit: { sha: 'c'.repeat(40) } };
const contents = { content: btoa('name: Boundary Reviews\non: pull_request_target\njobs: {}\n'),
  encoding: 'base64' };

describe('REQ-OPERATOR-053: approved target Action applicability, not release provenance', () => {
  it('selects remote only when numeric repository, protected workflow identity and immutable bytes agree', async () => {
    expect(await resolveBoundaryAction({ action, repository, baseRef: 'refs/heads/main', workflow, branch, contents, event: 'pull_request_target' }))
      .toEqual({ selection: 'remote', installationId: 'review-install', controlsRevision: 4 });
  });
  it('selects only an exact configured, protected PR base for main, master or develop', async () => {
    for (const name of ['main', 'master', 'develop']) {
      const binding = { ...action, protectedRef: `refs/heads/${name}` };
      const protectedBranch = { ...branch, name };
      expect(await resolveBoundaryAction({ action: binding, repository, baseRef: binding.protectedRef, workflow, branch: protectedBranch,
        contents, event: 'pull_request_target' }))
        .toEqual({ selection: 'remote', installationId: action.installationId, controlsRevision: 4 });
      expect(await resolveBoundaryAction({ action: binding, repository, baseRef: binding.protectedRef, workflow,
        branch: { ...protectedBranch, protected: false }, contents, event: 'pull_request_target' }))
        .toEqual({ selection: 'unavailable' });
      for (const other of ['main', 'master', 'develop'].filter(value => value !== name)) {
        expect(await resolveBoundaryAction({ action: binding, repository, baseRef: binding.protectedRef, workflow,
          branch: { ...branch, name: other }, contents, event: 'pull_request_target' }))
          .toEqual({ selection: 'unavailable' });
      }
    }
  });
  it('rejects a candidate-controlled pull_request job even with a matching protected workflow binding', async () => {
    expect(await resolveBoundaryAction({ action: { ...action, events: ['pull_request'] },
      repository, baseRef: 'refs/heads/main', workflow, branch, contents, event: 'pull_request' })).toEqual({ selection: 'unavailable' });
  });
  it('distinguishes confirmed absence from unavailable or tampered target workflow', async () => {
    expect(await resolveBoundaryAction({ action: null, repository, baseRef: 'refs/heads/main', workflow: null, branch, contents: null,
      event: 'pull_request_target', workflowLookup: 'not-found' })).toEqual({ selection: 'local' });
    expect(await resolveBoundaryAction({ action: null, repository, baseRef: 'refs/heads/main', workflow: null,
      branch: { ...branch, protected: false }, contents: null,
      event: 'pull_request_target', workflowLookup: 'not-found' })).toEqual({ selection: 'unavailable' });
    for (const candidate of [
      { action: null, workflowLookup: 'unavailable' },
      { action: null, workflowLookup: 'found' },
      { action, workflow: { ...workflow, state: 'disabled_manually' } },
      { action, workflow: { ...workflow, id: 532 } },
      { action, branch: { ...branch, protected: false } },
      { action, repository: { ...repository, id: 139 } },
      { action, contents: { ...contents, content: btoa('name: Tampered\non: pull_request_target\njobs: {}\n') } },
      { action, contents: null },
    ] as const) {
      expect(await resolveBoundaryAction({ repository, baseRef: 'refs/heads/main', workflow, branch, contents,
        event: 'pull_request_target', ...candidate })).toEqual({ selection: 'unavailable' });
    }
  });
});
