import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';

import { stageSidebarExtension } from '../src/package-extension.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

async function makeRemovable(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) return;
  await chmod(path, 0o755);
  for (const entry of await readdir(path)) await makeRemovable(join(path, entry));
}

async function fixture(): Promise<{ source: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-package-'));
  roots.push(root);
  const source = join(root, 'source');
  const target = join(root, 'openvscode');
  await mkdir(join(source, 'dist'), { recursive: true });
  await mkdir(join(source, 'media'), { recursive: true });
  await mkdir(join(source, 'node_modules', 'node-pty', 'build', 'Release'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'codeflare-agent-sidebar', publisher: 'codeflare', main: 'dist/extension.cjs' }));
  await writeFile(join(source, 'dist', 'extension.cjs'), 'module.exports = {}\n');
  await writeFile(join(source, 'media', 'agent.svg'), '<svg/>\n');
  await writeFile(join(source, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'native-fixture\n');
  return { source, target };
}

test('REQ-IDE-005 AC1+AC2: stages only the fixed Pi, Claude, and empty inventories', async () => {
  const { source, target } = await fixture();
  const staged = await stageSidebarExtension({ sourceDirectory: source, rootDirectory: target });

  assert.deepEqual((await readdir(join(target, 'extensions'))).sort(), ['claude', 'none', 'pi']);
  assert.deepEqual(await readdir(staged.inventories.none), []);
  for (const inventory of [staged.inventories.pi, staged.inventories.claude]) {
    assert.deepEqual(await readdir(inventory), ['codeflare-agent-sidebar']);
    const packaged = join(inventory, 'codeflare-agent-sidebar');
    assert.equal(JSON.parse(await readFile(join(packaged, 'package.json'), 'utf8')).publisher, 'codeflare');
    assert.equal(await readFile(join(packaged, 'dist', 'extension.cjs'), 'utf8'), 'module.exports = {}\n');
  }
});

test('staged extension files are immutable and inventories share content inodes', async () => {
  const { source, target } = await fixture();
  const staged = await stageSidebarExtension({ sourceDirectory: source, rootDirectory: target });
  const relative = join('codeflare-agent-sidebar', 'dist', 'extension.cjs');
  const piFile = join(staged.inventories.pi, relative);
  const claudeFile = join(staged.inventories.claude, relative);

  assert.equal((await stat(piFile)).mode & 0o222, 0);
  assert.equal((await stat(claudeFile)).mode & 0o222, 0);
  assert.equal((await stat(piFile)).ino, (await stat(claudeFile)).ino);
});

test('REQ-IDE-005 AC2: contributes a host-compatible Codeflare Activity Bar view', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    contributes: {
      viewsContainers: { activitybar: Array<{ id: string; title: string }> };
      views: Record<string, Array<{ id: string; name: string; type: string }>>;
    };
  };
  const containers = manifest.contributes.viewsContainers.activitybar;

  assert.equal(containers.length, 1);
  assert.match(containers[0]?.id ?? '', /^[A-Za-z0-9_-]+$/);
  assert.equal(containers[0]?.title, 'Codeflare Agent');
  assert.deepEqual(manifest.contributes.views[containers[0]?.id ?? ''], [{
    id: 'codeflare.agentSidebar',
    name: 'Agent',
    type: 'webview',
  }]);
});

test('REQ-IDE-005 AC3: refuses VSIX or Anthropic-owned extension input before staging', async () => {
  for (const forbidden of ['vsix', 'publisher']) {
    const { source, target } = await fixture();
    if (forbidden === 'vsix') await writeFile(join(source, 'anthropic.vsix'), 'forbidden\n');
    else await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'claude-code', publisher: 'Anthropic', main: 'dist/extension.cjs' }));

    await assert.rejects(stageSidebarExtension({ sourceDirectory: source, rootDirectory: target }), /VSIX|publisher|owned/i);
    await assert.rejects(stat(target), { code: 'ENOENT' });
  }
});
