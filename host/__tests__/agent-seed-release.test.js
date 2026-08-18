import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const releaseUrl = pathToFileURL(join(repoRoot, 'scripts/agent-seed-release.mjs')).href;
const SHA_40_A = 'a'.repeat(40);
const SHA_40_B = 'b'.repeat(40);
const HASH_64 = 'c'.repeat(64);

function compiledSeed(overrides = {}) {
  return {
    documents: [
      {
        key: '.pi/agent/skills/zeta/SKILL.md',
        contentType: 'text/markdown; charset=utf-8',
        content: 'zeta\n',
        modes: ['advanced'],
      },
      {
        key: '.claude/AGENTS.md',
        contentType: 'text/markdown; charset=utf-8',
        content: 'shared\n',
        modes: ['advanced', 'default'],
      },
    ],
    retiredKeys: ['.pi/agent/skills/old/SKILL.md'],
    preseedHash: '0123456789abcdef',
    runtimeHash: HASH_64,
    ...overrides,
  };
}

function releaseOptions(compiled = compiledSeed(), overrides = {}) {
  return {
    sourceRoot: '/curation',
    sequence: 7,
    previousSequence: 6,
    repositoryId: 123456,
    sourceSha: SHA_40_A,
    compilerSha: SHA_40_B,
    releaseTag: 'release-7',
    compile: async ({ rootDir }) => {
      assert.equal(rootDir, '/curation');
      return compiled;
    },
    ...overrides,
  };
}

function extensionInput(overrides = {}) {
  return {
    bytes: Buffer.from('measured VSIX bytes'),
    platform: 'universal',
    downloadUrl: 'https://open-vsx.org/api/Acme/review-tools/1.2.3/file/acme.review-tools.vsix',
    manifest: {
      publisher: 'Acme',
      name: 'review-tools',
      version: '1.2.3',
      engines: { vscode: '^1.90.0' },
      browser: './dist/web.js',
      extensionPack: [],
      extensionDependencies: [],
    },
    ...overrides,
  };
}

// Tests were authored before scripts/agent-seed-release.mjs. They exercise the
// exported release boundary rather than matching implementation text.
describe('REQ-AGENT-147 AC3: fixed managed seed release contract', () => {
  it('builds a complete seed-v1 contract and sorts unique path-mode documents', async () => {
    const { buildAgentSeedRelease } = await import(releaseUrl);
    const release = await buildAgentSeedRelease(releaseOptions());

    assert.deepEqual(
      release.documents.map(({ key, modes }) => `${key}:${modes.join(',')}`),
      [
        '.claude/AGENTS.md:advanced,default',
        '.pi/agent/skills/zeta/SKILL.md:advanced',
      ],
    );
    assert.deepEqual(release, {
      seedAbi: 1,
      sequence: 7,
      source: {
        repositoryId: 123456,
        commitSha: SHA_40_A,
        releaseTag: 'release-7',
        compilerCommit: SHA_40_B,
      },
      runtimeDependencyHash: HASH_64,
      documents: release.documents,
      retiredPaths: ['.pi/agent/skills/old/SKILL.md'],
      managedExtensions: [],
    });
  });

  it('retains historical managed retirements while excluding image-owned context-mode paths', async () => {
    const { buildAgentSeedRelease } = await import(releaseUrl);
    const release = await buildAgentSeedRelease(releaseOptions(compiledSeed({
      retiredKeys: [
        '.agents/skills/legacy/SKILL.md',
        '.claude/plugins/context-mode/hooks.json',
        '.pi/agent/extensions/review-jobs.ts',
      ],
    })));

    assert.deepEqual(release.retiredPaths, [
      '.agents/skills/legacy/SKILL.md',
      '.pi/agent/extensions/review-jobs.ts',
    ]);
  });

  it('rejects non-positive, unsafe, non-monotonic, and incomplete release identities', async () => {
    const { buildAgentSeedRelease } = await import(releaseUrl);
    for (const overrides of [
      { sequence: 0 },
      { sequence: (2 ** 32) + 1 },
      { sequence: 6 },
      { repositoryId: 0 },
      { repositoryId: '123456' },
      { sourceSha: 'a'.repeat(39) },
      { compilerSha: 'not-a-commit' },
      { releaseTag: '' },
    ]) {
      await assert.rejects(
        buildAgentSeedRelease(releaseOptions(compiledSeed(), overrides)),
        /sequence|repositoryId|sourceSha|compilerSha|releaseTag/,
      );
    }
  });
});

describe('REQ-AGENT-147 AC4: release path and mode boundary', () => {
  it('rejects traversal, absolute, malformed, context-mode, and retired Pi extension paths', async () => {
    const { buildAgentSeedRelease } = await import(releaseUrl);
    const invalidPaths = [
      '../escape',
      '/absolute/path',
      '.pi//agent/file',
      '.pi/agent/../file',
      '.pi\\agent\\file',
      '.claude/plugins/context-mode/hooks.json',
      '.pi/agent/extensions/context-mode-runtime.ts',
      '.pi/agent/npm/package.json',
      '.ssh/config',
      '.pi/agent/extensions/review-job-helpers.ts',
      '.pi/agent/extensions/review-jobs.ts',
      '.pi/agent/extensions/review-lane-guards.ts',
    ];

    for (const key of invalidPaths) {
      await assert.rejects(
        buildAgentSeedRelease(releaseOptions(compiledSeed({
          documents: [{ key, contentType: 'text/plain; charset=utf-8', content: 'x', modes: ['default'] }],
        }))),
        /path|context-mode|retired Pi extension/i,
      );
    }
  });

  it('rejects invalid modes, duplicate path-mode pairs, and live paths listed as retired', async () => {
    const { buildAgentSeedRelease } = await import(releaseUrl);
    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed({
        documents: [{ key: '.claude/a', contentType: 'text/plain; charset=utf-8', content: 'x', modes: ['expert'] }],
      }))),
      /mode/i,
    );
    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed({
        documents: [
          { key: '.claude/a', contentType: 'text/plain; charset=utf-8', content: 'one', modes: ['default'] },
          { key: '.claude/a', contentType: 'text/plain; charset=utf-8', content: 'two', modes: ['default'] },
        ],
      }))),
      /duplicate.*key.*mode/i,
    );
    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed({
        documents: [{ key: '.claude/a', contentType: 'text/plain; charset=utf-8', content: 'x', modes: ['default'] }],
        retiredKeys: ['.claude/a'],
      }))),
      /both live and retired/i,
    );
  });
});

describe('REQ-AGENT-147 AC4: fixed seed-v1 resource limits', () => {
  it('rejects an oversized document, aggregate document set, and retired-path set', async () => {
    const { buildAgentSeedRelease } = await import(releaseUrl);
    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed({
        documents: [{ key: '.claude/large', contentType: 'text/plain; charset=utf-8', content: 'x'.repeat((1024 * 1024) + 1), modes: ['default'] }],
      }))),
      /document.*bytes|document.*limit/i,
    );
    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed({
        documents: Array.from({ length: 25 }, (_, index) => ({
          key: `.claude/large-${index}`,
          contentType: 'text/plain; charset=utf-8',
          content: 'x'.repeat(1024 * 1024),
          modes: ['default'],
        })),
      }))),
      /total document/i,
    );
    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed({
        retiredKeys: Array.from({ length: 5_001 }, (_, index) => `.claude/retired-${index}`),
      }))),
      /retired path.*limit/i,
    );
  });

  it('refuses to emit an expanded bundle beyond the fixed seed-v1 boundary', async () => {
    const { createReleaseBundle } = await import(releaseUrl);
    assert.throws(
      () => createReleaseBundle({ seedAbi: 1, padding: 'x'.repeat((32 * 1024 * 1024) + 1) }),
      /expanded.*limit/i,
    );
  });
});

describe('REQ-AGENT-147 AC5: measured company extensions', () => {
  it('derives artifact size, hash, and package identity instead of trusting curator values', async () => {
    const { measureExtensionRecord } = await import(releaseUrl);
    const measured = measureExtensionRecord(extensionInput());

    assert.deepEqual(measured, {
      id: 'acme.review-tools',
      publisher: 'Acme',
      name: 'review-tools',
      version: '1.2.3',
      targetPlatform: 'universal',
      engine: '^1.90.0',
      entrypoint: './dist/web.js',
      extensionPack: [],
      extensionDependencies: [],
      downloadUrl: 'https://open-vsx.org/api/Acme/review-tools/1.2.3/file/acme.review-tools.vsix',
      size: Buffer.byteLength('measured VSIX bytes'),
      sha256: 'a46567178b9876105bf7f3933c3c58df166b7c8db43ae8404b9ee9a2091fd3df',
    });
  });

  it('rejects non-semantic extension labels instead of treating them as exact versions', async () => {
    const { measureExtensionRecord } = await import(releaseUrl);
    for (const version of ['latest', '01.2.3', '1.2.3-']) {
      assert.throws(
        () => measureExtensionRecord(extensionInput({ manifest: { ...extensionInput().manifest, version } })),
        /version.*exact|semantic/i,
      );
    }
  });

  it('rejects hand-authored measurements and dependency sets that are not closed', async () => {
    const { buildAgentSeedRelease, measureExtensionRecord } = await import(releaseUrl);
    const measured = measureExtensionRecord(extensionInput({
      manifest: {
        ...extensionInput().manifest,
        extensionDependencies: ['Acme.required-tool'],
      },
    }));

    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed(), {
        managedExtensions: [{ ...measured }],
      })),
      /measure/i,
    );
    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed(), { managedExtensions: [measured] })),
      /dependency closure/i,
    );
  });

  it('accepts and deterministically sorts a fully measured dependency closure', async () => {
    const { buildAgentSeedRelease, measureExtensionRecord } = await import(releaseUrl);
    const dependent = measureExtensionRecord(extensionInput({
      manifest: {
        ...extensionInput().manifest,
        extensionDependencies: ['Acme.required-tool'],
      },
    }));
    const required = measureExtensionRecord(extensionInput({
      bytes: Buffer.from('required bytes'),
      downloadUrl: 'https://open-vsx.org/api/Acme/required-tool/2.0.0/file/acme.required-tool.vsix',
      manifest: {
        ...extensionInput().manifest,
        name: 'required-tool',
        version: '2.0.0',
      },
    }));
    const release = await buildAgentSeedRelease(releaseOptions(compiledSeed(), {
      managedExtensions: [required, dependent],
    }));

    assert.deepEqual(release.managedExtensions.map(({ id }) => id), ['acme.required-tool', 'acme.review-tools']);
  });
});

describe('REQ-AGENT-147 AC6: deterministic signed release assets', () => {
  it('serializes stable JSON, emits gzip with mtime zero, and signs/verifies exact bytes with Ed25519', async () => {
    const {
      buildAgentSeedRelease,
      createReleaseBundle,
      signReleaseBundle,
      verifyReleaseBundle,
    } = await import(releaseUrl);
    const release = await buildAgentSeedRelease(releaseOptions());
    const first = createReleaseBundle(release);
    const second = createReleaseBundle(release);

    assert.deepEqual(first.gzip, second.gzip);
    assert.deepEqual([...first.gzip.subarray(4, 8)], [0, 0, 0, 0]);
    assert.equal(gunzipSync(first.gzip).toString('utf8'), first.json);
    assert.equal(first.json.endsWith('\n'), true);

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signature = signReleaseBundle(first.gzip, privateKey);
    assert.equal(verifyReleaseBundle(first.gzip, signature, publicKey), true);
    assert.equal(verifyReleaseBundle(Buffer.concat([first.gzip, Buffer.from('x')]), signature, publicKey), false);
  });
});
