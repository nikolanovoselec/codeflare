import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { enterpriseStartup, nativeHandle, siblingProvider } from '../../../../host/__fixtures__/enterprise-pi-startup.mjs';

const dist = process.env.CODEFLARE_PI_PACKAGE_ROOT
  ? join(process.env.CODEFLARE_PI_PACKAGE_ROOT, 'dist')
  : dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const sourceRuntime = await import(pathToFileURL(join(dist, 'index.js')).href);
const sourcePicker = await import(pathToFileURL(join(dist, 'modes/interactive/components/model-selector.js')).href);
const sourceSettings = await import(pathToFileURL(join(dist, 'modes/interactive/components/settings-selector.js')).href);
const sourceTheme = await import(pathToFileURL(join(dist, 'modes/interactive/theme/theme.js')).href);
// The installed CLI executes the bundle, not these source modules. Cover both.
const bundled = await import(pathToFileURL(join(dist, 'bundle/chunks/chunk-JVUZSMYM.js')).href);
const plainRender = (component) => component.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '');

function thinkingSettings(SettingsSelectorComponent, models, currentModel, onChange) {
  const settings = new SettingsSelectorComponent({
    autoCompact: true, defaultModel: `${currentModel.provider}/${currentModel.id}`,
    currentModel, availableDefaultModels: models,
    showImages: true, imageWidthCells: 80, autoResizeImages: true, blockImages: false,
    enableSkillCommands: true, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time',
    transport: 'sse', httpIdleTimeoutMs: 300000, thinkingLevel: 'off',
    availableThinkingLevels: ['off'], modelThinkingLevels: {},
    currentTheme: 'dark', terminalTheme: 'dark', availableThemes: ['dark'],
    hideThinkingBlock: false, mermaidRenderingMode: 'off', showCacheMissNotices: false,
    collapseChangelog: false, enableInstallTelemetry: false,
    doubleEscapeAction: 'tree', treeFilterMode: 'default', showHardwareCursor: false,
    editorPaddingX: 0, outputPad: 1, autocompleteMaxVisible: 5, quietStartup: false,
    defaultProjectTrust: 'ask', clearOnShrink: false, showTerminalProgress: false,
    tuiMode: 'regular', fullscreenExitOutput: 'transcript', fullscreenScrollbar: 'auto',
    fullscreenCopyOnSelect: true, warnings: { anthropicExtraUsage: true },
  }, { onModelThinkingLevelChange: onChange, onCancel() {} });
  const input = settings.getSettingsList();
  input.handleInput('Default thinking level per model');
  input.handleInput('\r');
  assert.match(plainRender(settings), /Per-Model Thinking Level/);
  return { settings, input };
}

// Keep real command, selection, session persistence and status Text rendering;
// only the terminal host and selector mounting are replaced.
async function interactiveSelection(t, api, targetId) {
  const { ModelRuntime, SettingsManager, SessionManager, DefaultResourceLoader, createAgentSession, InteractiveMode } = api;
  const fixture = enterpriseStartup({ reasoning: '' });
  t.after(fixture.cleanup);
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
    modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false,
  });
  const initialId = targetId === nativeHandle ? 'bedrock_opus' : nativeHandle;
  const settingsManager = SettingsManager.inMemory({ defaultProvider: 'codeflare-gateway', defaultModel: initialId });
  const sessionManager = SessionManager.inMemory(fixture.home);
  const resourceLoader = new DefaultResourceLoader({
    cwd: fixture.home, agentDir: fixture.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: fixture.home, agentDir: fixture.agentDir, modelRuntime, settingsManager, sessionManager,
    resourceLoader, tools: [], model: modelRuntime.getModel('codeflare-gateway', initialId),
  });
  t.after(() => session.dispose());
  let rendered, picker;
  const status = new Promise((resolve) => { rendered = resolve; });
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    runtimeHost: { session }, editor: {}, outputPad: 1,
    footer: { invalidate() {} }, footerDataProvider: { setAvailableProviderCount() {} },
    chatContainer: { children: [], addChild(child) { this.children.push(child); } },
    ui: { requestRender() {
      if (mode.chatContainer.children.length) {
        rendered(mode.chatContainer.children.map(plainRender).join('\n').trim());
      }
    } },
    showSelector(create) {
      const mounted = create(() => {});
      picker = mounted.component;
      t.after(() => mounted.dispose?.());
    },
  });
  return { mode, session, sessionManager, settingsManager, initialId, status, getPicker: () => picker };
}

describe('REQ-ENTERPRISE-082: Pi native model display', () => {
for (const [kind, api] of [
  ['source', { ...sourceRuntime, ...sourcePicker, ...sourceSettings, ...sourceTheme }], ['bundle', bundled],
]) {
const { ModelRuntime, ModelSelectorComponent, SettingsSelectorComponent, initTheme } = api;
initTheme('dark', false);
for (const [id, name] of [
  [nativeHandle, 'Native Route - bedrock-opus-5'],
  ['bedrock_opus', 'Dynamic Route - bedrock_opus'],
]) {
  for (const action of ['command', 'picker', 'picker default callback']) {
    it(`REQ-ENTERPRISE-082: real Pi ${kind} ${action} renders ${name} and retains routing identity`, { timeout: 10000 }, async (t) => {
      const { mode, session, sessionManager, settingsManager, initialId, status, getPicker } = await interactiveSelection(t, api, id);
      const persist = action === 'picker default callback';
      let pickerRendered;
      if (action === 'command') {
        await mode.handleModelCommand(`codeflare-gateway/${id}`);
      } else {
        mode.showModelSelector(id);
        const picker = getPicker();
        pickerRendered = plainRender(picker);
        if (persist) {
          // Exercise the real default-selection closure without booting terminal keybindings.
          await picker.onSelectAsDefaultCallback(session.modelRuntime.getModel('codeflare-gateway', id));
        } else {
          picker.handleInput('\r');
        }
      }
      const message = await status;
      assert.equal(session.model.provider, 'codeflare-gateway');
      assert.equal(session.model.id, id);
      assert.deepEqual(sessionManager.buildSessionContext().model, { provider: 'codeflare-gateway', modelId: id });
      assert.equal(settingsManager.getDefaultProvider(), 'codeflare-gateway');
      assert.equal(settingsManager.getDefaultModel(), persist ? id : initialId);
      assert.equal(message, persist ? `Default model: codeflare-gateway/${name}` : `Model: ${name}`);
      assert.ok(!message.includes(nativeHandle), 'status must not expose the opaque transport handle');
      if (pickerRendered !== undefined) assert.ok(pickerRendered.includes(`${name} [codeflare-gateway]`));
    });
  }
}
it(`REQ-ENTERPRISE-058: real Pi ${kind} picker renders the native name and selects the opaque identity`, async (t) => {
  const fixture = enterpriseStartup({ reasoning: '' });
  t.after(fixture.cleanup);
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const runtime = await ModelRuntime.create({
    modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
    modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false,
  });
  const native = runtime.getModel('codeflare-gateway', nativeHandle);
  assert.equal(native.name, 'Native Route - bedrock-opus-5');
  assert.equal(runtime.getModel('codeflare-gateway', 'bedrock_opus').name, 'Dynamic Route - bedrock_opus');
  let selected;
  const picker = new ModelSelectorComponent(
    { requestRender() {} }, native, runtime, [], (model) => { selected = model; }, () => {},
  );
  t.after(() => picker.dispose());
  const rendered = picker.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const nativeRow = rendered.split('\n').find((line) => line.includes('bedrock-opus-5') && line.includes('[codeflare-gateway]'));
  assert.ok(nativeRow?.includes('Native Route - bedrock-opus-5 [codeflare-gateway]'),
    'native picker row must show the prefixed administrator label, not only the details pane');
  assert.ok(rendered.split('\n').some((line) => line.includes('Dynamic Route - bedrock_opus [codeflare-gateway]')),
    'dynamic picker row must show its published route prefix');
  assert.ok(!rendered.includes(nativeHandle), 'opaque transport handle must not be the visible model label');
  picker.handleInput('bedrock-opus-5');
  const searched = plainRender(picker);
  assert.ok(searched.split('\n').some((line) => line.includes('Native Route - bedrock-opus-5 [codeflare-gateway]')),
    'friendly-name search must retain the native picker row');
  assert.ok(!searched.includes('bedrock_opus [codeflare-gateway]'));
  picker.handleInput('\r');
  assert.equal(selected.id, nativeHandle);
  assert.equal(selected.provider, 'codeflare-gateway');
  assert.equal(runtime.getModel('codeflare-gateway', nativeHandle).id, nativeHandle);
});
it(`real Pi ${kind} thinking submenu uses the native label and header, searches the name, and saves the opaque ID`, async (t) => {
  const fixture = enterpriseStartup({ reasoning: '' });
  t.after(fixture.cleanup);
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const runtime = await ModelRuntime.create({
    modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
    modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false,
  });
  const native = runtime.getModel('codeflare-gateway', nativeHandle);
  const changes = [];
  const { settings, input } = thinkingSettings(SettingsSelectorComponent, runtime.getAvailableSnapshot(), native,
    (...args) => changes.push(args));
  const rendered = plainRender(settings);
  assert.ok(rendered.includes('Native Route - bedrock-opus-5 [codeflare-gateway]'));
  assert.ok(rendered.includes('Dynamic Route - bedrock_opus [codeflare-gateway]'));
  assert.ok(!rendered.includes(nativeHandle));
  input.handleInput('bedrock-opus-5');
  const searched = plainRender(settings);
  assert.ok(searched.split('\n').some((line) => line.includes('Native Route - bedrock-opus-5 [codeflare-gateway]')));
  assert.ok(!searched.includes('bedrock_opus [codeflare-gateway]'));
  input.handleInput('\r');
  const header = plainRender(settings);
  assert.ok(header.includes('Thinking Level for Native Route - bedrock-opus-5 [codeflare-gateway]'));
  assert.ok(!header.includes(nativeHandle));
  input.handleInput('\r');
  assert.deepEqual(changes, [['codeflare-gateway', nativeHandle, 'off']]);
});
for (const [provider, id] of [
  ['codeflare-gateway', 'bedrock_opus'],
  ['unrelated-provider', nativeHandle],
  ['codeflare-gateway', 'ordinary-route'],
]) {
  it(`real Pi ${kind} preserves ordinary display and selection for ${provider}/${id}`, async (t) => {
    const fixture = enterpriseStartup({ reasoning: '' });
    t.after(fixture.cleanup);
    assert.equal(fixture.result.status, 0, fixture.result.stderr);
    const dynamic = provider === 'codeflare-gateway';
    const name = dynamic ? `Dynamic Route - ${id}` : 'Ordinary friendly name';
    writeFileSync(fixture.modelsPath, JSON.stringify({ providers: {
      [provider]: { ...siblingProvider, models: [{ id, name, reasoning: false }] },
    } }));
    const runtime = await ModelRuntime.create({
      modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
      modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false,
    });
    const model = runtime.getModel(provider, id);
    assert.equal(model.name, name);
    const selections = [];
    const picker = new ModelSelectorComponent(
      { requestRender() {} }, model, runtime, [], (selected) => selections.push([selected.provider, selected.id]), () => {},
    );
    t.after(() => picker.dispose());
    const label = `${dynamic ? name : id} [${provider}]`;
    const rendered = plainRender(picker);
    assert.ok(rendered.includes(label), 'published route prefixes must display while unrelated rows retain IDs');
    if (!dynamic) assert.ok(!rendered.includes(`${name} [${provider}]`));
    picker.handleInput('\r');
    assert.deepEqual(selections, [[provider, id]]);
    const changes = [];
    const { settings, input } = thinkingSettings(SettingsSelectorComponent, [model], model,
      (...args) => changes.push(args));
    assert.ok(plainRender(settings).includes(label));
    if (!dynamic) assert.ok(!plainRender(settings).includes(name));
    input.handleInput('\r');
    assert.ok(plainRender(settings).includes(`Thinking Level for ${label}`));
    input.handleInput('\r');
    assert.deepEqual(changes, [[provider, id, 'off']]);
  });
}
}
});
