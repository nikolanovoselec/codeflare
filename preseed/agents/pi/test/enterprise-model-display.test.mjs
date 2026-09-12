import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { enterpriseStartup, nativeHandle } from '../../../../host/__fixtures__/enterprise-pi-startup.mjs';

const dist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const sourcePicker = await import(pathToFileURL(join(dist, 'modes/interactive/components/model-selector.js')).href);
const sourceTheme = await import(pathToFileURL(join(dist, 'modes/interactive/theme/theme.js')).href);
// The installed CLI executes the bundle, not these source modules. Cover both.
const bundled = await import(pathToFileURL(join(dist, 'bundle/chunks/chunk-JVUZSMYM.js')).href);
for (const [kind, { ModelSelectorComponent, initTheme }] of [
  ['source', { ...sourcePicker, ...sourceTheme }], ['bundle', bundled],
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
  picker.handleInput('\r');
  assert.equal(selected.id, nativeHandle);
  assert.equal(selected.provider, 'codeflare-gateway');
  assert.equal(runtime.getModel('codeflare-gateway', nativeHandle).id, nativeHandle);
});
}
