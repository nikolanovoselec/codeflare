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

describe('REQ-ENTERPRISE-082: Pi native model display', () => {
for (const [kind, { ModelRuntime, ModelSelectorComponent, SettingsSelectorComponent, initTheme }] of [
  ['source', { ...sourceRuntime, ...sourcePicker, ...sourceSettings, ...sourceTheme }], ['bundle', bundled],
]) {
initTheme('dark', false);
it(`REQ-ENTERPRISE-058: real Pi ${kind} picker renders the native name and selects the opaque identity`, async (t) => {
  const fixture = enterpriseStartup({ reasoning: '' });
  t.after(fixture.cleanup);
  assert.equal(fixture.result.status, 0, fixture.result.stderr);
  const runtime = await ModelRuntime.create({
    modelsPath: fixture.modelsPath, authPath: join(fixture.agentDir, 'auth.json'),
    modelsStorePath: join(fixture.agentDir, 'models-store.json'), allowModelNetwork: false,
  });
  const native = runtime.getModel('codeflare-gateway', nativeHandle);
  assert.equal(native.name, 'bedrock-opus-5');
  let selected;
  const picker = new ModelSelectorComponent(
    { requestRender() {} }, native, runtime, [], (model) => { selected = model; }, () => {},
  );
  t.after(() => picker.dispose());
  const rendered = picker.render(120).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const nativeRow = rendered.split('\n').find((line) => line.includes('bedrock-opus-5') && line.includes('[codeflare-gateway]'));
  assert.ok(nativeRow, 'native picker row must show the administrator label, not only the details pane');
  assert.ok(!rendered.includes(nativeHandle), 'opaque transport handle must not be the visible model label');
  picker.handleInput('bedrock-opus-5');
  const searched = plainRender(picker);
  assert.ok(searched.split('\n').some((line) => line.includes('bedrock-opus-5 [codeflare-gateway]')),
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
  assert.ok(rendered.includes('bedrock-opus-5 [codeflare-gateway]'));
  assert.ok(!rendered.includes(nativeHandle));
  input.handleInput('bedrock-opus-5');
  const searched = plainRender(settings);
  assert.ok(searched.split('\n').some((line) => line.includes('bedrock-opus-5 [codeflare-gateway]')));
  assert.ok(!searched.includes('bedrock_opus [codeflare-gateway]'));
  input.handleInput('\r');
  const header = plainRender(settings);
  assert.ok(header.includes('Thinking Level for bedrock-opus-5 [codeflare-gateway]'));
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
    const name = 'Ordinary friendly name';
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
    const label = `${id} [${provider}]`;
    const rendered = plainRender(picker);
    assert.ok(rendered.includes(label), 'ordinary picker rows must retain IDs, even when a name exists');
    assert.ok(!rendered.includes(`${name} [${provider}]`));
    picker.handleInput('\r');
    assert.deepEqual(selections, [[provider, id]]);
    const changes = [];
    const { settings, input } = thinkingSettings(SettingsSelectorComponent, [model], model,
      (...args) => changes.push(args));
    assert.ok(plainRender(settings).includes(label));
    assert.ok(!plainRender(settings).includes(name));
    input.handleInput('\r');
    assert.ok(plainRender(settings).includes(`Thinking Level for ${label}`));
    input.handleInput('\r');
    assert.deepEqual(changes, [[provider, id, 'off']]);
  });
}
}
});
