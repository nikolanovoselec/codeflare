import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCandidate } from '../../scripts/ci/update-shadow-image-pins.mjs';

const archive = 'k6-v0.59.0-linux-amd64.tar.gz';
const publisherDigest = '7b32add2eb49495a641e5bdf9a392f58d2d5da1a50254f23b3e33fc02e1bfa55';
const sumsName = 'k6-v0.59.0-checksums.txt';

function releaseFixture(t, { digest = null, sums = `${publisherDigest}  ${archive}\n`, checksumAsset = true } = {}) {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === 'https://api.github.com/repos/grafana/k6/releases?per_page=100') {
      return new Response(JSON.stringify([{
        tag_name: 'v0.59.0', draft: false, prerelease: false,
        assets: [{ name: archive, digest }, ...(checksumAsset ? [{ name: sumsName }] : [])],
      }]));
    }
    if (url === `https://github.com/grafana/k6/releases/download/v0.59.0/${sumsName}`) {
      return new Response(sums);
    }
    throw new Error(`Unapproved release endpoint: ${url}`);
  });
}

test('REQ-OPS-020: an older k6 release resolves its publisher checksum without inventing an archive digest', async (t) => {
  releaseFixture(t);
  assert.deepEqual(await resolveCandidate('k6', '0.58.0'), { version: '0.59.0', sha256: publisherDigest });
});

test('REQ-OPS-020: a published GitHub digest remains authoritative when available', async (t) => {
  releaseFixture(t, { digest: `sha256:${'a'.repeat(64)}`, checksumAsset: false });
  assert.deepEqual(await resolveCandidate('k6', '0.58.0'), { version: '0.59.0', sha256: 'a'.repeat(64) });
});

for (const [label, options] of [
  ['missing checksum publication', { checksumAsset: false }],
  ['wrong platform filename', { sums: `${publisherDigest}  k6-v0.59.0-linux-arm64.tar.gz\n` }],
  ['ambiguous archive checksum', { sums: `${publisherDigest}  ${archive}\n${'b'.repeat(64)}  ${archive}\n` }],
  ['malformed checksum', { sums: `not-a-digest  ${archive}\n` }],
  ['malformed existing GitHub digest', { digest: 'sha256:invalid' }],
]) {
  test(`REQ-OPS-020: rejects ${label} rather than weakening archive verification`, async (t) => {
    releaseFixture(t, options);
    await assert.rejects(resolveCandidate('k6', '0.58.0'));
  });
}


test('REQ-OPS-020: GitHub release metadata uses the configured token rather than anonymous rate limits', async (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'synthetic-release-token';
  t.after(() => { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/aquasecurity/trivy/releases?per_page=100');
    const authorized = new Headers(options?.headers).get('authorization') === 'Bearer synthetic-release-token';
    return authorized ? Response.json([{ tag_name: 'v0.70.0', draft: false, prerelease: false }])
      : new Response('API rate limit exceeded', { status: 403 });
  });
  assert.deepEqual(await resolveCandidate('trivy', '0.69.0'), { version: '0.70.0' });
});

test('REQ-OPS-020: release metadata authentication never reaches public checksum downloads', async (t) => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'synthetic-release-token';
  t.after(() => { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const authorization = new Headers(options?.headers).get('authorization');
    if (url === 'https://api.github.com/repos/grafana/k6/releases?per_page=100') {
      return authorization === 'Bearer synthetic-release-token' ? Response.json([{
        tag_name: 'v0.59.0', draft: false, prerelease: false,
        assets: [{ name: archive, digest: null }, { name: sumsName }],
      }]) : new Response('API rate limit exceeded', { status: 403 });
    }
    assert.equal(url, `https://github.com/grafana/k6/releases/download/v0.59.0/${sumsName}`);
    return authorization === null ? new Response(`${publisherDigest}  ${archive}\n`)
      : new Response('credential disclosure refused', { status: 403 });
  });
  assert.deepEqual(await resolveCandidate('k6', '0.58.0'), { version: '0.59.0', sha256: publisherDigest });
});

test('REQ-OPS-020: GitHub CLI resolves the immutable source used by the final executable', async (t) => {
  const sourceCommit = 'b'.repeat(40), source = 'synthetic immutable source archive';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://api.github.com/repos/cli/cli/releases?per_page=100') {
      return Response.json([{ tag_name: 'v2.999.0', draft: false, prerelease: false,
        assets: [{ name: 'gh_2.999.0_linux_amd64.deb', digest: `sha256:${'a'.repeat(64)}` }] }]);
    }
    if (url === 'https://api.github.com/repos/cli/cli/commits/v2.999.0') {
      return Response.json({ sha: sourceCommit, commit: { committer: { date: '2026-10-01T00:00:00Z' } } });
    }
    assert.equal(url, `https://codeload.github.com/cli/cli/tar.gz/${sourceCommit}`);
    assert.equal(new Headers(options.headers).get('authorization'), null);
    return new Response(source);
  });
  assert.deepEqual(await resolveCandidate('github-cli', '2.105.0'), {
    version: '2.999.0', sha256: 'a'.repeat(64), sourceCommit, sourceEpoch: 1790812800,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
  });
});

test('REQ-OPS-020: GitHub CLI source archives are bounded before hashing completes', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/releases?')) return Response.json([{ tag_name: 'v2.999.0', draft: false, prerelease: false,
      assets: [{ name: 'gh_2.999.0_linux_amd64.deb', digest: `sha256:${'a'.repeat(64)}` }] }]);
    if (url.includes('/commits/')) return Response.json({ sha: 'b'.repeat(40), commit: { committer: { date: '2026-10-01T00:00:00Z' } } });
    let chunks = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (chunks++ < 65) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    } }));
  });
  await assert.rejects(resolveCandidate('github-cli', '2.105.0'), /exceeds 64 MiB/);
});

const repo = fileURLToPath(new URL('../..', import.meta.url));
function zizmorCommand() {
  const workflow = readFileSync(join(repo, '.github/workflows/bump-shadow-pins.yml'), 'utf8');
  const step = workflow.split('      - name: Compare the zizmor pin against what the pinned action supports\n')[1]
    ?.split('\n      - name: ')[0];
  const body = step?.split('        run: |\n')[1];
  if (!body) throw new Error('Zizmor workflow command boundary is missing');
  return body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
}
for (const [label, latest, exact, success] of [
  ['known stable version', 'zizmor==1.999.0', 'zizmor==1.999.0', true],
  ['wrong exact lock', 'zizmor==1.999.0', 'zizmor==1.998.0', false],
  ['foreign requirement', 'other-package==1.999.0', 'zizmor==1.999.0', false],
  ['prerelease requirement', 'zizmor==1.999.0rc1', 'zizmor==1.999.0rc1', false],
]) {
  test(`REQ-OPS-020: zizmor workflow resolves only a pinned supported version (${label})`, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), 'zizmor-pin-resolution-'));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const output = join(fixture, 'github-output');
    const executable = join(fixture, 'gh');
    writeFileSync(executable, `#!/bin/bash
set -euo pipefail
case "$2" in
  *'/contents/support/locks/zizmor-latest.txt?ref='*) printf '%s' "$FAKE_LATEST_LOCK" ;;
  *'/contents/support/locks/zizmor-1.999.0.txt?ref='*) printf '%s' "$FAKE_EXACT_LOCK" ;;
  *) echo 'unsupported pinned action resource' >&2; exit 1 ;;
esac
`);
    chmodSync(executable, 0o755);
    const result = spawnSync('bash', ['-c', zizmorCommand()], {
      cwd: repo, encoding: 'utf8', env: {
        ...process.env, PATH: `${fixture}:${process.env.PATH ?? ''}`,
        GH_TOKEN: 'synthetic-fixture-token', GITHUB_OUTPUT: output,
        FAKE_LATEST_LOCK: Buffer.from(latest).toString('base64'),
        FAKE_EXACT_LOCK: Buffer.from(exact).toString('base64'),
      },
    });
    assert.equal(result.status, success ? 0 : 1, result.stderr);
    if (success) {
      const current = JSON.parse(readFileSync(join(repo, '.github/workflow-tool-pins.json'), 'utf8')).zizmor.version;
      assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [`current=${current}`, 'latest=1.999.0']);
    }
  });
}

const agyManifest = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json';
const agyCandidate = {
  version: '1.5.4',
  url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.4-5037094733742080/linux-x64/cli_linux_x64.tar.gz',
  sha512: 'a'.repeat(128),
};
test('REQ-AGENT-001 AC3: Antigravity resolves the vendor stable native identity, not an installer hash', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url !== agyManifest) throw new Error(`unexpected vendor endpoint: ${url}`);
    return Response.json(agyCandidate);
  });
  assert.deepEqual(await resolveCandidate('antigravity', '1.5.3'), agyCandidate);
});
for (const [label, patch] of [
  ['prerelease', { version: '1.5.4-beta.1' }],
  ['missing checksum', { sha512: undefined }],
  ['malformed checksum', { sha512: 'bad' }],
  ['foreign host', { url: agyCandidate.url.replace('storage.googleapis.com', 'example.com') }],
  ['wrong platform', { url: agyCandidate.url.replace('linux-x64', 'linux-arm64') }],
  ['wrong version', { url: agyCandidate.url.replace('1.5.4-', '1.5.3-') }],
  ['mutable path', { url: agyCandidate.url.replace('1.5.4-5037094733742080', 'latest') }],
  ['query suffix', { url: `${agyCandidate.url}?alternate=1` }],
]) {
  test(`REQ-AGENT-001 AC3: Antigravity rejects ${label} metadata`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ ...agyCandidate, ...patch }));
    await assert.rejects(resolveCandidate('antigravity', '1.5.3'));
  });
}
