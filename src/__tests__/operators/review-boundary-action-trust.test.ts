/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { selectVerifiedBoundaryAction } from '../../operators/review-boundary-preparation';

const empty = { revision: 0, managers: { users: [], groups: [] },
  ceiling: { capabilities: [], resourceProfileIds: [] }, boundaryActions: [] };
const action = { repositoryId: 138, installationId: 'review-install', workflowId: 531,
  workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
  workflowDigest: 'a'.repeat(64), events: ['pull_request'] };
async function withRegistry(test: (registry: OperatorRegistry) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_REGISTRY: DurableObjectNamespace }).OPERATOR_REGISTRY;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    await test(new OperatorRegistry(ctx, { ENCRYPTION_KEY: btoa('k'.repeat(32)) }));
  });
}

describe('REQ-OPERATOR-053: target Action trust is admin-owned and distinct from package build provenance', () => {
  it('does not select a target repository from an operator release workflow or absent protected binding', () => withRegistry(async registry => {
    expect(await registry.getBoundaryAction(138, 'refs/heads/main')).toBeNull();
    expect(await registry.getBoundaryAction(139, 'refs/heads/main')).toBeNull();
  }));
  it('persists the exact target repository/workflow/digest and fences stale controls revisions', () => withRegistry(async registry => {
    const authorized = { email: 'admin@example.test', expiresAt: Date.now() + 60_000 };
    const selected = await registry.setManagementControls({ ...empty, boundaryActions: [action] }, authorized);
    expect(selected).toMatchObject({ ok: true, value: { revision: 1, boundaryActions: [action] } });
    expect(await registry.getBoundaryAction(138, 'refs/heads/main')).toEqual({ ...action, controlsRevision: 1 });
    expect(await registry.getBoundaryAction(139, 'refs/heads/main')).toBeNull();
    expect(await registry.setManagementControls({ ...empty, boundaryActions: [] }, authorized))
      .toMatchObject({ ok: false, reason: 'revision-conflict' });
    expect(await registry.getBoundaryAction(138, 'refs/heads/main')).toEqual({ ...action, controlsRevision: 1 });
  }));
  it('REQ-OPERATOR-053: an explicitly inactive verified workflow leaves local review available without granting claim trust', () => withRegistry(async registry => {
    const inactive = { ...action, events: ['pull_request_target'], enabled: false,
      verified: true, runtimeSha: 'd'.repeat(40) };
    expect((await registry.setManagementControls({ ...empty, boundaryActions: [inactive] },
      { email: 'admin@example.test', expiresAt: Date.now() + 60_000 }, true)).ok).toBe(true);
    expect(await registry.getBoundaryAction(138, 'refs/heads/main')).toBeNull();
    const selection = await selectVerifiedBoundaryAction({ OPERATOR_REGISTRY: { getByName: () => registry },
      OPERATOR_ACTIVITY: { getByName: () => ({}) } } as never,
    { subject: 'human', email: 'human@example.test', issuer: 'https://issuer.example.test', audiences: ['aud'],
      issuedAt: Math.floor(Date.now() / 1000) - 1, expiresAt: Math.floor(Date.now() / 1000) + 300 },
    { owner: 'owner', repository: 'repo', repositoryId: 138, baseRef: 'main', baseSha: 'a'.repeat(40) },
    async path => path === '/repos/owner/repo'
      ? Response.json({ id: 138, full_name: 'owner/repo', default_branch: 'main' })
      : Response.json({ name: 'main', protected: true, commit: { sha: 'a'.repeat(40) } }));
    expect(selection).toBe('local');
  }));
  it('refuses duplicate bindings and expired configuration authority', () => withRegistry(async registry => {
    await expect(registry.setManagementControls({ ...empty, boundaryActions: [action, action] },
      { email: 'admin@example.test', expiresAt: Date.now() + 60_000 })).rejects.toThrow();
    expect(await registry.setManagementControls({ ...empty, boundaryActions: [action] },
      { email: 'admin@example.test', expiresAt: Date.now() - 1 }))
      .toMatchObject({ ok: false, reason: 'authority-expired' });
    expect(await registry.getBoundaryAction(138, 'refs/heads/main')).toBeNull();
  }));
});
