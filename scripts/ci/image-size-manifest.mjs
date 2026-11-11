import { createHash } from 'node:crypto';
const digest = value => /^sha256:[a-f0-9]{64}$/.test(value);
const size = value => { if (!Number.isSafeInteger(value) || value < 0) throw Error('invalid size'); return value; };
// Credentials are inherited only inside existing sealed CI registry steps. Never print request data.
try {
  const { CLOUDFLARE_ACCOUNT_ID: account, IMAGE_NAME: repo, INVENTORY_REF: ref, AUTH: auth } = process.env;
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9][a-z0-9-]*-container$/.test(repo)
      || !(digest(ref) || /^in-[a-f0-9]{16}$/.test(ref)) || !auth) throw Error('invalid registry input');
  async function manifest(reference, expectedSize) {
    const response = await fetch(`https://registry.cloudflare.com/v2/${account}/${repo}/manifests/${reference}`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/vnd.oci.image.manifest.v1+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.docker.distribution.manifest.list.v2+json' },
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error('manifest unavailable');
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > 1048576) throw Error('manifest bound'); chunks.push(chunk);
    }
    const body = Buffer.concat(chunks), hash = `sha256:${createHash('sha256').update(body).digest('hex')}`;
    if ((digest(reference) && hash !== reference) || (expectedSize !== undefined && size(expectedSize) !== bytes)
        || response.headers.get('docker-content-digest') !== hash) throw Error('manifest identity mismatch');
    return { hash, bytes, data: JSON.parse(body) };
  }
  const top = await manifest(ref); let platform = top;
  if (top.data.manifests) {
    const matches = top.data.manifests.filter(m => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64' && !m.platform?.variant);
    if (matches.length !== 1 || !digest(matches[0].digest)) throw Error('ambiguous platform');
    platform = await manifest(matches[0].digest, matches[0].size);
  }
  const { config, layers, schemaVersion } = platform.data;
  if (schemaVersion !== 2 || !['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'].includes(config?.mediaType) || !digest(config?.digest) || !Array.isArray(layers) || layers.length > 256) throw Error('invalid manifest');
  const measured = layers.map(layer => {
    if (!digest(layer.digest) || !['application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd', 'application/vnd.docker.image.rootfs.diff.tar.gzip'].includes(layer.mediaType)) throw Error('invalid compressed layer');
    return { digest: layer.digest, bytes: size(layer.size) };
  });
  const compressedLayerBytes = size(measured.reduce((sum, layer) => size(sum + layer.bytes), 0));
  console.log(JSON.stringify({ manifestDigest: top.hash, platformManifestDigest: platform.hash,
    manifestBytes: platform.bytes, indexBytes: top === platform ? 0 : top.bytes,
    configBytes: size(config.size), configDigest: config.digest, compressedLayerBytes, layers: measured }));
} catch {
  console.error('Image size registry measurement unavailable or invalid'); process.exitCode = 1;
}
