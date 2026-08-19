import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/browser-ide-extensions.py', import.meta.url));
const POLICY = fileURLToPath(new URL('../../openvscode/extension-persistence-policy.json', import.meta.url));
const roots = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'codeflare-ide-extensions-'));
  roots.push(root);
  const extensionsDir = join(root, 'extensions');
  const manifest = join(root, 'persistent', 'ide-extensions.json');
  mkdirSync(extensionsDir, { recursive: true });
  mkdirSync(join(manifest, '..'), { recursive: true });
  return { root, extensionsDir, manifest };
}

function capture(extensionsDir, manifest) {
  execFileSync('python3', [
    SCRIPT,
    'capture',
    '--extensions-dir', extensionsDir,
    '--manifest', manifest,
    '--policy', POLICY,
  ], { env: { ...process.env, REMOTE_CURATION_RELEASE_DIGEST: 'a'.repeat(64) } });
}

function manifest(extensionEntries = {}, settings = {}) {
  return {
    version: 1,
    securityWarningShown: true,
    extensions: extensionEntries,
    settings,
  };
}

function managedExtension(id, version) {
  const [publisher, name] = id.split('.');
  return {
    id,
    publisher,
    name,
    version,
    targetPlatform: 'universal',
    engine: '^1.109.0',
    entrypoint: './dist/extension.js',
    extensionPack: [],
    extensionDependencies: [],
    size: 2578697,
    sha256: '7363ae578eeaedf124ba6676accb86a565b4e9f82f80eeeba8f104f72d74fb69',
    downloadUrl: `https://open-vsx.org/api/${publisher}/${name}/${version}/file/${publisher}.${name}-${version}.vsix`,
  };
}

function managedManifest(extensions) {
  return {
    schemaVersion: 1,
    release: { digest: 'a'.repeat(64), sequence: 7 },
    extensions,
  };
}

function registryEntry(id, version, targetPlatform = 'universal', installedTimestamp = 1_786_921_200_000) {
  return {
    identifier: { id },
    version,
    location: { scheme: 'file', path: `/tmp/extensions/${id}` },
    relativeLocation: id,
    metadata: { targetPlatform, installedTimestamp },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('REQ-IDE-016 AC4 + REQ-IDE-036 AC1+AC2+AC3+AC4+AC5+AC6: captures bounded extension registry without settings loss', () => {
  const { extensionsDir, manifest: manifestPath } = fixture();
  const originalSettings = {
    'yaml.validate': true,
    'eslint.options': { overrideConfigFile: '.eslintrc.json' },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest({
    'redhat.vscode-yaml': { version: '1.23.0', targetPlatform: 'universal', installedAt: '2026-08-16T10:00:00Z' },
    'dbaeumer.vscode-eslint': { version: '3.0.34', targetPlatform: 'universal', installedAt: '2026-08-16T10:00:00Z' },
    'eamodio.gitlens': { version: '17.0.0', targetPlatform: 'universal', installedAt: '2026-08-16T10:00:00Z' },
  }, originalSettings)));
  writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([
    registryEntry('RedHat.VSCode-YAML', '1.24.0'),
    registryEntry('dbaeumer.vscode-eslint', '3.0.34'),
    registryEntry('codeflare.codeflare-agent-sidebar', '0.0.0'),
    registryEntry('anthropic.claude-code', '2.1.224', 'linux-x64'),
    registryEntry('codeflare.codeflare-welcome', '0.0.0'),
  ]));
  writeFileSync(join(extensionsDir, '.obsolete'), JSON.stringify({
    'dbaeumer.vscode-eslint-3.0.34-universal': true,
  }));

  capture(extensionsDir, manifestPath);

  const captured = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(captured.version, 1);
  assert.equal(captured.securityWarningShown, true);
  assert.deepEqual(captured.settings, originalSettings);
  assert.deepEqual(Object.keys(captured.extensions).sort(), [
    'eamodio.gitlens',
    'redhat.vscode-yaml',
  ]);
  assert.equal(captured.extensions['redhat.vscode-yaml'].version, '1.24.0');
  assert.equal(captured.extensions['redhat.vscode-yaml'].targetPlatform, 'universal');
  assert.match(captured.extensions['redhat.vscode-yaml'].installedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(captured.extensions['eamodio.gitlens'].version, '17.0.0', 'absence without .obsolete preserves gallery-failure intent');
  assert.equal(lstatSync(manifestPath).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(manifestPath, '..')), ['ide-extensions.json']);
});

test('REQ-IDE-036 AC3: malformed or unsafe manifests stay byte-for-byte unchanged', () => {
  const invalidBodies = [
    '{not-json',
    `${' '.repeat(65 * 1024)}\n`,
    JSON.stringify({ version: 2, extensions: {}, settings: {} }),
    JSON.stringify({ version: 1, unknown: true, extensions: {}, settings: {} }),
    JSON.stringify(manifest({ 'RedHat.vscode-yaml': { version: '1.24.0' } })),
    JSON.stringify(manifest(Object.fromEntries(Array.from({ length: 51 }, (_, index) => [
      `publisher.extension-${index}`,
      { version: '1.0.0' },
    ])))),
    JSON.stringify(manifest({ 'bad/id': { version: '1.0.0' } })),
    JSON.stringify(manifest({ 'publisher.extension': { version: 'x'.repeat(65) } })),
    JSON.stringify(manifest({ 'publisher.extension': { version: 'latest' } })),
    JSON.stringify(manifest({ 'publisher.extension': { version: '1.0.0', targetPlatform: 'Linux-X64' } })),
    JSON.stringify(manifest({ 'publisher.extension': { version: '1.0.0', installedAt: 'yesterday' } })),
    JSON.stringify(manifest({ 'publisher.extension': { version: '1.0.0', sha256: 'f'.repeat(63) } })),
    JSON.stringify(manifest({}, { 'fixture.array': ['not', 'plain-object'] })),
    JSON.stringify(manifest({}, { 'fixture.large': 'x'.repeat(2_049) })),
  ];

  for (const body of invalidBodies) {
    const { extensionsDir, manifest: manifestPath } = fixture();
    writeFileSync(manifestPath, body);
    writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([
      registryEntry('redhat.vscode-yaml', '1.24.0'),
    ]));

    capture(extensionsDir, manifestPath);

    assert.equal(readFileSync(manifestPath, 'utf8'), body);
  }

  const { root, extensionsDir, manifest: manifestPath } = fixture();
  const target = join(root, 'redirected.json');
  const original = JSON.stringify(manifest({ 'publisher.extension': { version: '1.0.0' } }));
  writeFileSync(target, original);
  symlinkSync(target, manifestPath);
  writeFileSync(join(extensionsDir, 'extensions.json'), '[]');

  capture(extensionsDir, manifestPath);

  assert.equal(lstatSync(manifestPath).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), original);
});

test('REQ-IDE-042 AC5: generation-reap capture preserves prior intent but never creates it solely from company installs', () => {
  const { extensionsDir, manifest: manifestPath } = fixture();
  const companyId = 'cherrymarkdownpublisher.cherry-markdown';
  const company = managedExtension(companyId, '0.3.1081718');
  const managedPath = join(manifestPath, '..', 'managed-extensions.json');
  writeFileSync(managedPath, JSON.stringify(managedManifest([company])));
  writeFileSync(manifestPath, JSON.stringify(manifest({
    [companyId]: { version: '0.2.0', targetPlatform: 'universal' },
  })));
  writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([
    registryEntry(companyId, company.version),
    registryEntry('acme.company-only', '1.0.0'),
  ]));
  writeFileSync(managedPath, JSON.stringify(managedManifest([
    company,
    managedExtension('acme.company-only', '1.0.0'),
  ])));

  capture(extensionsDir, manifestPath);

  let captured = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(captured.extensions, {
    [companyId]: { version: '0.2.0', targetPlatform: 'universal' },
  });

  writeFileSync(join(extensionsDir, '.codeflare-company-extensions.json'), JSON.stringify([companyId, 'acme.company-only']));
  rmSync(managedPath);
  capture(extensionsDir, manifestPath);
  captured = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(captured.extensions, {
    [companyId]: { version: '0.2.0', targetPlatform: 'universal' },
  });
});

test('REQ-IDE-038 AC1: an absent manifest awaits security acknowledgement', () => {
  const { extensionsDir, manifest: manifestPath } = fixture();
  writeFileSync(join(extensionsDir, 'extensions.json'), JSON.stringify([
    registryEntry('publisher.extension', '1.2.3', 'linux-x64'),
    registryEntry('codeflare.codeflare-agent-sidebar', '0.0.0'),
  ]));

  capture(extensionsDir, manifestPath);

  assert.equal(existsSync(manifestPath), true);
  const captured = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(captured.extensions, {}, 'the non-interactive reap backstop cannot acknowledge arbitrary-code risk');
  assert.deepEqual(captured.settings, {});
  assert.equal(captured.securityWarningShown, undefined);
  assert.equal(lstatSync(manifestPath).mode & 0o777, 0o600);
});
