import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const host = vi.hoisted(() => ({
  commands: [] as Array<{ command: string; arguments: unknown[] }>,
  execute: async (_command: string, ..._args: unknown[]): Promise<unknown> => undefined,
  extensions: [] as Array<{ id: string; packageJSON: Record<string, unknown> }>,
  extensionChange: undefined as (() => void) | undefined,
  configurationChange: undefined as ((event: { affectsConfiguration(key: string): boolean }) => void) | undefined,
  inspected: new Map<string, unknown>(),
  settingsUpdates: [] as Array<{ key: string; value: unknown; target: unknown }>,
  updateSetting: async (_key: string, _value: unknown, _target: unknown): Promise<void> => undefined,
  acknowledgeSecurity: true,
  warnings: [] as string[],
  progressTitles: [] as string[],
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  Uri: {
    file: (fsPath: string) => ({ scheme: 'file', fsPath }),
  },
  ProgressLocation: { Notification: 15 },
  commands: {
    executeCommand: async (command: string, ...args: unknown[]) => {
      host.commands.push({ command, arguments: args });
      return host.execute(command, ...args);
    },
  },
  extensions: {
    get all() { return host.extensions; },
    onDidChange: (listener: () => void) => {
      host.extensionChange = listener;
      return { dispose: () => { host.extensionChange = undefined; } };
    },
  },
  window: {
    showWarningMessage: async (message: string, ...actions: unknown[]) => {
      host.warnings.push(message);
      return host.acknowledgeSecurity && actions.includes('I understand') ? 'I understand' : undefined;
    },
    withProgress: async (options: { title: string }, task: (progress: { report(): void }) => Promise<unknown>) => {
      host.progressTitles.push(options.title);
      return task({ report() {} });
    },
  },
  workspace: {
    onDidChangeConfiguration: (listener: (event: { affectsConfiguration(key: string): boolean }) => void) => {
      host.configurationChange = listener;
      return { dispose: () => { host.configurationChange = undefined; } };
    },
    getConfiguration: () => ({
      inspect: (key: string) => ({ globalValue: host.inspected.get(key) }),
      update: async (key: string, value: unknown, target: unknown) => {
        await host.updateSetting(key, value, target);
        host.settingsUpdates.push({ key, value, target });
      },
    }),
  },
}));

import {
  activateExtensionPersistence,
  captureExtensionManifest,
  loadExtensionManifest,
  reconcileCompanyExtensions,
  restoreExtensionManifest,
} from '../src/extension-persistence.ts';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codeflare-extension-persistence-'));
  roots.push(root);
  const extensionsDir = join(root, 'extensions');
  const manifestPath = join(root, '.codeflare', 'ide-extensions.json');
  const syncPidFile = join(root, 'sync-daemon.pid');
  const managedExtensionsPath = join(root, '.codeflare', 'managed-extensions.json');
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(join(manifestPath, '..'), { recursive: true });
  return { root, extensionsDir, manifestPath, managedExtensionsPath, syncPidFile };
}

function managedExtension(
  id = 'cherrymarkdownpublisher.cherry-markdown',
  version = '0.3.1081718',
  bytes = Buffer.from('verified company extension'),
) {
  const [publisher, name] = id.split('.');
  return {
    id,
    publisher,
    name,
    version,
    targetPlatform: 'universal',
    engine: '^1.109.0',
    entrypoint: './dist/extension.js',
    extensionPack: [],
    extensionDependencies: [] as string[],
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    downloadUrl: `https://open-vsx.org/api/${publisher}/${name}/${version}/file/${publisher}.${name}-${version}.vsix`,
  };
}

function managedExtensionsBytes(records: Array<ReturnType<typeof managedExtension>>) {
  return JSON.stringify({
    schemaVersion: 1,
    release: { digest: 'a'.repeat(64), sequence: 7 },
    extensions: records,
  });
}

function writeManagedExtensions(path: string, records: Array<ReturnType<typeof managedExtension>>) {
  const bytes = managedExtensionsBytes(records);
  writeFileSync(path, bytes);
  process.env.REMOTE_CURATION_RELEASE_DIGEST = 'a'.repeat(64);
  process.env.REMOTE_CURATION_MANIFEST_DIGEST = createHash('sha256').update(bytes).digest('hex');
}

function writeRegistry(
  extensionsDir: string,
  entries: Array<{ id: string; version: string; targetPlatform?: string; omitMetadata?: boolean }> = [],
) {
  writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify(entries.map((entry) => ({
    identifier: { id: entry.id },
    version: entry.version,
    location: { scheme: 'file', path: `/tmp/${entry.id}` },
    relativeLocation: entry.id,
    ...(entry.omitMetadata ? {} : {
      metadata: {
        targetPlatform: entry.targetPlatform ?? 'universal',
        installedTimestamp: 1_786_921_200_000,
      },
    }),
  }))));
}

function validManifest(extensions: Record<string, Record<string, unknown>>, settings: Record<string, unknown> = {}) {
  return {
    version: 1,
    extensions,
    settings,
  };
}

async function flushMicrotasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function flushAsyncWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  host.commands = [];
  host.execute = async () => undefined;
  host.extensions = [];
  host.extensionChange = undefined;
  host.configurationChange = undefined;
  host.inspected.clear();
  host.settingsUpdates = [];
  host.updateSetting = async () => undefined;
  host.acknowledgeSecurity = true;
  delete process.env.REMOTE_CURATION_RELEASE_DIGEST;
  delete process.env.REMOTE_CURATION_MANIFEST_DIGEST;
  host.warnings = [];
  host.progressTitles = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.CODEFLARE_OPENVSCODE_EXTENSIONS_DIR;
  delete process.env.CODEFLARE_IDE_EXTENSIONS_MANIFEST;
  delete process.env.CODEFLARE_SYNC_DAEMON_PIDFILE;
  delete process.env.REMOTE_CURATION_RELEASE_DIGEST;
  delete process.env.REMOTE_CURATION_MANIFEST_DIGEST;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('REQ-IDE-046 AC1+AC2: exact company VSIX installs from a deleted temporary file', async () => {
  const { extensionsDir, manifestPath, managedExtensionsPath } = fixture();
  const bytes = Buffer.from('verified company extension');
  const record = managedExtension(undefined, undefined, bytes);
  writeManagedExtensions(managedExtensionsPath, [record]);
  writeRegistry(extensionsDir);
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (request: Request) => {
    requests.push(request);
    if (new URL(request.url).hostname === 'open-vsx.org') {
      return new Response(null, {
        status: 302,
        headers: {
          location: `https://openvsx.eclipsecontent.org/${record.publisher}/${record.name}/${record.version}/${basename(record.downloadUrl)}`,
        },
      });
    }
    return new Response(bytes.toString('utf8'), { status: 200, headers: { 'content-length': String(bytes.length) } });
  });
  let installedPath = '';
  host.execute = async (_command, source, options) => {
    assert.equal(typeof source, 'object');
    installedPath = (source as { fsPath: string }).fsPath;
    assert.equal(existsSync(installedPath), true);
    assert.deepEqual(options, { donotSync: true });
  };

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result, { failures: [], managedIds: [record.id] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, record.downloadUrl);
  assert.equal(requests.every((request) => request.redirect === 'manual'), true);
  assert.equal(existsSync(installedPath), false);
  assert.equal(host.commands.some(({ arguments: args }) => typeof args[0] === 'string'), false, 'company install never falls back to a gallery identity');
  assert.equal(existsSync(manifestPath), false, 'company bytes and intent do not enter the personal manifest');
});

test('REQ-IDE-046 AC3: failed company installation removes the temporary VSIX', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  const bytes = Buffer.from('verified company extension');
  const record = managedExtension(undefined, undefined, bytes);
  writeManagedExtensions(managedExtensionsPath, [record]);
  writeRegistry(extensionsDir);
  vi.stubGlobal('fetch', async () => new Response(bytes, {
    status: 200,
    headers: { 'content-length': String(bytes.length) },
  }));
  let installedPath = '';
  host.execute = async (_command, source) => {
    installedPath = (source as { fsPath: string }).fsPath;
    assert.equal(existsSync(installedPath), true);
    throw new Error('injected installation failure');
  };

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result, { failures: [record.id], managedIds: [record.id] });
  assert.equal(existsSync(installedPath), false);
});

test('REQ-IDE-042 AC1: a company manifest from another release is rejected before download', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  writeManagedExtensions(managedExtensionsPath, [managedExtension()]);
  process.env.REMOTE_CURATION_RELEASE_DIGEST = 'b'.repeat(64);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result, { failures: ['managed-extension-manifest'], managedIds: [] });
  assert.equal(fetcher.mock.calls.length, 0);
  assert.equal(host.warnings.length, 1);
});

test('REQ-IDE-042 AC1: changed company manifest bytes are rejected despite a matching release digest', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  const trusted = managedExtension();
  writeManagedExtensions(managedExtensionsPath, [trusted]);
  const substituted = managedExtension('acme.substituted', '1.0.0');
  writeFileSync(managedExtensionsPath, managedExtensionsBytes([substituted]));
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result, { failures: ['managed-extension-manifest'], managedIds: [] });
  assert.equal(fetcher.mock.calls.length, 0);
  assert.equal(host.commands.length, 0);
  assert.deepEqual(host.warnings, [
    'Managed Browser IDE extensions could not be verified. Stop this session, then run “Recreate Agent Skills & Rules” in Codeflare Settings.',
  ]);
});

test('REQ-IDE-045 AC6: a missing active-release manifest preserves prior company extensions', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  const priorId = 'acme.company';
  writeFileSync(join(extensionsDir, '.codeflare-company-extensions.json'), JSON.stringify([priorId]));
  process.env.REMOTE_CURATION_RELEASE_DIGEST = 'a'.repeat(64);
  process.env.REMOTE_CURATION_MANIFEST_DIGEST = 'b'.repeat(64);

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result, { failures: ['managed-extension-manifest'], managedIds: [priorId] });
  assert.equal(host.commands.length, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(extensionsDir, '.codeflare-company-extensions.json'), 'utf8')), [priorId]);
});

test('REQ-IDE-045 AC6: manifest failure preserves company ownership while unrelated personal restore continues', async () => {
  const { extensionsDir, manifestPath, managedExtensionsPath, syncPidFile } = fixture();
  const priorId = 'acme.company';
  writeFileSync(join(extensionsDir, '.codeflare-company-extensions.json'), JSON.stringify([priorId]));
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({
      [priorId]: { version: '1.0.0' },
      'publisher.personal': { version: '2.0.0' },
    }),
    securityWarningShown: true,
  }));
  writeRegistry(extensionsDir);
  process.env.REMOTE_CURATION_RELEASE_DIGEST = 'a'.repeat(64);
  process.env.REMOTE_CURATION_MANIFEST_DIGEST = 'b'.repeat(64);
  const installed: string[] = [];
  host.execute = async (_command, source) => {
    if (typeof source === 'string') installed.push(source);
  };
  const subscriptions: Array<{ dispose(): void }> = [];

  const deactivate = await activateExtensionPersistence(
    { subscriptions } as never,
    { extensionsDir, manifestPath, managedExtensionsPath, syncPidFile, debounceMs: 2_000 },
  );

  assert.deepEqual(installed, ['publisher.personal@2.0.0']);
  assert.deepEqual(JSON.parse(readFileSync(join(extensionsDir, '.codeflare-company-extensions.json'), 'utf8')), [priorId]);
  assert.equal(host.warnings.length, 1);
  await deactivate();
  for (const subscription of subscriptions) subscription.dispose();
});

test('REQ-IDE-044 AC1: unsigned company download URLs are rejected before download', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  const invalid = {
    ...managedExtension(),
    downloadUrl: 'https://example.com/company-extension.vsix',
  };
  writeManagedExtensions(managedExtensionsPath, [invalid]);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result, { failures: ['managed-extension-manifest'], managedIds: [] });
  assert.equal(fetcher.mock.calls.length, 0);
});

test('REQ-IDE-044 AC3: non-semantic company versions are rejected before download', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  const invalid = {
    ...managedExtension(),
    version: '01.2.3',
    downloadUrl: 'https://open-vsx.org/api/cherrymarkdownpublisher/cherry-markdown/01.2.3/file/cherry-markdown.vsix',
  };
  writeManagedExtensions(managedExtensionsPath, [invalid]);
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result, { failures: ['managed-extension-manifest'], managedIds: [] });
  assert.equal(fetcher.mock.calls.length, 0);
});

test('REQ-IDE-044 AC2+AC4+AC5 + REQ-IDE-046 AC3: invalid bytes install nothing and clean every temporary directory', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  const redirect = managedExtension('acme.bad-redirect', '1.0.0', Buffer.from('redirect'));
  const oversized = managedExtension('acme.bad-size', '1.0.0', Buffer.from('size'));
  const changed = managedExtension('acme.bad-hash', '1.0.0', Buffer.from('expected'));
  writeManagedExtensions(managedExtensionsPath, [redirect, oversized, changed]);
  writeRegistry(extensionsDir);
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('codeflare-company-extension-')));
  vi.stubGlobal('fetch', async (request: Request) => {
    if (request.url === redirect.downloadUrl) {
      return new Response(null, { status: 302, headers: { location: 'https://example.com/extension.vsix' } });
    }
    if (request.url === oversized.downloadUrl) return new Response('too-large');
    if (request.url === changed.downloadUrl) return new Response('modified');
    throw new Error('unexpected redirect request');
  });

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result.failures, [changed.id, redirect.id, oversized.id].sort());
  assert.deepEqual(host.commands, []);
  const after = readdirSync(tmpdir()).filter((name) => name.startsWith('codeflare-company-extension-') && !before.has(name));
  assert.deepEqual(after, []);
});

test('REQ-IDE-044 AC7: a matching registry identity is reinstalled from exact signed bytes', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  const bytes = Buffer.from('verified company extension');
  const company = managedExtension('cherrymarkdownpublisher.cherry-markdown', '0.3.1081718', bytes);
  writeManagedExtensions(managedExtensionsPath, [company]);
  writeRegistry(extensionsDir, [{ id: company.id, version: company.version, targetPlatform: company.targetPlatform }]);
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (request: Request) => {
    requests.push(request.url);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  });

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(requests, [company.downloadUrl]);
  assert.equal(host.commands.length, 1);
  assert.equal((host.commands[0].arguments[0] as { scheme: string }).scheme, 'file');
});

test('REQ-IDE-045 AC4+AC5: company failures remain bounded and do not block the workbench', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  const records = ['one.extension', 'two.extension', 'zthree.extension'].map((id) => managedExtension(id, '1.0.0', Buffer.from(id)));
  writeManagedExtensions(managedExtensionsPath, records);
  writeRegistry(extensionsDir);
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === 'open-vsx.org') {
      const record = records.find((candidate) => request.url === candidate.downloadUrl);
      assert.ok(record);
      return new Response(null, {
        status: 302,
        headers: { location: `https://openvsx.eclipsecontent.org/${record.publisher}/${record.name}/${record.version}/${basename(record.downloadUrl)}` },
      });
    }
    const record = records.find((candidate) => url.pathname.startsWith(`/${candidate.publisher}/${candidate.name}/`));
    assert.ok(record);
    const bytes = Buffer.from(record.id);
    return new Response(record.id, { status: 200, headers: { 'content-length': String(bytes.length) } });
  });
  let active = 0;
  let maximum = 0;
  host.execute = async (_command, source) => {
    const shouldFail = (source as { fsPath: string }).fsPath.endsWith('/two.extension.vsix');
    active += 1;
    maximum = Math.max(maximum, active);
    await flushAsyncWork();
    active -= 1;
    if (shouldFail) throw new Error('isolated install failure');
  };

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.ok(maximum > 0 && maximum <= 2);
  assert.deepEqual(result.failures, ['two.extension']);
  assert.equal(host.warnings.length, 1);
  assert.match(host.warnings[0], /two\.extension/);
});

test('REQ-IDE-044 AC6 + REQ-IDE-045 AC3: exact dependencies install without gallery fallback', async () => {
  const { extensionsDir, managedExtensionsPath } = fixture();
  const dependency = managedExtension('acme.zzz-dependency', '1.0.0', Buffer.from('dependency'));
  const dependent = {
    ...managedExtension('acme.aaa-parent', '1.0.0', Buffer.from('parent')),
    extensionDependencies: [dependency.id],
  };
  writeManagedExtensions(managedExtensionsPath, [dependent, dependency]);
  writeRegistry(extensionsDir);
  vi.stubGlobal('fetch', async (request: Request) => {
    const record = [dependent, dependency].find((candidate) => request.url === candidate.downloadUrl);
    assert.ok(record);
    const bytes = record.id === dependency.id ? Buffer.from('dependency') : Buffer.from('parent');
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  });
  const installed: string[] = [];
  host.execute = async (_command, source) => {
    const id = basename((source as { fsPath: string }).fsPath, '.vsix');
    if (id === dependent.id) assert.deepEqual(installed, [dependency.id]);
    installed.push(id);
  };

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(installed, [dependency.id, dependent.id]);
  assert.equal(host.commands.some(({ arguments: args }) => typeof args[0] === 'string'), false);
});

test('REQ-IDE-045 AC1 + REQ-IDE-042 AC3+AC4: company reconciliation precedes personal restore and capture', async () => {
  const { extensionsDir, manifestPath, managedExtensionsPath, syncPidFile } = fixture();
  const company = managedExtension();
  writeManagedExtensions(managedExtensionsPath, [company]);
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({
      [company.id]: { version: '0.2.0' },
      'publisher.personal': { version: '1.0.0' },
    }),
    securityWarningShown: true,
  }));
  writeRegistry(extensionsDir);
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === 'open-vsx.org') {
      return new Response(null, { status: 302, headers: { location: `https://openvsx.eclipsecontent.org/${company.publisher}/${company.name}/${company.version}/${basename(company.downloadUrl)}` } });
    }
    return new Response('verified company extension', { status: 200 });
  });
  const order: string[] = [];
  host.execute = async (_command, source) => {
    if (typeof source === 'string') {
      order.push(`personal:${source}`);
      return;
    }
    order.push(`company:${company.id}@${company.version}`);
    writeRegistry(extensionsDir, [{ id: company.id, version: company.version }]);
  };
  const subscriptions: Array<{ dispose(): void }> = [];

  const deactivate = await activateExtensionPersistence(
    { subscriptions } as never,
    { extensionsDir, manifestPath, managedExtensionsPath, syncPidFile, debounceMs: 2_000 },
  );

  assert.deepEqual(order, [
    `company:${company.id}@${company.version}`,
    'personal:publisher.personal@1.0.0',
  ]);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).extensions[company.id].version, '0.2.0', 'managed company version does not overwrite preserved personal intent');
  await deactivate();
  for (const subscription of subscriptions) subscription.dispose();
});

test('disabling company enforcement preserves personal extension intent', async () => {
  const { extensionsDir, manifestPath, managedExtensionsPath } = fixture();
  const company = managedExtension();
  writeManagedExtensions(managedExtensionsPath, [company]);
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({ [company.id]: { version: '0.2.0' } }),
    securityWarningShown: true,
  }));
  writeRegistry(extensionsDir, [{ id: company.id, version: company.version }]);
  const companyBytes = Buffer.from('verified company extension');
  vi.stubGlobal('fetch', async () => new Response(companyBytes, {
    status: 200,
    headers: { 'content-length': String(companyBytes.length) },
  }));
  await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });
  unlinkSync(managedExtensionsPath);
  host.commands = [];

  await restoreExtensionManifest({ extensionsDir, manifestPath });

  assert.deepEqual(host.commands.map(({ arguments: args }) => args[0]), [`${company.id}@0.2.0`]);
  assert.equal(host.commands.some(({ command }) => /uninstall/i.test(command)), false);
  await captureExtensionManifest({ extensionsDir, manifestPath, syncPidFile: join(extensionsDir, 'missing.pid') });
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).extensions[company.id].version, '0.2.0');
});

test('REQ-IDE-042 AC7: removed company extensions are uninstalled before personal intent is restored', async () => {
  const { extensionsDir, manifestPath, managedExtensionsPath } = fixture();
  const company = managedExtension();
  const companyBytes = Buffer.from('verified company extension');
  writeManagedExtensions(managedExtensionsPath, [company]);
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({ [company.id]: { version: '0.2.0' } }),
    securityWarningShown: true,
  }));
  writeRegistry(extensionsDir, [{ id: company.id, version: company.version }]);
  vi.stubGlobal('fetch', async () => new Response(companyBytes, {
    status: 200,
    headers: { 'content-length': String(companyBytes.length) },
  }));
  await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });
  writeManagedExtensions(managedExtensionsPath, []);
  host.commands = [];

  const result = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });
  await restoreExtensionManifest({ extensionsDir, manifestPath });

  assert.deepEqual(result, { failures: [], managedIds: [] });
  assert.deepEqual(host.commands.map(({ command, arguments: args }) => [command, args[0]]), [
    ['workbench.extensions.uninstallExtension', company.id],
    ['workbench.extensions.installExtension', `${company.id}@0.2.0`],
  ]);
});

test('REQ-IDE-042 AC7: failed company removal blocks personal restoration until retry succeeds', async () => {
  const { extensionsDir, manifestPath, managedExtensionsPath } = fixture();
  const company = managedExtension();
  writeManagedExtensions(managedExtensionsPath, [company]);
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({ [company.id]: { version: '0.2.0' } }),
    securityWarningShown: true,
  }));
  writeRegistry(extensionsDir, [{ id: company.id, version: company.version }]);
  vi.stubGlobal('fetch', async () => new Response(Buffer.from('verified company extension'), {
    status: 200,
    headers: { 'content-length': String(company.size) },
  }));
  await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });
  writeManagedExtensions(managedExtensionsPath, []);
  host.commands = [];
  host.execute = async (command) => {
    if (command === 'workbench.extensions.uninstallExtension') throw new Error('uninstall failed');
  };

  const failed = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });
  await restoreExtensionManifest({ extensionsDir, manifestPath }, new Set(failed.managedIds));

  assert.deepEqual(failed, { failures: [company.id], managedIds: [company.id] });
  assert.deepEqual(host.commands.map(({ command }) => command), ['workbench.extensions.uninstallExtension']);

  host.commands = [];
  host.execute = async () => undefined;
  const retried = await reconcileCompanyExtensions({ extensionsDir, managedExtensionsPath });
  await restoreExtensionManifest({ extensionsDir, manifestPath }, new Set(retried.managedIds));

  assert.deepEqual(retried, { failures: [], managedIds: [] });
  assert.deepEqual(host.commands.map(({ command, arguments: args }) => [command, args[0]]), [
    ['workbench.extensions.uninstallExtension', company.id],
    ['workbench.extensions.installExtension', `${company.id}@0.2.0`],
  ]);
});

test('REQ-IDE-042 AC4+AC6: live capture excludes company-only installs from personal intent', async () => {
  const { extensionsDir, manifestPath, managedExtensionsPath, syncPidFile } = fixture();
  const company = managedExtension();
  writeManagedExtensions(managedExtensionsPath, [company]);
  writeRegistry(extensionsDir, [{ id: company.id, version: company.version }]);

  assert.equal(await captureExtensionManifest({
    extensionsDir,
    manifestPath,
    syncPidFile,
    managedExtensionsPath,
    managedReleaseDigest: 'a'.repeat(64),
  }), true);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).extensions, {});
  assert.deepEqual(host.warnings, []);
});

test('REQ-IDE-036 AC1+AC2+AC3: malformed manifests fail closed and valid manifests round-trip atomically', async () => {
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  const malformed = JSON.stringify({
    version: 1,
    extensions: { 'RedHat.vscode-yaml': { version: '1.24.0' } },
    settings: {},
  });
  writeFileSync(manifestPath, malformed);
  writeRegistry(extensionsDir, [{ id: 'redhat.vscode-yaml', version: '1.24.0' }]);
  writeFileSync(syncPidFile, '1234\n');

  assert.deepEqual(await loadExtensionManifest(manifestPath), { state: 'invalid' });
  const changed = await captureExtensionManifest({ extensionsDir, manifestPath, syncPidFile });
  assert.equal(changed, false);
  assert.equal(readFileSync(manifestPath, 'utf8'), malformed);

  const valid = `${JSON.stringify(validManifest({
    'redhat.vscode-yaml': { version: '1.24.0', targetPlatform: 'universal', installedAt: '2026-08-17T00:00:00Z' },
  }, { 'yaml.validate': true }))}\n`;
  writeFileSync(manifestPath, valid, { mode: 0o600 });
  const loaded = await loadExtensionManifest(manifestPath);
  assert.equal(loaded.state, 'valid');
  assert.deepEqual(loaded.manifest?.settings, { 'yaml.validate': true });
});

test('REQ-IDE-016 AC3 + REQ-IDE-037 AC1+AC3+AC4: restores exact versions, falls back once, and preserves failures', async () => {
  const { extensionsDir, manifestPath } = fixture();
  const manifest = {
    ...validManifest({
      'redhat.vscode-yaml': { version: '1.24.0' },
      'dbaeumer.vscode-eslint': { version: '3.0.34' },
      'eamodio.gitlens': { version: '17.0.0' },
    }, {
      'yaml.validate': true,
      'extensions.allowed': { '*': false },
      'workbench.colorTheme': 'must-not-override-ui-state',
    }),
    securityWarningShown: true,
  };
  const original = `${JSON.stringify(manifest)}\n`;
  writeFileSync(manifestPath, original);
  writeRegistry(extensionsDir);
  host.execute = async (_command, selector) => {
    if (selector === 'dbaeumer.vscode-eslint@3.0.34') {
      throw Object.assign(new Error('structured error'), { code: 'ExtensionNotFound' });
    }
    if (selector === 'eamodio.gitlens@17.0.0') {
      throw Object.assign(new Error('network unavailable'), { code: 'NetworkError' });
    }
    const id = String(selector).split('@')[0];
    const current = JSON.parse(readFileSync(join(extensionsDir, 'extensions.json'), 'utf8'));
    const version = id === 'dbaeumer.vscode-eslint' ? '3.0.35' : '1.24.0';
    writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([
      ...current,
      {
        identifier: { id },
        version,
        location: { scheme: 'file', path: `/tmp/${id}` },
        relativeLocation: id,
        metadata: { targetPlatform: 'universal' },
      },
    ]));
  };

  const result = await restoreExtensionManifest({ extensionsDir, manifestPath });

  assert.deepEqual(result.failures, ['eamodio.gitlens']);
  const selectors = host.commands.map(({ arguments: args }) => String(args[0]));
  assert.deepEqual([...selectors].sort(), [
    'dbaeumer.vscode-eslint',
    'dbaeumer.vscode-eslint@3.0.34',
    'eamodio.gitlens@17.0.0',
    'redhat.vscode-yaml@1.24.0',
  ]);
  assert.ok(selectors.indexOf('dbaeumer.vscode-eslint@3.0.34') < selectors.indexOf('dbaeumer.vscode-eslint'));
  assert.equal(selectors.filter((selector) => selector.startsWith('eamodio.gitlens')).length, 1);
  assert.equal(host.warnings.length, 1);
  assert.match(host.warnings[0], /eamodio\.gitlens/);
  assert.equal(readFileSync(manifestPath, 'utf8'), original, 'restore never converts a transient failure into manifest deletion');
  assert.deepEqual(host.settingsUpdates, [
    { key: 'yaml.validate', value: true, target: 1 },
  ]);
});

test('REQ-IDE-038 AC2+AC3: restore warns before execution and never repeats an accepted warning', async () => {
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  const original = JSON.stringify(validManifest({
    'publisher.extension': { version: '1.0.0' },
  }));
  writeFileSync(manifestPath, original);
  writeRegistry(extensionsDir);
  host.acknowledgeSecurity = false;

  await restoreExtensionManifest({ extensionsDir, manifestPath, syncPidFile });

  assert.deepEqual(host.commands, []);
  assert.equal(readFileSync(manifestPath, 'utf8'), original);

  host.acknowledgeSecurity = true;
  let acknowledgedAtInstall = false;
  host.execute = async () => {
    acknowledgedAtInstall = JSON.parse(readFileSync(manifestPath, 'utf8')).securityWarningShown === true;
  };
  const result = await restoreExtensionManifest({ extensionsDir, manifestPath, syncPidFile });

  assert.deepEqual(result.failures, []);
  assert.equal(acknowledgedAtInstall, true);
  assert.deepEqual(host.commands.map(({ arguments: args }) => args[0]), ['publisher.extension@1.0.0']);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).securityWarningShown, true);

  const warningCount = host.warnings.length;
  await restoreExtensionManifest({ extensionsDir, manifestPath, syncPidFile });
  assert.equal(host.warnings.length, warningCount);
});

test('REQ-IDE-037 AC5: contributed settings restore after their missing extension registers', async () => {
  const { extensionsDir, manifestPath } = fixture();
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({ 'publisher.extension': { version: '1.0.0' } }, { 'fixture.enabled': true }),
    securityWarningShown: true,
  }));
  writeRegistry(extensionsDir);
  let registered = false;
  host.execute = async () => { registered = true; };
  host.updateSetting = async () => {
    if (!registered) throw new Error('configuration is not registered');
  };

  await restoreExtensionManifest({ extensionsDir, manifestPath });

  assert.deepEqual(host.settingsUpdates, [{ key: 'fixture.enabled', value: true, target: 1 }]);
});

test('REQ-IDE-037 AC2: restores at most two missing extensions concurrently', async () => {
  const { extensionsDir, manifestPath } = fixture();
  const ids = ['one.extension', 'two.extension', 'three.extension', 'four.extension'];
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest(Object.fromEntries(ids.map((id) => [id, { version: '1.0.0' }]))),
    securityWarningShown: true,
  }));
  writeRegistry(extensionsDir);
  let active = 0;
  let maximum = 0;
  let firstWaveReady!: () => void;
  const firstWave = new Promise<void>((resolve) => { firstWaveReady = resolve; });
  const releases: Array<() => void> = [];
  host.execute = async (_command, selector) => new Promise<void>((resolve) => {
    active += 1;
    maximum = Math.max(maximum, active);
    if (active === 2) firstWaveReady();
    releases.push(() => {
      const id = String(selector).split('@')[0];
      const current = JSON.parse(readFileSync(join(extensionsDir, 'extensions.json'), 'utf8'));
      writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([
        ...current,
        { identifier: { id }, version: '1.0.0', metadata: { targetPlatform: 'universal' } },
      ]));
      active -= 1;
      resolve();
    });
  });

  const restoring = restoreExtensionManifest({ extensionsDir, manifestPath });
  await firstWave;
  assert.equal(active, 2);
  for (let completed = 0; completed < ids.length; completed += 1) {
    while (releases.length === 0) await flushAsyncWork();
    const release = releases.shift();
    assert.ok(release);
    release();
    await flushMicrotasks();
    assert.ok(active <= 2);
  }
  const result = await restoring;

  assert.deepEqual(result.failures, []);
  assert.equal(maximum, 2);
  const installed = JSON.parse(readFileSync(join(extensionsDir, 'extensions.json'), 'utf8'));
  assert.deepEqual(installed.map((entry: { identifier: { id: string } }) => entry.identifier.id).sort(), [...ids].sort());
});

test('REQ-IDE-016 AC4 + REQ-IDE-036 AC4+AC5+AC6 + REQ-IDE-038 AC5: capture preserves intent, settings, and uninstall evidence', async () => {
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  writeRegistry(extensionsDir, [{ id: 'RedHat.VSCode-YAML', version: '1.24.0' }]);
  writeFileSync(syncPidFile, '4321\n');
  host.extensions = [{
    id: 'redhat.vscode-yaml',
    packageJSON: {
      contributes: {
        configuration: {
          properties: {
            'yaml.validate': { type: 'boolean' },
            'yaml.schemas': { type: 'object' },
            'extensions.allowed': { type: 'object' },
            'workbench.colorTheme': { type: 'string' },
            'yaml.array': { type: 'array' },
          },
        },
      },
    },
  }];
  host.inspected.set('yaml.validate', true);
  host.inspected.set('yaml.schemas', { 'https://example.invalid/schema.json': '*.yaml' });
  host.inspected.set('extensions.allowed', { '*': false });
  host.inspected.set('workbench.colorTheme', 'must-not-override');
  host.inspected.set('yaml.array', ['not', 'plain-object']);
  let manifestObservedAtSignal: unknown;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    manifestObservedAtSignal = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return true;
  });

  assert.equal(await captureExtensionManifest({ extensionsDir, manifestPath, syncPidFile }), true);
  const captured = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(captured.securityWarningShown, true);
  assert.deepEqual(captured.settings, {
    'yaml.schemas': { 'https://example.invalid/schema.json': '*.yaml' },
    'yaml.validate': true,
  });
  assert.deepEqual(Object.keys(captured.extensions), ['redhat.vscode-yaml']);
  assert.deepEqual(manifestObservedAtSignal, captured);
  assert.equal(host.warnings.length, 1);
  assert.equal(kill.mock.calls.length, 1);

  assert.equal(await captureExtensionManifest({ extensionsDir, manifestPath, syncPidFile }), false);
  assert.equal(host.warnings.length, 1);
  assert.equal(kill.mock.calls.length, 1, 'unchanged capture does not wake bisync');

  writeRegistry(extensionsDir);
  assert.equal(await captureExtensionManifest({ extensionsDir, manifestPath, syncPidFile }), false);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).extensions['redhat.vscode-yaml'].version, '1.24.0');

  writeFileSync(join(extensionsDir, '.obsolete'), JSON.stringify({
    'redhat.vscode-yaml-1.24.0-universal': true,
  }));
  assert.equal(await captureExtensionManifest({ extensionsDir, manifestPath, syncPidFile }), true);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).extensions, {});
  assert.equal(host.warnings.length, 1, 'durable acknowledgement survives complete removal');
  assert.equal(kill.mock.calls.length, 2);
});

test('REQ-IDE-036 AC6: obsolete evidence removes a stale registry entry without platform metadata', async () => {
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  writeRegistry(extensionsDir, [{ id: 'publisher.extension', version: '1.0.0', omitMetadata: true }]);
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({ 'publisher.extension': { version: '1.0.0', targetPlatform: 'universal' } }),
    securityWarningShown: true,
  }));
  writeFileSync(join(extensionsDir, '.obsolete'), JSON.stringify({
    'publisher.extension-1.0.0-universal': true,
  }));

  assert.equal(await captureExtensionManifest({ extensionsDir, manifestPath, syncPidFile }), true);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).extensions, {});
});

test('REQ-IDE-038 AC1+AC4: capture warns once before the first persisted user extension', async () => {
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  writeRegistry(extensionsDir, [{ id: 'publisher.extension', version: '1.0.0' }]);
  writeFileSync(syncPidFile, '2222\n');
  vi.spyOn(process, 'kill').mockImplementation(() => true);

  await captureExtensionManifest({ extensionsDir, manifestPath, syncPidFile });
  assert.equal(host.warnings.length, 1);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).securityWarningShown, true);

  host.warnings = [];
  await captureExtensionManifest({ extensionsDir, manifestPath, syncPidFile });
  assert.deepEqual(host.warnings, []);
});

test('REQ-IDE-038 AC6: fresh activations do not repeat an acknowledged warning', async () => {
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  writeRegistry(extensionsDir, [{ id: 'publisher.extension', version: '1.0.0' }]);
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({ 'publisher.extension': { version: '1.0.0' } }),
    securityWarningShown: true,
  }));

  for (let activation = 0; activation < 2; activation += 1) {
    const subscriptions: Array<{ dispose(): void }> = [];
    await activateExtensionPersistence(
      { subscriptions } as never,
      { extensionsDir, manifestPath, syncPidFile, debounceMs: 2_000 },
    );
    for (const subscription of subscriptions) subscription.dispose();
  }

  assert.deepEqual(host.warnings, []);
});

test('REQ-IDE-038 AC1: declining a scheduled warning does not prompt again during capture', async () => {
  vi.useFakeTimers();
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  writeRegistry(extensionsDir);
  host.acknowledgeSecurity = false;
  const subscriptions: Array<{ dispose(): void }> = [];

  const deactivate = await activateExtensionPersistence(
    { subscriptions } as never,
    { extensionsDir, manifestPath, syncPidFile, debounceMs: 2_000 },
  );
  const extensionChange = host.extensionChange;
  assert.ok(extensionChange);
  for (const subscription of subscriptions.splice(0)) subscription.dispose();
  writeRegistry(extensionsDir, [{ id: 'publisher.extension', version: '1.0.0' }]);
  extensionChange();

  await vi.advanceTimersByTimeAsync(2_000);
  await deactivate();
  assert.equal(host.warnings.length, 1);
});

test('REQ-IDE-036 AC6 + REQ-IDE-038 AC1: obsolete evidence bypasses warning preflight and removes stale intent', async () => {
  vi.useFakeTimers();
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  writeRegistry(extensionsDir);
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({}),
    securityWarningShown: true,
  }));
  const subscriptions: Array<{ dispose(): void }> = [];
  const deactivate = await activateExtensionPersistence(
    { subscriptions } as never,
    { extensionsDir, manifestPath, syncPidFile, debounceMs: 2_000 },
  );
  const extensionChange = host.extensionChange;
  assert.ok(extensionChange);
  for (const subscription of subscriptions.splice(0)) subscription.dispose();

  writeRegistry(extensionsDir, [{ id: 'publisher.extension', version: '1.0.0', omitMetadata: true }]);
  writeFileSync(manifestPath, JSON.stringify(
    validManifest({ 'publisher.extension': { version: '1.0.0', targetPlatform: 'universal' } }),
  ));
  writeFileSync(join(extensionsDir, '.obsolete'), JSON.stringify({
    'publisher.extension-1.0.0-universal': true,
  }));
  host.acknowledgeSecurity = false;
  host.warnings = [];
  extensionChange();

  await vi.advanceTimersByTimeAsync(2_000);
  await deactivate();
  assert.deepEqual(host.warnings, []);
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).extensions, {});
});

test('REQ-IDE-036 AC5: setting-only changes flush during deactivation and restore', async () => {
  vi.useFakeTimers();
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  writeRegistry(extensionsDir, [{ id: 'publisher.extension', version: '1.0.0' }]);
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({ 'publisher.extension': { version: '1.0.0' } }, { 'fixture.enabled': false }),
    securityWarningShown: true,
  }));
  host.extensions = [{
    id: 'publisher.extension',
    packageJSON: {
      contributes: {
        configuration: { properties: { 'fixture.enabled': { type: 'boolean' } } },
      },
    },
  }];
  host.inspected.set('fixture.enabled', false);
  const subscriptions: Array<{ dispose(): void }> = [];
  const deactivate = await activateExtensionPersistence(
    { subscriptions } as never,
    { extensionsDir, manifestPath, syncPidFile, debounceMs: 2_000 },
  );
  const configurationChange = host.configurationChange;
  assert.ok(configurationChange);

  host.inspected.set('fixture.enabled', true);
  configurationChange({ affectsConfiguration: (key) => key === 'fixture.enabled' });
  await deactivate();
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).settings['fixture.enabled'], true);

  host.inspected.clear();
  host.settingsUpdates = [];
  await restoreExtensionManifest({ extensionsDir, manifestPath, syncPidFile });
  assert.deepEqual(host.settingsUpdates, [{ key: 'fixture.enabled', value: true, target: 1 }]);
  for (const subscription of subscriptions) subscription.dispose();
});

test('REQ-IDE-016 AC4: extension-host changes debounce one capture', async () => {
  vi.useFakeTimers();
  const { extensionsDir, manifestPath, syncPidFile } = fixture();
  writeRegistry(extensionsDir);
  writeFileSync(manifestPath, JSON.stringify({
    ...validManifest({}),
    securityWarningShown: true,
  }));
  writeFileSync(syncPidFile, '3333\n');
  let captureSignaled!: () => void;
  const captureSignal = new Promise<void>((resolve) => { captureSignaled = resolve; });
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    captureSignaled();
    return true;
  });
  const subscriptions: Array<{ dispose(): void }> = [];

  await activateExtensionPersistence(
    { subscriptions } as never,
    { extensionsDir, manifestPath, syncPidFile, debounceMs: 2_000 },
  );
  kill.mockClear();
  const extensionChange = host.extensionChange;
  assert.ok(extensionChange);
  for (const subscription of subscriptions.splice(0)) subscription.dispose();
  writeRegistry(extensionsDir, [{ id: 'publisher.extension', version: '1.0.0' }]);
  extensionChange();
  extensionChange();

  await vi.advanceTimersByTimeAsync(1_999);
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).extensions['publisher.extension'], undefined);
  await vi.advanceTimersByTimeAsync(1);
  await captureSignal;
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).extensions['publisher.extension'].version, '1.0.0');
  assert.equal(kill.mock.calls.length, 1);
});
