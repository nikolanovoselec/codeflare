import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = '/opt/codeflare/openvscode';
const CODE_SERVER_ROOT = '/opt/code-server';
const EXTENSION_NAME = 'codeflare-agent-sidebar';

async function main() {
  const codeServerRuntime = await verifyCodeServerRuntime();
  const inventoriesRoot = join(ROOT, 'extensions');
  assert.deepEqual((await readdir(inventoriesRoot)).sort(), ['claude', 'none', 'pi']);
  assert.deepEqual(await readdir(join(inventoriesRoot, 'none')), []);

  const officialPinPath = join(ROOT, 'official-claude.json');
  const officialPin = JSON.parse(await readFile(officialPinPath, 'utf8'));
  assert.equal((await stat(officialPinPath)).uid, 0);
  assert.equal((await stat(officialPinPath)).mode & 0o222, 0);
  const piInventory = join(inventoriesRoot, 'pi');
  const claudeInventory = join(inventoriesRoot, 'claude');
  assert.deepEqual(await readdir(piInventory), [EXTENSION_NAME]);
  assert.deepEqual(await readdir(claudeInventory), ['anthropic.claude-code']);
  const piRoot = join(piInventory, EXTENSION_NAME);
  const claudeRoot = join(claudeInventory, 'anthropic.claude-code');
  const piManifest = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8'));
  assert.equal(piManifest.name, EXTENSION_NAME);
  assert.equal(piManifest.publisher, 'codeflare');
  assert.equal(piManifest.version, '0.0.0');
  assert.equal(piManifest.main, './dist/extension.cjs');
  assert.equal(piManifest.engines.vscode, '^1.109.0');
  assertExtensionApiFloor(piManifest, codeServerRuntime.codeVersion);
  assert.deepEqual(piManifest.extensionKind, ['workspace']);
  assert.equal(piManifest.capabilities.untrustedWorkspaces.supported, false);
  await assertImmutable(piRoot);
  await assertImmutable(claudeRoot);

  const piMain = join(piRoot, 'dist', 'extension.cjs');
  const extensionHash = createHash('sha256').update(await readFile(piMain)).digest('hex');
  assert.equal((await collect(ROOT)).some((path) => path.toLowerCase().endsWith('.vsix')), false);
  const nativeChat = await verifyPackagedNativeChat(piRoot);
  const officialClaude = verifyOfficialClaudeExtension(claudeRoot, officialPin);

  const managedModule = await import(pathToFileURL(join(ROOT, 'claude', 'managed-settings.mjs')).href);
  const managedSettings = managedModule.buildManagedSettings();
  const optSettings = JSON.parse(await readFile(join(ROOT, 'claude', 'sidebar-settings.json'), 'utf8'));
  const etcSettings = JSON.parse(await readFile('/etc/codeflare/claude-sidebar/settings.json', 'utf8'));
  assert.deepEqual(optSettings, managedSettings);
  assert.deepEqual(etcSettings, managedSettings);
  assert.equal(managedSettings.permissions.defaultMode, 'bypassPermissions');
  assert.equal(managedSettings.disableRemoteControl, true);

  await verifyConfigProjection();
  await verifyOpenVscodeSettings();
  await verifyUiStateHelper();
  const claudeVersion = execFileSync('/usr/local/bin/claude', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
  const piVersion = execFileSync('/usr/local/bin/pi', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();

  process.stdout.write(`${JSON.stringify({
    result: 'SIDEBAR_IMAGE_SMOKE_OK',
    extensionHash,
    nativeChat,
    officialClaude,
    codeServerRuntime,
    claudeVersion,
    piVersion,
  })}\n`);
}

function assertExtensionApiFloor(manifest, codeVersion) {
  const comparableMinor = (version) => {
    const match = String(version).match(/^[^\d]*(\d+)\.(\d+)/);
    assert.ok(match, `invalid VS Code API version: ${version}`);
    return Number(match[1]) * 10_000 + Number(match[2]);
  };
  const hostMinor = comparableMinor(codeVersion);
  assert.ok(
    hostMinor >= comparableMinor(manifest.engines.vscode),
    'embedded Code must satisfy the extension engines.vscode floor',
  );
  assert.ok(
    hostMinor >= comparableMinor(manifest.devDependencies['@types/vscode']),
    'embedded Code must provide every API exposed by @types/vscode',
  );
}

async function verifyCodeServerRuntime() {
  const expected = JSON.parse(await readFile(join(CODE_SERVER_ROOT, 'codeflare-provenance.json'), 'utf8'));
  const runtimePackage = JSON.parse(await readFile(join(CODE_SERVER_ROOT, 'package.json'), 'utf8'));
  const codePackage = JSON.parse(await readFile(join(CODE_SERVER_ROOT, 'lib', 'vscode', 'package.json'), 'utf8'));
  const product = JSON.parse(await readFile(join(CODE_SERVER_ROOT, 'lib', 'vscode', 'product.json'), 'utf8'));
  assert.match(expected.codeServerVersion, /^\d+\.\d+\.\d+$/);
  assert.match(expected.codeVersion, /^\d+\.\d+\.\d+$/);
  assert.match(expected.codeServerCommit, /^[0-9a-f]{40}$/);
  assert.match(expected.vscodeCommit, /^[0-9a-f]{40}$/);
  assert.equal(runtimePackage.version, expected.codeServerVersion);
  assert.equal(runtimePackage.commit, expected.codeServerCommit);
  assert.equal(codePackage.version, expected.codeVersion);
  assert.equal(product.codeServerVersion, expected.codeServerVersion);
  assert.equal(product.commit, expected.codeServerCommit);
  assert.equal(await readlink('/usr/local/bin/code-server'), '/opt/code-server/bin/code-server');
  await assert.rejects(lstat('/usr/local/bin/openvscode-server'), { code: 'ENOENT' });
  await assert.rejects(lstat('/opt/openvscode-server'), { code: 'ENOENT' });
  await assert.rejects(
    lstat(join(CODE_SERVER_ROOT, 'lib', 'vscode', 'extensions', 'copilot')),
    { code: 'ENOENT' },
    'the Browser IDE image must not retain code-server\'s bundled GitHub Copilot extension',
  );

  const versionOutput = execFileSync('/usr/local/bin/code-server', ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();
  assert.match(versionOutput, new RegExp(expected.codeServerVersion.replaceAll('.', '\\.')));
  assert.match(versionOutput, new RegExp(expected.codeVersion.replaceAll('.', '\\.')));
  assert.match(versionOutput, new RegExp(expected.codeServerCommit));
  return { ...expected, versionOutput };
}

async function verifyPackagedNativeChat(extensionRoot) {
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.enabledApiProposals, ['chatProvider', 'defaultChatParticipant']);
  assert.equal(manifest.displayName, 'Codeflare');
  assert.deepEqual(manifest.activationEvents, [
    'onStartupFinished',
    'onChatParticipant:codeflare.pi',
    'onCommand:codeflare.pi.reviewFile',
  ]);
  assert.deepEqual(manifest.contributes?.languageModelChatProviders, [{
    vendor: 'copilot',
    displayName: 'Codeflare',
  }]);
  const [participant] = manifest.contributes?.chatParticipants ?? [];
  assert.equal(participant?.id, 'codeflare.pi');
  assert.equal(participant?.name, 'codeflare');
  assert.equal(participant?.fullName, 'Codeflare');
  assert.equal(participant?.isDefault, true);
  assert.equal(participant?.isSticky, true);
  assert.deepEqual(participant?.modes, ['ask', 'edit', 'agent']);
  assert.deepEqual(manifest.contributes?.menus?.['editor/context'], [{
    command: 'codeflare.pi.reviewFile',
    group: '1_chat@6',
    when: "resourceScheme == 'file'",
  }]);
  assert.equal(manifest.contributes?.views, undefined);

  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const originalLoad = Module._load;
  let activeEditorUri;
  let executedCommand;
  const contextValues = new Map();
  let handler;
  let hostModelProvider;
  let reviewFile;
  const disposable = () => ({ dispose() {} });
  const uri = (path) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` });
  const vscode = new Proxy({
    Uri: {
      file: (path) => uri(path),
      joinPath: (base, ...parts) => uri(join(base.fsPath ?? base.path, ...parts)),
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    chat: {
      createChatParticipant: (id, candidate) => {
        assert.equal(id, 'codeflare.pi');
        handler = candidate;
        return disposable();
      },
    },
    commands: {
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') {
          contextValues.set(String(args[0]), args[1]);
          return;
        }
        executedCommand = { id, options: args[0] };
      },
      registerCommand: (id, candidate) => {
        assert.equal(id, 'codeflare.pi.reviewFile');
        reviewFile = candidate;
        return disposable();
      },
    },
    languages: { getDiagnostics: () => [] },
    lm: {
      registerLanguageModelChatProvider: (vendor, provider) => {
        assert.equal(vendor, 'copilot');
        hostModelProvider = provider;
        return disposable();
      },
    },
    window: {
      get activeTextEditor() {
        return activeEditorUri ? { document: { uri: activeEditorUri } } : undefined;
      },
      showWarningMessage: async () => undefined,
      showTextDocument: async () => undefined,
    },
    workspace: {
      getWorkspaceFolder: (resource) => resource.fsPath.startsWith('/home/user/workspace/') ? {} : undefined,
      textDocuments: [],
      openTextDocument: async () => ({}),
    },
  }, {
    get(target, property, receiver) {
      assert.notEqual(property, 'authentication');
      return Reflect.get(target, property, receiver);
    },
  });
  let extension;
  const reviewPath = '/home/user/workspace/codeflare-review-smoke.ts';
  await mkdir('/home/user/workspace', { recursive: true });
  await writeFile(reviewPath, 'export const reviewSmoke = true;\n');

  try {
    Module._load = function load(request, parent, isMain) {
      if (request === 'vscode') return vscode;
      return originalLoad.call(this, request, parent, isMain);
    };
    extension = require(join(extensionRoot, String(manifest.main).replace(/^\.\//, '')));
    const subscriptions = [];
    extension.activate({ extensionUri: uri(extensionRoot), subscriptions });
    assert.equal(typeof handler, 'function', 'packaged extension did not register native Pi Chat');
    assert.equal(contextValues.get('chatSetupCompleted'), true, 'packaged Pi inventory did not suppress Code OSS account setup actions');
    assert.equal(typeof hostModelProvider, 'object', 'packaged extension did not register its host compatibility model');
    const models = await hostModelProvider.provideLanguageModelChatInformation({}, {});
    assert.equal(models.length, 1);
    assert.equal(models[0].name, 'Codeflare');
    assert.deepEqual(models[0].isDefault, { 1: true });
    assert.equal(models[0].isUserSelectable, false);
    assert.equal(models[0].requiresAuthorization, undefined);
    await assert.rejects(
      hostModelProvider.provideLanguageModelChatResponse(),
      /compatibility.*cannot generate|cannot generate.*compatibility/i,
    );
    assert.equal(await hostModelProvider.provideTokenCount(), 0);
    assert.equal(typeof reviewFile, 'function', 'packaged extension did not register file review');
    const reviewResource = uri(reviewPath);
    activeEditorUri = reviewResource;
    await reviewFile();
    assert.equal(executedCommand?.id, 'workbench.action.chat.open');
    assert.deepEqual(executedCommand?.options.attachFiles.map((file) => file.fsPath), [reviewResource.fsPath]);
    assert.match(executedCommand?.options.query, /^@codeflare\b/);
    assert.equal(executedCommand?.options.mode, 'ask');
    await handler(
      { prompt: 'cancelled smoke', references: [] },
      { history: [] },
      { markdown: () => assert.fail('cancelled request emitted markdown'), progress: () => assert.fail('cancelled request emitted progress') },
      { isCancellationRequested: true, onCancellationRequested: () => disposable() },
    );
    return 'DEFAULT_NATIVE_PI_OK';
  } finally {
    await extension?.deactivate?.();
    Module._load = originalLoad;
    await rm(reviewPath, { force: true });
  }
}

function verifyOfficialClaudeExtension(extensionRoot, pin) {
  const manifest = JSON.parse(execFileSync('/usr/local/bin/node', [
    '-e',
    'const p=require(process.argv[1]); process.stdout.write(JSON.stringify(p))',
    join(extensionRoot, 'package.json'),
  ], { encoding: 'utf8', timeout: 10_000 }));
  assert.equal(pin.targetPlatform, 'linux-x64');
  assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.name, pin.name);
  assert.equal(manifest.publisher, pin.namespace);
  assert.equal(manifest.version, pin.version);
  assert.equal(manifest.main, pin.main);
  assert.equal(manifest.engines.vscode, pin.vscodeEngine);
  assert.match(manifest.license, /Anthropic PBC.*All rights reserved/i);
  const bundledVersion = execFileSync(join(extensionRoot, 'resources', 'native-binary', 'claude'), ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    },
  }).trim();
  assert.match(bundledVersion, new RegExp(pin.version.replaceAll('.', '\\.')));
  return { result: 'OFFICIAL_CLAUDE_OK', version: manifest.version, bundledVersion, archiveSha256: pin.sha256 };
}

async function verifyConfigProjection() {
  const root = await mkdtemp(join(tmpdir(), 'sidebar-image-smoke-'));
  try {
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, '.credentials.json'), 'image-smoke-secret-canary\n', { mode: 0o600 });
    await writeFile(join(sourceRoot, 'history.jsonl'), 'terminal-history-must-not-project\n');
    const module = await import(pathToFileURL(join(ROOT, 'claude', 'prepare-sidebar-config.mjs')).href);
    await module.prepareSidebarConfig({ sourceRoot, targetRoot });
    assert.equal((await lstat(join(targetRoot, '.credentials.json'))).isSymbolicLink(), true);
    assert.equal(await readlink(join(targetRoot, '.credentials.json')), join(sourceRoot, '.credentials.json'));
    await assert.rejects(lstat(join(targetRoot, 'history.jsonl')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(join(targetRoot, '.codeflare-projection.json'), 'utf8')).version, 1);
    assert.equal((await stat(targetRoot)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyOpenVscodeSettings() {
  const root = await mkdtemp(join(tmpdir(), 'claude-vscode-settings-smoke-'));
  try {
    const serverDataRoot = join(root, 'openvscode-data');
    const claudeConfigRoot = join(root, 'claude-config');
    const preparation = await import(pathToFileURL(join(ROOT, 'claude', 'prepare-sidebar-config.mjs')).href);
    const managed = await import(pathToFileURL(join(ROOT, 'claude', 'managed-settings.mjs')).href);
    await preparation.prepareOpenVscodeSettings({ serverDataRoot, claudeConfigRoot });
    const settings = JSON.parse(await readFile(join(serverDataRoot, 'data', 'User', 'settings.json'), 'utf8'));
    assert.deepEqual(settings, managed.buildOpenVscodeSettings(claudeConfigRoot));
    assert.equal(settings['chat.disableAIFeatures'], true);

    const unsupportedDataRoot = join(root, 'unsupported-data');
    await preparation.prepareUnsupportedOpenVscodeSettings(unsupportedDataRoot);
    const unsupportedSettings = JSON.parse(await readFile(join(unsupportedDataRoot, 'data', 'User', 'settings.json'), 'utf8'));
    assert.deepEqual(unsupportedSettings, managed.buildUnsupportedOpenVscodeSettings());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyUiStateHelper() {
  const helper = join(ROOT, 'browser-ide-ui-state.py');
  const helperInfo = await stat(helper);
  assert.equal(helperInfo.uid, 0);
  assert.equal(helperInfo.mode & 0o222, 0);
  assert.equal(helperInfo.mode & 0o111, 0o111);

  const root = await mkdtemp(join(tmpdir(), 'ide-ui-state-image-smoke-'));
  try {
    const workspace = join(root, 'workspace');
    const live = join(root, 'live');
    const restored = join(root, 'restored');
    const snapshot = join(root, 'persistent', 'ide-ui-state.json');
    await mkdir(join(live, 'data', 'User'), { recursive: true });
    await mkdir(workspace);
    await writeFile(join(live, 'data', 'User', 'settings.json'), JSON.stringify({
      'workbench.colorTheme': 'Default Dark Modern',
      'github.copilot.token': 'must-not-persist',
    }));
    execFileSync('python3', [helper, 'capture', '--data-root', live, '--snapshot', snapshot, '--workspace', workspace]);
    execFileSync('python3', [helper, 'restore', '--data-root', restored, '--snapshot', snapshot, '--workspace', workspace]);
    const restoredSettings = JSON.parse(await readFile(join(restored, 'data', 'User', 'settings.json'), 'utf8'));
    assert.deepEqual(restoredSettings, { 'workbench.colorTheme': 'Default Dark Modern' });
    assert.doesNotMatch(await readFile(snapshot, 'utf8'), /copilot|must-not-persist/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function assertImmutable(root) {
  for (const path of await collect(root)) {
    const info = await lstat(path);
    assert.equal(info.uid, 0, `${path} is not root-owned`);
    assert.equal(info.mode & 0o222, 0, `${path} is writable`);
  }
}

async function collect(root, output = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    output.push(path);
    if (entry.isDirectory()) await collect(path, output);
  }
  return output;
}

main().catch((error) => {
  process.stderr.write(`SIDEBAR_IMAGE_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
