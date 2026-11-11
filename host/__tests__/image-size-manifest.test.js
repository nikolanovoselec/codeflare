import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { measureManifest } from '../../scripts/ci/image-size-manifest.mjs';

const input = { account: 'a'.repeat(32), repo: 'codeflare-container', ref: 'in-0123456789abcdef', auth: 'fixture-credential' };
const sha = body => `sha256:${createHash('sha256').update(body).digest('hex')}`;
const config = { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${'b'.repeat(64)}`, size: 67 };
const layers = ['application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd', 'application/vnd.docker.image.rootfs.diff.tar.gzip']
  .map((mediaType, i) => ({ mediaType, digest: `sha256:${String(i).repeat(64)}`, size: [101, 203, 307][i] }));
const image = () => ({ schemaVersion: 2, config: { ...config }, layers: layers.map(layer => ({ ...layer })), annotation: 'byte-count: é' });
function fixture(data) {
  const body = Buffer.from(JSON.stringify(data));
  return { body, hash: sha(body), bytes: body.length };
}
function response(value, header = value.hash) {
  return new Response(value.body, { headers: header === null ? {} : { 'docker-content-digest': header } });
}
function registry(routes) {
  return async (url, options) => {
    const prefix = `https://registry.cloudflare.com/v2/${input.account}/${input.repo}/manifests/`;
    assert.ok(url.startsWith(prefix));
    assert.equal(options.headers.Authorization, `Basic ${input.auth}`);
    assert.equal(options.headers.Accept, 'application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const value = routes[url.slice(prefix.length)];
    assert.ok(value, 'only the selected manifest may be retrieved');
    return response(value);
  };
}
function expected(platform, top = platform) {
  return { manifestDigest: top.hash, platformManifestDigest: platform.hash, manifestBytes: platform.bytes,
    indexBytes: top === platform ? 0 : top.bytes, configBytes: 67, configDigest: config.digest,
    compressedLayerBytes: 611, layers: layers.map(({ digest, size }) => ({ digest, bytes: size })) };
}
const descriptor = (platform, overrides = {}) => ({ digest: platform.hash, size: platform.bytes,
  platform: { os: 'linux', architecture: 'amd64' }, ...overrides });

test('authenticated tag and immutable single manifests report exact wire, config and compressed layer bytes', async () => {
  const platform = fixture(image());
  for (const ref of [input.ref, platform.hash]) {
    assert.deepEqual(await measureManifest({ ...input, ref }, registry({ [ref]: platform })), expected(platform));
  }
  const docker = image(); docker.config.mediaType = 'application/vnd.docker.container.image.v1+json';
  const value = fixture(docker);
  assert.deepEqual(await measureManifest(input, registry({ [input.ref]: value })), expected(value));
});

test('index resolves exactly one unvarianted linux amd64 manifest and accounts for both wire bodies', async () => {
  const platform = fixture(image());
  const top = fixture({ schemaVersion: 2, manifests: [
    descriptor(platform, { platform: { os: 'linux', architecture: 'arm64' } }),
    descriptor(platform, { platform: { os: 'windows', architecture: 'amd64' } }),
    descriptor(platform, { platform: { os: 'linux', architecture: 'amd64', variant: 'v3' } }), descriptor(platform),
  ] });
  assert.deepEqual(await measureManifest({ ...input, ref: top.hash }, registry({ [top.hash]: top, [platform.hash]: platform })), expected(platform, top));
});

test('immutable reference and digest header mismatches fail closed', async () => {
  const platform = fixture(image());
  await assert.rejects(measureManifest({ ...input, ref: config.digest }, async () => response(platform)));
  for (const header of [null, config.digest, platform.hash.toUpperCase()]) {
    await assert.rejects(measureManifest(input, async () => response(platform, header)));
  }
});

test('selected descriptor digest and size must match the retrieved bytes', async () => {
  const platform = fixture(image());
  for (const overrides of [{ size: platform.bytes + 1 }, { size: -1 }, { size: '123' }, { digest: config.digest }]) {
    const selected = descriptor(platform, overrides);
    const top = fixture({ manifests: [selected] });
    await assert.rejects(measureManifest(input, registry({ [input.ref]: top, [selected.digest]: platform })));
  }
});

test('absent, variant-only, duplicate and malformed platform selections fail closed', async () => {
  const platform = fixture(image());
  for (const manifests of [[], [descriptor(platform, { platform: { os: 'linux', architecture: 'arm64' } })],
    [descriptor(platform, { platform: { os: 'linux', architecture: 'amd64', variant: 'v2' } })],
    [descriptor(platform), descriptor(platform)], [descriptor(platform, { digest: 'latest' })]]) {
    const top = fixture({ manifests });
    await assert.rejects(measureManifest(input, registry({ [input.ref]: top })));
  }
});

test('invalid registry inputs are rejected before retrieval', async () => {
  for (const change of [{ account: '' }, { account: 'A'.repeat(32) }, { repo: '../private-container' },
    { repo: 'other' }, { repo: 'https://evil/container' }, { ref: 'latest' }, { ref: '../tags/list' },
    { ref: `sha256:${'A'.repeat(64)}` }, { auth: '' }]) {
    let retrieved = false;
    await assert.rejects(measureManifest({ ...input, ...change }, async () => {
      retrieved = true;
      return response(fixture(image()));
    }));
    assert.equal(retrieved, false, 'invalid input must not reach the registry');
  }
});

test('failed retrieval, invalid JSON and bodies over the one MiB bound never produce measurements', async () => {
  for (const fetchResponse of [async () => { throw Error('transport failure'); },
    async () => new Response('denied', { status: 401 }),
    async () => new Response('unavailable', { status: 503 }),
    async () => response(fixture('not a manifest')),
    async () => { const body = Buffer.from('{'); return response({ body, hash: sha(body) }); },
    async () => response(fixture({ ...image(), annotation: 'x'.repeat(1048576) })),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(Error('body interrupted')); } })),
  ]) await assert.rejects(measureManifest(input, fetchResponse));
});

test('unsupported layers, invalid sizes, unsafe sums and malformed manifests fail closed', async () => {
  const cases = [
    { schemaVersion: 1 }, { config: { ...config, digest: 'latest' } },
    { config: { ...config, mediaType: 'text/plain' } }, { config: { ...config, size: -1 } },
    { layers: null }, { layers: Array.from({ length: 257 }, () => layers[0]) },
    { layers: [{ ...layers[0], mediaType: 'application/vnd.oci.image.layer.v1.tar' }] },
    { layers: [{ ...layers[0], digest: 'latest' }] },
    ...[-1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1].map(size => ({ layers: [{ ...layers[0], size }] })),
    { layers: [{ ...layers[0], size: Number.MAX_SAFE_INTEGER }, { ...layers[1], size: 1 }] },
  ];
  for (const change of cases) {
    const value = fixture({ ...image(), ...change });
    await assert.rejects(measureManifest(input, registry({ [input.ref]: value })));
  }
});

test('CLI invalid input and retrieval failure exit nonzero with no success output or credential details', () => {
  const script = fileURLToPath(new URL('../../scripts/ci/image-size-manifest.mjs', import.meta.url));
  // In-memory preload prevents any network access and deliberately puts credentials in the transport error.
  const preload = `data:text/javascript,${encodeURIComponent(`globalThis.fetch = async () => { throw Error('Authorization: Basic ${input.auth}'); };`)}`;
  for (const ref of ['latest', input.ref]) {
    const result = spawnSync(process.execPath, ['--import', preload, script], { encoding: 'utf8', timeout: 5000,
      env: { CLOUDFLARE_ACCOUNT_ID: input.account, IMAGE_NAME: input.repo, INVENTORY_REF: ref, AUTH: input.auth } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Image size registry measurement unavailable or invalid\n');
  }
});
