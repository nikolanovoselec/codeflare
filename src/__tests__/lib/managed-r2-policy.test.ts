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
      { key: '.claude/extensions/company/index.ts', modes: ['advanced', 'default'] },
      { key: '.pi/agent/extensions/company.ts', modes: ['advanced'] },
    ],
    retiredPaths: ['.codex/extensions/retired.ts'],
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
        '.claude/extensions/company/index.ts',
        '.codeflare/managed-extensions.json',
        '.codeflare/managed-paths.json',
        '.codex/extensions/retired.ts',
        '.pi/agent/extensions/company.ts',
      ],
      resourceRoots: [],
    });
    expect(new TextDecoder().decode(built.bytes)).toBe(`${JSON.stringify(built.value)}\n`);
    expect(built.digest).toMatch(/^[0-9a-f]{64}$/);
    expect((await buildManagedR2Policy(digest, release(), 'immutable')).digest).toBe(built.digest);

    const changed = await buildManagedR2Policy(digest, release({
      retiredPaths: ['.codex/extensions/retired.ts', '.pi/agent/extensions/retired.ts'],
    }), 'immutable');
    expect(changed.bytes).not.toEqual(built.bytes);
    expect(changed.digest).not.toBe(built.digest);
  });

  it('REQ-STOR-028 AC2: duplicate and independently permuted inventories produce identical canonical bytes and identity', async () => {
    const original = release({ retiredPaths: ['.codex/extensions/z.ts', '.pi/agent/rules/a.md'] });
    const duplicate = release({
      documents: [...original.documents].reverse().concat(original.documents[0]!),
      retiredPaths: ['.pi/agent/rules/a.md', '.codex/extensions/z.ts', '.pi/agent/rules/a.md'],
    });
    const first = await buildManagedR2Policy(digest, original, 'exclusive');
    const second = await buildManagedR2Policy(digest, duplicate, 'exclusive');
    expect(first.value.paths).toEqual([
      '.claude/extensions/company/index.ts', '.codeflare/managed-extensions.json',
      '.codeflare/managed-paths.json', '.codex/extensions/z.ts',
      '.pi/agent/extensions/company.ts', '.pi/agent/rules/a.md',
    ]);
    expect(second.value).toEqual(first.value);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.digest).toBe(first.digest);
  });

  it('REQ-STOR-032 AC1: derives category roots across all six managed homes, including retirements', async () => {
    const homes = ['.claude/', '.codex/', '.copilot/', '.gemini/', '.config/opencode/', '.pi/agent/'];
    const built = await buildManagedR2Policy(digest, release({
      documents: homes.map(home => ({ key: `${home}skills/company/SKILL.md`, modes: ['default'] })),
      retiredPaths: homes.map(home => `${home}rules/retired.md`),
    }), 'exclusive');
    expect(built.value.resourceRoots).toEqual(homes.flatMap(home => [`${home}skills/`, `${home}rules/`]).sort());
    for (const home of homes) {
      expect(isManagedMutationProtected(built.value, `${home}skills/personal/SKILL.md`)).toBe(true);
      expect(isManagedMutationProtected(built.value, `${home}sessions/current.jsonl`)).toBe(false);
    }
  });

  it('REQ-STOR-032 AC1/AC2: exclusive roots derive segment-aware while sessions and root files remain outside', async () => {
    const built = await buildManagedR2Policy(digest, release(), 'exclusive');

    expect(built.value.resourceRoots).toEqual([
      '.claude/extensions/',
      '.codex/extensions/',
      '.pi/agent/extensions/',
    ]);
    expect(isManagedMutationProtected(built.value, '.claude/extensions')).toBe(true);
    expect(isManagedMutationProtected(built.value, '.claude/extensions/personal/index.ts')).toBe(true);
    expect(isManagedMutationProtected(built.value, '.claude/extensions-other/personal.md')).toBe(false);
    expect(isManagedMutationProtected(built.value, '.pi/agent/sessions/session.jsonl')).toBe(false);
    expect(canPrefixIntersectManagedPolicy(built.value, '.claude/')).toBe(true);
    expect(canPrefixIntersectManagedPolicy(built.value, 'Vault/')).toBe(false);
  });

  it('REQ-STOR-032 AC3: exclusive generation rejects a novel or later nested managed category', async () => {
    for (const key of ['.claude/toolboxes/company/tool.md', '.claude/toolboxes/extensions/tool.md']) {
      await expect(buildManagedR2Policy(digest, release({
        documents: [{ key, modes: ['default'] }],
      }), 'exclusive')).rejects.toThrow(/recognized managed resource category/);
    }
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

    const mismatchedDigest = `${built.digest[0] === '0' ? '1' : '0'}${built.digest.slice(1)}`;
    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject,
      releaseDigest: digest,
      pathsDigest: mismatchedDigest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    })).rejects.toThrow(/digest does not match applied state/);

    const noncanonicalBytes = new TextEncoder().encode(JSON.stringify(built.value, null, 2));
    const noncanonicalDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', noncanonicalBytes)))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject: async () => new Response(noncanonicalBytes, { status: 200 }),
      releaseDigest: digest,
      pathsDigest: noncanonicalDigest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    })).rejects.toThrow(/canonical/);
    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject,
      releaseDigest: 'e'.repeat(64),
      pathsDigest: built.digest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    })).rejects.toThrow(/release/);

    const invalidIdentityFetch = vi.fn(async () => new Response(built.bytes, { status: 200 }));
    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject: invalidIdentityFetch,
      releaseDigest: 'bad',
      pathsDigest: built.digest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    })).rejects.toThrow(/release digest/);
    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject: invalidIdentityFetch,
      releaseDigest: digest,
      pathsDigest: 'bad',
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    })).rejects.toThrow(/paths digest/);
    expect(invalidIdentityFetch).not.toHaveBeenCalled();
  });

  it('REQ-STOR-030 AC1: oversized streamed policy is refused and its body cancelled', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    });
    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject: async () => new Response(body),
      releaseDigest: digest,
      pathsDigest: 'f'.repeat(64),
      expectedPolicy: 'immutable',
      bypassMemoryCache: true,
    })).rejects.toThrow(/exceeds/);
    expect(cancelled).toBe(true);
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
      releaseDigest: 'e'.repeat(64),
      pathsDigest: built.digest,
      expectedPolicy: 'immutable',
      bypassMemoryCache: false,
    })).rejects.toThrow(/release does not match/);
    await expect(readVerifiedManagedR2Policy({
      fetchPolicyObject,
      releaseDigest: digest,
      pathsDigest: built.digest,
      expectedPolicy: 'exclusive',
      bypassMemoryCache: false,
    })).rejects.toThrow(/policy mode/);
  });
});
