import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { patchPiNativeModelDisplay } from '../../../../scripts/patch-pi-native-model-display.mjs';

const installed = process.env.CODEFLARE_PI_PACKAGE_ROOT || dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const version = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;
// Exact reviewed artifact names are the display admission contract, not an inferred glob.
const chunks = { '1.5.0': 'chunk-44DLKSKE.js', '1.5.2': 'chunk-VEJDBY3O.js' };
assert.ok(Object.hasOwn(chunks, version), `Unreviewed display fixture: ${version}`);
const paths = ['package.json', 'dist/modes/interactive/components/model-selector.js',
  'dist/modes/interactive/components/settings-selector.js', `dist/bundle/chunks/${chunks[version]}`,
  'dist/modes/interactive/interactive-mode.js'];
function copyPackage(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-display-patch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(installed, path), join(root, path));
  }
  return root;
}
const snapshot = (root) => paths.map((path) => readFileSync(join(root, path), 'utf8'));

it('REQ-ENTERPRISE-082: packaged display patch is idempotent', (t) => {
  const root = copyPackage(t);
  patchPiNativeModelDisplay(root);
  const once = snapshot(root);
  patchPiNativeModelDisplay(root);
  assert.deepEqual(snapshot(root), once);
});
for (const damage of ['version', 'other reviewed version', 'package name', 'source anchor', 'bundle anchor', 'source bytes', 'bundle bytes']) {
  it(`REQ-ENTERPRISE-082: display patch rejects ${damage} drift before any writes`, (t) => {
    const root = copyPackage(t);
    if (['version', 'other reviewed version', 'package name'].includes(damage)) {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest,
        ...(damage === 'package name' ? { name: 'unrelated-package' } :
          { version: damage === 'version' ? '0.0.0' : version === '1.5.0' ? '1.5.2' : '1.5.0' }),
      }));
    } else {
      const path = join(root, damage.startsWith('source') ? paths[1] : paths[3]);
      const source = readFileSync(path, 'utf8');
      writeFileSync(path, damage.endsWith('bytes') ? `${source}\n` : source.replaceAll('modelText', 'changedModelText'));
    }
    const before = snapshot(root);
    const expectedError = damage === 'version' || damage === 'package name' ? /requires Pi 1\.5\.0 or 1\.5\.2/ :
      damage.endsWith('anchor') ? /anchor drift/ : /source hash drift/;
    assert.throws(() => patchPiNativeModelDisplay(root), expectedError);
    assert.deepEqual(snapshot(root), before);
  });
}

for (const partial of ['one anchor', 'one file']) {
  it(`REQ-ENTERPRISE-082: display patch rejects partial preparation (${partial}) without writes`, (t) => {
    const root = copyPackage(t);
    patchPiNativeModelDisplay(root);
    const path = join(root, paths[2]);
    let source = readFileSync(path, 'utf8');
    // Restore authentic upstream label functions to model an interrupted preparation.
    const functions = partial === 'one anchor' ? ['modelDisplayLabel'] : ['modelDisplayLabel', 'modelItemLabel'];
    for (const name of functions) {
      const body = name === 'modelDisplayLabel' ? '`${model.id} [${model.provider}]`' :
        '`${model.id} ${theme.fg("muted", `[${model.provider}]`)}`';
      source = source.replace(new RegExp(`function ${name}\\(model\\) \\{[\\s\\S]*?\\n\\}`),
        `function ${name}(model) {\n    return ${body};\n}`);
    }
    writeFileSync(path, source);
    const before = snapshot(root);
    assert.throws(() => patchPiNativeModelDisplay(root), /Incomplete native model display patch/);
    assert.deepEqual(snapshot(root), before);
  });
}

it('REQ-ENTERPRISE-082: display admission leaves persisted routing identity untouched', (t) => {
  const root = copyPackage(t);
  const protectedFiles = {
    'settings.json': '{"defaultProvider":"codeflare-gateway","defaultModel":"opaque-native-id"}\n',
    'models.json': '{"providers":{"codeflare-gateway":{"models":[{"id":"opaque-native-id","name":"Native Route - fixture"}]}}}\n',
    'history.json': '[{"provider":"codeflare-gateway","modelId":"opaque-native-id"}]\n',
  };
  for (const [path, bytes] of Object.entries(protectedFiles)) writeFileSync(join(root, path), bytes);
  const manifest = readFileSync(join(root, 'package.json'), 'utf8');
  patchPiNativeModelDisplay(root);
  for (const [path, bytes] of Object.entries(protectedFiles)) assert.equal(readFileSync(join(root, path), 'utf8'), bytes);
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), manifest);
});
