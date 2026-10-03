import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { patchRpivHostPeers } from '../../scripts/patch-rpiv-host-peers.mjs';

const packages = ['rpiv-advisor', 'rpiv-ask-user-question', 'rpiv-todo'];
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'rpiv-host-peers-'));
  try {
    for (const name of packages) {
      const dir = join(root, '@juicesharp', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@juicesharp/${name}`,
        dependencies: { typebox: '^1.1.24', '@juicesharp/rpiv-config': '^2.11.0' },
        peerDependencies: { '@earendil-works/pi-coding-agent': '*' }, pi: { extensions: ['./index.ts'] } }));
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

it('REQ-AGENT-210: RPIV declares host TypeBox as a wildcard peer without changing other package contracts', async () => {
  await fixture(async root => {
    await patchRpivHostPeers(root);
    for (const name of packages) {
      const manifest = JSON.parse(await readFile(join(root, '@juicesharp', name, 'package.json')));
      assert.deepEqual(manifest.dependencies, { '@juicesharp/rpiv-config': '^2.11.0' });
      assert.deepEqual(manifest.peerDependencies, { '@earendil-works/pi-coding-agent': '*', typebox: '*' });
      assert.deepEqual(manifest.pi, { extensions: ['./index.ts'] });
    }
    await patchRpivHostPeers(root);
    const manifest = JSON.parse(await readFile(join(root, '@juicesharp', packages[0], 'package.json')));
    assert.equal(manifest.peerDependencies.typebox, '*');
  });
});

it('fails closed when an expected RPIV package is missing or has the wrong identity', async () => {
  await fixture(async root => {
    const path = join(root, '@juicesharp', packages[0], 'package.json');
    await writeFile(path, JSON.stringify({ name: 'unrelated-package', dependencies: { typebox: '*' } }));
    await assert.rejects(patchRpivHostPeers(root), /RPIV package identity/);
    await rm(path);
    await assert.rejects(patchRpivHostPeers(root), /ENOENT/);
  });
});
