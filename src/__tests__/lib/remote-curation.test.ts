import { describe, expect, it, vi } from 'vitest';
import {
  configureManagedEnvironment,
  downloadManagedAsset,
  getManagedEnvironmentConfigFingerprint,
  getManagedEnvironmentKeyFingerprint,
  getManagedEnvironmentPrefill,
  gzipBytes,
  readManagedEnvironmentSnapshot,
  resolveManagedEnvironment,
  resolveManagedResourcePolicy,
  resolveManagedEnvironmentRelease,
  streamManagedReleaseDocuments,
  verifyManagedReleaseStream as verifyManagedRelease,
  type ManagedEnvironmentFreshnessState,
  type ManagedRelease,
} from '../../lib/remote-curation';
import { getLegacyManagedReleaseCacheBucketName, type ActiveManagedRelease, type ManagedReleaseCache } from '../../lib/remote-curation-cache';
import { createMockKV } from '../helpers/mock-kv';
import { getManagedEnvironmentPatKey, getManagedEnvironmentStateKey, SETUP_KEYS } from '../../lib/kv-keys';
import { MANAGED_RELEASE_LIMITS } from '../../../scripts/agent-seed-release-limits.mjs';
import { PRESEED_RUNTIME_DEPENDENCY_HASH } from '../../lib/agent-seed.generated';

const bucketMocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ success: true, created: true })),
  remove: vi.fn(async (_input?: { bucketName: string }) => true),
}));
vi.mock('../../lib/r2-admin', () => ({
  createBucketIfNotExists: bucketMocks.create,
  deleteR2BucketIfExists: bucketMocks.remove,
}));

describe('managed resource policy selection', () => {
  it('REQ-SETUP-015 AC2: normalizes explicit managed resource controls', () => {
    expect(resolveManagedResourcePolicy({ enabled: true, immutableResources: false, disableUserCreatedResources: false }, 'exclusive')).toBe('mutable');
    expect(resolveManagedResourcePolicy({ enabled: true, immutableResources: true, disableUserCreatedResources: false }, 'exclusive')).toBe('immutable');
    expect(resolveManagedResourcePolicy({ enabled: true, immutableResources: true, disableUserCreatedResources: true }, 'mutable')).toBe('exclusive');
    expect(resolveManagedResourcePolicy({ enabled: false }, 'exclusive')).toBe('mutable');
  });

  it('REQ-SETUP-015 AC4: omitted managed resource controls preserve stored policy', () => {
    expect(resolveManagedResourcePolicy({ enabled: true }, 'exclusive')).toBe('exclusive');
    expect(resolveManagedResourcePolicy({ enabled: true, immutableResources: true }, 'exclusive')).toBe('exclusive');
  });

  it('REQ-SETUP-015 AC5: omitted managed resource controls default to mutable', () => {
    expect(resolveManagedResourcePolicy({ enabled: true }, undefined)).toBe('mutable');
  });

  it('REQ-SETUP-016 AC1: rejects exclusive policy without immutable policy', () => {
    expect(() => resolveManagedResourcePolicy({
      enabled: true,
      immutableResources: false,
      disableUserCreatedResources: true,
    }, 'mutable')).toThrow(/requires Immutable Resources/);
  });

});

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');

function release(overrides: Partial<ManagedRelease> = {}): ManagedRelease {
  return {
    seedAbi: 1,
    sequence: 7,
    source: {
      repositoryId: 123456,
      commitSha: 'a'.repeat(40),
      releaseTag: 'release-7',
      compilerCommit: 'b'.repeat(40),
    },
    runtimeDependencyHash: 'c'.repeat(64),
    documents: [
      {
        key: '.claude/skills/company/SKILL.md',
        contentType: 'text/markdown; charset=utf-8',
        content: '# Company\n',
        modes: ['advanced', 'default'],
      },
    ],
    retiredPaths: [],
    managedExtensions: [
      {
        id: 'cherrymarkdownpublisher.cherry-markdown',
        publisher: 'cherryMarkdownPublisher',
        name: 'cherry-markdown',
        version: '0.3.1081718',
        targetPlatform: 'universal',
        engine: '^1.73.0',
        entrypoint: './dist/extension.js',
        extensionPack: [],
        extensionDependencies: [],
        size: 1024,
        sha256: 'd'.repeat(64),
        downloadUrl: 'https://open-vsx.org/api/cherryMarkdownPublisher/cherry-markdown/0.3.1081718/file/cherry-markdown.vsix',
      },
    ],
    ...overrides,
  };
}

async function signedFixture(value = release(), suppliedKeyPair?: CryptoKeyPair) {
  const keyPair = suppliedKeyPair ?? await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const compressed = await gzipBytes(encoder.encode(JSON.stringify(value)));
  const signature = await crypto.subtle.sign('Ed25519', keyPair.privateKey, compressed);
  const publicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey) as ArrayBuffer;
  return { compressed, signature: new Uint8Array(signature), publicKeyHex: hex(publicKey) };
}

// REQ-AGENT-150 and REQ-SETUP-013: the Worker is the trust boundary. These
// tests assert activation inputs, not validation copy or implementation text.
describe('managed environment release verification', () => {
  it('REQ-AGENT-147 AC3: accepts one complete signed release contract and rejects an incomplete contract', async () => {
    const fixture = await signedFixture();

    const verified = await verifyManagedRelease({
      ...fixture,
      expectedRepositoryId: 123456,
      minimumSequence: 6,
      expectedRuntimeHash: 'c'.repeat(64),
    });

    expect(verified.release.sequence).toBe(7);
    expect(verified.release.documents).toHaveLength(1);
    expect(verified.digest).toMatch(/^[0-9a-f]{64}$/);

    const incomplete = await signedFixture(release({ source: { repositoryId: 123456, commitSha: '', releaseTag: 'release-7', compilerCommit: 'b'.repeat(40) } }));
    await expect(verifyManagedRelease({
      ...incomplete,
      expectedRepositoryId: 123456,
      minimumSequence: 6,
      expectedRuntimeHash: 'c'.repeat(64),
    })).rejects.toThrow(/commitSha/i);
  });

  it('REQ-AGENT-151 AC1+AC3+AC4: retains bounded metadata and streams identical documents', async () => {
    const documents = [
      { key: '.claude/common.md', contentType: 'text/markdown; charset=utf-8', content: '# Common\n', modes: ['advanced', 'default'] as const },
      { key: '.pi/agent/skills/company/SKILL.md', contentType: 'text/markdown; charset=utf-8', content: '# Advanced\n', modes: ['advanced'] as const },
    ];
    const fixture = await signedFixture(release({ documents: documents.map((document) => ({ ...document, modes: [...document.modes] })) }));

    const verified = await verifyManagedRelease({
      ...fixture,
      expectedRepositoryId: 123456,
      minimumSequence: 6,
      expectedRuntimeHash: 'c'.repeat(64),
    });

    expect(verified.release.documents).toEqual(documents.map(({ key, modes }) => ({ key, modes: [...modes] })));
    expect(JSON.stringify(verified.release.documents)).not.toContain('# Common');

    const streamed: ManagedRelease['documents'] = [];
    await streamManagedReleaseDocuments(verified.compressed, async (document) => {
      streamed.push(document);
    });
    expect(streamed).toEqual(documents.map((document) => ({ ...document, modes: [...document.modes] })));
  });

  it('REQ-AGENT-151 AC4+AC5: caps pending callbacks and resumes after one settles', async () => {
    const documentCount = 20;
    const fixture = await signedFixture(release({
      documents: Array.from({ length: documentCount }, (_, index) => ({
        key: `.claude/rules/${String(index).padStart(2, '0')}.md`,
        contentType: 'text/markdown; charset=utf-8',
        content: `# Rule ${index}`,
        modes: ['advanced'],
      })),
    }));
    const pendingCallbacks: Array<() => void> = [];
    let holdCallbacks = true;
    let reachedConcurrencyLimit: (() => void) | undefined;
    const concurrencyLimitReached = new Promise<void>((resolve) => { reachedConcurrencyLimit = resolve; });
    let releaseSeventhCallback: (() => void) | undefined;
    const seventhCallbackStarted = new Promise<void>((resolve) => { releaseSeventhCallback = resolve; });
    let started = 0;
    let active = 0;
    let peak = 0;

    const streaming = streamManagedReleaseDocuments(fixture.compressed, async () => {
      started += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (started === 6) reachedConcurrencyLimit?.();
      if (started === 7) releaseSeventhCallback?.();
      if (holdCallbacks) {
        await new Promise<void>((resolve) => pendingCallbacks.push(resolve));
      }
      active -= 1;
    });

    await concurrencyLimitReached;
    await Promise.resolve();
    expect(started).toBe(6);
    expect(peak).toBe(6);

    pendingCallbacks.shift()?.();
    await seventhCallbackStarted;
    expect(started).toBe(7);
    expect(peak).toBe(6);

    holdCallbacks = false;
    pendingCallbacks.splice(0).forEach((releaseCallback) => releaseCallback());
    await streaming;
    expect(started).toBe(documentCount);
    expect(active).toBe(0);
  });

  it('REQ-AGENT-151 AC2: aborts gzip expansion at the shared expanded-byte limit', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const compressed = await gzipBytes(encoder.encode(' '.repeat(MANAGED_RELEASE_LIMITS.expandedBytes + 1)));
    const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', keyPair.privateKey, compressed));
    const publicKeyHex = hex(await crypto.subtle.exportKey('raw', keyPair.publicKey) as ArrayBuffer);

    await expect(verifyManagedRelease({
      compressed,
      signature,
      publicKeyHex,
      expectedRepositoryId: 123456,
      minimumSequence: 1,
      expectedRuntimeHash: 'c'.repeat(64),
    })).rejects.toThrow(/exceeds/i);
  });

  it('rejects signatures that are not exactly 64 raw bytes before activation', async () => {
    const fixture = await signedFixture();
    await expect(verifyManagedRelease({
      ...fixture,
      signature: fixture.signature.slice(0, 63),
      expectedRepositoryId: 123456,
      minimumSequence: 6,
      expectedRuntimeHash: 'c'.repeat(64),
    })).rejects.toThrow(/64 bytes/i);
  });

  it('REQ-AGENT-150 AC1-AC6: independently rejects invalid release records before activation', async () => {
    const fixture = await signedFixture();
    const changedSignature = new Uint8Array(fixture.signature);
    changedSignature[0] ^= 0xff;

    await expect(verifyManagedRelease({
      ...fixture,
      signature: changedSignature,
      expectedRepositoryId: 123456,
      minimumSequence: 6,
      expectedRuntimeHash: 'c'.repeat(64),
    })).rejects.toThrow(/signature/i);
    await expect(verifyManagedRelease({ ...fixture, expectedRepositoryId: 999, minimumSequence: 6, expectedRuntimeHash: 'c'.repeat(64) })).rejects.toThrow(/repository/i);
    await expect(verifyManagedRelease({ ...fixture, expectedRepositoryId: 123456, minimumSequence: 8, expectedRuntimeHash: 'c'.repeat(64) })).rejects.toThrow(/sequence/i);
    await expect(verifyManagedRelease({ ...fixture, expectedRepositoryId: 123456, minimumSequence: 6, expectedRuntimeHash: 'e'.repeat(64) })).rejects.toThrow(/runtime/i);

    const forbidden = await signedFixture(release({
      documents: [{ key: '.claude/plugins/context-mode/plugin.json', contentType: 'application/json; charset=utf-8', content: '{}', modes: ['advanced'] }],
    }));
    await expect(verifyManagedRelease({ ...forbidden, expectedRepositoryId: 123456, minimumSequence: 6, expectedRuntimeHash: 'c'.repeat(64) })).rejects.toThrow(/context-mode/i);

    for (const key of ['.ssh/authorized_keys', '.pi/agent/npm/package.json']) {
      const unsupported = await signedFixture(release({
        documents: [{ key, contentType: 'text/plain; charset=utf-8', content: 'forbidden', modes: ['advanced'] }],
      }));
      await expect(verifyManagedRelease({ ...unsupported, expectedRepositoryId: 123456, minimumSequence: 6, expectedRuntimeHash: 'c'.repeat(64) })).rejects.toThrow(/supported managed path roots|image-owned Pi package metadata/i);
    }

    const forbiddenRetirement = await signedFixture(release({ retiredPaths: ['.claude/plugins/context-mode/hooks.json'] }));
    await expect(verifyManagedRelease({ ...forbiddenRetirement, expectedRepositoryId: 123456, minimumSequence: 6, expectedRuntimeHash: 'c'.repeat(64) })).rejects.toThrow(/context-mode/i);

    const duplicateDocument = release().documents[0];
    const duplicateOwnership = await signedFixture(release({ documents: [duplicateDocument, duplicateDocument] }));
    await expect(verifyManagedRelease({ ...duplicateOwnership, expectedRepositoryId: 123456, minimumSequence: 6, expectedRuntimeHash: 'c'.repeat(64) })).rejects.toThrow(/duplicate/i);

    const invalidExtensionRelease = release();
    invalidExtensionRelease.managedExtensions[0] = {
      ...invalidExtensionRelease.managedExtensions[0],
      id: 'different.extension',
    };
    const invalidExtension = await signedFixture(invalidExtensionRelease);
    await expect(verifyManagedRelease({ ...invalidExtension, expectedRepositoryId: 123456, minimumSequence: 6, expectedRuntimeHash: 'c'.repeat(64) })).rejects.toThrow(/identity|publisher|name|id/i);

    const invalidVersionRelease = release();
    invalidVersionRelease.managedExtensions[0] = {
      ...invalidVersionRelease.managedExtensions[0],
      version: '01.2.3',
      downloadUrl: 'https://open-vsx.org/api/cherryMarkdownPublisher/cherry-markdown/01.2.3/file/cherry-markdown.vsix',
    };
    const invalidVersion = await signedFixture(invalidVersionRelease);
    await expect(verifyManagedRelease({ ...invalidVersion, expectedRepositoryId: 123456, minimumSequence: 6, expectedRuntimeHash: 'c'.repeat(64) })).rejects.toThrow(/schema|semantic|version/i);
  });

  it('downloads one exact allowed redirect without forwarding GitHub authorization', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com/release/seed-v1.json.gz' } }))
      .mockResolvedValueOnce(new Response('bundle', { status: 200 }));

    const bytes = await downloadManagedAsset({
      url: 'https://api.github.com/repos/acme/curation/releases/assets/1',
      token: 'secret-pat',
      fetcher,
    });

    expect(new TextDecoder().decode(bytes)).toBe('bundle');
    const first = fetcher.mock.calls[0][0] as Request;
    const second = fetcher.mock.calls[1][0] as Request;
    expect(first.headers.get('authorization')).toBe('Bearer secret-pat');
    expect(second.headers.has('authorization')).toBe(false);
    expect(second.redirect).toBe('manual');
  });

  it('REQ-SETUP-014 AC3: rejects a non-GitHub API origin before sending repository authorization', async () => {
    const fetcher = vi.fn();

    await expect(downloadManagedAsset({
      url: 'https://example.com/repos/acme/curation/releases/assets/1',
      token: 'secret-pat',
      fetcher,
    })).rejects.toThrow(/GitHub API host/i);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts managed GitHub requests after the shared ten-second boundary', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetcher = vi.fn().mockResolvedValue(new Response('bundle', { status: 200 }));

    try {
      await downloadManagedAsset({
        url: 'https://api.github.com/repos/acme/curation/releases/assets/1',
        token: 'secret-pat',
        fetcher,
      });

      expect(timeout).toHaveBeenCalledWith(10_000);
      const request = fetcher.mock.calls[0][0] as Request;
      expect(request.signal.aborted).toBe(false);
      controller.abort();
      expect(request.signal.aborted).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it('rejects an asset redirect outside the fixed GitHub object hosts', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://objects.githubusercontent.com.evil.example/seed-v1.json.gz' } }),
    );

    await expect(downloadManagedAsset({
      url: 'https://api.github.com/repos/acme/curation/releases/assets/1',
      token: 'secret-pat',
      fetcher,
    })).rejects.toThrow(/redirect host/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function resolverCache(initial?: ActiveManagedRelease) {
  let active = initial;
  const objects = new Map<string, Uint8Array>();
  const cache: ManagedReleaseCache = {
    putImmutable: vi.fn(async (key, bytes) => {
      const prior = objects.get(key);
      if (prior && (prior.length !== bytes.length || prior.some((value, index) => value !== bytes[index]))) {
        throw new Error('immutable conflict');
      }
      objects.set(key, bytes);
    }),
    readActive: vi.fn(async () => active ? { pointer: active, etag: '"active-etag"' } : undefined),
    createActive: vi.fn(async (pointer) => {
      if (active) return false;
      active = pointer;
      return true;
    }),
    replaceActive: vi.fn(async (pointer) => {
      active = pointer;
      return true;
    }),
  };
  return { cache, objects, active: () => active };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

function releaseMetadata(input: {
  bundleDigest: string;
  signatureDigest: string;
  immutable?: boolean;
  releaseId?: number;
  releaseTag?: string;
}) {
  const releaseId = input.releaseId ?? 77;
  return {
    id: releaseId,
    tag_name: input.releaseTag ?? 'release-7',
    immutable: input.immutable ?? true,
    draft: false,
    prerelease: false,
    assets: [
      {
        id: releaseId * 10 + 1,
        name: 'seed-v1.json.gz',
        url: `https://api.github.com/repos/acme/curation/releases/assets/${releaseId * 10 + 1}`,
        digest: `sha256:${input.bundleDigest}`,
      },
      {
        id: releaseId * 10 + 2,
        name: 'seed-v1.sig',
        url: `https://api.github.com/repos/acme/curation/releases/assets/${releaseId * 10 + 2}`,
        digest: `sha256:${input.signatureDigest}`,
      },
    ],
  };
}

function latestReleaseResponse(input: Parameters<typeof releaseMetadata>[0]): Response {
  return new Response(JSON.stringify(releaseMetadata(input)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      etag: '"latest-etag"',
      'github-authentication-token-expiration': '2026-09-01 00:00:00 UTC',
    },
  });
}

function releaseListResponse(releases: unknown[]): Response {
  return new Response(JSON.stringify(releases), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('managed release resolver', () => {
  it('derives stable trust fingerprints from repository identity and the raw signing key', async () => {
    const key = 'ab'.repeat(32);
    const keyFingerprint = await getManagedEnvironmentKeyFingerprint(key);
    const first = await getManagedEnvironmentConfigFingerprint(123456, key);
    expect(keyFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    await expect(getManagedEnvironmentConfigFingerprint(123456, key)).resolves.toBe(first);
    await expect(getManagedEnvironmentConfigFingerprint(123457, key)).resolves.not.toBe(first);
  });

  it('activates only a GitHub immutable release whose two immutable asset digests and signature verify', async () => {
    const fixture = await signedFixture();
    const bundleDigest = await sha256(fixture.compressed);
    const signatureDigest = await sha256(fixture.signature);
    const stateKey = 'setup:managed_environment_state:test';
    const kv = createMockKV();
    const state = resolverCache();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(latestReleaseResponse({ bundleDigest, signatureDigest }))
      .mockResolvedValueOnce(new Response(fixture.compressed, { status: 200 }))
      .mockResolvedValueOnce(new Response(fixture.signature, { status: 200 }));

    const resolved = await resolveManagedEnvironmentRelease({
      kv: kv as unknown as KVNamespace,
      stateKey,
      cache: state.cache,
      repository: 'acme/curation',
      repositoryId: 123456,
      token: 'secret-pat',
      publicKeyHex: fixture.publicKeyHex,
      expectedRuntimeHash: 'c'.repeat(64),
      fetcher,
      now: new Date('2026-08-18T00:00:00.000Z'),
      requireFresh: true,
    });

    expect(resolved.freshness).toBe('fresh');
    expect(resolved.active?.digest).toBe(bundleDigest);
    expect(resolved.active?.releaseId).toBe(77);
    expect([...state.objects.keys()].sort()).toEqual([
      `releases/${bundleDigest}/seed-v1.json.gz`,
      `releases/${bundleDigest}/seed-v1.sig`,
    ]);
    const persisted = JSON.parse(kv._store.get(stateKey) ?? '{}') as ManagedEnvironmentFreshnessState;
    expect(persisted.etag).toBe('"latest-etag"');
    expect(persisted.lastError).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain('secret-pat');
  });

  it('REQ-AGENT-154 AC2+AC3+AC4: skips mismatches and unrelated releases then activates the newest compatible seed', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const latest = await signedFixture(release({
      sequence: 9,
      source: { repositoryId: 123456, commitSha: '9'.repeat(40), releaseTag: 'release-9', compilerCommit: 'd'.repeat(40) },
      runtimeDependencyHash: 'd'.repeat(64),
    }), keyPair);
    const compatible = await signedFixture(release({
      sequence: 8,
      source: { repositoryId: 123456, commitSha: '8'.repeat(40), releaseTag: 'release-8', compilerCommit: 'c'.repeat(40) },
      runtimeDependencyHash: 'c'.repeat(64),
    }), keyPair);
    const olderCompatible = await signedFixture(release({
      sequence: 7,
      source: { repositoryId: 123456, commitSha: '7'.repeat(40), releaseTag: 'release-7', compilerCommit: 'b'.repeat(40) },
      runtimeDependencyHash: 'c'.repeat(64),
    }), keyPair);
    const latestMetadata = releaseMetadata({
      releaseId: 99,
      releaseTag: 'release-9',
      bundleDigest: await sha256(latest.compressed),
      signatureDigest: await sha256(latest.signature),
    });
    const compatibleMetadata = releaseMetadata({
      releaseId: 88,
      releaseTag: 'release-8',
      bundleDigest: await sha256(compatible.compressed),
      signatureDigest: await sha256(compatible.signature),
    });
    const olderCompatibleMetadata = releaseMetadata({
      releaseId: 77,
      releaseTag: 'release-7',
      bundleDigest: await sha256(olderCompatible.compressed),
      signatureDigest: await sha256(olderCompatible.signature),
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(latestReleaseResponse({
        releaseId: 99,
        releaseTag: 'release-9',
        bundleDigest: await sha256(latest.compressed),
        signatureDigest: await sha256(latest.signature),
      }))
      .mockResolvedValueOnce(new Response(latest.compressed, { status: 200 }))
      .mockResolvedValueOnce(new Response(latest.signature, { status: 200 }))
      .mockResolvedValueOnce(releaseListResponse([
        latestMetadata,
        { id: 90, tag_name: 'ordinary-v1', immutable: false, draft: false, prerelease: false, assets: [] },
        compatibleMetadata,
        olderCompatibleMetadata,
      ]))
      .mockResolvedValueOnce(new Response(compatible.compressed, { status: 200 }))
      .mockResolvedValueOnce(new Response(compatible.signature, { status: 200 }));

    const resolved = await resolveManagedEnvironmentRelease({
      kv: createMockKV() as unknown as KVNamespace,
      stateKey: 'state',
      cache: resolverCache().cache,
      repository: 'acme/curation',
      repositoryId: 123456,
      token: 'secret-pat',
      publicKeyHex: latest.publicKeyHex,
      expectedRuntimeHash: 'c'.repeat(64),
      fetcher,
      now: new Date('2026-08-18T00:00:00.000Z'),
      requireFresh: true,
    });

    expect(resolved.active?.sequence).toBe(8);
    expect(resolved.active?.runtimeDependencyHash).toBe('c'.repeat(64));
    expect(fetcher.mock.calls.some(([request]) => new URL((request as Request).url).pathname.endsWith('/releases'))).toBe(true);
    expect(fetcher.mock.calls.some(([request]) => (request as Request).url.endsWith('/assets/771'))).toBe(false);
  });

  it('REQ-AGENT-154 AC5: stops when an advertised history release fails validation', async () => {
    const fixture = await signedFixture(release({ runtimeDependencyHash: 'd'.repeat(64) }));
    const bundleDigest = await sha256(fixture.compressed);
    const signatureDigest = await sha256(fixture.signature);
    const state = resolverCache();
    const advertisedInvalid = {
      ...releaseMetadata({ releaseId: 66, releaseTag: 'release-6', bundleDigest, signatureDigest }),
      immutable: false,
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(latestReleaseResponse({ bundleDigest, signatureDigest }))
      .mockResolvedValueOnce(new Response(fixture.compressed, { status: 200 }))
      .mockResolvedValueOnce(new Response(fixture.signature, { status: 200 }))
      .mockResolvedValueOnce(releaseListResponse([advertisedInvalid]));

    await expect(resolveManagedEnvironmentRelease({
      kv: createMockKV() as unknown as KVNamespace,
      stateKey: 'state',
      cache: state.cache,
      repository: 'acme/curation',
      repositoryId: 123456,
      token: 'secret-pat',
      publicKeyHex: fixture.publicKeyHex,
      expectedRuntimeHash: 'c'.repeat(64),
      fetcher,
      now: new Date('2026-08-18T00:00:00.000Z'),
      requireFresh: true,
    })).rejects.toThrow(/managed release history contains invalid immutable metadata/i);
    expect(state.active()).toBeUndefined();
  });

  it('REQ-AGENT-154 AC1+AC6: bounds compatible-release discovery to the 1,000 most recent records', async () => {
    const fixture = await signedFixture(release({ runtimeDependencyHash: 'd'.repeat(64) }));
    const ordinaryPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      tag_name: `ordinary-${index + 1}`,
      immutable: false,
      draft: false,
      prerelease: false,
      assets: [],
    }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(latestReleaseResponse({
        bundleDigest: await sha256(fixture.compressed),
        signatureDigest: await sha256(fixture.signature),
      }))
      .mockResolvedValueOnce(new Response(fixture.compressed, { status: 200 }))
      .mockResolvedValueOnce(new Response(fixture.signature, { status: 200 }));
    for (let page = 0; page < 10; page += 1) fetcher.mockResolvedValueOnce(releaseListResponse(ordinaryPage));

    await expect(resolveManagedEnvironmentRelease({
      kv: createMockKV() as unknown as KVNamespace,
      stateKey: 'state',
      cache: resolverCache().cache,
      repository: 'acme/curation',
      repositoryId: 123456,
      token: 'secret-pat',
      publicKeyHex: fixture.publicKeyHex,
      expectedRuntimeHash: 'c'.repeat(64),
      fetcher,
      now: new Date('2026-08-18T00:00:00.000Z'),
      requireFresh: true,
    })).rejects.toThrow(/No immutable managed release matches/i);

    const historyUrls = fetcher.mock.calls
      .map(([request]) => (request as Request).url)
      .filter((url) => url.includes('/releases?'));
    expect(historyUrls).toHaveLength(10);
    expect(historyUrls.at(-1)).toContain('page=10');
  });

  it('uses a complete verified cache without GitHub I/O inside the five-minute freshness window', async () => {
    const active: ActiveManagedRelease = {
      schemaVersion: 1,
      seedAbi: 1,
      sequence: 7,
      digest: 'd'.repeat(64),
      repositoryId: 123456,
      releaseId: 77,
      releaseTag: 'release-7',
      sourceCommit: 'a'.repeat(40),
      runtimeDependencyHash: 'c'.repeat(64),
      activatedAt: '2026-08-18T00:00:00.000Z',
    };
    const kv = createMockKV();
    kv._store.set('state', JSON.stringify({ schemaVersion: 1, active, lastCheckedAt: '2026-08-18T00:00:00.000Z' }));
    const fetcher = vi.fn();

    const resolved = await resolveManagedEnvironmentRelease({
      kv: kv as unknown as KVNamespace,
      stateKey: 'state',
      cache: resolverCache(active).cache,
      repository: 'acme/curation',
      repositoryId: 123456,
      token: 'secret-pat',
      publicKeyHex: 'ab'.repeat(32),
      expectedRuntimeHash: 'c'.repeat(64),
      fetcher,
      now: new Date('2026-08-18T00:04:59.000Z'),
    });

    expect(resolved.active).toEqual(active);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('REQ-AGENT-162 AC1: reads a stale verified snapshot without repository or cache I/O', async () => {
    const active: ActiveManagedRelease = {
      schemaVersion: 1,
      seedAbi: 1,
      sequence: 24,
      digest: 'd'.repeat(64),
      repositoryId: 123456,
      releaseId: 240,
      releaseTag: 'release-24',
      sourceCommit: 'a'.repeat(40),
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      activatedAt: '2026-08-18T00:00:00.000Z',
    };
    const config = {
      schemaVersion: 1 as const,
      enabled: true,
      repository: 'acme/curation',
      repositoryId: 123456,
      publicKeyHex: 'ab'.repeat(32),
      publicKeyFingerprint: '1'.repeat(16),
      configFingerprint: 'f'.repeat(64),
      cacheBucketName: 'managed-cache',
      resourcePolicy: 'mutable' as const,
    };
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, JSON.stringify(config));
    kv._store.set(getManagedEnvironmentStateKey(config.configFingerprint), JSON.stringify({
      schemaVersion: 1,
      active,
      lastCheckedAt: '2026-08-18T00:00:00.000Z',
      lastError: 'repository unavailable',
    }));

    await expect(readManagedEnvironmentSnapshot({ KV: kv as unknown as KVNamespace })).resolves.toEqual({
      configured: true,
      enabled: true,
      config,
      active,
    });
  });

  it('does not reuse a fresh cached release from a different build hash', async () => {
    const fixture = await signedFixture(release({ runtimeDependencyHash: 'c'.repeat(64) }));
    const incompatible: ActiveManagedRelease = {
      schemaVersion: 1,
      seedAbi: 1,
      sequence: 6,
      digest: 'd'.repeat(64),
      repositoryId: 123456,
      releaseId: 66,
      releaseTag: 'release-6',
      sourceCommit: '6'.repeat(40),
      runtimeDependencyHash: 'd'.repeat(64),
      activatedAt: '2026-08-18T00:00:00.000Z',
    };
    const kv = createMockKV();
    kv._store.set('state', JSON.stringify({ schemaVersion: 1, active: incompatible, lastCheckedAt: '2026-08-18T00:00:00.000Z' }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(latestReleaseResponse({
        bundleDigest: await sha256(fixture.compressed),
        signatureDigest: await sha256(fixture.signature),
      }))
      .mockResolvedValueOnce(new Response(fixture.compressed, { status: 200 }))
      .mockResolvedValueOnce(new Response(fixture.signature, { status: 200 }));

    const resolved = await resolveManagedEnvironmentRelease({
      kv: kv as unknown as KVNamespace,
      stateKey: 'state',
      cache: resolverCache(incompatible).cache,
      repository: 'acme/curation',
      repositoryId: 123456,
      token: 'secret-pat',
      publicKeyHex: fixture.publicKeyHex,
      expectedRuntimeHash: 'c'.repeat(64),
      fetcher,
      now: new Date('2026-08-18T00:01:00.000Z'),
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(resolved.active?.runtimeDependencyHash).toBe('c'.repeat(64));
  });

  it('uses the stored ETag after five minutes and treats 304 as a fresh no-op', async () => {
    const fixture = await signedFixture();
    const active: ActiveManagedRelease = {
      schemaVersion: 1,
      seedAbi: 1,
      sequence: 7,
      digest: await sha256(fixture.compressed),
      repositoryId: 123456,
      releaseId: 77,
      releaseTag: 'release-7',
      sourceCommit: 'a'.repeat(40),
      runtimeDependencyHash: 'c'.repeat(64),
      activatedAt: '2026-08-18T00:00:00.000Z',
    };
    const kv = createMockKV();
    kv._store.set('state', JSON.stringify({
      schemaVersion: 1,
      etag: '"old-etag"',
      active,
      lastCheckedAt: '2026-08-18T00:00:00.000Z',
    }));
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.headers.get('if-none-match')).toBe('"old-etag"');
      expect(request.headers.get('authorization')).toBe('Bearer secret-pat');
      return new Response(null, { status: 304, headers: { etag: '"old-etag"' } });
    });

    const resolved = await resolveManagedEnvironmentRelease({
      kv: kv as unknown as KVNamespace,
      stateKey: 'state',
      cache: resolverCache(active).cache,
      repository: 'acme/curation',
      repositoryId: 123456,
      token: 'secret-pat',
      publicKeyHex: fixture.publicKeyHex,
      expectedRuntimeHash: 'c'.repeat(64),
      fetcher: fetcher as typeof fetch,
      now: new Date('2026-08-18T00:05:01.000Z'),
    });

    expect(resolved.active).toEqual(active);
    expect(resolved.freshness).toBe('fresh');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('REQ-SETUP-014 AC5: degraded diagnostics redact repository credentials', async () => {
    const active: ActiveManagedRelease = {
      schemaVersion: 1,
      seedAbi: 1,
      sequence: 7,
      digest: 'd'.repeat(64),
      repositoryId: 123456,
      releaseId: 77,
      releaseTag: 'release-7',
      sourceCommit: 'a'.repeat(40),
      runtimeDependencyHash: 'c'.repeat(64),
      activatedAt: '2026-08-18T00:00:00.000Z',
    };
    const kv = createMockKV();
    kv._store.set('state', JSON.stringify({
      schemaVersion: 1,
      active,
      lastCheckedAt: '2026-08-18T00:00:00.000Z',
      etag: '"etag"',
    }));

    const resolved = await resolveManagedEnvironmentRelease({
      kv: kv as unknown as KVNamespace,
      stateKey: 'state',
      cache: resolverCache(active).cache,
      repository: 'acme/curation',
      repositoryId: 123456,
      token: 'secret-pat',
      publicKeyHex: 'ab'.repeat(32),
      expectedRuntimeHash: 'c'.repeat(64),
      fetcher: vi.fn(async () => { throw new Error('secret-pat failed during GitHub outage'); }),
      now: new Date('2026-08-18T00:05:01.000Z'),
    });

    expect(resolved.active).toEqual(active);
    expect(resolved.freshness).toBe('degraded');
    expect(resolved.lastError).toContain('[redacted]');
    expect(resolved.lastError).not.toContain('secret-pat');
  });

  it('stores the PAT only as AES ciphertext and transactionally activates monotonic public-key replacement', async () => {
    const firstKeyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const firstFixture = await signedFixture(release({ runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH }), firstKeyPair);
    const sameTrustUpdateFixture = await signedFixture(release({
      sequence: 8,
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 123456,
        commitSha: '1'.repeat(40),
        releaseTag: 'release-8-same-trust',
        compilerCommit: 'b'.repeat(40),
      },
    }), firstKeyPair);
    const sameTrustConflictFixture = await signedFixture(release({
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 123456,
        commitSha: '2'.repeat(40),
        releaseTag: 'release-7-conflict',
        compilerCommit: 'b'.repeat(40),
      },
    }), firstKeyPair);
    const replacementKeyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const replacementFixture = await signedFixture(release({
      sequence: 9,
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 123456,
        commitSha: '3'.repeat(40),
        releaseTag: 'release-9-new-key',
        compilerCommit: 'b'.repeat(40),
      },
    }), replacementKeyPair);
    const replacementLowerFixture = await signedFixture(release({
      sequence: 6,
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 123456,
        commitSha: '4'.repeat(40),
        releaseTag: 'release-6-new-key',
        compilerCommit: 'b'.repeat(40),
      },
    }), replacementKeyPair);
    const replacementConflictFixture = await signedFixture(release({
      sequence: 7,
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 123456,
        commitSha: '5'.repeat(40),
        releaseTag: 'release-7-new-key-conflict',
        compilerCommit: 'b'.repeat(40),
      },
    }), replacementKeyPair);
    const otherRepositoryFixture = await signedFixture(release({
      sequence: 1,
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 654321,
        commitSha: '6'.repeat(40),
        releaseTag: 'release-1-other-repository',
        compilerCommit: 'b'.repeat(40),
      },
    }), replacementKeyPair);
    const rotationTenKeyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const rotationTenFixture = await signedFixture(release({
      sequence: 10,
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 654321,
        commitSha: '7'.repeat(40),
        releaseTag: 'release-10-concurrent',
        compilerCommit: 'b'.repeat(40),
      },
    }), rotationTenKeyPair);
    const rotationEightKeyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const rotationEightFixture = await signedFixture(release({
      sequence: 8,
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 654321,
        commitSha: '8'.repeat(40),
        releaseTag: 'release-8-concurrent',
        compilerCommit: 'b'.repeat(40),
      },
    }), rotationEightKeyPair);
    const rotationTwelveKeyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const rotationTwelveFixture = await signedFixture(release({
      sequence: 12,
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 654321,
        commitSha: '9'.repeat(40),
        releaseTag: 'release-12-concurrent',
        compilerCommit: 'b'.repeat(40),
      },
    }), rotationTwelveKeyPair);
    const rotationTwentyKeyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const rotationTwentyFixture = await signedFixture(release({
      sequence: 20,
      runtimeDependencyHash: PRESEED_RUNTIME_DEPENDENCY_HASH,
      source: {
        repositoryId: 654321,
        commitSha: '0'.repeat(40),
        releaseTag: 'release-20-exhaustion',
        compilerCommit: 'b'.repeat(40),
      },
    }), rotationTwentyKeyPair);
    const replacementPublicKey = replacementFixture.publicKeyHex;
    const releases = {
      first: {
        id: 77,
        tag: 'release-7',
        fixture: firstFixture,
        bundleDigest: await sha256(firstFixture.compressed),
        signatureDigest: await sha256(firstFixture.signature),
      },
      sameTrustUpdate: {
        id: 79,
        tag: 'release-8-same-trust',
        fixture: sameTrustUpdateFixture,
        bundleDigest: await sha256(sameTrustUpdateFixture.compressed),
        signatureDigest: await sha256(sameTrustUpdateFixture.signature),
      },
      sameTrustConflict: {
        id: 76,
        tag: 'release-7-conflict',
        fixture: sameTrustConflictFixture,
        bundleDigest: await sha256(sameTrustConflictFixture.compressed),
        signatureDigest: await sha256(sameTrustConflictFixture.signature),
      },
      replacement: {
        id: 80,
        tag: 'release-9-new-key',
        fixture: replacementFixture,
        bundleDigest: await sha256(replacementFixture.compressed),
        signatureDigest: await sha256(replacementFixture.signature),
      },
      replacementLower: {
        id: 81,
        tag: 'release-6-new-key',
        fixture: replacementLowerFixture,
        bundleDigest: await sha256(replacementLowerFixture.compressed),
        signatureDigest: await sha256(replacementLowerFixture.signature),
      },
      replacementConflict: {
        id: 82,
        tag: 'release-7-new-key-conflict',
        fixture: replacementConflictFixture,
        bundleDigest: await sha256(replacementConflictFixture.compressed),
        signatureDigest: await sha256(replacementConflictFixture.signature),
      },
      otherRepository: {
        id: 83,
        tag: 'release-1-other-repository',
        fixture: otherRepositoryFixture,
        bundleDigest: await sha256(otherRepositoryFixture.compressed),
        signatureDigest: await sha256(otherRepositoryFixture.signature),
      },
      rotationTen: {
        id: 84,
        tag: 'release-10-concurrent',
        fixture: rotationTenFixture,
        bundleDigest: await sha256(rotationTenFixture.compressed),
        signatureDigest: await sha256(rotationTenFixture.signature),
      },
      rotationEight: {
        id: 85,
        tag: 'release-8-concurrent',
        fixture: rotationEightFixture,
        bundleDigest: await sha256(rotationEightFixture.compressed),
        signatureDigest: await sha256(rotationEightFixture.signature),
      },
      rotationTwelve: {
        id: 86,
        tag: 'release-12-concurrent',
        fixture: rotationTwelveFixture,
        bundleDigest: await sha256(rotationTwelveFixture.compressed),
        signatureDigest: await sha256(rotationTwelveFixture.signature),
      },
      rotationTwenty: {
        id: 87,
        tag: 'release-20-exhaustion',
        fixture: rotationTwentyFixture,
        bundleDigest: await sha256(rotationTwentyFixture.compressed),
        signatureDigest: await sha256(rotationTwentyFixture.signature),
      },
    };
    const concurrentReleases = new Map([
      ['github_pat_ten', releases.rotationTen],
      ['github_pat_eight', releases.rotationEight],
      ['github_pat_twelve', releases.rotationTwelve],
      ['github_pat_twenty', releases.rotationTwenty],
    ]);
    const rotationTenConfigFingerprint = await getManagedEnvironmentConfigFingerprint(654321, rotationTenFixture.publicKeyHex);
    const rotationEightConfigFingerprint = await getManagedEnvironmentConfigFingerprint(654321, rotationEightFixture.publicKeyHex);
    const rotationTwelveConfigFingerprint = await getManagedEnvironmentConfigFingerprint(654321, rotationTwelveFixture.publicKeyHex);
    const rotationTwentyConfigFingerprint = await getManagedEnvironmentConfigFingerprint(654321, rotationTwentyFixture.publicKeyHex);
    let releaseConcurrentLatest: (() => void) | undefined;
    const concurrentLatest = new Promise<void>((resolve) => { releaseConcurrentLatest = resolve; });
    let concurrentLatestCount = 0;
    let releaseEightConfigSnapshot: (() => void) | undefined;
    const eightConfigSnapshot = new Promise<void>((resolve) => { releaseEightConfigSnapshot = resolve; });
    let captureEightConfigSnapshot = false;
    let releaseTwelveRepair: (() => void) | undefined;
    const twelveRepair = new Promise<void>((resolve) => { releaseTwelveRepair = resolve; });
    let releaseTenConfigCommit: (() => void) | undefined;
    const tenConfigCommitted = new Promise<void>((resolve) => { releaseTenConfigCommit = resolve; });
    let releaseTwelveConfigCommit: (() => void) | undefined;
    const twelveConfigCommitted = new Promise<void>((resolve) => { releaseTwelveConfigCommit = resolve; });
    let selected = releases.first;
    const immutable = true;
    const r2 = new Map<string, { bytes: Uint8Array; etag: string }>();
    const coordinatorSelections = new Map<string, NonNullable<ActiveManagedRelease['selection']>>();
    let repositorySequencePointerKey: string | undefined;
    let forceRepairExhaustion = false;
    let repairChurnReads = 0;
    let etagCounter = 0;
    const githubRequests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const requestRelease = concurrentReleases.get(token) ?? selected;
      if (url.hostname === 'api.github.com') {
        githubRequests.push(request);
        if (url.pathname === '/repos/acme/curation') {
          return new Response(JSON.stringify({ id: 123456 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.pathname === '/repos/other/curation') {
          return new Response(JSON.stringify({ id: 654321 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.pathname.endsWith('/releases/latest')) {
          if (concurrentReleases.has(token)) {
            concurrentLatestCount += 1;
            if (concurrentLatestCount === 3) releaseConcurrentLatest?.();
            await concurrentLatest;
          }
          return new Response(JSON.stringify({
            id: requestRelease.id,
            tag_name: requestRelease.tag,
            immutable,
            assets: [
              { id: requestRelease.id * 10 + 1, name: 'seed-v1.json.gz', url: `https://api.github.com/assets/${requestRelease.id}/bundle`, digest: `sha256:${requestRelease.bundleDigest}` },
              { id: requestRelease.id * 10 + 2, name: 'seed-v1.sig', url: `https://api.github.com/assets/${requestRelease.id}/signature`, digest: `sha256:${requestRelease.signatureDigest}` },
            ],
          }), { status: 200, headers: { 'Content-Type': 'application/json', etag: `"release-${requestRelease.id}"` } });
        }
        if (url.pathname.endsWith('/bundle')) {
          if (token === 'github_pat_ten') await eightConfigSnapshot;
          if (token === 'github_pat_twelve') await twelveRepair;
          return new Response(requestRelease.fixture.compressed, { status: 200 });
        }
        if (url.pathname.endsWith('/signature')) return new Response(requestRelease.fixture.signature, { status: 200 });
      }
      if (url.hostname.endsWith('.r2.cloudflarestorage.com')) {
        const key = url.pathname;
        if (request.method === 'GET') {
          const object = r2.get(key);
          if (object && forceRepairExhaustion && key === repositorySequencePointerKey) {
            const pointer = JSON.parse(new TextDecoder().decode(object.bytes)) as ActiveManagedRelease;
            const selectionFingerprint = repairChurnReads % 2 === 0
              ? rotationTenConfigFingerprint
              : rotationTwelveConfigFingerprint;
            repairChurnReads += 1;
            const churned: ActiveManagedRelease = {
              ...pointer,
              sequence: pointer.sequence + 1,
              selection: coordinatorSelections.get(selectionFingerprint)!,
            };
            const bytes = new TextEncoder().encode(JSON.stringify(churned));
            const etag = `"r2-${++etagCounter}"`;
            r2.set(key, { bytes, etag });
            return new Response(bytes, { status: 200, headers: { etag } });
          }
          return object
            ? new Response(object.bytes, { status: 200, headers: { etag: object.etag } })
            : new Response('', { status: 404 });
        }
        if (request.method === 'PUT') {
          const current = r2.get(key);
          if (request.headers.get('if-none-match') === '*' && current) return new Response('', { status: 412 });
          if (request.headers.has('if-match') && request.headers.get('if-match') !== current?.etag) return new Response('', { status: 412 });
          const bytes = new Uint8Array(await request.arrayBuffer());
          const etag = `"r2-${++etagCounter}"`;
          r2.set(key, { bytes, etag });
          if (key.endsWith('/active.json')
            && !key.includes(`/configs/${rotationTenConfigFingerprint}/`)
            && !key.includes(`/configs/${rotationEightConfigFingerprint}/`)
            && !key.includes(`/configs/${rotationTwelveConfigFingerprint}/`)
            && !key.includes(`/configs/${rotationTwentyConfigFingerprint}/`)) {
            try {
              repositorySequencePointerKey = key;
              const pointer = JSON.parse(new TextDecoder().decode(bytes)) as ActiveManagedRelease;
              if (pointer.selection) {
                coordinatorSelections.set(pointer.selection.configFingerprint, pointer.selection);
              }
              if (pointer.sequence === 8) {
                captureEightConfigSnapshot = true;
              }
            } catch {
              // Non-pointer cache bytes are irrelevant to the concurrency barrier.
            }
          }
          return new Response('', { status: 200, headers: { etag } });
        }
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    const kv = createMockKV();
    const env = {
      KV: kv as unknown as KVNamespace,
      CLOUDFLARE_API_TOKEN: 'cloudflare-token',
      ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    };
    const base = {
      env,
      accountId: 'account-1',
      workerName: 'worker-1',
      endpoint: 'https://account-1.r2.cloudflarestorage.com',
      r2Credentials: { R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' },
      fetcher: fetcher as typeof fetch,
    };

    await configureManagedEnvironment({
      ...base,
      request: {
        enabled: true,
        repository: 'acme/curation',
        personalAccessToken: 'github_pat_first',
        publicKey: firstFixture.publicKeyHex,
      },
    });
    const firstConfig = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}') as { configFingerprint: string; cacheBucketName: string; resourcePolicy: string };
    expect(firstConfig.resourcePolicy).toBe('mutable');
    expect(bucketMocks.create).toHaveBeenCalledWith('account-1', 'cloudflare-token', firstConfig.cacheBucketName);

    await configureManagedEnvironment({
      ...base,
      request: { enabled: true, immutableResources: true, disableUserCreatedResources: false },
    });
    const immutableConfig = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}') as { configFingerprint: string; resourcePolicy: string };
    expect(immutableConfig.resourcePolicy).toBe('immutable');
    expect(immutableConfig.configFingerprint).toBe(firstConfig.configFingerprint);

    await configureManagedEnvironment({
      ...base,
      request: { enabled: true, immutableResources: true, disableUserCreatedResources: true },
    });
    const exclusiveConfig = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}') as { configFingerprint: string; resourcePolicy: string };
    expect(exclusiveConfig.resourcePolicy).toBe('exclusive');
    expect(exclusiveConfig.configFingerprint).toBe(firstConfig.configFingerprint);
    const patKey = getManagedEnvironmentPatKey(firstConfig.configFingerprint);
    expect(kv._store.get(patKey)).toMatch(/^v1:/);
    expect(kv._store.get(patKey)).not.toContain('github_pat_first');
    const prefill = await getManagedEnvironmentPrefill(env);
    expect(prefill).toEqual(expect.objectContaining({
      enabled: true,
      repository: 'acme/curation',
      personalAccessTokenSet: true,
      publicKeyFingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
      activeSequence: 7,
    }));
    expect(JSON.stringify(prefill)).not.toContain(firstFixture.publicKeyHex);
    expect(JSON.stringify(prefill)).not.toContain('github_pat_first');

    // Simulate a deployment created before recognizable managed-cache names.
    // Normal release resolution must rebuild the verified cache before selecting
    // it operationally, without rewriting the concurrent administrator selection.
    const legacyBucketName = await getLegacyManagedReleaseCacheBucketName('account-1', 'worker-1');
    const selectedConfig = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG)!) as Record<string, unknown>;
    for (const [key, value] of r2) {
      const currentPrefix = `/${firstConfig.cacheBucketName}/`;
      if (!key.startsWith(currentPrefix)) continue;
      r2.set(`/${legacyBucketName}/${key.slice(currentPrefix.length)}`, value);
      r2.delete(key);
    }
    kv._store.set(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, JSON.stringify({
      ...selectedConfig,
      cacheBucketName: legacyBucketName,
    }));
    kv._store.set(SETUP_KEYS.ACCOUNT_ID, 'account-1');
    kv._store.set(SETUP_KEYS.R2_ENDPOINT, base.endpoint);
    const selectedConfigWrites = () => kv.put.mock.calls
      .filter(([key]) => key === SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG).length;
    const configWritesBeforeMigration = selectedConfigWrites();
    bucketMocks.remove.mockImplementationOnce(async (input?: { bucketName: string }) => {
      const migration = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CACHE_MIGRATION)!) as {
        cacheBucketName: string;
        legacyCacheBucketName: string;
        cleanupPending: boolean;
      };
      expect(migration).toEqual(expect.objectContaining({
        cacheBucketName: firstConfig.cacheBucketName,
        legacyCacheBucketName: legacyBucketName,
        cleanupPending: true,
      }));
      expect(r2.has(`/${firstConfig.cacheBucketName}/configs/${firstConfig.configFingerprint}/active.json`)).toBe(true);
      expect(input?.bucketName).toBe(legacyBucketName);
      throw new Error('injected legacy cleanup failure');
    });

    const resolverInput = {
      env: {
        ...env,
        R2_ACCESS_KEY_ID: 'access',
        R2_SECRET_ACCESS_KEY: 'secret',
        CLOUDFLARE_WORKER_NAME: 'worker-1',
      },
      fetcher: fetcher as typeof fetch,
    };
    const pendingCleanup = await resolveManagedEnvironment(resolverInput);
    expect(pendingCleanup.config?.cacheBucketName).toBe(firstConfig.cacheBucketName);
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG)!).cacheBucketName).toBe(legacyBucketName);
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CACHE_MIGRATION)!).cleanupPending).toBe(true);
    expect(selectedConfigWrites()).toBe(configWritesBeforeMigration);

    const migrated = await resolveManagedEnvironment(resolverInput);
    expect(migrated.config?.cacheBucketName).toBe(firstConfig.cacheBucketName);
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CACHE_MIGRATION)!).cleanupPending).toBe(false);
    expect(selectedConfigWrites()).toBe(configWritesBeforeMigration);
    expect(bucketMocks.remove).toHaveBeenCalledTimes(2);

    const encryptedPat = kv._store.get(patKey)!;
    kv._store.set(patKey, JSON.stringify({ token: 'plaintext-must-not-migrate' }));
    await expect(configureManagedEnvironment({
      ...base,
      request: { enabled: true, repository: 'acme/curation', personalAccessToken: '', publicKey: '' },
    })).rejects.toThrow(/not encrypted/i);
    kv._store.set(patKey, encryptedPat);

    await configureManagedEnvironment({
      ...base,
      request: { enabled: true, repository: 'acme/curation', personalAccessToken: '', publicKey: '' },
    });
    expect(githubRequests.some((request) => request.headers.get('authorization') === 'Bearer github_pat_first')).toBe(true);
    const currentEncryptedPat = kv._store.get(patKey)!;

    selected = releases.sameTrustConflict;
    await expect(configureManagedEnvironment({
      ...base,
      request: { enabled: true, repository: 'acme/curation', personalAccessToken: 'github_pat_conflict', publicKey: '' },
    })).rejects.toThrow(/same sequence.*conflicting identity|conflicting identity.*same sequence/i);
    expect(kv._store.get(patKey)).toBe(currentEncryptedPat);
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}').configFingerprint).toBe(firstConfig.configFingerprint);

    selected = releases.sameTrustUpdate;
    const originalPut = kv.put.getMockImplementation()!;
    let rejectedConfigWrite = false;
    kv.put.mockImplementation(async (key, value, options) => {
      if (key === SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG && !rejectedConfigWrite) {
        rejectedConfigWrite = true;
        throw new Error('injected selected-config write failure');
      }
      await originalPut(key, value, options);
    });
    await expect(configureManagedEnvironment({
      ...base,
      request: { enabled: true, repository: 'acme/curation', personalAccessToken: 'github_pat_replacement', publicKey: '' },
    })).rejects.toThrow(/injected selected-config write failure/i);
    kv.put.mockImplementation(originalPut);
    expect(kv._store.get(patKey)).toBe(currentEncryptedPat);
    const activeObject = [...r2.entries()].find(([key]) => key.endsWith(`/configs/${firstConfig.configFingerprint}/active.json`));
    expect(activeObject).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(activeObject![1].bytes)).sequence).toBe(7);

    await expect(configureManagedEnvironment({
      ...base,
      request: {
        enabled: true,
        repository: 'acme/curation',
        personalAccessToken: 'github_pat_replacement',
        publicKey: replacementPublicKey,
      },
    })).rejects.toThrow(/signature/i);
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}').configFingerprint).toBe(firstConfig.configFingerprint);
    expect([...kv._store.keys()].filter((key) => key.startsWith('setup:managed_environment_pat:'))).toEqual([patKey]);

    selected = releases.replacementLower;
    await expect(configureManagedEnvironment({
      ...base,
      request: {
        enabled: true,
        repository: 'acme/curation',
        personalAccessToken: 'github_pat_replacement',
        publicKey: replacementPublicKey,
      },
    })).rejects.toThrow(/older than active state/i);
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}').configFingerprint).toBe(firstConfig.configFingerprint);

    selected = releases.replacementConflict;
    await expect(configureManagedEnvironment({
      ...base,
      request: {
        enabled: true,
        repository: 'acme/curation',
        personalAccessToken: 'github_pat_replacement',
        publicKey: replacementPublicKey,
      },
    })).rejects.toThrow(/same sequence.*conflicting identity|conflicting identity.*same sequence/i);
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}').configFingerprint).toBe(firstConfig.configFingerprint);

    selected = releases.replacement;
    const replaced = await configureManagedEnvironment({
      ...base,
      request: {
        enabled: true,
        repository: 'acme/curation',
        personalAccessToken: 'github_pat_replacement',
        publicKey: replacementPublicKey,
      },
    });
    const replacementConfig = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}') as { configFingerprint: string };
    const replacementPatKey = getManagedEnvironmentPatKey(replacementConfig.configFingerprint);
    expect(replaced.active?.sequence).toBe(9);
    expect(replacementConfig.configFingerprint).not.toBe(firstConfig.configFingerprint);
    expect(kv._store.get(replacementPatKey)).toMatch(/^v1:/);
    expect(kv._store.get(replacementPatKey)).not.toContain('github_pat_replacement');

    selected = releases.replacement;
    await expect(configureManagedEnvironment({
      ...base,
      request: {
        enabled: true,
        repository: 'other/curation',
        personalAccessToken: 'github_pat_other',
        publicKey: '',
      },
    })).rejects.toThrow(/repository identity/i);
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}').configFingerprint).toBe(replacementConfig.configFingerprint);

    selected = releases.otherRepository;
    const repositoryReplaced = await configureManagedEnvironment({
      ...base,
      request: {
        enabled: true,
        repository: 'other/curation',
        personalAccessToken: 'github_pat_other',
        publicKey: '',
      },
    });
    const otherConfig = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}') as { configFingerprint: string; repository: string };
    expect(repositoryReplaced.active?.sequence).toBe(1);
    expect(otherConfig.repository).toBe('other/curation');
    expect(otherConfig.configFingerprint).not.toBe(replacementConfig.configFingerprint);

    // Force the three-way stale-snapshot race: sequence 8 captures prior KV,
    // sequence 10 replaces the pointer and commits, and sequence 12 advances and
    // commits after sequence 8 reads winner 10 but before its repair writes KV.
    const originalConcurrentGet = kv.get.getMockImplementation()!;
    const originalConcurrentPut = kv.put.getMockImplementation()!;
    kv.get.mockImplementation(async (key: string, type?: string) => {
      if (key === SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG && captureEightConfigSnapshot) {
        captureEightConfigSnapshot = false;
        const snapshot = await originalConcurrentGet(key, type);
        releaseEightConfigSnapshot?.();
        return snapshot;
      }
      return originalConcurrentGet(key, type);
    });
    let rotationTenSelectionWrites = 0;
    kv.put.mockImplementation(async (key, value, options) => {
      const selection = key === SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG
        ? JSON.parse(value) as { configFingerprint?: string }
        : undefined;
      if (selection?.configFingerprint === rotationEightConfigFingerprint) {
        await tenConfigCommitted;
      }
      if (selection?.configFingerprint === rotationTenConfigFingerprint) {
        rotationTenSelectionWrites += 1;
        if (rotationTenSelectionWrites === 2) {
          releaseTwelveRepair?.();
          await twelveConfigCommitted;
        }
      }
      await originalConcurrentPut(key, value, options);
      if (selection?.configFingerprint === rotationTenConfigFingerprint
        && rotationTenSelectionWrites === 1) {
        releaseTenConfigCommit?.();
      }
      if (selection?.configFingerprint === rotationTwelveConfigFingerprint) {
        releaseTwelveConfigCommit?.();
      }
    });

    const rotations = await Promise.allSettled([
      configureManagedEnvironment({
        ...base,
        request: {
          enabled: true,
          repository: 'other/curation',
          personalAccessToken: 'github_pat_ten',
          publicKey: rotationTenFixture.publicKeyHex,
        },
      }),
      configureManagedEnvironment({
        ...base,
        request: {
          enabled: true,
          repository: 'other/curation',
          personalAccessToken: 'github_pat_eight',
          publicKey: rotationEightFixture.publicKeyHex,
        },
      }),
      configureManagedEnvironment({
        ...base,
        request: {
          enabled: true,
          repository: 'other/curation',
          personalAccessToken: 'github_pat_twelve',
          publicKey: rotationTwelveFixture.publicKeyHex,
        },
      }),
    ]);
    expect(rotations[0]).toMatchObject({ status: 'fulfilled', value: { active: { sequence: 10 } } });
    expect(rotations[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringMatching(/newer release won/i) }) });
    expect(rotations[2]).toMatchObject({ status: 'fulfilled', value: { active: { sequence: 12 } } });
    kv.get.mockImplementation(originalConcurrentGet);
    kv.put.mockImplementation(originalConcurrentPut);
    const concurrentConfig = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}') as { configFingerprint: string };
    expect(concurrentConfig.configFingerprint).toBe(rotationTwelveConfigFingerprint);
    expect(kv._store.get(getManagedEnvironmentPatKey(rotationTenConfigFingerprint))).toMatch(/^v1:/);
    expect(kv._store.get(getManagedEnvironmentPatKey(rotationEightConfigFingerprint))).toBeUndefined();
    expect(kv._store.get(getManagedEnvironmentPatKey(rotationTwelveConfigFingerprint))).toMatch(/^v1:/);

    const originalExhaustionPut = kv.put.getMockImplementation()!;
    kv.put.mockImplementation(async (key, value, options) => {
      await originalExhaustionPut(key, value, options);
      if (key === SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG
        && JSON.parse(value).configFingerprint === rotationTwentyConfigFingerprint) {
        forceRepairExhaustion = true;
      }
    });
    await expect(configureManagedEnvironment({
      ...base,
      request: {
        enabled: true,
        repository: 'other/curation',
        personalAccessToken: 'github_pat_twenty',
        publicKey: rotationTwentyFixture.publicKeyHex,
      },
    })).rejects.toThrow(/selection repair did not converge/i);
    forceRepairExhaustion = false;
    kv.put.mockImplementation(originalExhaustionPut);

    expect(repairChurnReads).toBe(9);
    const exhaustedConfig = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}') as { configFingerprint: string };
    expect(exhaustedConfig.configFingerprint).toBe(rotationTenConfigFingerprint);
    expect(kv._store.get(getManagedEnvironmentPatKey(rotationTwentyConfigFingerprint))).toBeUndefined();

    const cacheObjectCount = r2.size;
    const retainedPat = kv._store.get(patKey);
    await configureManagedEnvironment({ ...base, request: { enabled: false } });
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}').enabled).toBe(false);
    expect(r2.size).toBe(cacheObjectCount);
    expect(kv._store.get(patKey)).toBe(retainedPat);
  });

  it('allows explicit disable to recover from a malformed selected configuration without deleting retained history', async () => {
    const kv = createMockKV();
    kv._store.set(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG, '{"schemaVersion":1,"enabled":true,"broken":true}');
    kv._store.set('managed-environment:retained-history', 'keep');

    await expect(configureManagedEnvironment({
      env: {
        KV: kv as unknown as KVNamespace,
        CLOUDFLARE_API_TOKEN: 'cloudflare-token',
        ENCRYPTION_KEY: '',
      },
      accountId: 'account-1',
      workerName: 'worker-1',
      endpoint: 'https://account-1.r2.cloudflarestorage.com',
      r2Credentials: { R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' },
      request: { enabled: false },
    })).resolves.toEqual({ enabled: false });

    expect(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG)).toBeUndefined();
    expect(kv._store.get('managed-environment:retained-history')).toBe('keep');
  });

  it('rejects mutable releases and changed immutable asset bytes without moving the active pointer', async () => {
    const fixture = await signedFixture();
    const bundleDigest = await sha256(fixture.compressed);
    const signatureDigest = await sha256(fixture.signature);

    for (const response of [
      latestReleaseResponse({ bundleDigest, signatureDigest, immutable: false }),
      latestReleaseResponse({ bundleDigest: '0'.repeat(64), signatureDigest }),
    ]) {
      const kv = createMockKV();
      const state = resolverCache();
      const fetcher = vi.fn()
        .mockResolvedValueOnce(response)
        .mockResolvedValueOnce(new Response(fixture.compressed, { status: 200 }))
        .mockResolvedValueOnce(new Response(fixture.signature, { status: 200 }));

      await expect(resolveManagedEnvironmentRelease({
        kv: kv as unknown as KVNamespace,
        stateKey: 'state',
        cache: state.cache,
        repository: 'acme/curation',
        repositoryId: 123456,
        token: 'secret-pat',
        publicKeyHex: fixture.publicKeyHex,
        expectedRuntimeHash: 'c'.repeat(64),
        fetcher,
        requireFresh: true,
      })).rejects.toThrow(/immutable|digest/i);
      expect(state.active()).toBeUndefined();
    }
  });
});
