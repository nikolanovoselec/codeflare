import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function replaceExactlyOnce(source, pattern, replacement, label) {
  const matches = source.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${matches.length}`);
  }
  return source.replace(pattern, () => replacement);
}

export function updateSilverBulletPins(dockerfile, nativeWorkerSource, worker, pins) {
  if (!VERSION_RE.test(pins.version) || !SHA256_RE.test(pins.artifactSha256)) {
    throw new Error('invalid SilverBullet release metadata');
  }
  if (!worker.includes('cache:"reload"')) {
    throw new Error('SilverBullet service worker must force cache reload during precache');
  }

  const workerSha256 = createHash('sha256').update(worker, 'utf8').digest('hex');
  const updatedDockerfile = replaceExactlyOnce(
    replaceExactlyOnce(
      dockerfile,
      /SILVERBULLET_VERSION="[^"]+"/g,
      `SILVERBULLET_VERSION="${pins.version}"`,
      'SILVERBULLET_VERSION',
    ),
    /SILVERBULLET_SHA256="[^"]+"/g,
    `SILVERBULLET_SHA256="${pins.artifactSha256}"`,
    'SILVERBULLET_SHA256',
  );
  let updatedNativeWorkerSource = replaceExactlyOnce(
    nativeWorkerSource,
    /SilverBullet [0-9A-Za-z.+-]+ native service worker/g,
    `SilverBullet ${pins.version} native service worker`,
    'native worker version heading',
  );
  updatedNativeWorkerSource = replaceExactlyOnce(
    updatedNativeWorkerSource,
    /From SilverBullet [0-9A-Za-z.+-]+\./g,
    `From SilverBullet ${pins.version}.`,
    'native worker drift-guard version',
  );
  updatedNativeWorkerSource = replaceExactlyOnce(
    updatedNativeWorkerSource,
    /export const VAULT_NATIVE_SW_SHA256 = "[0-9a-f]+";/g,
    `export const VAULT_NATIVE_SW_SHA256 = "${workerSha256}";`,
    'VAULT_NATIVE_SW_SHA256',
  );
  updatedNativeWorkerSource = replaceExactlyOnce(
    updatedNativeWorkerSource,
    /export const VAULT_NATIVE_SW_VERBATIM = ".*";/g,
    `export const VAULT_NATIVE_SW_VERBATIM = ${JSON.stringify(worker)};`,
    'VAULT_NATIVE_SW_VERBATIM',
  );

  return { dockerfile: updatedDockerfile, nativeWorkerSource: updatedNativeWorkerSource };
}

function main(args) {
  if (args.length !== 3) {
    throw new Error('usage: update-silverbullet-pins.mjs <Dockerfile> <native-sw.ts> <service_worker.js>');
  }
  const version = process.env.SILVERBULLET_VERSION;
  const artifactSha256 = process.env.SILVERBULLET_SHA256;
  if (!version || !artifactSha256) throw new Error('SILVERBULLET_VERSION and SILVERBULLET_SHA256 are required');
  const [dockerfilePath, nativeWorkerPath, workerPath] = args;
  const updated = updateSilverBulletPins(
    readFileSync(dockerfilePath, 'utf8'),
    readFileSync(nativeWorkerPath, 'utf8'),
    readFileSync(workerPath, 'utf8'),
    { version, artifactSha256 },
  );
  writeFileSync(dockerfilePath, updated.dockerfile);
  writeFileSync(nativeWorkerPath, updated.nativeWorkerSource);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
