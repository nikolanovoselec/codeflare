import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { createAgentSession, CustomEditor, DefaultPackageManager, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager, VERSION } from '@earendil-works/pi-coding-agent';
import { CombinedAutocompleteProvider, Container, TuiAltScreen, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import { enterpriseStartup, nativeHandle } from '../../../../host/__fixtures__/enterprise-pi-startup.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
// Real installed modules used by InteractiveMode, not replacement implementations.
const themeModule = await import(pathToFileURL(join(dist, 'modes/interactive/theme/theme.js')).href);
const { KeybindingsManager } = await import(pathToFileURL(join(dist, 'core/keybindings.js')).href);
const packageVersion = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package.json'), 'utf8')).dependencies['pi-open-tui'];
const packageLock = JSON.parse(readFileSync(join(repo, 'preseed/agents/pi/package-lock.json'), 'utf8')).packages['node_modules/pi-open-tui'];
const OPEN_TUI = { source: `npm:pi-open-tui@${packageVersion}`, extensions: [] };
const plain = lines => stripVTControlCharacters(lines.join('\n'));
const turn = () => new Promise(resolve => setImmediate(resolve));

// Only the terminal/UI host is substituted. All mounted components, keybindings,
// Theme, package source, TS loader, SDK event dispatch and session models are real.
function terminalHost(fullscreen = false) {
  const bytes = [];
  let input = () => {};
  const terminal = { columns: 120, rows: 60, kittyProtocolActive: false,
    start(onInput) { input = onInput; }, stop() {}, async drainInput() {},
    write(data) { bytes.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const headerSlot = new Container(); const editorSlot = new Container(); const footerSlot = new Container();
  tui.addChild(headerSlot); tui.addChild(editorSlot); tui.addChild(footerSlot);
  const statuses = new Map(); const notices = []; const effects = [];
  const kb = KeybindingsManager.create();
  let header; let footer; let editor; let editorFactory; let overlay;
  const defaultEditor = new CustomEditor(tui, themeModule.getEditorTheme(), kb);
  function mountEditor(factory) {
    const text = editor?.getText() ?? '';
    editorSlot.clear(); editorFactory = factory;
    editor = factory ? factory(tui, themeModule.getEditorTheme(), kb) : defaultEditor;
    editor.setText(text); editorSlot.addChild(editor); tui.setFocus(editor);
  }
  mountEditor(undefined);
  const ui = {
    get theme() { return themeModule.theme; },
    notify(message, type) { notices.push({ message, type }); },
    setStatus(key, value) {
      effects.push({ key, value });
      if (value === undefined) statuses.delete(key); else statuses.set(key, value);
      tui.requestRender();
    },
    setHeader(factory) {
      header?.dispose?.(); headerSlot.clear();
      header = factory?.(tui, themeModule.theme);
      if (header) headerSlot.addChild(header);
    },
    setFooter(factory) {
      footer?.dispose?.(); footerSlot.clear();
      footer = factory?.(tui, themeModule.theme, {
        onBranchChange() { return () => {}; }, getGitBranch() { return undefined; },
        getExtensionStatuses() { return new Map(statuses); },
      });
      if (footer) footerSlot.addChild(footer);
    },
    setEditorComponent: mountEditor, getEditorComponent: () => editorFactory,
    setEditorText: text => editor.setText(text), getEditorText: () => editor.getExpandedText(),
    pasteToEditor: text => input(`\x1b[200~${text}\x1b[201~`),
    setHiddenThinkingLabel() {}, setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    onTerminalInput(handler) { return tui.addInputListener(handler); },
    custom: async (factory, options) => new Promise((resolve, reject) => {
      const finish = value => {
        tui.hideOverlay(); overlay?.dispose?.(); overlay = undefined;
        tui.setFocus(editor); resolve(value);
      };
      Promise.resolve(factory(tui, themeModule.theme, kb, finish)).then(component => {
        overlay = component;
        const handle = tui.showOverlay(component, options?.overlayOptions);
        options?.onHandle?.(handle);
      }, reject);
    }),
  };
  tui.start();
  return { ui, tui, bytes, statuses, notices, effects,
    key: data => input(data), get header() { return header; }, get footer() { return footer; },
    get editor() { return editor; }, get overlay() { return overlay; },
    close() { header?.dispose?.(); footer?.dispose?.(); tui.stop(); },
  };
}

async function fixture(t, { mode = 'tui', hasUI = true, fullscreen = false, config, unsafeConfig, compacted = false } = {}) {
  assert.equal(VERSION, '1.3.0', 'candidate SDK contract; installed 0.99 is not a compatibility result');
  const enterprise = enterpriseStartup({ reasoning: '' });
  assert.equal(enterprise.result.status, 0, enterprise.result.stderr);
  const { home, agentDir } = enterprise;
  const previous = Object.fromEntries(['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PATH'].map(key => [key, process.env[key]]));
  let session; let display; let shutdown = false;
  t.after(async () => {
    try {
      if (session && !shutdown) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session?.dispose(); display?.close();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      delete globalThis[Symbol.for('codeflare.activeRepo')];
      enterprise.cleanup();
    }
  });
  process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1';
  delete globalThis[Symbol.for('codeflare.activeRepo')];
  const npm = join(agentDir, 'npm'); const modules = join(npm, 'node_modules');
  const vendor = join(modules, 'pi-open-tui'); mkdirSync(vendor, { recursive: true });
  const archive = join(repo, `host/__fixtures__/pi-open-tui-${packageVersion}.tgz`);
  // Execute only the archive matching the exact locked production candidate.
  assert.equal(packageLock.version, packageVersion);
  assert.equal(`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`, packageLock.integrity);
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', vendor]);
  writeFileSync(join(npm, 'package.json'), JSON.stringify({ private: true, dependencies: { 'pi-open-tui': packageVersion } }));
  symlinkSync(join(repo, 'preseed/agents/pi/node_modules/@earendil-works'), join(modules, '@earendil-works'), 'dir');
  const extensionDir = join(agentDir, 'extensions'); mkdirSync(extensionDir);
  // Explicit resource paths keep helper-only modules out of autodiscovery.
  for (const name of ['startup-header.ts', 'local-statusline.ts', 'active-repo-memory.ts',
    'graphify-helpers.ts', 'review-helpers.ts', 'guard-helpers.ts']) {
    copyFileSync(join(repo, 'preseed/agents/pi/extensions', name), join(extensionDir, name));
  }
  const configPath = join(agentDir, 'open-tui.json');
  let outside;
  if (unsafeConfig) {
    outside = join(home, 'do-not-overwrite.json');
    writeFileSync(outside, '{"enabled":false,"private":"fixture-sensitive-value"}\n');
    symlinkSync(outside, configPath);
  } else if (config !== undefined) writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config));
  const data = new Map();
  for (const [name, bytes] of [['auth.json', '{}\n'], ['history.json', '["retain history"]\n'],
    ['usage.json', '{"credential":"fixture-only-retain"}\n'], ['npm/package-lock.json', '{"fixture":"user-owned"}\n']]) {
    const path = join(agentDir, name); writeFileSync(path, bytes); data.set(path, bytes);
  }
  const settings = JSON.parse(readFileSync(enterprise.settingsPath, 'utf8'));
  // Host migration tests exercise the complete assembled inventory. This is the
  // real package-filter + managed-adapter seam, not a claim of full mode loading.
  writeFileSync(enterprise.settingsPath, JSON.stringify({ ...settings, packages: [OPEN_TUI] }));
  const settingsManager = SettingsManager.create(home, agentDir);
  const resolved = await new DefaultPackageManager({ cwd: home, agentDir, settingsManager }).resolve();
  assert.deepEqual(resolved.extensions.filter(resource => resource.enabled && resource.path.startsWith(vendor)), [],
    'the real package filter must prevent automatic native extension loading; the managed adapter enables it');
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir, settingsManager,
    noExtensions: true, additionalExtensionPaths: ['startup-header.ts', 'local-statusline.ts', 'active-repo-memory.ts'].map(name => join(extensionDir, name)),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [], 'loader errors are setup/integration failures, never expected RED');
  const modelRuntime = await ModelRuntime.create({ modelsPath: enterprise.modelsPath, authPath: join(agentDir, 'auth.json'),
    modelsStorePath: join(agentDir, 'models-store.json'), allowModelNetwork: false });
  const sessionManager = SessionManager.inMemory(home);
  if (compacted) {
    // A legitimate restored compaction has unknown usage until the next model
    // response. Empty fresh sessions correctly have a known zero estimate.
    const kept = sessionManager.appendMessage({ role: 'user', content: 'Earlier prompt', timestamp: Date.now() });
    sessionManager.appendCompaction('Earlier session summary', kept, 1000);
  }
  ({ session } = await createAgentSession({ cwd: home, agentDir, settingsManager, resourceLoader, modelRuntime,
    sessionManager, tools: ['read'], thinkingLevel: 'off', model: modelRuntime.getModel('codeflare-gateway', 'bedrock_opus') }));
  initTheme('dark', false); display = terminalHost(fullscreen);
  const errors = [];
  if (mode !== 'tui') {
    for (const key of ['setHeader', 'setFooter', 'setEditorComponent', 'custom']) {
      display.ui[key] = () => { throw new Error(`terminal-only ${key} in ${mode}`); };
    }
  }
  // Project runtime probe: meaningful even with RPC's hasUI=true. It cannot
  // interfere with node/tar/SDK loading because only rustc is substituted.
  const bin = join(home, 'bin'); mkdirSync(bin);
  const marker = join(home, 'runtime-probe-ran');
  writeFileSync(join(home, 'Cargo.toml'), '[package]\nname="probe"\nversion="0.0.0"\n');
  writeFileSync(join(bin, 'rustc'), `#!/bin/sh\nprintf probe > ${JSON.stringify(marker)}\nprintf 'rustc 1.0.0\\n'\n`);
  chmodSync(join(bin, 'rustc'), 0o755); process.env.PATH = `${bin}:${previous.PATH}`;
  await session.bindExtensions({ mode, uiContext: hasUI ? display.ui : undefined, onError: error => errors.push(error) });
  return { home, agentDir, configPath, outside, data, session, modelRuntime, display, errors, marker,
    async stop() { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); shutdown = true; },
  };
}

async function settingsOverlay(f) {
  assert.ok(f.session.extensionRunner.getRegisteredCommands().some(command => command.name === 'open-tui'),
    'managed adapter must expose the native settings command before dispatch');
  const pending = f.session.prompt('/open-tui');
  await turn();
  assert.ok(f.display.overlay, 'native /open-tui must open a real interactive component');
  assert.match(plain(f.display.overlay.render(100)), /Open TUI Settings/); // User-facing command contract.
  return { pending };
}

it('REQ-AGENT-056: filtered native package is enabled through the managed adapter and its settings accept keyboard input', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.session.extensionRunner.getCommandDiagnostics(), []);
  assert.match(plain(f.display.header.render(120)), /Pi/);
  assert.match(plain(f.display.editor.render(80)), /╭.*╮/);
  assert.match(plain(f.display.footer.render(120)), /Dynamic Route - bedrock_opus/);
  const { pending } = await settingsOverlay(f);
  f.display.key('\t'); // Appearance tab.
  f.display.key('\x1b[B'); // Cursor style.
  f.display.key('\r'); // Block -> Bar.
  f.display.key('\x1b'); await pending;
  assert.equal(JSON.parse(readFileSync(f.configPath)).cursorStyle, 'bar');
  assert.ok(f.display.bytes.join('').includes('\x1b[6 q'), 'native cursor style must reach the terminal');
  assert.equal(f.display.overlay, undefined);
  f.display.key('draft'); f.display.key('\x1b[200~ 中文 e\u0301 👩‍💻\x1b[201~');
  assert.equal(f.display.editor.getExpandedText(), 'draft 中文 e\u0301 👩‍💻');
  const reopened = await settingsOverlay(f); f.display.key('\x1b'); await reopened.pending;
  f.display.key(' retained');
  assert.equal(f.display.editor.getExpandedText(), 'draft 中文 e\u0301 👩‍💻 retained');
});

it('REQ-AGENT-161 / REQ-AGENT-056 AC5/AC6: actual native header and composed footer obey terminal columns', { timeout: 20000 }, async t => {
  const f = await fixture(t, { fullscreen: true, compacted: true });
  assert.equal(f.session.getContextUsage().tokens, null, 'real restored compaction exposes unknown usage');
  f.display.ui.setStatus('review', '\x1b[32mReview 中文 e\u0301 👩‍💻 clean\x1b[0m');
  f.display.ui.setStatus('empty', '');
  const colored = f.display.footer.render(120).join('\n');
  assert.ok(colored.includes('\x1b[32m'), 'native status rendering must retain third-party ANSI colors');
  assert.match(colored, /\x1b\[(?:0|39)m/, 'colored statuses must close their foreground style');
  const full = plain(f.display.footer.render(120));
  assert.match(full, /Review 中文 é 👩‍💻 clean/);
  assert.match(full, /--%.*Dynamic Route - bedrock_opus:off/s);
  const withoutEmpty = f.display.footer.render(120);
  f.display.ui.setStatus('empty', undefined);
  assert.deepEqual(f.display.footer.render(120), withoutEmpty, 'empty third-party status must add no blank row');
  for (const width of [0, 1, 2, 8, 20, 23, 24, 36, 44, 80, 120]) {
    for (const component of [f.display.header, f.display.footer]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} columns > ${width}`);
    }
  }
  // Real editor input/autocomplete/history at ordinary pane width. Header/footer
  // degenerate widths are not permission to replace the editor's cursor geometry.
  f.display.editor.addToHistory('previous prompt');
  f.display.key('\x1b[A'); assert.equal(f.display.editor.getText(), 'previous prompt');
  f.display.editor.setText('/open-t');
  f.display.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: 'open-tui', description: 'Settings' }], f.home));
  f.display.key('\t'); await turn();
  assert.equal(f.display.editor.getText().trim(), '/open-tui');
});

it('REQ-AGENT-056 AC2 / REQ-ENTERPRISE-058 / REQ-ENTERPRISE-082: published enterprise names render without changing opaque routing identity', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  for (const [id, name] of [['bedrock_opus', 'Dynamic Route - bedrock_opus'], [nativeHandle, 'Native Route - bedrock-opus-5']]) {
    const model = f.modelRuntime.getModel('codeflare-gateway', id);
    assert.ok(model, 'model must be generated by actual enterprise startup');
    const before = structuredClone(model);
    await f.session.setModel(model); f.session.setThinkingLevel('off');
    assert.match(plain(f.display.footer.render(160)), new RegExp(name));
    assert.ok(plain(f.display.footer.render(160)).includes(`${name}:off`));
    assert.deepEqual(model, before); assert.equal(f.session.model.id, id);
  }
  const ordinary = f.modelRuntime.getModel('unrelated-provider', 'unrelated');
  await f.session.setModel(ordinary);
  assert.match(plain(f.display.footer.render(160)), /unrelated:off/);
  assert.equal(f.session.model.provider, 'unrelated-provider');
});

it('REQ-AGENT-056 AC7: model/effort changes and real SDK reload retain native input and shutdown clears only owned status', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  f.display.ui.setStatus('review', 'Review retained');
  f.display.key('unfinished');
  f.session.setThinkingLevel('high'); await turn();
  assert.match(plain(f.display.footer.render(160)), /Dynamic Route - bedrock_opus:high/);
  await f.session.reload();
  assert.match(plain(f.display.editor.render(80)), /╭.*╮/);
  assert.match(plain(f.display.footer.render(160)), /Review retained/);
  assert.match(plain(f.display.footer.render(160)), /Dynamic Route - bedrock_opus:high/);
  f.display.key(' continued');
  assert.equal(f.display.editor.getText(), 'unfinished continued');
  assert.deepEqual(f.errors, []);
  await f.stop(); await turn();
  assert.equal(f.display.statuses.has('codeflare-session'), false);
  assert.equal(f.display.statuses.get('review'), 'Review retained');
  const after = f.display.effects.slice();
  // Cross the owned one-second refresh deadline using the same clock on which
  // the real SDK/package timers were created; do not swap clocks after mount.
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(f.display.effects, after, 'no old-context status emission after shutdown');
  assert.equal(f.display.editor.getText(), 'unfinished continued');
});

for (const options of [{ mode: 'rpc', hasUI: true }, { mode: 'json', hasUI: false },
  { mode: 'print', hasUI: false }, { mode: 'tui', hasUI: false }]) {
  it(`REQ-AGENT-056: ${options.mode} hasUI=${options.hasUI} leaves terminal UI, config and runtime probes inert while reads work`, { timeout: 20000 }, async t => {
    const f = await fixture(t, options);
    assert.ok(f.session.extensionRunner.getRegisteredCommands().some(command => command.name === 'open-tui'));
    await f.session.prompt('/open-tui');
    await f.session.extensionRunner.emit({ type: 'model_select', model: f.session.model, source: 'set' });
    await f.session.extensionRunner.emit({ type: 'thinking_level_select', thinkingLevel: 'off', previousThinkingLevel: 'high' });
    const note = join(f.home, 'ordinary.txt'); writeFileSync(note, 'ordinary tool remains available');
    const result = await f.session.extensionRunner.createToolContext('test-read', undefined).executeTool('read', { path: note });
    assert.equal(result.isError, false);
    assert.ok(result.result.content.some(item => item.text?.includes('ordinary tool remains available')));
    assert.deepEqual(f.errors, []);
    assert.equal(existsSync(f.configPath), false);
    assert.equal(existsSync(f.marker), false);
    assert.equal(f.display.header, undefined); assert.equal(f.display.footer, undefined);
    assert.equal(f.display.ui.getEditorComponent(), undefined);
    assert.equal(f.display.statuses.has('codeflare-session'), false);
    // Host TUI startup bytes are not extension output. No native editor cursor style may leak.
    assert.ok(!f.display.bytes.join('').includes('\x1b[6 q'));
  });
}

for (const config of [undefined, { enabled: false, inlineFooter: false, settingsLanguage: 'en', cursorStyle: 'underline',
  icons: { mode: 'ascii' }, thinkingPeek: { lines: 2 }, footerSegments: { context: true, extensionStatuses: false, hostname: true },
  telemetry: { enabled: false }, userField: { retain: true } }]) {
  it(`REQ-AGENT-056: ${config ? 'restored' : 'fresh'} TUI enables owned fields without changing unrelated valid preferences or user data`, { timeout: 20000 }, async t => {
    const f = await fixture(t, { config });
    const actual = JSON.parse(readFileSync(f.configPath));
    assert.equal(actual.enabled, true);
    assert.equal(actual.footerSegments.extensionStatuses, true); assert.equal(actual.footerSegments.context, false);
    assert.equal(actual.icons.mode, config?.icons.mode ?? 'unicode');
    assert.equal(actual.thinkingPeek.lines, config?.thinkingPeek.lines ?? 0);
    if (config) {
      for (const key of ['inlineFooter', 'settingsLanguage', 'cursorStyle', 'telemetry', 'userField']) assert.deepEqual(actual[key], config[key]);
      assert.equal(actual.footerSegments.hostname, true);
    }
    assert.match(plain(f.display.editor.render(80)), /╭.*╮/);
    for (const [path, bytes] of f.data) assert.equal(readFileSync(path, 'utf8'), bytes);
  });
}

for (const unsafe of ['malformed', 'symlink']) {
  it(`REQ-AGENT-056: ${unsafe} config remains byte-identical, warns without disclosing content and leaves agent tools usable`, { timeout: 20000 }, async t => {
    const malformed = '{"private":"fixture-sensitive-value",broken\n';
    const f = await fixture(t, unsafe === 'malformed' ? { config: malformed } : { unsafeConfig: true });
    assert.equal(readFileSync(f.configPath, 'utf8'), unsafe === 'malformed' ? malformed : '{"enabled":false,"private":"fixture-sensitive-value"}\n');
    assert.equal(f.display.header, undefined); assert.equal(f.display.footer, undefined);
    assert.equal(f.display.ui.getEditorComponent(), undefined);
    assert.ok(f.display.notices.some(notice => notice.type === 'warning'));
    assert.ok(f.display.notices.every(notice => !notice.message.includes('fixture-sensitive-value')));
    const note = join(f.home, 'safe.txt'); writeFileSync(note, 'built-in read still works');
    const result = await f.session.extensionRunner.createToolContext('safe-read', undefined).executeTool('read', { path: note });
    assert.equal(result.isError, false);
    assert.ok(result.result.content.some(item => item.text?.includes('built-in read still works')));
    assert.deepEqual(f.errors, []);
    for (const [path, bytes] of f.data) assert.equal(readFileSync(path, 'utf8'), bytes);
  });
}
