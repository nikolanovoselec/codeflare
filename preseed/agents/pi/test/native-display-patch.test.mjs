import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { patchPiNativeModelDisplay } from '../../../../scripts/patch-pi-native-model-display.mjs';

const installed = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
const paths = ['package.json', 'dist/modes/interactive/components/model-selector.js',
  'dist/modes/interactive/components/settings-selector.js', 'dist/bundle/chunks/chunk-JVUZSMYM.js',
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
for (const damage of ['version', 'source anchor', 'bundle anchor']) {
  it(`REQ-ENTERPRISE-082: display patch rejects ${damage} drift before any writes`, (t) => {
    const root = copyPackage(t);
    if (damage === 'version') {
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ ...manifest, version: '0.0.0' }));
    } else {
      const path = join(root, damage === 'source anchor' ? paths[1] : paths[3]);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('modelText', 'changedModelText'));
    }
    const before = snapshot(root);
    assert.throws(() => patchPiNativeModelDisplay(root));
    assert.deepEqual(snapshot(root), before);
  });
}
