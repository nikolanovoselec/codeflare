import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGES = ['rpiv-advisor', 'rpiv-ask-user-question', 'rpiv-todo'];

// Repair installed upstream metadata after integrity-locked npm installation.
// Do not alter archive integrity, extension code or Pi's warning machinery.
export async function patchRpivHostPeers(nodeModulesRoot) {
  const manifests = await Promise.all(PACKAGES.map(async name => {
    const path = join(nodeModulesRoot, '@juicesharp', name, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    if (manifest.name !== `@juicesharp/${name}`) throw new Error(`RPIV package identity mismatch: ${path}`);
    if (typeof manifest.dependencies?.typebox !== 'string' && manifest.peerDependencies?.typebox !== '*') {
      throw new Error(`RPIV host TypeBox declaration missing: ${path}`);
    }
    return { path, manifest };
  }));
  for (const { path, manifest } of manifests) {
    if (manifest.dependencies) delete manifest.dependencies.typebox;
    manifest.peerDependencies = { ...manifest.peerDependencies, typebox: '*' };
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('usage: patch-rpiv-host-peers.mjs NODE_MODULES_ROOT');
  await patchRpivHostPeers(process.argv[2]);
}
