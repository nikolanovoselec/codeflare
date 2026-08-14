import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';

import officialClaude from '../official-claude.json' with { type: 'json' };
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

async function fixture(): Promise<{ source: string; claudeSource: string; target: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-package-'));
  roots.push(root);
  const source = join(root, 'source');
  const claudeSource = join(root, 'claude-source');
  const target = join(root, 'openvscode');
  await mkdir(join(source, 'dist'), { recursive: true });
  await mkdir(join(source, 'media'), { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'codeflare-agent-sidebar', publisher: 'codeflare', main: 'dist/extension.cjs' }));
  await writeFile(join(source, 'dist', 'extension.cjs'), 'module.exports = {}\n');
  await writeFile(join(source, 'media', 'agent.svg'), '<svg/>\n');

  await mkdir(join(claudeSource, 'resources', 'native-binary'), { recursive: true });
  await writeFile(join(claudeSource, 'package.json'), JSON.stringify({
    name: officialClaude.name,
    publisher: officialClaude.namespace,
    version: officialClaude.version,
    main: officialClaude.main,
    engines: { vscode: officialClaude.vscodeEngine },
  }));
  await writeFile(join(claudeSource, 'extension.js'), 'module.exports = {}\n');
  await writeFile(join(claudeSource, 'resources', 'native-binary', 'claude'), 'official-binary-fixture\n', { mode: 0o755 });
  return { source, claudeSource, target };
}

async function stageFixture(source: string, claudeSource: string, target: string) {
  return stageSidebarExtension({
    sourceDirectory: source,
    claudeSourceDirectory: claudeSource,
    rootDirectory: target,
  });
}

interface TreeEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly content?: string;
  readonly executable?: number;
}

async function snapshotTree(root: string, directory = ''): Promise<TreeEntry[]> {
  const snapshot: TreeEntry[] = [];
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      snapshot.push({ path, kind: 'directory' });
      snapshot.push(...await snapshotTree(root, path));
    } else {
      assert.equal(entry.isFile(), true, `unsupported tree entry: ${path}`);
      const info = await stat(join(root, path));
      snapshot.push({
        path,
        kind: 'file',
        content: (await readFile(join(root, path))).toString('base64'),
        executable: info.mode & 0o111,
      });
    }
  }
  return snapshot;
}

test('REQ-IDE-005 AC1: stages native Pi, official Claude, and empty unsupported inventories', async () => {
  const { source, claudeSource, target } = await fixture();
  const claudeSourceSnapshot = await snapshotTree(claudeSource);
  const staged = await stageFixture(source, claudeSource, target);

  assert.deepEqual((await readdir(join(target, 'extensions'))).sort(), ['claude', 'none', 'pi']);
  assert.deepEqual(await readdir(staged.inventories.none), []);
  assert.deepEqual(
    JSON.parse(await readFile(join(target, 'official-claude.json'), 'utf8')),
    officialClaude,
  );
  assert.deepEqual(await readdir(staged.inventories.pi), ['codeflare-agent-sidebar']);
  assert.deepEqual(await readdir(staged.inventories.claude), ['anthropic.claude-code']);
  assert.deepEqual(
    await snapshotTree(join(staged.inventories.claude, 'anthropic.claude-code')),
    claudeSourceSnapshot,
  );
  assert.equal(
    JSON.parse(await readFile(join(staged.inventories.pi, 'codeflare-agent-sidebar', 'package.json'), 'utf8')).publisher,
    'codeflare',
  );
  const claudeManifest = JSON.parse(
    await readFile(join(staged.inventories.claude, 'anthropic.claude-code', 'package.json'), 'utf8',),
  ) as Record<string, unknown>;
  assert.equal(claudeManifest.name, officialClaude.name);
  assert.equal(claudeManifest.publisher, officialClaude.namespace);
  assert.equal(claudeManifest.version, officialClaude.version);
});

test('staged Pi and Claude extension files are immutable', async () => {
  const { source, claudeSource, target } = await fixture();
  const staged = await stageFixture(source, claudeSource, target);
  const piFile = join(staged.inventories.pi, 'codeflare-agent-sidebar', 'dist', 'extension.cjs');
  const claudeFile = join(staged.inventories.claude, 'anthropic.claude-code', 'extension.js');

  assert.equal((await stat(piFile)).mode & 0o222, 0);
  assert.equal((await stat(claudeFile)).mode & 0o222, 0);
  assert.notEqual((await stat(piFile)).ino, (await stat(claudeFile)).ino);
});

test('REQ-IDE-005 AC2 + REQ-IDE-011 AC1 + REQ-IDE-014 AC1 + REQ-IDE-019 AC1 + REQ-IDE-023 AC1: contributes native Pi panel and editor Chat', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    displayName: string;
    activationEvents: string[];
    enabledApiProposals: string[];
    contributes: {
      chatParticipants: Array<Record<string, unknown>>;
      commands: Array<Record<string, unknown>>;
      languageModelChatProviders: Array<Record<string, unknown>>;
      menus: {
        'editor/context': Array<Record<string, unknown>>;
        'explorer/context': Array<Record<string, unknown>>;
      };
      viewsContainers?: unknown;
      views?: unknown;
    };
  };

  assert.equal(manifest.displayName, 'Codeflare');
  assert.deepEqual(manifest.activationEvents, [
    '*',
    'onChatParticipant:codeflare.pi',
    'onCommand:codeflare.pi.reviewFile',
  ]);
  assert.deepEqual(manifest.enabledApiProposals, [
    'chatParticipantAdditions',
    'chatProvider',
    'defaultChatParticipant',
  ]);
  assert.deepEqual(manifest.contributes.languageModelChatProviders, [
    {
      vendor: 'copilot',
      displayName: 'Codeflare',
    },
    {
      vendor: 'codeflare',
      displayName: 'Codeflare',
    },
  ]);
  const [participant] = manifest.contributes.chatParticipants;
  assert.equal(participant?.id, 'codeflare.pi');
  assert.equal(participant?.name, 'codeflare');
  assert.equal(participant?.fullName, 'Codeflare');
  assert.equal(participant?.isDefault, true);
  assert.equal(participant?.isSticky, true);
  assert.deepEqual(participant?.locations, ['panel', 'editor']);
  assert.deepEqual(participant?.modes, ['ask', 'edit', 'agent']);
  assert.deepEqual(manifest.contributes.commands, [{
    command: 'codeflare.pi.reviewFile',
    title: 'Review with Codeflare',
  }]);
  assert.deepEqual(manifest.contributes.menus['explorer/context'], [{
    command: 'codeflare.pi.reviewFile',
    group: '1_chat@1',
    when: "resourceScheme == 'file' && !explorerResourceIsFolder",
  }]);
  assert.deepEqual(manifest.contributes.menus['editor/context'], [{
    command: 'codeflare.pi.reviewFile',
    group: '1_chat@6',
    when: "resourceScheme == 'file'",
  }]);
  assert.equal(manifest.contributes.viewsContainers, undefined);
  assert.equal(manifest.contributes.views, undefined);
});

test('REQ-IDE-024 AC1+AC2: the shared welcome extension contributes no agent surface', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../welcome-package.json', import.meta.url), 'utf8'),
  ) as {
    name: string;
    publisher: string;
    activationEvents: string[];
    contributes: Record<string, unknown>;
  };

  assert.equal(manifest.name, 'codeflare-welcome');
  assert.equal(manifest.publisher, 'codeflare');
  assert.deepEqual(manifest.activationEvents, [
    'onStartupFinished',
    'onCommand:codeflare.welcome.open',
  ]);
  assert.deepEqual(manifest.contributes.commands, [{
    command: 'codeflare.welcome.open',
    title: 'Codeflare: Open Welcome',
  }]);
  assert.equal(manifest.contributes.chatParticipants, undefined);
  assert.equal(manifest.contributes.languageModelChatProviders, undefined);
  assert.equal(manifest.contributes.views, undefined);
});

test('REQ-IDE-010 AC3: refuses retained VSIX and substituted publisher or version metadata', async () => {
  for (const forbidden of ['vsix', 'owned-publisher', 'official-publisher', 'official-version']) {
    const { source, claudeSource, target } = await fixture();
    if (forbidden === 'vsix') await writeFile(join(source, 'anthropic.vsix'), 'forbidden\n');
    if (forbidden === 'owned-publisher') {
      await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'claude-code', publisher: 'Anthropic', main: 'dist/extension.cjs' }));
    }
    if (forbidden === 'official-publisher' || forbidden === 'official-version') {
      const manifest = JSON.parse(await readFile(join(claudeSource, 'package.json'), 'utf8')) as Record<string, unknown>;
      if (forbidden === 'official-publisher') manifest.publisher = 'lookalike';
      else manifest.version = `${officialClaude.version}-substituted`;
      await writeFile(join(claudeSource, 'package.json'), JSON.stringify(manifest));
    }

    await assert.rejects(stageFixture(source, claudeSource, target), /VSIX|publisher|owned|official|version/i);
    await assert.rejects(stat(target), { code: 'ENOENT' });
  }
});
