import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
const WELCOME_EXTENSION_NAME = 'codeflare-welcome';
const NPM_TOOLS_NODE_MODULES = '/opt/codeflare/npm-tools/node_modules';
const AGENT_PACKAGE_FAMILIES = Object.freeze([
  Object.freeze({ agent: 'claude-code', directory: '@anthropic-ai', prefix: 'claude-code', keep: Object.freeze(['claude-code', 'claude-code-linux-x64']) }),
  Object.freeze({ agent: 'codex', directory: '@openai', prefix: 'codex', keep: Object.freeze(['codex', 'codex-linux-x64']) }),
  Object.freeze({ agent: 'copilot', directory: '@github', prefix: 'copilot', keep: Object.freeze(['copilot', 'copilot-linux-x64']) }),
  Object.freeze({ agent: 'opencode', directory: '', prefix: 'opencode-', keep: Object.freeze(['opencode-ai', 'opencode-linux-x64']) }),
]);

export class VscodeEventEmitter {
  #listeners = new Set();

  event = (listener) => {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  };

  fire(value) {
    for (const listener of this.#listeners) listener(value);
  }

  dispose() {
    this.#listeners.clear();
  }
}

export function createVscodeSmokeApi(api) {
  return new Proxy({ EventEmitter: VscodeEventEmitter, ...api }, {
    get(target, property, receiver) {
      assert.notEqual(property, 'authentication');
      return Reflect.get(target, property, receiver);
    },
  });
}

export async function activateExtensionWithVscode(extensionMain, vscode, context, moduleOverrides = {}) {
  const require = createRequire(import.meta.url);
  const Module = require('node:module');
  const originalLoad = Module._load;
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === 'vscode') return vscode;
      if (Object.hasOwn(moduleOverrides, request)) return moduleOverrides[request];
      return originalLoad.call(this, request, parent, isMain);
    };
    const extension = require(extensionMain);
    await extension.activate(context);
    return extension;
  } finally {
    Module._load = originalLoad;
  }
}

export async function verifySelectedAgentLaunchers(
  selection,
  { commands, hasCodingAgent, inspectPath = lstat, run = execFileSync },
) {
  const versions = {};
  for (const [agent, command] of Object.entries(commands)) {
    if (hasCodingAgent(selection, agent)) {
      await inspectPath(command.path);
      versions[agent] = run(command.path, command.args, { encoding: 'utf8', timeout: 10_000 }).trim();
    } else {
      await assert.rejects(inspectPath(command.path), (error) => error?.code === 'ENOENT');
      versions[agent] = null;
    }
  }
  return versions;
}

export async function verifySelectedAgentPackages(
  selection,
  {
    hasCodingAgent,
    nodeModulesPath = NPM_TOOLS_NODE_MODULES,
    readDirectory = readdir,
  },
) {
  const inventories = {};
  for (const family of AGENT_PACKAGE_FAMILIES) {
    let entries;
    try {
      entries = await readDirectory(join(nodeModulesPath, family.directory));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      entries = [];
    }
    const actual = entries.filter((name) => name.startsWith(family.prefix)).sort();
    const expected = hasCodingAgent(selection, family.agent) ? [...family.keep].sort() : [];
    assert.deepEqual(actual, expected, `${family.agent} package inventory must contain only canonical Linux x64 payloads`);
    inventories[family.agent] = actual;
  }
  return inventories;
}

export async function verifyUnsupportedInventory(inventory) {
  const entries = await readdir(inventory, { withFileTypes: true });
  assert.deepEqual(
    entries
      .filter((entry) => entry.name !== 'extensions.json' || !entry.isFile())
      .map((entry) => entry.name),
    [],
  );
  if (entries.some((entry) => entry.name === 'extensions.json')) {
    assert.deepEqual(JSON.parse(await readFile(join(inventory, 'extensions.json'), 'utf8')), []);
  }
}

async function waitForUnsupportedInventoryInitialization(inventory) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await readdir(inventory)).includes('extensions.json')) {
        await verifyUnsupportedInventory(inventory);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('code-server did not initialize the unsupported inventory');
}

async function main() {
  const codeServerRuntime = await verifyCodeServerRuntime();
  const welcomeRoot = join(CODE_SERVER_ROOT, 'lib', 'vscode', 'extensions', WELCOME_EXTENSION_NAME);
  const welcomeManifest = JSON.parse(await readFile(join(welcomeRoot, 'package.json'), 'utf8'));
  assert.equal(welcomeManifest.name, WELCOME_EXTENSION_NAME);
  assert.equal(welcomeManifest.publisher, 'codeflare');
  assert.equal(welcomeManifest.main, './dist/welcome-extension.cjs');
  assert.deepEqual(welcomeManifest.activationEvents, [
    'onStartupFinished',
    'onCommand:codeflare.welcome.open',
  ]);
  assert.equal(welcomeManifest.contributes.chatParticipants, undefined);
  assert.equal(welcomeManifest.contributes.languageModelChatProviders, undefined);
  await assertImmutable(welcomeRoot);
  const inventoriesRoot = join(ROOT, 'extensions');
  const unsupportedInventory = join(inventoriesRoot, 'none');
  assert.deepEqual((await readdir(inventoriesRoot)).sort(), ['claude', 'none', 'pi']);
  assert.deepEqual(await readdir(unsupportedInventory), []);

  await verifyCodeServerWorkspaceProjection();
  // code-server may initialize its extensions-dir with registry metadata. The
  // unsupported inventory must still contain no extension or unknown entry.
  await verifyUnsupportedInventory(unsupportedInventory);

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
  const { CODING_AGENT_COMMANDS, hasCodingAgent } = await import('file:///opt/codeflare/scripts/coding-agent-selection.mjs');
  const selection = process.env.CODEFLARE_CODING_AGENTS;
  const agentPackages = await verifySelectedAgentPackages(selection, { hasCodingAgent });
  const agentVersions = await verifySelectedAgentLaunchers(selection, {
    commands: CODING_AGENT_COMMANDS,
    hasCodingAgent,
  });
  const claudeVersion = agentVersions['claude-code'];
  const piVersion = agentVersions.pi;

  process.stdout.write(`${JSON.stringify({
    result: 'SIDEBAR_IMAGE_SMOKE_OK',
    extensionHash,
    nativeChat,
    officialClaude,
    welcomeExtension: WELCOME_EXTENSION_NAME,
    codeServerRuntime,
    agentPackages,
    agentVersions,
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

async function verifyCodeServerWorkspaceProjection() {
  const root = await mkdtemp(join(tmpdir(), 'code-server-workspace-smoke-'));
  await mkdir('/home/user/workspace', { recursive: true });
  const port = 18_000 + (process.pid % 1_000);
  const child = spawn('/usr/local/bin/code-server', [
    '--bind-addr', `127.0.0.1:${port}`,
    '--auth', 'none',
    '--disable-telemetry',
    '--disable-update-check',
    '--disable-proxy',
    '--disable-getting-started-override',
    '--disable-workspace-trust',
    '--user-data-dir', join(root, 'data'),
    '--extensions-dir', join(ROOT, 'extensions', 'none'),
    '/home/user/workspace',
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 8_192) stderr += String(chunk).slice(0, 8_192 - stderr.length);
  });
  try {
    let response;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        response = await fetch(`http://127.0.0.1:${port}/?folder=%2Fhome%2Fuser%2Fworkspace`, {
          redirect: 'manual',
        });
        if (response.status === 200) break;
        await response.body?.cancel();
      } catch {
        // The pinned server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(response?.status, 200, `packaged code-server root unavailable: ${stderr}`);
    const html = await response.text();
    const { projectVscodeWorkbenchWorkspace } = await import(
      pathToFileURL('/app/host/dist/vscode-proxy.js').href
    );
    const projected = projectVscodeWorkbenchWorkspace(html);
    assert.ok(projected, 'packaged Code OSS workbench configuration shape is incompatible');
    const matches = [...projected.matchAll(/id="vscode-workbench-web-configuration" data-settings="([^"]+)"/g)];
    assert.equal(matches.length, 1);
    const config = JSON.parse(matches[0][1].replaceAll('&quot;', '"'));
    assert.deepEqual(config.folderUri, {
      scheme: 'vscode-remote',
      authority: config.remoteAuthority,
      path: '/home/user/workspace',
    });
    await waitForUnsupportedInventoryInitialization(join(ROOT, 'extensions', 'none'));
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    await rm(root, { recursive: true, force: true });
  }
}

function createInlineEditRpcChild() {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new EventEmitter();
  let closed = false;
  stdin.destroyed = false;
  stdin.write = (line, _encoding, callback) => {
    const envelope = JSON.parse(line);
    assert.equal(envelope.type, 'prompt');
    callback?.();
    queueMicrotask(() => {
      const events = [{ id: envelope.id, type: 'response', command: 'prompt', success: true }];
      if (String(envelope.message).startsWith('/codeflare-inline-edit ')) {
        const encoded = String(envelope.message).split(/\s+/, 2)[1] ?? '';
        const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        events.push({
          type: 'tool_execution_start',
          toolName: 'codeflare_submit_inline_edits',
          args: {
            requestId: payload.requestId,
            edits: [{
              startLine: 0,
              startCharacter: 0,
              endLine: 0,
              endCharacter: 19,
              newText: 'const packaged = 42;',
            }],
          },
        });
      } else {
        events.push({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'packaged panel response' },
        });
      }
      events.push({ type: 'agent_settled' });
      stdout.emit('data', Buffer.from(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`));
    });
    return true;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = () => {
    if (!closed) {
      closed = true;
      stdin.destroyed = true;
      queueMicrotask(() => child.emit('close', 0, null));
    }
    return true;
  };
  queueMicrotask(() => child.emit('spawn'));
  return child;
}

async function verifyPackagedNativeChat(extensionRoot) {
  const manifest = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.enabledApiProposals, [
    'chatParticipantAdditions',
    'chatParticipantPrivate',
    'chatProvider',
    'defaultChatParticipant',
  ]);
  assert.equal(manifest.displayName, 'Codeflare');
  assert.deepEqual(manifest.activationEvents, [
    '*',
    'onChatParticipant:codeflare.pi',
    'onCommand:codeflare.pi.reviewFile',
  ]);
  assert.deepEqual(manifest.contributes?.languageModelChatProviders, [
    {
      vendor: 'copilot',
      displayName: 'Codeflare',
    },
    {
      vendor: 'codeflare',
      displayName: 'Codeflare',
    },
  ]);
  const [participant] = manifest.contributes?.chatParticipants ?? [];
  assert.equal(participant?.id, 'codeflare.pi');
  assert.equal(participant?.name, 'codeflare');
  assert.equal(participant?.fullName, 'Codeflare');
  assert.equal(participant?.isDefault, true);
  assert.equal(participant?.isSticky, true);
  assert.deepEqual(participant?.locations, ['panel', 'editor']);
  assert.deepEqual(participant?.modes, ['ask', 'edit', 'agent']);
  assert.deepEqual(manifest.contributes?.menus?.['editor/context'], [{
    command: 'codeflare.pi.reviewFile',
    group: '1_chat@6',
    when: "resourceScheme == 'file'",
  }]);
  assert.equal(manifest.contributes?.views, undefined);

  let activeEditorUri;
  let activeEditorDocument;
  let executedCommand;
  const contextValues = new Map();
  let handler;
  const hostModelProviders = new Map();
  let reviewFile;
  const disposable = () => ({ dispose() {} });
  const uri = (path) => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` });
  const vscode = createVscodeSmokeApi({
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
        assert.ok(vendor === 'copilot' || vendor === 'codeflare');
        assert.equal(hostModelProviders.has(vendor), false);
        hostModelProviders.set(vendor, provider);
        return disposable();
      },
    },
    Range: class Range {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    TextEdit: {
      replace: (range, newText) => ({ range, newText }),
    },
    window: {
      get activeTextEditor() {
        return activeEditorDocument ?? (activeEditorUri ? { document: { uri: activeEditorUri } } : undefined);
      },
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showTextDocument: async () => undefined,
    },
    workspace: {
      getWorkspaceFolder: (resource) => resource.fsPath.startsWith('/home/user/workspace/') ? {} : undefined,
      textDocuments: [],
      openTextDocument: async () => ({}),
    },
  });
  let extension;
  const reviewPath = '/home/user/workspace/codeflare-review-smoke.ts';
  await mkdir('/home/user/workspace', { recursive: true });
  await writeFile(reviewPath, 'export const reviewSmoke = true;\n');

  try {
    const subscriptions = [];
    const actualChildProcess = createRequire(import.meta.url)('node:child_process');
    const spawnedRpcChildren = [];
    extension = await activateExtensionWithVscode(
      join(extensionRoot, String(manifest.main).replace(/^\.\//, '')),
      vscode,
      { extensionUri: uri(extensionRoot), subscriptions },
      {
        'node:child_process': {
          ...actualChildProcess,
          spawn: (executable, args, options) => {
            assert.equal(executable, '/usr/local/bin/pi');
            assert.deepEqual(args, ['--mode', 'rpc', '--no-session', '--no-themes']);
            assert.equal(options?.cwd, '/home/user/workspace');
            const child = createInlineEditRpcChild();
            spawnedRpcChildren.push(child);
            return child;
          },
        },
      },
    );
    assert.equal(typeof handler, 'function', 'packaged extension did not register native Pi Chat');
    assert.equal(contextValues.get('chatSetupHidden'), true, 'packaged Pi inventory did not suppress Code OSS Copilot setup chrome');
    assert.equal(contextValues.get('chatSetupCompleted'), true, 'packaged Pi inventory did not suppress Code OSS account setup actions');
    assert.deepEqual([...hostModelProviders.keys()], ['copilot', 'codeflare'], 'packaged extension did not register both host adapters');
    const fallbackProvider = hostModelProviders.get('copilot');
    const visibleProvider = hostModelProviders.get('codeflare');
    const fallbackModels = await fallbackProvider.provideLanguageModelChatInformation({}, {});
    assert.equal(fallbackModels.length, 1);
    assert.equal(fallbackModels[0].id, 'host-compatibility');
    assert.equal(fallbackModels[0].name, 'Codeflare');
    assert.deepEqual(fallbackModels[0].isDefault, { 1: true });
    assert.equal(fallbackModels[0].isUserSelectable, false);
    assert.deepEqual(fallbackModels[0].capabilities, {});
    assert.equal(fallbackModels[0].requiresAuthorization, undefined);
    const visibleModels = await visibleProvider.provideLanguageModelChatInformation({}, {});
    assert.equal(visibleModels.length, 1);
    assert.equal(visibleModels[0].id, 'host-visible');
    assert.equal(visibleModels[0].name, 'Codeflare');
    assert.deepEqual(visibleModels[0].isDefault, { 1: true, 4: true });
    assert.equal(visibleModels[0].isUserSelectable, true);
    assert.deepEqual(visibleModels[0].capabilities, { toolCalling: true });
    assert.equal(visibleModels[0].requiresAuthorization, undefined);
    for (const provider of [fallbackProvider, visibleProvider]) {
      await assert.rejects(
        provider.provideLanguageModelChatResponse(),
        /compatibility.*cannot generate|cannot generate.*compatibility/i,
      );
      assert.equal(await provider.provideTokenCount(), 0);
    }
    assert.equal(typeof reviewFile, 'function', 'packaged extension did not register file review');
    const reviewResource = uri(reviewPath);
    activeEditorUri = reviewResource;
    await reviewFile();
    assert.equal(executedCommand?.id, 'workbench.action.chat.open');
    assert.deepEqual(executedCommand?.options.attachFiles.map((file) => file.fsPath), [reviewResource.fsPath]);
    assert.match(executedCommand?.options.query, /^@codeflare\b/);
    assert.equal(executedCommand?.options.mode, 'ask');
    const source = 'const packaged = 0;\n';
    activeEditorDocument = {
      document: {
        uri: reviewResource,
        isClosed: false,
        isDirty: false,
        version: 1,
        languageId: 'typescript',
        lineCount: 2,
        getText: () => source,
        lineAt: (line) => ({ text: line === 0 ? source.trimEnd() : '' }),
      },
      selection: {
        isEmpty: true,
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    };
    const rendered = [];
    await handler(
      { location: 4, prompt: 'replace packaged value', references: [] },
      { history: [] },
      {
        markdown: () => assert.fail('inline request emitted hidden markdown'),
        progress: () => undefined,
        textEdit: (target, edits) => rendered.push({ target, edits }),
      },
      { isCancellationRequested: false, onCancellationRequested: () => disposable() },
    );
    assert.equal(spawnedRpcChildren.length, 1, 'packaged inline request did not use one IDE Pi process');
    assert.equal(rendered.length, 2);
    assert.equal(rendered[0]?.target, reviewResource);
    assert.deepEqual(rendered[0]?.edits.map((edit) => ({
      start: edit.range.start,
      end: edit.range.end,
      newText: edit.newText,
    })), [{
      start: { line: 0, character: 0 },
      end: { line: 0, character: 19 },
      newText: 'const packaged = 42;',
    }]);
    assert.deepEqual(rendered[1], { target: reviewResource, edits: true });
    const panelMarkdown = [];
    await handler(
      { location: 1, prompt: 'continue in panel', references: [] },
      { history: [] },
      { markdown: (value) => panelMarkdown.push(value), progress: () => undefined },
      { isCancellationRequested: false, onCancellationRequested: () => disposable() },
    );
    assert.equal(spawnedRpcChildren.length, 1, 'packaged panel request did not reuse the IDE Pi process');
    assert.deepEqual(panelMarkdown, ['packaged panel response']);
    assert.ok((await stat('/opt/codeflare/pi-agent/extensions/inline-edit.ts')).size > 0, 'image omitted the inline proposal extension');
    await handler(
      { prompt: 'cancelled smoke', references: [] },
      { history: [] },
      { markdown: () => assert.fail('cancelled request emitted markdown'), progress: () => assert.fail('cancelled request emitted progress') },
      { isCancellationRequested: true, onCancellationRequested: () => disposable() },
    );
    return 'DEFAULT_NATIVE_PI_OK';
  } finally {
    await extension?.deactivate?.();
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

    const piDataRoot = join(root, 'pi-data');
    await preparation.prepareBaseOpenVscodeSettings(piDataRoot);
    const piSettings = JSON.parse(await readFile(join(piDataRoot, 'data', 'User', 'settings.json'), 'utf8'));
    assert.deepEqual(piSettings, managed.buildPiOpenVscodeSettings());
    assert.equal(piSettings['chat.disableAIFeatures'], true);
    assert.deepEqual(piSettings['chat.agentFilesLocations'], { '~/.claude/agents': false });

    const unsupportedDataRoot = join(root, 'unsupported-data');
    await preparation.prepareUnsupportedOpenVscodeSettings(unsupportedDataRoot);
    const unsupportedSettings = JSON.parse(await readFile(join(unsupportedDataRoot, 'data', 'User', 'settings.json'), 'utf8'));
    assert.deepEqual(unsupportedSettings, managed.buildUnsupportedOpenVscodeSettings());

    for (const dataRoot of [serverDataRoot, piDataRoot, unsupportedDataRoot]) {
      const profileState = JSON.parse(await readFile(join(dataRoot, 'data', 'User', 'State', 'storage.json'), 'utf8'));
      assert.equal(profileState['workbench.statusbar.hidden'], undefined);
      assert.equal(profileState['workbench.activity.showAccounts'], 'false');
    }
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
      'keyboard.layout': 'de',
      'editor.fontSize': 18,
      'github.copilot.token': 'must-not-persist',
    }));
    execFileSync('python3', [helper, 'capture', '--data-root', live, '--snapshot', snapshot, '--workspace', workspace]);
    execFileSync('python3', [helper, 'restore', '--data-root', restored, '--snapshot', snapshot, '--workspace', workspace]);
    const restoredSettings = JSON.parse(await readFile(join(restored, 'data', 'User', 'settings.json'), 'utf8'));
    assert.deepEqual(restoredSettings, {
      'keyboard.layout': 'de',
      'workbench.colorTheme': 'Default Dark Modern',
    });
    assert.doesNotMatch(await readFile(snapshot, 'utf8'), /fontSize|copilot|must-not-persist/);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`SIDEBAR_IMAGE_SMOKE_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
