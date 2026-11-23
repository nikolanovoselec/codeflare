import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test, vi } from 'vitest';

const host = vi.hoisted(() => ({
  install: async (_path: string): Promise<void> => undefined,
  primary: undefined as ((message: unknown) => Promise<void>) | undefined,
  opened: undefined as (() => void) | undefined,
  commands: [] as string[],
  warnings: [] as string[],
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  ConfigurationTarget: { Global: 1 },
  ProgressLocation: { Notification: 15 },
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', fsPath }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: join(base.fsPath, ...parts) }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: async (command: string, source?: { fsPath: string }) => {
      if (command === 'workbench.extensions.installExtension') return host.install(source!.fsPath);
      host.commands.push(command);
    },
  },
  extensions: { all: [], onDidChange: () => ({ dispose() {} }) },
  workspace: {
    onDidChangeConfiguration: () => ({ dispose() {} }),
    getConfiguration: () => ({ inspect: () => ({}), update: async () => undefined }),
  },
  window: {
    terminals: [],
    showWarningMessage: async (message: string) => { host.warnings.push(message); },
    withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
    createWebviewPanel: () => {
      host.opened?.();
      return {
        webview: {
          html: '',
          onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => {
            host.primary = handler;
            return { dispose() { host.primary = undefined; } };
          },
        },
        onDidDispose: () => ({ dispose() {} }),
        dispose() {},
      };
    },
  },
}));

import { activate, deactivate } from '../src/welcome-extension.ts';

test('REQ-IDE-045 AC5: real welcome actions continue during a pending company install and after its failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codeflare-welcome-persistence-'));
  const extensionsDir = join(root, 'extensions');
  const manifestPath = join(root, 'ide-extensions.json');
  const managedPath = join(root, '.codeflare', 'managed-extensions.json');
  mkdirSync(extensionsDir);
  mkdirSync(join(root, '.codeflare'));
  writeFileSync(join(extensionsDir, 'extensions.json'), '[]');
  const records = ['acme.first', 'acme.second', 'acme.third'].map(id => {
    const [publisher, name] = id.split('.');
    const bytes = Buffer.from(id);
    return { id, publisher, name, version: '1.0.0', targetPlatform: 'universal', engine: '^1.109.0',
      entrypoint: './extension.js', extensionPack: [], extensionDependencies: [], size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      downloadUrl: `https://open-vsx.org/api/${publisher}/${name}/1.0.0/file/${id}-1.0.0.vsix` };
  });
  const managed = JSON.stringify({ schemaVersion: 1, release: { digest: 'a'.repeat(64), sequence: 7 }, extensions: records });
  writeFileSync(managedPath, managed);
  const overrides = {
    CODEFLARE_OPENVSCODE_EXTENSIONS_DIR: extensionsDir,
    CODEFLARE_IDE_EXTENSIONS_MANIFEST: manifestPath,
    HOME: root,
    CODEFLARE_SYNC_DAEMON_PIDFILE: join(root, 'missing-sync.pid'),
    CODEFLARE_SIDEBAR_AGENT: 'pi',
    CODEFLARE_SESSION_WORKSPACE: 'terminal',
    REMOTE_CURATION_RELEASE_DIGEST: 'a'.repeat(64),
    REMOTE_CURATION_MANIFEST_DIGEST: createHash('sha256').update(managed).digest('hex'),
  };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const subscriptions: Array<{ dispose(): void }> = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const installing = new Promise<void>(resolve => { entered = resolve; });
  let opened!: () => void;
  const welcome = new Promise<void>(resolve => { opened = resolve; });
  host.opened = opened;
  host.commands = [];
  host.warnings = [];
  let firstPending = false;
  const completed: string[] = [];
  let otherInstallsFinished!: () => void;
  const remainingInstalls = new Promise<void>(resolve => { otherInstallsFinished = resolve; });
  host.install = async path => {
    const id = basename(path, '.vsix');
    assert.equal(readFileSync(path, 'utf8'), id);
    if (id === 'acme.first') {
      firstPending = true;
      entered();
      await pending;
      firstPending = false;
      throw new Error('isolated company install failure');
    }
    completed.push(id);
    if (completed.length === 2) otherInstallsFinished();
  };
  vi.stubGlobal('fetch', async (request: Request) => {
    const record = records.find(record => record.downloadUrl === request.url);
    assert.ok(record);
    return new Response(record.id, { headers: { 'content-length': String(record.size) } });
  });
  try {
    activate({ extensionUri: { fsPath: '/extension' }, subscriptions } as never);
    await Promise.all([installing, welcome, remainingInstalls]);
    assert.equal(firstPending, true);
    assert.ok(host.primary);
    await host.primary({ type: 'primary' });
    assert.deepEqual(host.commands, ['workbench.action.chat.open']);
    release();
    await deactivate();
    assert.deepEqual(completed.sort(), ['acme.second', 'acme.third']);
    assert.equal(host.warnings.length, 1);
    assert.match(host.warnings[0]!, /acme\.first/);
    await host.primary({ type: 'primary' });
    assert.deepEqual(host.commands, ['workbench.action.chat.open', 'workbench.action.chat.open']);
  } finally {
    release();
    await deactivate();
    for (const subscription of subscriptions) subscription.dispose();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    host.opened = undefined;
    host.primary = undefined;
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  }
});
