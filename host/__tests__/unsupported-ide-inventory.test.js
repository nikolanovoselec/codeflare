import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { verifyUnsupportedInventory } from '../../scripts/ci/smoke-openvscode-sidebar-image.mjs';

const roots = [];

async function inventory() {
  const root = await mkdtemp(join(tmpdir(), 'unsupported-ide-inventory-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('REQ-IDE-017 AC1: unsupported inventory remains extension-free after initialization', () => {
  it('permits only an optional regular empty registry file', async () => {
    const empty = await inventory();
    await verifyUnsupportedInventory(empty);

    const initialized = await inventory();
    await writeFile(join(initialized, 'extensions.json'), '[]\n');
    await verifyUnsupportedInventory(initialized);

    const extension = await inventory();
    await mkdir(join(extension, 'publisher.extension'));
    await assert.rejects(verifyUnsupportedInventory(extension));

    const unknown = await inventory();
    await writeFile(join(unknown, 'metadata.json'), '[]');
    await assert.rejects(verifyUnsupportedInventory(unknown));

    const symlink = await inventory();
    await symlink('/tmp', join(symlink, 'extensions.json'));
    await assert.rejects(verifyUnsupportedInventory(symlink));

    const populated = await inventory();
    await writeFile(join(populated, 'extensions.json'), '[{"identifier":{"id":"publisher.extension"}}]');
    await assert.rejects(verifyUnsupportedInventory(populated));
  });
});
