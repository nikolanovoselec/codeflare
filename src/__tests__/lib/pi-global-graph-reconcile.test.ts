// REQ-VAULT-004 AC6 / REQ-VAULT-014 AC5 on the Pi runtime. Pi previously only
// ever ran `graphify global add`, so the global manifest accumulated every repo
// a session touched and a graph-less checkout kept publishing the repo before
// it. These assert the reconcile plan Pi now computes before taking the lock.
import { describe, expect, it } from 'vitest';

import { planGlobalGraphReconcile } from '../../../preseed/agents/pi/extensions/codeflare-pi';

const manifest = (...tags: string[]) =>
  JSON.stringify({ repos: Object.fromEntries(tags.map((tag) => [tag, { source_hash: '0123456789abcdef' }])) });

describe('planGlobalGraphReconcile / REQ-VAULT-014 AC5 (Pi holds the same single-active-repo invariant)', () => {
  it('removes every repo tag that is not the active checkout, and adds the active one', () => {
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-a', 'repo-b'), '/w/repo-b', true);
    expect(plan.remove).toEqual(['repo-a']);
    expect(plan.add).toEqual({ graph: '/w/repo-b/graphify-out/graph.json', tag: 'repo-b' });
  });

  it('never removes user_vault, which is always-on and never a repo tag', () => {
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-a'), '/w/repo-b', true);
    expect(plan.remove).not.toContain('user_vault');
  });

  it('sweeps tags no previous-repo comparison could name, such as a crashed run leftover', () => {
    // repo-z and workspace are reachable from the manifest alone; a diff
    // against the previously active repo would only ever have found repo-a.
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-a', 'repo-z', 'workspace'), '/w/repo-b', true);
    expect(plan.remove.sort()).toEqual(['repo-a', 'repo-z', 'workspace']);
  });

  it('a checkout without a graph removes every repo tag and adds nothing', () => {
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-a'), '/w/repo-b', false);
    expect(plan.remove).toEqual(['repo-a']);
    expect(plan.add).toBeUndefined();
  });

  it('re-adds the active checkout rather than removing it when it is already published', () => {
    const plan = planGlobalGraphReconcile(manifest('user_vault', 'repo-b'), '/w/repo-b', true);
    expect(plan.remove).toEqual([]);
    expect(plan.add?.tag).toBe('repo-b');
  });

  it('an absent or malformed manifest removes nothing, since adding is idempotent and removing is not', () => {
    expect(planGlobalGraphReconcile(undefined, '/w/repo-b', true).remove).toEqual([]);
    expect(planGlobalGraphReconcile('{not json', '/w/repo-b', true).remove).toEqual([]);
    expect(planGlobalGraphReconcile('{"repos":null}', '/w/repo-b', true).remove).toEqual([]);
    // The addition still happens; only the removal set is withheld.
    expect(planGlobalGraphReconcile('{not json', '/w/repo-b', true).add?.tag).toBe('repo-b');
  });
});
