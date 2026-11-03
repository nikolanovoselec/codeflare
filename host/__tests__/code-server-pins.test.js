import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateCodeServerPins } from '../../scripts/ci/update-code-server-pins.mjs';

// This fixture names the intentional Docker version/checksum pin contract.
const source = `RUN CODE_SERVER_VERSION="4.143.1" && \\
    CODE_SERVER_SHA256="${'a'.repeat(64)}" && \\
    CODE_SERVER_COMMIT="${'b'.repeat(40)}" && \\
    CODE_SERVER_CODE_VERSION="1.143.0" && \\
    CODE_SERVER_VSCODE_COMMIT="${'c'.repeat(40)}" && \\
    CODE_SERVER_JS_YAML_VERSION="5.4.1" && \\
    CODE_SERVER_IDE_TAR_VERSION="7.5.22"
`;
const pins = {
  codeServerVersion: '4.144.0',
  codeServerCommit: 'ee31cdbe02c07b3ba718007f221d14c890696c61',
  codeVersion: '1.144.0',
  vscodeCommit: '2c33b50b16c472efe58357d1d2a8a5414bc23fbf',
  jsYamlVersion: '5.4.3',
  ideTarVersion: '7.5.22',
};

test('REQ-OPS-020: code-server candidate carries its actual bundled dependency pins and invalidates the old digest', () => {
  const expected = `RUN CODE_SERVER_VERSION="4.144.0" && \\
    CODE_SERVER_SHA256="NEEDS_UPDATE_SEE_PR_BODY" && \\
    CODE_SERVER_COMMIT="ee31cdbe02c07b3ba718007f221d14c890696c61" && \\
    CODE_SERVER_CODE_VERSION="1.144.0" && \\
    CODE_SERVER_VSCODE_COMMIT="2c33b50b16c472efe58357d1d2a8a5414bc23fbf" && \\
    CODE_SERVER_JS_YAML_VERSION="5.4.3" && \\
    CODE_SERVER_IDE_TAR_VERSION="7.5.22"
`;
  assert.equal(updateCodeServerPins(source, pins), expected,
    'the candidate must not retain the stale 5.4.1 equality guard or bless an old archive checksum');
});

for (const [field, version] of [
  ['jsYamlVersion', undefined],
  ['jsYamlVersion', '5.4.0'],
  ['jsYamlVersion', '6.0.0'],
  ['jsYamlVersion', '5.4.4-beta.1'],
  ['ideTarVersion', undefined],
  ['ideTarVersion', '7.5.21'],
  ['ideTarVersion', '8.0.0'],
]) {
  test(`REQ-OPS-020: rejects missing, downgraded or unqualified bundled code-server metadata (${field}=${version})`, () => {
    assert.throws(() => updateCodeServerPins(source, { ...pins, [field]: version }));
  });
}

test('REQ-OPS-020: accepts a forward patch without relaxing the existing package-major boundary', () => {
  const updated = updateCodeServerPins(source, { ...pins, jsYamlVersion: '5.4.4', ideTarVersion: '7.5.23' });
  assert.ok(updated.includes('CODE_SERVER_JS_YAML_VERSION="5.4.4"'));
  assert.ok(updated.includes('CODE_SERVER_IDE_TAR_VERSION="7.5.23"'));
});
