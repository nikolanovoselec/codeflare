import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
        key: '.pi/agent/extensions/zeta.ts',
        contentType: 'text/markdown; charset=utf-8',
        content: 'zeta\n',
        modes: ['advanced'],
      },
      {
        key: '.claude/settings.json',
        contentType: 'text/markdown; charset=utf-8',
        content: 'shared\n',
        modes: ['advanced', 'default'],
      },
    ],
    retiredKeys: ['.pi/agent/extensions/old.ts'],
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

async function managedSource(t) {
  const root = await mkdtemp(join(tmpdir(), 'managed-native-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Match curation's source ownership, without filtering compiler output.
  const exclusions = new Set([
    'claude/plugins/context-mode/.claude-plugin/plugin.json',
    'claude/plugins/context-mode/README.md',
    'pi/extensions/context-mode-runtime.ts',
    'pi/package.json',
    'pi/package-lock.json',
  ]);
  const copy = async (relative) => {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await copyFile(join(repoRoot, relative), join(root, relative));
  };
  for (const runtime of ['claude', 'pi']) {
    const prefix = `preseed/agents/${runtime}`;
    const manifest = JSON.parse(await readFile(join(repoRoot, prefix, 'manifest.json'), 'utf8'));
    for (const relative of Object.keys(manifest)) {
      if (exclusions.has(`${runtime}/${relative}`)) delete manifest[relative];
      else await copy(`${prefix}/${relative}`);
    }
    await writeFile(join(root, prefix, 'manifest.json'), JSON.stringify(manifest));
  }
  for (const relative of [
    'preseed/retired-keys.json',
    'preseed/npm-tools/package-lock.json',
    'preseed/agents/claude/browser-run-mcp/package-lock.json',
    'preseed/agents/pi/package-lock.json',
  ]) await copy(relative);
  return root;
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
        '.claude/settings.json:advanced,default',
        '.pi/agent/extensions/zeta.ts:advanced',
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
      retiredPaths: ['.pi/agent/extensions/old.ts'],
      managedExtensions: [],
    });
  });

  it('REQ-AGENT-147 AC2: compiles native Impeccable text and launchers into a signed managed release', async (t) => {
    const { computeAgentRuntimeHash } = await import(pathToFileURL(join(repoRoot, 'scripts/agent-seed-core.mjs')).href);
    const { buildAgentSeedRelease, createReleaseBundle, signReleaseBundle, verifyReleaseBundle } = await import(releaseUrl);
    const sourceRoot = await managedSource(t);
    const release = await buildAgentSeedRelease(releaseOptions(undefined, { sourceRoot, compile: undefined }));
    const bundle = createReleaseBundle(release);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    assert.equal(verifyReleaseBundle(bundle.gzip, signReleaseBundle(bundle.gzip, privateKey), publicKey), true);
    const published = JSON.parse(gunzipSync(bundle.gzip).toString('utf8'));
    for (const [runtime, root] of [['claude', '.claude'], ['pi', '.pi/agent']]) {
      for (const [name, contentType] of [
        ['VERSION', 'text/plain; charset=utf-8'],
        ['impeccable', 'application/x-shellscript; charset=utf-8'],
        ['impeccable.cmd', 'text/plain; charset=utf-8'],
      ]) {
        const key = `${root}/skills/impeccable/scripts/${name}`;
        const matches = published.documents.filter((document) => document.key === key);
        assert.equal(matches.length, 1, key);
        assert.deepEqual(matches[0], {
          key,
          contentType,
          content: await readFile(join(repoRoot, 'preseed/agents', runtime, 'skills/impeccable/scripts', name), 'utf8'),
          modes: ['advanced'],
        });
      }
    }
    assert.equal(published.runtimeDependencyHash, await computeAgentRuntimeHash(repoRoot));
  });

  it('retains historical managed retirements while excluding image-owned context-mode paths', async () => {
    const { buildAgentSeedRelease } = await import(releaseUrl);
    const release = await buildAgentSeedRelease(releaseOptions(compiledSeed({
      retiredKeys: [
        '.agents/config/legacy.md',
        '.claude/plugins/context-mode/hooks.json',
        '.pi/agent/extensions/review-jobs.ts',
      ],
    })));

    assert.deepEqual(release.retiredPaths, [
      '.agents/config/legacy.md',
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
  it('REQ-AGENT-147 AC4: rejects paths outside the managed release contract', async () => {
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

  it('REQ-AGENT-147 AC4: rejects invalid modes, duplicate ownership, and live paths listed as retired', async () => {
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

  it('REQ-AGENT-147 AC4: rejects unsupported binary document types', async (t) => {
    const { compileAgentSeed } = await import(pathToFileURL(join(repoRoot, 'scripts/agent-seed-core.mjs')).href);
    const { buildAgentSeedRelease } = await import(releaseUrl);
    for (const [runtime, prefix] of [['claude', '.claude'], ['pi', '.pi/agent']]) {
      for (const name of ['engine.bin', 'impeccable']) {
        await t.test(`${runtime}: ${name}`, async (subtest) => {
          const sourceRoot = await managedSource(subtest);
          const relative = `skills/probe/scripts/${name}`;
          const filename = join(sourceRoot, 'preseed/agents', runtime, relative);
          const manifestPath = join(sourceRoot, 'preseed/agents', runtime, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          manifest[relative] = { modes: ['advanced'] };
          await mkdir(dirname(filename), { recursive: true });
          await writeFile(filename, Buffer.from([0, 255, 1, 128]));
          await writeFile(manifestPath, JSON.stringify(manifest));
          const compiled = await compileAgentSeed({ rootDir: sourceRoot });
          const index = compiled.documents.findIndex(({ key }) => key === `${prefix}/${relative}`);
          assert.ok(index >= 0);
          assert.equal(compiled.documents[index].contentType, 'application/octet-stream');
          await assert.rejects(
            buildAgentSeedRelease(releaseOptions(undefined, { sourceRoot, compile: undefined })),
            { message: `document ${index} contentType is unsupported: application/octet-stream` },
          );
        });
      }
    }
  });

  it('REQ-AGENT-147 AC4: rejects an undeclared runtime dependency identity', async () => {
    const { buildAgentSeedRelease } = await import(releaseUrl);
    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed({ runtimeHash: '' }))),
      /runtime/i,
    );
  });
});

describe('REQ-AGENT-147 AC6: fixed seed-v1 resource limits', () => {
  it('REQ-AGENT-147 AC6: enforces document and retired-path resource limits', async () => {
    const { buildAgentSeedRelease } = await import(releaseUrl);
    await assert.doesNotReject(
      buildAgentSeedRelease(releaseOptions(compiledSeed({
        documents: [{ key: '.claude/large', contentType: 'text/plain; charset=utf-8', content: 'x'.repeat(1_100_013), modes: ['default'] }],
      }))),
    );
    await assert.rejects(
      buildAgentSeedRelease(releaseOptions(compiledSeed({
        documents: [{ key: '.claude/too-large', contentType: 'text/plain; charset=utf-8', content: 'x'.repeat((2 * 1024 * 1024) + 1), modes: ['default'] }],
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

  it('REQ-AGENT-147 AC6: enforces the expanded bundle resource limit', async () => {
    const { createReleaseBundle } = await import(releaseUrl);
    assert.throws(
      () => createReleaseBundle({ seedAbi: 1, padding: 'x'.repeat((32 * 1024 * 1024) + 1) }),
      /expanded.*limit/i,
    );
  });
});

describe('REQ-AGENT-147 AC5: measured company extensions', () => {
  it('REQ-AGENT-147 AC5: measures exact extension identity and bytes', async () => {
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

  it('REQ-AGENT-147 AC5: rejects unmeasured or incomplete extension closure', async () => {
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

describe('REQ-AGENT-148 AC1: deterministic signed release assets', () => {
  it('REQ-AGENT-148 AC1: emits deterministic gzip and signs its exact bytes', async () => {
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
