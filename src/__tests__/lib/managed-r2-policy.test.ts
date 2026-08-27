import { describe, expect, it, vi } from 'vitest';
import type { ManagedReleaseIndex } from '../../lib/remote-curation';
import {
  buildManagedR2Policy,
  canPrefixIntersectManagedPolicy,
  isManagedMutationProtected,
  readVerifiedManagedR2Policy,
} from '../../lib/managed-r2-policy';

function release(overrides: Partial<ManagedReleaseIndex> = {}): ManagedReleaseIndex {
  return {
    seedAbi: 1,
    sequence: 7,
    source: {
      repositoryId: 123,
      commitSha: 'a'.repeat(40),
      releaseTag: 'release-7',
      compilerCommit: 'b'.repeat(40),
    },
    runtimeDependencyHash: 'c'.repeat(64),
    documents: [
      { key: '.claude/skills/company/SKILL.md', modes: ['advanced', 'default'] },
      { key: '.pi/agent/AGENTS.md', modes: ['advanced', 'default'] },
      { key: '.pi/agent/extensions/company.ts', modes: ['advanced'] },
    ],
    retiredPaths: ['.codex/rules/retired.md'],
    managedExtensions: [],
    ...overrides,
  };
}

const digest = 'd'.repeat(64);

describe('REQ-STOR-028 managed R2 policy', () => {
  it('AC1: deterministically protects both modes, retirements, and synthetic policy paths', async () => {
    const built = await buildManagedR2Policy(digest, release(), 'immutable');

    expect(built.value).toEqual({
      schemaVersion: 1,
      releaseDigest: digest,
      resourcePolicy: 'immutable',
      paths: [
        '.claude/skills/company/SKILL.md',
        '.codeflare/managed-extensions.json',
        '.codeflare/managed-paths.json',
        '.codex/rules/retired.md',
        '.pi/agent/AGENTS.md',
        '.pi/agent/extensions/company.ts',
      ],
      resourceRoots: [],
    });
    expect(new TextDecoder().decode(built.bytes)).toBe(`${JSON.stringify(built.value)}\n`);
    expect(built.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await buildManagedR2Policy(digest, release(), 'immutable')).digest).toBe(built.digest);
  });

  it('AC2: exclusive roots derive segment-aware while sessions and root files remain outside', async () => {
    const built = await buildManagedR2Policy(digest, release(), 'exclusive');

    expect(built.value.resourceRoots).toEqual([
      '.claude/skills/',
      '.codex/rules/',
      '.pi/agent/extensions/',
    ]);
    expect(isManagedMutationProtected(built.value, '.claude/skills')).toBe(true);
    expect(isManagedMutationProtected(built.value, '.claude/skills/personal/SKILL.md')).toBe(true);
    expect(isManagedMutationProtected(built.value, '.claude/skills-other/personal.md')).toBe(false);
    expect(isManagedMutationProtected(built.value, '.pi/agent/sessions/session.jsonl')).toBe(false);
    expect(canPrefixIntersectManagedPolicy(built.value, '.claude/')).toBe(true);
    expect(canPrefixIntersectManagedPolicy(built.value, 'Vault/')).toBe(false);
  });

  it('AC3: exclusive generation rejects a novel nested managed category', async () => {
    await expect(buildManagedR2Policy(digest, release({
      documents: [{ key: '.claude/toolboxes/company/tool.md', modes: ['default'] }],
    }), 'exclusive')).rejects.toThrow(/recognized managed resource category/);
  });

  it('AC4: loader verifies exact digest, release, mode, and canonical bytes', async () => {
    const built = await buildManagedR2Policy(digest, release(), 'immutable');
    const fetchPolicyObject = vi.fn(async () => new Response(built.bytes, { status: 200 }));

    const verified = await readVerifiedManagedR2Policy({
      fetchPolicyObject,
      releaseDigest: digest,
      pathsDigest: built.digest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    });
    expect(verified.paths).toEqual(built.value.paths);
    expect(fetchPolicyObject).toHaveBeenCalledTimes(1);

    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject: async () => new Response(`${new TextDecoder().decode(built.bytes)} `, { status: 200 }),
      releaseDigest: digest,
      pathsDigest: built.digest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    })).rejects.toThrow(/digest/);
    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject,
      releaseDigest: 'e'.repeat(64),
      pathsDigest: built.digest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    })).rejects.toThrow(/release/);
  });

  it('AC5: cache hits still revalidate expected release and mode', async () => {
    const built = await buildManagedR2Policy(digest, release(), 'immutable');
    const fetchPolicyObject = vi.fn(async () => new Response(built.bytes, { status: 200 }));
    await readVerifiedManagedR2Policy({
      fetchPolicyObject,
      releaseDigest: digest,
      pathsDigest: built.digest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    });
    await readVerifiedManagedR2Policy({
      fetchPolicyObject,
      releaseDigest: digest,
      pathsDigest: built.digest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: false,
    });
    expect(fetchPolicyObject).toHaveBeenCalledTimes(1);
    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject,
      releaseDigest: digest,
      pathsDigest: built.digest,
      expectedPolicy: 'exclusive',
      bypassMemoryCache: false,
    })).rejects.toThrow(/policy mode/);
  });
});
