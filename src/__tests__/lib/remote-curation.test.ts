import { describe, expect, it, vi } from 'vitest';
import {
  configureManagedEnvironment,
  downloadManagedAsset,
  getManagedEnvironmentConfigFingerprint,
  getManagedEnvironmentKeyFingerprint,
  getManagedEnvironmentPrefill,
  gzipBytes,
  resolveManagedEnvironmentRelease,
  verifyManagedRelease,
  type ManagedEnvironmentFreshnessState,
  type ManagedRelease,
} from '../../lib/remote-curation';
import type { ActiveManagedRelease, ManagedReleaseCache } from '../../lib/remote-curation-cache';
import { createMockKV } from '../helpers/mock-kv';
import { getManagedEnvironmentPatKey, SETUP_KEYS } from '../../lib/kv-keys';
import { MANAGED_RELEASE_LIMITS } from '../../../scripts/agent-seed-release-limits.mjs';
import { PRESEED_RUNTIME_DEPENDENCY_HASH } from '../../lib/agent-seed.generated';

const bucketMocks = vi.hoisted(() => ({
  create: vi.fn(async () => ({ success: true, created: true })),
}));
vi.mock('../../lib/r2-admin', () => ({ createBucketIfNotExists: bucketMocks.create }));

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

// REQ-AGENT-147 and REQ-SETUP-013: the Worker is the trust boundary. These
// tests assert activation inputs, not validation copy or implementation text.
describe('managed coding-environment release verification', () => {
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

  it('aborts gzip expansion at the shared expanded-byte limit', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const compressed = await gzipBytes(encoder.encode('x'.repeat(MANAGED_RELEASE_LIMITS.expandedBytes + 1)));
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

  it('REQ-AGENT-147 AC6: independently rejects invalid release records before activation', async () => {
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

function latestReleaseResponse(input: {
  bundleDigest: string;
  signatureDigest: string;
  immutable?: boolean;
  releaseId?: number;
}): Response {
  return new Response(JSON.stringify({
    id: input.releaseId ?? 77,
    tag_name: 'release-7',
    immutable: input.immutable ?? true,
    assets: [
      {
        id: 1,
        name: 'seed-v1.json.gz',
        url: 'https://api.github.com/repos/acme/curation/releases/assets/1',
        digest: `sha256:${input.bundleDigest}`,
      },
      {
        id: 2,
        name: 'seed-v1.sig',
        url: 'https://api.github.com/repos/acme/curation/releases/assets/2',
        digest: `sha256:${input.signatureDigest}`,
      },
    ],
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      etag: '"latest-etag"',
      'github-authentication-token-expiration': '2026-09-01 00:00:00 UTC',
    },
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

  it('stores the PAT only as AES ciphertext, preserves blanks, and rejects public-key replacement', async () => {
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
    const replacementPublicKey = firstFixture.publicKeyHex === 'ab'.repeat(32) ? 'cd'.repeat(32) : 'ab'.repeat(32);
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
    };
    let selected = releases.first;
    const immutable = true;
    const r2 = new Map<string, { bytes: Uint8Array; etag: string }>();
    let etagCounter = 0;
    const githubRequests: Request[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === 'api.github.com') {
        githubRequests.push(request);
        if (url.pathname === '/repos/acme/curation') {
          return new Response(JSON.stringify({ id: 123456 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url.pathname.endsWith('/releases/latest')) {
          return new Response(JSON.stringify({
            id: selected.id,
            tag_name: selected.tag,
            immutable,
            assets: [
              { id: selected.id * 10 + 1, name: 'seed-v1.json.gz', url: `https://api.github.com/assets/${selected.id}/bundle`, digest: `sha256:${selected.bundleDigest}` },
              { id: selected.id * 10 + 2, name: 'seed-v1.sig', url: `https://api.github.com/assets/${selected.id}/signature`, digest: `sha256:${selected.signatureDigest}` },
            ],
          }), { status: 200, headers: { 'Content-Type': 'application/json', etag: `"release-${selected.id}"` } });
        }
        if (url.pathname.endsWith('/bundle')) return new Response(selected.fixture.compressed, { status: 200 });
        if (url.pathname.endsWith('/signature')) return new Response(selected.fixture.signature, { status: 200 });
      }
      if (url.hostname.endsWith('.r2.cloudflarestorage.com')) {
        const key = url.pathname;
        if (request.method === 'GET') {
          const object = r2.get(key);
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
    const firstConfig = JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}') as { configFingerprint: string; cacheBucketName: string };
    expect(bucketMocks.create).toHaveBeenCalledWith('account-1', 'cloudflare-token', firstConfig.cacheBucketName);
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
    })).rejects.toThrow(/public key cannot be changed/i);
    expect(JSON.parse(kv._store.get(SETUP_KEYS.MANAGED_ENVIRONMENT_CONFIG) ?? '{}').configFingerprint).toBe(firstConfig.configFingerprint);
    expect([...kv._store.keys()].filter((key) => key.startsWith('setup:managed_environment_pat:'))).toEqual([patKey]);

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
