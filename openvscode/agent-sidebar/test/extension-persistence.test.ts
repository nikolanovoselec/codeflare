import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  restoreExtensionManifest,
} from '../src/extension-persistence.ts';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codeflare-extension-persistence-'));
  roots.push(root);
  const extensionsDir = join(root, 'extensions');
  const manifestPath = join(root, '.codeflare', 'ide-extensions.json');
  const syncPidFile = join(root, 'sync-daemon.pid');
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(join(manifestPath, '..'), { recursive: true });
  return { root, extensionsDir, manifestPath, syncPidFile };
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
  host.warnings = [];
  host.progressTitles = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.CODEFLARE_OPENVSCODE_EXTENSIONS_DIR;
  delete process.env.CODEFLARE_IDE_EXTENSIONS_MANIFEST;
  delete process.env.CODEFLARE_SYNC_DAEMON_PIDFILE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
